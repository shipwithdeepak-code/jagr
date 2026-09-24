import type { LLMPlannerProvider } from '../plannerManager.js';
import { buildPlannerPrompt, PLANNER_SYSTEM_PROMPT } from '../plannerPrompt.js';
import { parseProposal, PLAN_JSON_SCHEMA, PLANNER_TOOL_NAME } from '../plannerSchema.js';
import { ANTHROPIC_DEFAULT_MODEL, createAnthropicAdapter } from './anthropic.js';
import { createGeminiAdapter } from './gemini.js';
import { createOpenAIAdapter } from './openai.js';
import { TruncatedOutputError, type Fetch, type ProviderAdapter, type ProviderConfig } from './types.js';

/**
 * Supported LLM providers. Adding one = an adapter file + an entry here + its tests.
 * Nothing in the investigation engine, validator, tools, risk model or approvals changes.
 *
 * Model names are configuration, not code. Only Anthropic has a default (the model Jagr's planner
 * was first built against); Gemini and OpenAI require an explicit model — Jagr does not guess.
 */
export interface ProviderSpec {
  id: string;
  displayName: string;
  requiresKey: boolean;
  requiresBaseUrl: boolean;
  defaultModel?: string;
  /** Provider-specific environment variables, used when the generic LLM_* ones are not set. */
  keyEnv: string[];
  modelEnv: string[];
  create(cfg: ProviderConfig, http?: Fetch): ProviderAdapter;
}

export const PROVIDER_REGISTRY: Record<string, ProviderSpec> = {
  anthropic: {
    id: 'anthropic',
    displayName: 'Claude (Anthropic)',
    requiresKey: true,
    requiresBaseUrl: false,
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
    keyEnv: ['ANTHROPIC_API_KEY'],
    modelEnv: ['ANTHROPIC_MODEL', 'JAGR_PLANNER_MODEL'],
    create: (cfg, http) => createAnthropicAdapter(cfg, http),
  },
  gemini: {
    id: 'gemini',
    displayName: 'Gemini (Google)',
    requiresKey: true,
    requiresBaseUrl: false,
    keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    modelEnv: ['GEMINI_MODEL'],
    create: (cfg, http) => createGeminiAdapter(cfg, http),
  },
  openai: {
    id: 'openai',
    displayName: 'OpenAI',
    requiresKey: true,
    requiresBaseUrl: false,
    keyEnv: ['OPENAI_API_KEY'],
    modelEnv: ['OPENAI_MODEL'],
    create: (cfg, http) => createOpenAIAdapter(cfg, http, 'openai'),
  },
  'openai-compatible': {
    id: 'openai-compatible',
    displayName: 'OpenAI-compatible endpoint',
    requiresKey: false,
    requiresBaseUrl: true,
    keyEnv: [],
    modelEnv: [],
    create: (cfg, http) => createOpenAIAdapter(cfg, http, 'openai-compatible'),
  },
};

/** Wrap a native adapter as a normalized planner provider: same prompt in, shared schema out. */
export function llmPlannerProvider(adapter: ProviderAdapter, opts: { timeoutMs?: number } = {}): LLMPlannerProvider {
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    model: adapter.model,
    async plan(state) {
      const signal = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;
      const source = { provider: adapter.id, displayName: adapter.displayName, model: adapter.model };
      let raw: string;
      try {
        raw = await adapter.generate({ system: PLANNER_SYSTEM_PROMPT, prompt: buildPlannerPrompt(state), schema: PLAN_JSON_SCHEMA as unknown as Record<string, unknown>, toolName: PLANNER_TOOL_NAME, signal });
      } catch (e) {
        if (e instanceof TruncatedOutputError) return { status: 'failed', code: 'TRUNCATED_OUTPUT', detail: e.message, source };
        throw e;
      }
      return { ...parseProposal(raw), source };
    },
  };
}
