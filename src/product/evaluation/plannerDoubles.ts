import type { PlannerClient, PlannerInput, PlannerOption } from '../agent/planner';

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
 * A sensible planner with a different strategy from the deterministic one: establish whether users
 * are really affected (crashes, complaints, bugs) before looking at release timing.
 */
export function impactFirst(i: PlannerInput): string {
  const order = ['getStoreCrashRate', 'getRecentJiraIssues', 'getAppStoreReviews', 'getPlayStoreReviews', 'getAnalyticsTraffic', 'getAnalyticsMetric', 'getJiraRelease', 'getStoreReleases'];
  const opts = reachable(i)
    .filter((o) => wanted(i, o))
    .sort((a, b) => order.indexOf(a.tool) - order.indexOf(b.tool));
  const o = opts[0] ?? reachable(i)[0] ?? i.options[0];
  return plan(o);
}

export const PLANNER_DOUBLES = {
  impactFirst: scripted('impact first', impactFirst),
  alwaysUnavailableJira: scripted('insists on Jira', (i) => plan(i.options.find((o) => o.tool === 'getJiraRelease') ?? { id: 'getJiraRelease', tests: ['HYP-01'], question: 'Was anything released?' })),
  hallucinated: scripted('hallucinates a tool', () => JSON.stringify({ nextTool: 'getDatadogErrors', reason: 'Server errors would show whether checkout requests are failing.', evidenceGap: 'Server-side errors', hypothesesAffected: ['HYP-02'], expectedEvidence: 'Error rate on the checkout endpoint.' })),
  repeatsJiraIssues: scripted('repeats Jira issues', () => JSON.stringify({ nextTool: 'getRecentJiraIssues', reason: 'Engineering reports would test whether this is a real product issue.', evidenceGap: 'Recent checkout defects', hypothesesAffected: ['HYP-02'], expectedEvidence: 'Checkout bugs or incidents.' })),
  /**
   * Release-first, then keeps chasing release corroboration after release-related has hit its
   * ceiling — while real gaps (impact, demand) are still open.
   */
  releaseObsessed: scripted('chases release timing', (i) => {
    const rel = i.hypotheses.find((h) => h.id === 'HYP-01');
    const opt = (tool: string) => i.options.find((o) => o.tool === tool && !o.alreadyQueried);
    if (rel?.status === 'untested' && opt('getJiraRelease')) return plan(opt('getJiraRelease')!);
    if (rel && rel.strength !== rel.ceiling && opt('getRecentJiraIssues')) return plan(opt('getRecentJiraIssues')!);
    if (rel && rel.strength === rel.ceiling && opt('getStoreReleases')) return plan(opt('getStoreReleases')!);
    return impactFirst(i);
  }),
  proposesRollback: scripted('proposes an action', () => JSON.stringify({ nextTool: 'rollback_release', reason: 'Rolling back 4.8.1 would limit exposure while the team looks into the drop.', evidenceGap: 'None — act now', hypothesesAffected: ['HYP-01'], expectedEvidence: 'Checkout conversion recovers.' })),
  malformed: scripted('malformed JSON', () => '{"nextTool": "getRecentJiraIssues", "reason": "Engineering evid'),
  empty: scripted('empty response', () => ''),
  timeout: scripted('never answers', () => new Promise<string>(() => {})),
  causal: scripted('claims causation', (i) => plan(reachable(i).find((o) => wanted(i, o)) ?? i.options[0], { reason: 'Release 4.8.1 caused the checkout drop, so its engineering issues will confirm it.' })),
  invalidHypothesis: scripted('cites unknown hypotheses', (i) => plan(reachable(i).find((o) => wanted(i, o)) ?? i.options[0], { hypothesesAffected: ['HYP-99'] })),
  extendsBudget: scripted('tries to raise the budget', (i) => plan(reachable(i).find((o) => wanted(i, o)) ?? i.options[0], { budget: 20 })),
  repeatsTraffic: scripted('repeats a queried tool', (i) => (i.options.some((o) => o.tool === 'getAnalyticsTraffic') ? plan(i.options.find((o) => o.tool === 'getAnalyticsTraffic')!) : impactFirst(i))),
};

export type PlannerDoubleName = keyof typeof PLANNER_DOUBLES;
