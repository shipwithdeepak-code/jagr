import { ANTHROPIC_DEFAULT_MODEL, createAnthropicAdapter } from './providers/anthropic';
import { PLAN_JSON_SCHEMA, PLANNER_TOOL_NAME } from './plannerSchema';
import type { Fetch } from './providers/types';

/**
 * Phase 3 entry point, kept for compatibility. The Anthropic implementation now lives in
 * providers/anthropic.ts behind the provider-agnostic adapter contract.
 */
export const DEFAULT_PLANNER_MODEL = ANTHROPIC_DEFAULT_MODEL;

export function createAnthropicPlannerClient(cfg: { apiKey: string; model?: string; baseUrl?: string; http: Fetch }) {
  const adapter = createAnthropicAdapter({ provider: 'anthropic', model: cfg.model ?? ANTHROPIC_DEFAULT_MODEL, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl }, cfg.http);
  return {
    model: adapter.model,
    complete: (req: { system: string; prompt: string }) => adapter.generate({ ...req, schema: PLAN_JSON_SCHEMA as unknown as Record<string, unknown>, toolName: PLANNER_TOOL_NAME }),
  };
}
