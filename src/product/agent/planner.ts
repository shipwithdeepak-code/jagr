import type { ToolName } from '../types';
import { overclaimingSentences } from '../engine/language';
import { PROVIDERS } from '../integrations/adapters';
import type { PlannerFailureCode, PlannerProposal } from './plannerSchema';
import type { PlannerInput, PlannerOption } from './plannerPrompt';

/**
 * Constrained model planning — the policy side.
 *
 *   ANY PLANNER → normalized PlannerProposal → POLICY VALIDATOR (here) → tool executor
 *
 * The validator knows nothing about providers. A proposal from any LLM provider, a scripted test
 * planner or the deterministic planner is checked the same way, and only the investigator's own
 * tool option is ever executed.
 */

export * from './plannerPrompt';
export { parseProposal, parseProposal as parsePlan, PlannerProposalSchema, PLAN_JSON_SCHEMA, type PlannerOutcome, type PlannerProposal, type PlannerFailureCode, type PlannerSource } from './plannerSchema';
export { createModelPlanner, createPlannerManager, providerFromClient, createHttpPlannerProvider, type InvestigationPlanner, type LLMPlannerProvider, type PlannerClient } from './plannerManager';

// ─────────────────────────────────────────────────────────────
// Deterministic policy validator — the hard boundary
// ─────────────────────────────────────────────────────────────

export const TOOL_NAMES: ToolName[] = ['getAnalyticsMetric', 'getAnalyticsTraffic', 'getJiraRelease', 'getRecentJiraIssues', 'getStoreReleases', 'getStoreCrashRate', 'getAppStoreReviews', 'getPlayStoreReviews'];

/** Things a planner might try to "call" that are actions, not investigation tools. */
const ACTION_NAMES = ['link_issues', 'create_jira_task', 'create_jira_incident', 'pause_rollout', 'rollback_release', 'notify_customers', 'executeAction', 'proposeActions'];
const ACTION_VERBS = /^(rollback|roll_back|pause|resume|notify|email|refund|execute|deploy|revert|disable|enable|create|link|file|change|set)/i;

export type ValidationCode =
  | 'CAUSAL_CLAIM'
  | 'ACTION_NOT_TOOL'
  | 'UNKNOWN_TOOL'
  | 'BUDGET_EXHAUSTED'
  | 'NOT_IN_INVESTIGATION'
  | 'SOURCE_UNAVAILABLE'
  | 'ALREADY_QUERIED'
  | 'INVALID_HYPOTHESIS'
  | 'REPETITIVE_PROBE'
  | 'NO_INFORMATION_VALUE';

export type Validation = { ok: true; option: PlannerOption } | { ok: false; code: ValidationCode; reason: string };

const unavailable = (o: PlannerOption) => o.sourceFailed || o.sourceState === 'unavailable' || o.sourceState === 'error';

/**
 * Checks a plan against policy. Pure and deterministic: same plan + same state → same verdict.
 * Nothing runs unless this returns ok, and what runs is the investigator's own option — never
 * anything the model wrote.
 */
export function validatePlan(plan: PlannerProposal, input: PlannerInput): Validation {
  const text = [plan.reason, plan.evidenceGap, plan.expectedEvidence].join(' ');
  if (overclaimingSentences(text).length) {
    return { ok: false, code: 'CAUSAL_CLAIM', reason: 'The plan asserted causation. Correlation is not causation; the plan text is withheld and nothing was executed.' };
  }
  const requested = plan.nextTool.trim();
  const base = requested.replace(/\s*\(.*\)\s*$/, '');
  if (ACTION_NAMES.includes(base) || (!TOOL_NAMES.includes(base as ToolName) && ACTION_VERBS.test(base))) {
    return { ok: false, code: 'ACTION_NOT_TOOL', reason: `“${base}” is an action, not an investigation tool. The planner can only request evidence; actions go through the risk policy and human approval.` };
  }
  if (!TOOL_NAMES.includes(base as ToolName)) {
    return { ok: false, code: 'UNKNOWN_TOOL', reason: `“${base}” is not a Jagr tool. Nothing was executed.` };
  }
  if (input.budget.used >= input.budget.max) {
    return { ok: false, code: 'BUDGET_EXHAUSTED', reason: `The ${input.budget.max}-call budget is used up. The planner cannot extend it.` };
  }
  const matching = input.options.filter((o) => o.id === requested || (requested === base && o.tool === base));
  if (!matching.length) {
    return { ok: false, code: 'NOT_IN_INVESTIGATION', reason: `${requested} is not available for this investigation (its source is not in the watch, or it does not apply to this signal).` };
  }
  const reachable = matching.filter((o) => !unavailable(o));
  if (!reachable.length) {
    const o = matching[0];
    return { ok: false, code: 'SOURCE_UNAVAILABLE', reason: `${PROVIDERS[o.source].name} is ${o.sourceFailed ? 'not responding (it failed earlier in this pass)' : o.sourceState}. The call was not made.` };
  }
  const fresh = reachable.filter((o) => !o.alreadyQueried);
  if (!fresh.length) {
    return { ok: false, code: 'ALREADY_QUERIED', reason: `${requested} was already queried in this pass; the same evidence is already in the investigation.` };
  }
  const known = new Set(input.hypotheses.map((h) => h.id));
  const bad = plan.hypothesesAffected.filter((id) => !known.has(id));
  if (bad.length) {
    return { ok: false, code: 'INVALID_HYPOTHESIS', reason: `${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not a hypothesis in this investigation.` };
  }
  const valuable = fresh.filter((o) => o.informative);
  if (!valuable.length && fresh.some((o) => o.probeLimited)) {
    return { ok: false, code: 'REPETITIVE_PROBE', reason: `Everything ${requested} tests has been probed twice with no change, while another open explanation has not been tested at all. Test that first.` };
  }
  if (!valuable.length) {
    return { ok: false, code: 'NO_INFORMATION_VALUE', reason: `${requested} cannot change any open explanation: everything it tests is ruled out or already at its evidence ceiling.` };
  }
  return { ok: true, option: valuable[0] };
}

export const FAILURE_LABEL: Record<PlannerFailureCode, string> = {
  NOT_CONFIGURED: 'LLM planner not configured',
  TIMEOUT: 'LLM planner timed out',
  MODEL_UNAVAILABLE: 'LLM planner unreachable',
  EMPTY_RESPONSE: 'LLM planner returned nothing',
  INVALID_JSON: 'LLM planner returned malformed output',
  SCHEMA_VIOLATION: 'LLM planner output failed the schema',
  TRUNCATED_OUTPUT: 'LLM planner output was cut off',
  CIRCUIT_OPEN: 'LLM planner stopped after repeated failures',
};
