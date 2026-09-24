import { parseProposal, PLAN_JSON_SCHEMA, type PlannerFailureCode, type PlannerOutcome, type PlannerProposal, type PlannerSource } from './plannerSchema.js';
import { buildPlannerPrompt, planFingerprint, PLANNER_SYSTEM_PROMPT, type PlannerInput } from './plannerPrompt.js';

/**
 * The provider-agnostic planning runtime.
 *
 *   investigation engine ──plan(state)──▶ PlannerManager ──▶ LLMPlannerProvider (any)
 *                                                         └─▶ fallback provider (only if configured)
 *
 * The engine only ever calls `plan(state)` and receives a normalized PlannerOutcome. It never sees
 * a provider name, a model id, a request format or a credential — `source` is opaque metadata it
 * copies into the trace. Timeouts, the circuit breaker, plan reuse and provider fallback live here,
 * identically for every provider.
 */

/** What the investigation engine depends on. */
export interface InvestigationPlanner {
  label: string;
  plan(state: PlannerInput): Promise<PlannerOutcome>;
}

/** One LLM provider behind a normalized contract. Adapters convert native responses into PlannerOutcome. */
export interface LLMPlannerProvider {
  id: string;
  displayName: string;
  model?: string;
  plan(state: PlannerInput): Promise<PlannerOutcome>;
}

/** A raw-text planner (scripted test planners). Its text is parsed with the shared schema like any model's. */
export interface PlannerClient {
  label: string;
  complete(req: { system: string; prompt: string; schema: object; input: PlannerInput }): Promise<string>;
}

export function providerFromClient(client: PlannerClient, id = 'scripted'): LLMPlannerProvider {
  return {
    id,
    displayName: client.label,
    async plan(state) {
      return parseProposal(await client.complete({ system: PLANNER_SYSTEM_PROMPT, prompt: buildPlannerPrompt(state), schema: PLAN_JSON_SCHEMA, input: state }));
    },
  };
}

/** Availability failures may use a configured fallback provider. Bad output never does — it goes to the deterministic planner. */
const AVAILABILITY: PlannerFailureCode[] = ['TIMEOUT', 'MODEL_UNAVAILABLE', 'CIRCUIT_OPEN', 'NOT_CONFIGURED'];

class PlannerTimeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new PlannerTimeout()), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export interface PlannerManagerOptions {
  primary: LLMPlannerProvider;
  /** Used only when the primary is unavailable, and only if explicitly configured. */
  fallback?: LLMPlannerProvider;
  timeoutMs?: number;
  circuitAfter?: number;
  label?: string;
}

