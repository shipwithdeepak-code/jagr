import { z } from 'zod';

/**
 * The normalized planner output. Every provider — Claude, Gemini, OpenAI, an OpenAI-compatible
 * endpoint, a scripted test planner — must produce exactly this, and it is validated here before
 * the policy validator ever sees it. Strict: unknown keys (e.g. a bigger "budget") are a schema
 * violation, not something to ignore.
 *
 * No path-alias imports: the server-side planner endpoint loads this file too.
 */
export const PlannerProposalSchema = z
  .object({
    nextTool: z.string().trim().min(1).max(80),
    reason: z.string().trim().min(8).max(280),
    evidenceGap: z.string().trim().min(4).max(200),
    hypothesesAffected: z.array(z.string().regex(/^HYP-\d{2}$/, 'hypothesis ids look like HYP-01')).min(1).max(6),
    expectedEvidence: z.string().trim().min(4).max(240),
  })
  .strict();

export type PlannerProposal = z.infer<typeof PlannerProposalSchema>;

/** The same contract as JSON Schema, for providers with native structured output. */
export const PLAN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['nextTool', 'reason', 'evidenceGap', 'hypothesesAffected', 'expectedEvidence'],
  properties: {
    nextTool: { type: 'string', description: 'Exactly one option id from the list of tool options, e.g. "getWorkItems" or "getMetric(purchase_revenue)".' },
    reason: { type: 'string', maxLength: 280, description: 'One or two sentences: why this evidence is the most useful next step. A summary, not step-by-step reasoning. Never claim causation.' },
    evidenceGap: { type: 'string', maxLength: 200, description: 'The evidence gap this call addresses.' },
    hypothesesAffected: { type: 'array', items: { type: 'string', pattern: '^HYP-\\d{2}$' }, minItems: 1, maxItems: 6, description: 'Ids of the hypotheses the result could strengthen or weaken.' },
    expectedEvidence: { type: 'string', maxLength: 240, description: 'What the result could show, in either direction.' },
  },
} as const;

export const PLANNER_TOOL_NAME = 'propose_next_step';

export type PlannerFailureCode = 'NOT_CONFIGURED' | 'TIMEOUT' | 'MODEL_UNAVAILABLE' | 'EMPTY_RESPONSE' | 'INVALID_JSON' | 'SCHEMA_VIOLATION' | 'TRUNCATED_OUTPUT' | 'CIRCUIT_OPEN';

/** Safe, key-free description of who produced a plan. Opaque to the investigation engine. */
export interface PlannerSource {
  provider: string;
  displayName: string;
  model?: string;
  latencyMs?: number;
  /** Set when a configured fallback provider answered because the primary was unavailable. */
  fallbackFrom?: { provider: string; displayName: string; reason: string };
}

/** What a planner returns for one step: a validated proposal, or a failure. Never both, never partial. */
export type PlannerOutcome = ({ status: 'ok'; proposal: PlannerProposal; cached: boolean } | { status: 'failed'; code: PlannerFailureCode; detail: string }) & { source?: PlannerSource };

/** Parse raw model text into a proposal. Never throws; never repairs. */
export function parseProposal(raw: string | null | undefined): PlannerOutcome {
  if (raw === null || raw === undefined || !raw.trim() || raw.trim() === 'null' || raw.trim() === '{}') {
    return { status: 'failed', code: 'EMPTY_RESPONSE', detail: 'The model returned an empty response.' };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { status: 'failed', code: 'INVALID_JSON', detail: 'The model output was not valid JSON.' };
  }
  const parsed = PlannerProposalSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { status: 'failed', code: 'SCHEMA_VIOLATION', detail: `The model output did not match the plan schema (${issue?.path.join('.') || 'root'}: ${issue?.message ?? 'invalid'}).` };
  }
  return { status: 'ok', proposal: parsed.data, cached: false };
}
