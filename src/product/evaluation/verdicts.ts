import type { MonitoringResult, WatchInvestigation } from '../types';
import { defaultBriefSchedule, defaultWatches } from '../catalog';
import { defaultConnections } from '../integrations/adapters';
import { defaultWorld } from '../integrations/world';
import { runMonitoring } from '../engine/monitor';
import { createModelPlanner } from '../agent/planner';
import { runGoldenSuite } from './golden';
import { runAdversarialSuite } from './adversarial';
import { runPlannerSuite } from './plannerEval';
import { PLANNER_DOUBLES } from './plannerDoubles';

/**
 * Verdict fingerprint — a regression lock for refactors that must not change behaviour.
 *
 * It records what the evaluation suites decided (every check's pass/fail) and what each
 * investigation concluded (status, attention, confidence, hypotheses, which sources were consulted,
 * how many calls it took, actions by risk). It deliberately leaves out names that a refactor is
 * allowed to change (tool names, action kind names, evidence ids, free text beyond the title), so a
 * difference here means a *verdict* changed, not a label.
 */

/** Action kinds, canonicalised so a rename is not a verdict change. */
const ACTION_CANON: Record<string, string> = {
  link_work_items: 'link_issues',
  create_work_item: 'create_jira_task',
  create_incident: 'create_jira_incident',
};

function investigation(i: WatchInvestigation) {
  return {
    area: i.area,
    title: i.title,
    status: i.status,
    attention: i.attention,
    confidence: i.confidence,
    correlated: [...i.correlatedProviders].sort(),
    release: i.releaseAssociation ? `${i.releaseAssociation.version}@${i.releaseAssociation.minutesBeforeOnset}` : null,
    hypotheses: i.agentHypotheses.map((h) => `${h.kind}:${h.status}:${h.strength}`),
    evidence: i.evidence.map((e) => `${e.provider}:${e.direction}`).sort(),
    // Investigation calls in order; pre-action rollout checks are independent reads, compared as a set.
    consulted: [
      ...i.trace.filter((s) => s.kind === 'tool_call' && !s.why?.startsWith('Before recommending')).map((s) => `${s.pass}:${s.sources ? s.sources.join('+') : s.source}`),
      ...i.trace.filter((s) => s.kind === 'tool_call' && s.why?.startsWith('Before recommending')).map((s) => `rollout-check ${s.pass}:${s.source}`).sort(),
    ],
    toolCalls: i.toolCalls,
    actions: i.actions.map((a) => `${ACTION_CANON[a.kind] ?? a.kind}:${a.risk}:${a.status}`).sort(),
    notified: i.notifiedLevels,
  };
}

export function resultFingerprint(r: MonitoringResult) {
  return {
    investigations: r.investigations.map(investigation),
    emails: r.emails.map((e) => `${e.kind}:${e.attention ?? ''}:${e.subject}`),
    briefs: r.briefs.map((b) => b.items.map((x) => `${x.attention}:${x.status}`)),
  };
}

type Checks = { label: string; passed: boolean }[];
const checks = (cs: Checks) => cs.map((c) => `${c.passed ? 'PASS' : 'FAIL'} ${c.label}`);

export async function verdictFingerprint() {
  const golden = await runGoldenSuite();
  const adversarial = await runAdversarialSuite();
  const adversarialModel = await runAdversarialSuite({ planner: () => createModelPlanner(PLANNER_DOUBLES.impactFirst) });
  const planner = await runPlannerSuite();
  const sample = await runMonitoring({ world: defaultWorld(), watches: defaultWatches(), connections: defaultConnections(), brief: defaultBriefSchedule() });
  return {
    golden: golden.cases.map((c) => ({ id: c.id, passed: c.passed, checks: checks(c.checks), result: resultFingerprint(c.result) })),
    goldenMetrics: golden.metrics.map((m) => `${m.key}=${m.value}`),
    adversarial: adversarial.results.map((r) => ({ id: r.id, passed: r.passed, knownFailure: !!r.knownFailure, checks: checks(r.checks) })),
    adversarialModelPlanned: adversarialModel.results.map((r) => ({ id: r.id, passed: r.passed, checks: checks(r.checks) })),
    planner: planner.results.map((r) => ({ id: r.id, passed: r.passed, knownFailure: !!r.knownFailure, checks: checks(r.checks) })),
    sample: resultFingerprint(sample),
  };
}
