import { PROVIDER_REGISTRY } from './registry';
import type { ProviderConfig, StructuredMode } from './types';

/**
 * The single configuration layer for planning. Server-side only — the only code that reads
 * credentials. The investigation engine never sees any of this.
 *
 *   PLANNER_MODE           llm | deterministic   (default: llm when a provider is configured, else deterministic)
 *   LLM_PROVIDER           anthropic | gemini | openai | openai-compatible
 *   LLM_MODEL              model id (or ANTHROPIC_MODEL / GEMINI_MODEL / OPENAI_MODEL)
 *   LLM_API_KEY            key (or ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY)
 *   LLM_BASE_URL           optional; required for openai-compatible
 *   LLM_STRUCTURED_OUTPUT  json_schema | json_object | prompt   (OpenAI-compatible endpoints)
 *   LLM_TIMEOUT_MS         server-side provider timeout (default 15000)
 *   LLM_FALLBACK_PROVIDER  optional second provider, used ONLY when the primary is unavailable.
 *                          Uses its provider-specific variables, or LLM_FALLBACK_MODEL / _API_KEY / _BASE_URL.
 *
 * Backwards compatible with Phase 3: ANTHROPIC_API_KEY alone (+ optional JAGR_PLANNER_MODEL) still
 * selects Claude.
 */

type Env = Record<string, string | undefined>;

export interface ResolvedProvider {
  config?: ProviderConfig;
  provider: string;
  displayName: string;
  model?: string;
  configured: boolean;
  problems: string[];
}

export interface PlannerConfig {
  mode: 'llm' | 'deterministic';
  primary?: ResolvedProvider;
  fallback?: ResolvedProvider;
  timeoutMs: number;
  problems: string[];
}

const first = (env: Env, names: string[]) => names.map((n) => env[n]?.trim()).find((v) => !!v);

function resolve(env: Env, id: string, prefix: 'LLM' | 'LLM_FALLBACK'): ResolvedProvider {
  const spec = PROVIDER_REGISTRY[id];
  if (!spec) {
    return { provider: id, displayName: id, configured: false, problems: [`Unknown provider “${id}”. Supported: ${Object.keys(PROVIDER_REGISTRY).join(', ')}.`] };
  }
  // Each role reads its own prefixed key or the provider-specific key — the fallback never borrows LLM_API_KEY.
  const apiKey = first(env, [`${prefix}_API_KEY`, ...spec.keyEnv]);
  const model = first(env, [`${prefix}_MODEL`, ...spec.modelEnv]) ?? spec.defaultModel;
  const baseUrl = first(env, [`${prefix}_BASE_URL`]);
  const structuredRaw = first(env, ['LLM_STRUCTURED_OUTPUT']);
  const structured = (['json_schema', 'json_object', 'prompt'] as const).includes(structuredRaw as StructuredMode) ? (structuredRaw as StructuredMode) : undefined;
  const problems: string[] = [];
  if (spec.requiresKey && !apiKey) problems.push(`No API key for ${spec.displayName}. Set ${prefix}_API_KEY${spec.keyEnv.length ? ` or ${spec.keyEnv.join(' / ')}` : ''}.`);
  if (!model) problems.push(`No model for ${spec.displayName}. Set ${prefix}_MODEL${spec.modelEnv.length ? ` or ${spec.modelEnv[0]}` : ''} — Jagr does not guess model names.`);
  if (spec.requiresBaseUrl && !baseUrl) problems.push(`${spec.displayName} needs ${prefix}_BASE_URL (e.g. https://host/v1).`);
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) problems.push(`${prefix}_BASE_URL must start with http:// or https://.`);
  if (structuredRaw && !structured) problems.push(`LLM_STRUCTURED_OUTPUT must be json_schema, json_object or prompt.`);
  return {
    provider: spec.id,
    displayName: spec.displayName,
    model,
    configured: problems.length === 0,
    problems,
    config: problems.length ? undefined : { provider: spec.id, model: model!, apiKey, baseUrl, structured },
  };
}

export function readPlannerConfig(env: Env): PlannerConfig {
  const legacyAnthropic = !env.LLM_PROVIDER && !!env.ANTHROPIC_API_KEY;
  const providerId = env.LLM_PROVIDER?.trim().toLowerCase() || (legacyAnthropic ? 'anthropic' : undefined);
  const requested = env.PLANNER_MODE?.trim().toLowerCase();
  const timeoutMs = Number(env.LLM_TIMEOUT_MS) > 0 ? Number(env.LLM_TIMEOUT_MS) : 15_000;
  const problems: string[] = [];
  if (requested && requested !== 'llm' && requested !== 'deterministic') problems.push('PLANNER_MODE must be "llm" or "deterministic".');
  const mode: PlannerConfig['mode'] = requested === 'deterministic' ? 'deterministic' : requested === 'llm' || providerId ? 'llm' : 'deterministic';
  if (mode === 'deterministic') return { mode, timeoutMs, problems };
  if (!providerId) return { mode, timeoutMs, problems: [...problems, 'PLANNER_MODE=llm but LLM_PROVIDER is not set.'] };
  const primary = resolve(env, providerId, 'LLM');
  const fbId = env.LLM_FALLBACK_PROVIDER?.trim().toLowerCase();
  const fallback = fbId ? resolve(env, fbId, 'LLM_FALLBACK') : undefined;
  if (fbId && fbId === providerId && !env.LLM_FALLBACK_MODEL) problems.push('LLM_FALLBACK_PROVIDER is the same as LLM_PROVIDER; set LLM_FALLBACK_MODEL to make it a different model.');
  return { mode, primary, fallback, timeoutMs, problems };
}

/** What is safe to show a browser: never keys, base URLs are reduced to their host. */
export function publicPlannerConfig(c: PlannerConfig) {
  const pub = (r?: ResolvedProvider) => (r ? { provider: r.provider, displayName: r.displayName, model: r.model, configured: r.configured, problems: r.problems } : undefined);
  return { mode: c.mode, configured: c.mode === 'llm' && !!c.primary?.configured, primary: pub(c.primary), fallback: pub(c.fallback), problems: c.problems };
}
