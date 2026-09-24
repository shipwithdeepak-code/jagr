import { createHttpPlannerProvider, createModelPlanner, createPlannerManager, type InvestigationPlanner } from '@/product/agent/planner';
import type { PlannerFailureCode, PlannerOutcome } from '@/product/agent/plannerSchema';
import { PLANNER_DOUBLES, type PlannerDoubleName } from '@/product/evaluation/plannerDoubles';
import type { PlannerRunInfo } from '@/product/types';

/**
 * Which planner the workspace uses for a monitoring run. The browser never sees a key or a provider
 * API: it reads safe config from /api/planner/health and sends investigation state to
 * /api/planner/plan, where the server-side provider layer does the rest.
 *
 *   1. ?plannerFault=<double>  — a scripted test planner for manual failure testing (labelled, never a model)
 *   2. PLANNER_MODE=llm        — the configured provider (and, only if configured, a fallback provider)
 *   3. otherwise               — the deterministic planner
 */

interface PublicProvider {
  provider: string;
  displayName: string;
  model?: string;
  configured: boolean;
  problems: string[];
}

export interface PlannerHealth {
  mode: 'llm' | 'deterministic';
  configured: boolean;
  primary?: PublicProvider;
  fallback?: PublicProvider;
  problems?: string[];
}

/** LLM mode was requested but the provider is misconfigured: every step fails as NOT_CONFIGURED and is labelled as a fallback. */
function unconfigured(p: PublicProvider | undefined, detail: string): InvestigationPlanner {
  const code: PlannerFailureCode = 'NOT_CONFIGURED';
  return {
    label: p?.displayName ?? 'LLM planner',
    plan: async (): Promise<PlannerOutcome> => ({ status: 'failed', code, detail, source: p ? { provider: p.provider, displayName: p.displayName, model: p.model } : undefined }),
  };
}

export type PlannerChoice = 'deterministic' | 'llm';

/** Safe planner config from the server (never keys). Undefined when there is no planner endpoint (static build). */
export async function fetchPlannerHealth(http: typeof fetch = (...a) => fetch(...a)): Promise<PlannerHealth | undefined> {
  try {
    const res = await http('/api/planner/health', { headers: { accept: 'application/json' } });
    if (res.ok && (res.headers.get('content-type') ?? '').includes('application/json')) return (await res.json()) as PlannerHealth;
  } catch {
    /* no planner endpoint (static build) */
  }
  return undefined;
}

/** What the selector shows for "Configured LLM": the real provider/model, or why it is unavailable. */
export function llmAvailability(health: PlannerHealth | undefined): { available: boolean; label: string; reason?: string } {
  if (!health) return { available: false, label: 'Configured LLM', reason: 'No LLM provider configured (no planner endpoint in this build).' };
  const p = health.primary;
  if (health.mode !== 'llm' || !p) return { available: false, label: 'Configured LLM', reason: 'No LLM provider configured.' };
  const label = `${p.displayName.replace(/ \(.*\)$/, '')} · ${p.model ?? 'model not set'}`;
  if (!p.configured) return { available: false, label, reason: p.problems.join(' ') || 'The LLM provider is not fully configured.' };
  return { available: true, label };
}

/**
 * The simulation controls the DATA; this controls the PLANNER. The default is deterministic —
 * the configured LLM is used only when the user explicitly selects it.
 */
export async function resolvePlanner(choice: PlannerChoice = 'deterministic', health?: PlannerHealth): Promise<{ planner?: InvestigationPlanner; info: PlannerRunInfo }> {
  const fault = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('plannerFault') : null;
  if (fault && fault in PLANNER_DOUBLES) {
    const client = PLANNER_DOUBLES[fault as PlannerDoubleName];
    return { planner: createModelPlanner(client, { timeoutMs: 300 }), info: { mode: 'test_double', label: client.label } };
  }
  if (choice === 'deterministic') return { info: { mode: 'deterministic', label: 'Deterministic planner', reason: 'Selected in the planner switch.' } };

  if (!health) health = await fetchPlannerHealth();
  if (!health) return { info: { mode: 'deterministic', label: 'Deterministic planner', reason: 'AI planner unavailable — deterministic investigation active (no planner endpoint on this deployment).' } };
  if (health.mode === 'deterministic') return { info: { mode: 'deterministic', label: 'Deterministic planner', reason: `AI planner unavailable — deterministic investigation active (no LLM provider configured). ${health.problems?.join(' ') ?? ''}`.trim() } };

  const p = health.primary;
  const fb = health.fallback?.configured ? health.fallback : undefined;
  const info: PlannerRunInfo = {
    mode: 'llm',
    label: p?.displayName ?? 'LLM planner',
    provider: p?.provider,
    model: p?.model,
    fallback: fb ? { provider: fb.provider, label: fb.displayName, model: fb.model } : undefined,
  };
  if (!p?.configured) {
    const detail = [...(p?.problems ?? []), ...(health.problems ?? [])].join(' ') || 'The LLM provider is not configured.';
    return { planner: unconfigured(p, detail), info: { ...info, reason: `Not configured — ${detail} Deterministic planner used.` } };
  }
  const planner = createPlannerManager({
    primary: createHttpPlannerProvider({ role: 'primary', id: p.provider, displayName: p.displayName, model: p.model }),
    fallback: fb ? createHttpPlannerProvider({ role: 'fallback', id: fb.provider, displayName: fb.displayName, model: fb.model }) : undefined,
    // Server-side adapters time out first; this is the outer bound for the browser round trip.
    timeoutMs: 25_000,
  });
  return { planner, info };
}
