import type { PlannerOutcome } from '../plannerSchema';
import type { PlannerInput } from '../plannerPrompt';
import { publicPlannerConfig, readPlannerConfig, type PlannerConfig, type ResolvedProvider } from './config';
import { llmPlannerProvider, PROVIDER_REGISTRY } from './registry';
import type { Fetch } from './types';

/**
 * The server-side planner endpoint. Framework-free: the Vite dev server mounts it today; a
 * serverless function could mount the same handler. Keys are read here (via config) and used only
 * inside provider adapters — no response ever contains one.
 *
 *   GET  /api/planner/health   safe config: mode, provider, model, problems (never keys)
 *   POST /api/planner/plan     { role: 'primary' | 'fallback', state } → { outcome, source }
 *   POST /api/planner/test     { state? } → one planning call against the configured primary, for manual checks
 */

export interface PlannerHttpRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface PlannerHttpResponse {
  status: number;
  body: unknown;
}

function redact(text: string, cfg: PlannerConfig): string {
  let out = text;
  for (const r of [cfg.primary, cfg.fallback]) {
    const key = r?.config?.apiKey;
    if (key && key.length >= 4) out = out.split(key).join('[redacted]');
  }
  return out.slice(0, 300);
}

function looksLikeState(v: unknown): v is PlannerInput {
  const s = v as PlannerInput;
  return !!s && typeof s === 'object' && Array.isArray(s.hypotheses) && Array.isArray(s.options) && !!s.signal && !!s.budget;
}

/** A small, fixed investigation state for the manual test path (checkout −18%, first planning step). */
export const SAMPLE_PLANNER_STATE: PlannerInput = {
  investigationId: 'planner-test',
  pass: 1,
  signal: { key: 'ga4.checkout_conversion', label: 'Checkout conversion', magnitude: '−18%' },
  area: 'checkout',
  budget: { used: 1, max: 9 },
  hypotheses: [
    { id: 'HYP-01', kind: 'release_related', label: 'Release-related', status: 'untested', strength: 'none', ceiling: 'moderate', evidenceFor: [], evidenceAgainst: [], unknowns: [] },
    { id: 'HYP-02', kind: 'shared_product_issue', label: 'Real product issue', status: 'untested', strength: 'none', ceiling: 'strong', evidenceFor: [], evidenceAgainst: [], unknowns: [] },
    { id: 'HYP-03', kind: 'demand_shift', label: 'Demand shift', status: 'untested', strength: 'none', ceiling: 'strong', evidenceFor: [], evidenceAgainst: [], unknowns: [] },
    { id: 'HYP-04', kind: 'measurement_artifact', label: 'Measurement artifact', status: 'untested', strength: 'none', ceiling: 'moderate', evidenceFor: [], evidenceAgainst: [], unknowns: [] },
  ],
  evidence: [{ source: 'Analytics', direction: 'degraded', statement: 'Checkout conversion is 2.78% vs 3.40% baseline (−18%) since 19:00.' }],
  options: [
    { id: 'getJiraRelease', tool: 'getJiraRelease', source: 'jira', sourceState: 'simulated', tests: ['HYP-01'], question: 'Was anything released shortly before the change began?', alreadyQueried: false, sourceFailed: false, informative: true },
    { id: 'getRecentJiraIssues', tool: 'getRecentJiraIssues', source: 'jira', sourceState: 'simulated', tests: ['HYP-02'], question: 'Are people reporting checkout bugs?', alreadyQueried: false, sourceFailed: false, informative: true },
    { id: 'getAnalyticsTraffic', tool: 'getAnalyticsTraffic', source: 'ga4', sourceState: 'simulated', tests: ['HYP-03'], question: 'Did fewer people arrive, or did the same people convert less?', alreadyQueried: false, sourceFailed: false, informative: true },
    { id: 'getAnalyticsMetric(ga4.purchase_revenue)', tool: 'getAnalyticsMetric', source: 'ga4', sourceState: 'simulated', tests: ['HYP-04'], question: 'Does revenue move too, or only the conversion metric?', alreadyQueried: false, sourceFailed: false, informative: true },
    { id: 'getStoreCrashRate(app_store)', tool: 'getStoreCrashRate', source: 'app_store', sourceState: 'simulated', tests: ['HYP-02'], question: 'Is the iOS app crashing more than normal?', alreadyQueried: false, sourceFailed: false, informative: true },
  ],
};

async function planWith(r: ResolvedProvider | undefined, cfg: PlannerConfig, state: PlannerInput, http?: Fetch): Promise<PlannerHttpResponse> {
  if (!r) return { status: 200, body: { outcome: { status: 'failed', code: 'NOT_CONFIGURED', detail: 'No provider is configured for this role.' } } };
  const source = { provider: r.provider, displayName: r.displayName, model: r.model };
  if (!r.configured || !r.config) return { status: 200, body: { outcome: { status: 'failed', code: 'NOT_CONFIGURED', detail: r.problems.join(' ') }, source } };
  const provider = llmPlannerProvider(PROVIDER_REGISTRY[r.provider].create(r.config, http), { timeoutMs: cfg.timeoutMs });
  const started = Date.now();
  let outcome: PlannerOutcome;
  try {
    outcome = await provider.plan(state);
  } catch (e) {
    const err = e as Error;
    outcome = err.name === 'TimeoutError' || err.name === 'AbortError'
      ? { status: 'failed', code: 'TIMEOUT', detail: `${r.displayName} did not answer within ${cfg.timeoutMs} ms.` }
      : { status: 'failed', code: 'MODEL_UNAVAILABLE', detail: redact(err.message, cfg) };
  }
  const { source: _drop, ...rest } = outcome;
  void _drop;
  return { status: 200, body: { outcome: rest, source: { ...source, latencyMs: Date.now() - started } } };
}

export function createPlannerHandler(env: Record<string, string | undefined>, http?: Fetch) {
  const cfg = readPlannerConfig(env);
  return async (req: PlannerHttpRequest): Promise<PlannerHttpResponse> => {
    const path = req.path.replace(/\/+$/, '') || '/';
    if (req.method === 'GET' && (path === '/health' || path === '/status')) return { status: 200, body: publicPlannerConfig(cfg) };
    if (req.method !== 'POST') return { status: 405, body: { error: 'method not allowed' } };
    const body = (req.body ?? {}) as { role?: string; state?: unknown };
    if (path === '/test') {
      if (cfg.mode !== 'llm') return { status: 200, body: { ...publicPlannerConfig(cfg), note: 'PLANNER_MODE is deterministic — no provider to test.' } };
      const state = looksLikeState(body.state) ? body.state : SAMPLE_PLANNER_STATE;
      return planWith(cfg.primary, cfg, state, http);
    }
    if (path === '/plan') {
      if (!looksLikeState(body.state)) return { status: 400, body: { error: 'state is missing or malformed' } };
      if (cfg.mode !== 'llm') return { status: 200, body: { outcome: { status: 'failed', code: 'NOT_CONFIGURED', detail: 'PLANNER_MODE is deterministic.' } } };
      return planWith(body.role === 'fallback' ? cfg.fallback : cfg.primary, cfg, body.state, http);
    }
    return { status: 404, body: { error: 'not found' } };
  };
}