export function createPlannerManager(opts: PlannerManagerOptions): InvestigationPlanner {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const circuitAfter = opts.circuitAfter ?? 3;
  const cache = new Map<string, { proposal: PlannerProposal; source?: PlannerSource }>();
  const outages = new Map<string, number>();
  const lastFailure = new Map<string, string>();
  const sourceOf = (p: LLMPlannerProvider, latencyMs?: number): PlannerSource => ({ provider: p.id, displayName: p.displayName, model: p.model, latencyMs });

  const attempt = async (p: LLMPlannerProvider, state: PlannerInput): Promise<PlannerOutcome> => {
    if ((outages.get(p.id) ?? 0) >= circuitAfter) {
      return { status: 'failed', code: 'CIRCUIT_OPEN', detail: `${p.displayName} failed ${circuitAfter} times in a row this run (last error: ${lastFailure.get(p.id) ?? 'unknown'}), so Jagr stopped calling it for the rest of this run.`, source: sourceOf(p) };
    }
    const started = Date.now();
    try {
      const out = await withTimeout(p.plan(state), timeoutMs);
      const failedOutage = out.status === 'failed' && (out.code === 'MODEL_UNAVAILABLE' || out.code === 'TIMEOUT');
      outages.set(p.id, failedOutage ? (outages.get(p.id) ?? 0) + 1 : 0);
      if (out.status === 'failed') lastFailure.set(p.id, out.detail);
      return { ...out, source: { ...sourceOf(p, Date.now() - started), ...out.source, fallbackFrom: undefined } };
    } catch (e) {
      outages.set(p.id, (outages.get(p.id) ?? 0) + 1);
      const err = e as Error;
      lastFailure.set(p.id, err?.message ?? String(e));
      return e instanceof PlannerTimeout || err?.name === 'TimeoutError' || err?.name === 'AbortError'
        ? { status: 'failed', code: 'TIMEOUT', detail: `${p.displayName} did not answer within ${timeoutMs} ms.`, source: sourceOf(p, Date.now() - started) }
        : { status: 'failed', code: 'MODEL_UNAVAILABLE', detail: `${p.displayName} could not be reached (${(e as Error).message}).`, source: sourceOf(p, Date.now() - started) };
    }
  };

  return {
    label: opts.label ?? `${opts.primary.displayName}${opts.primary.model ? ` · ${opts.primary.model}` : ''}`,
    async plan(state) {
      const key = planFingerprint(state);
      const hit = cache.get(key);
      if (hit) return { status: 'ok', proposal: hit.proposal, cached: true, source: hit.source };

      const first = await attempt(opts.primary, state);
      if (first.status === 'ok') {
        cache.set(key, { proposal: first.proposal, source: first.source });
        return first;
      }
      if (!opts.fallback || !AVAILABILITY.includes(first.code)) return first;

      // Explicitly configured provider fallback — never silent: the trace records who answered and why.
      const second = await attempt(opts.fallback, state);
      const fallbackFrom = { provider: opts.primary.id, displayName: opts.primary.displayName, reason: first.detail };
      const out: PlannerOutcome = { ...second, source: { ...sourceOf(opts.fallback), ...second.source, fallbackFrom } };
      if (out.status === 'ok') {
        cache.set(key, { proposal: out.proposal, source: out.source });
        return out;
      }
      return { ...out, detail: `Primary planner unavailable (${first.detail}) Fallback provider also failed (${out.detail})` };
    },
  };
}

/** Phase 3 entry point, kept: a single raw-text client behind the same manager. */
export function createModelPlanner(client: PlannerClient, opts: { timeoutMs?: number; circuitAfter?: number } = {}): InvestigationPlanner {
  return createPlannerManager({ primary: providerFromClient(client), label: client.label, ...opts });
}

// ─────────────────────────────────────────────────────────────
// Browser → server planner endpoint
// ─────────────────────────────────────────────────────────────

const KNOWN_CODES: PlannerFailureCode[] = ['NOT_CONFIGURED', 'TIMEOUT', 'MODEL_UNAVAILABLE', 'EMPTY_RESPONSE', 'INVALID_JSON', 'SCHEMA_VIOLATION', 'TRUNCATED_OUTPUT', 'CIRCUIT_OPEN'];
const str = (v: unknown, max = 120) => (typeof v === 'string' ? v.slice(0, max) : undefined);

/**
 * A provider that lives behind the server endpoint. The browser sends the investigation state; the
 * server picks the configured provider, holds the key and calls the API. The response is re-parsed
 * here with the shared schema — nothing from the network is trusted.
 */
export function createHttpPlannerProvider(cfg: { role: 'primary' | 'fallback'; id: string; displayName: string; model?: string; endpoint?: string; fetch?: typeof fetch }): LLMPlannerProvider {
  const http = cfg.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  return {
    id: cfg.id,
    displayName: cfg.displayName,
    model: cfg.model,
    async plan(state) {
      const res = await http(cfg.endpoint ?? '/api/planner/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: cfg.role, state }) });
      if (!res.ok) throw new Error(`planner endpoint returned ${res.status}`);
      const body = (await res.json()) as { outcome?: { status?: string; proposal?: unknown; code?: string; detail?: string }; source?: Record<string, unknown> };
      const source: PlannerSource = { provider: str(body.source?.provider) ?? cfg.id, displayName: str(body.source?.displayName) ?? cfg.displayName, model: str(body.source?.model) ?? cfg.model, latencyMs: typeof body.source?.latencyMs === 'number' ? body.source.latencyMs : undefined };
      const o = body.outcome;
      if (o?.status === 'ok') return { ...parseProposal(JSON.stringify(o.proposal ?? null)), source };
      const code = KNOWN_CODES.includes(o?.code as PlannerFailureCode) ? (o!.code as PlannerFailureCode) : 'MODEL_UNAVAILABLE';
      return { status: 'failed', code, detail: str(o?.detail, 300) ?? 'The planner endpoint returned no outcome.', source };
    },
  };
}
