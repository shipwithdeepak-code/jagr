import type { PlannerClient, PlannerInput, PlannerOption } from '../agent/planner.js';

/**
 * Scripted test planners. NOT models — deterministic stand-ins that produce the kinds of output a
 * model can produce (good plans, bad plans, garbage, silence) so the policy boundary can be tested
 * without a network call. Every one is labelled as scripted in the trace.
 */

export function scripted(label: string, fn: (input: PlannerInput) => string | Promise<string>): PlannerClient {
  return { label: `Scripted test planner — ${label} (not a model)`, complete: async ({ input }) => fn(input) };
}

const plan = (o: Pick<PlannerOption, 'id' | 'tests' | 'question'>, extra: Partial<Record<string, unknown>> = {}) =>
  JSON.stringify({
    nextTool: o.id,
    reason: `Chosen because it tests ${o.tests.join(', ') || 'an open question'}: ${o.question}`,
    evidenceGap: `Evidence for ${o.tests.join(', ') || 'the open question'}`,
    hypothesesAffected: o.tests.length ? o.tests : ['HYP-02'],
    expectedEvidence: 'A result that could strengthen or weaken these hypotheses.',
    ...extra,
  });

const reachable = (i: PlannerInput) => i.options.filter((o) => !o.alreadyQueried && !o.sourceFailed && o.sourceState !== 'unavailable' && o.sourceState !== 'error');

/** An open hypothesis the scripted planner still wants evidence on (it reads the state; it does not peek at the validator's `informative` flag). */
function wanted(i: PlannerInput, o: PlannerOption) {
  return o.tests.some((id) => {
    const h = i.hypotheses.find((x) => x.id === id);
    return !!h && h.status !== 'ruled_out' && h.strength !== h.ceiling && h.strength !== 'strong';
  });
}

/**
 * How a scripted planner recognises an option — by role, source and metric, as a model reads them.
 * The Sample workspace's sources are 'jira' (issues and releases), 'ga4' (analytics) and the two
 * app stores; the doubles are written against that fixture.
 */
type Want = 'stability' | 'work_items' | 'feedback:app_store' | 'feedback:google_play' | 'traffic' | 'metric' | 'changes';
function want(o: PlannerOption): Want {
  if (o.tool === 'getChanges') return 'changes';
  if (o.tool === 'getWorkItems') return 'work_items';
  if (o.tool === 'getFeedback') return o.source === 'app_store' ? 'feedback:app_store' : 'feedback:google_play';
  if (o.metric?.startsWith('crash_free_sessions')) return 'stability';
  if (o.metric === 'sessions') return 'traffic';
  return 'metric';
}
const find = (i: PlannerInput, w: Want, fresh = true) => i.options.find((o) => want(o) === w && (!fresh || !o.alreadyQueried));

/**
 * A sensible planner with a different strategy from the deterministic one: establish whether users
 * are really affected (crashes, complaints, bugs) before looking at release timing.
 */
export function impactFirst(i: PlannerInput): string {
  const order: Want[] = ['stability', 'work_items', 'feedback:app_store', 'feedback:google_play', 'traffic', 'metric', 'changes'];
  const opts = reachable(i)
    .filter((o) => wanted(i, o))
    .sort((a, b) => order.indexOf(want(a)) - order.indexOf(want(b)));
  const o = opts[0] ?? reachable(i)[0] ?? i.options[0];
  return plan(o);
}

export const PLANNER_DOUBLES = {
  impactFirst: scripted('impact first', impactFirst),
  alwaysUnavailableJira: scripted('insists on Jira', (i) => plan(find(i, 'work_items', false) ?? { id: 'getWorkItems', tests: ['HYP-02'], question: 'Are people reporting bugs in Jira?' })),
  hallucinated: scripted('hallucinates a tool', () => JSON.stringify({ nextTool: 'getDatadogErrors', reason: 'Server errors would show whether checkout requests are failing.', evidenceGap: 'Server-side errors', hypothesesAffected: ['HYP-02'], expectedEvidence: 'Error rate on the checkout endpoint.' })),
  repeatsJiraIssues: scripted('repeats Jira issues', () => JSON.stringify({ nextTool: 'getWorkItems', reason: 'Engineering reports would test whether this is a real product issue.', evidenceGap: 'Recent checkout defects', hypothesesAffected: ['HYP-02'], expectedEvidence: 'Checkout bugs or incidents.' })),
  /**
   * Release-first; once release-related has reached its evidence ceiling it keeps asking for more
   * corroboration of explanations that are already settled — while real gaps are still open.
   */
  releaseObsessed: scripted('chases settled explanations', (i) => {
    const rel = i.hypotheses.find((h) => h.id === 'HYP-01');
    if (rel?.status === 'untested' && find(i, 'changes')) return plan(find(i, 'changes')!);
    if (rel && rel.strength === rel.ceiling) {
      // Anything unqueried whose every hypothesis is already at its ceiling or ruled out.
      const settled = (id: string) => {
        const h = i.hypotheses.find((x) => x.id === id);
        return !h || h.status === 'ruled_out' || h.strength === h.ceiling;
      };
      const chase = reachable(i).find((o) => o.tests.length > 0 && o.tests.every(settled));
      if (chase) return plan(chase);
    }
    return impactFirst(i);
  }),
  proposesRollback: scripted('proposes an action', () => JSON.stringify({ nextTool: 'rollback_release', reason: 'Rolling back 4.8.1 would limit exposure while the team looks into the drop.', evidenceGap: 'None — act now', hypothesesAffected: ['HYP-01'], expectedEvidence: 'Checkout conversion recovers.' })),
  malformed: scripted('malformed JSON', () => '{"nextTool": "getWorkItems", "reason": "Engineering evid'),
  empty: scripted('empty response', () => ''),
  timeout: scripted('never answers', () => new Promise<string>(() => {})),
  causal: scripted('claims causation', (i) => plan(reachable(i).find((o) => wanted(i, o)) ?? i.options[0], { reason: 'Release 4.8.1 caused the checkout drop, so its engineering issues will confirm it.' })),
  invalidHypothesis: scripted('cites unknown hypotheses', (i) => plan(reachable(i).find((o) => wanted(i, o)) ?? i.options[0], { hypothesesAffected: ['HYP-99'] })),
  extendsBudget: scripted('tries to raise the budget', (i) => plan(reachable(i).find((o) => wanted(i, o)) ?? i.options[0], { budget: 20 })),
  repeatsTraffic: scripted('repeats a queried tool', (i) => (find(i, 'traffic', false) ? plan(find(i, 'traffic', false)!) : impactFirst(i))),
};

export type PlannerDoubleName = keyof typeof PLANNER_DOUBLES;
