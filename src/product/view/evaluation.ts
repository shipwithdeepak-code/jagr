import type { MonitoringResult, SourceConnection, WatchInvestigation } from '../types.js';
import { defaultBriefSchedule } from '../catalog.js';
import { defaultConnections } from '../integrations/adapters.js';
import { runMonitoring } from '../engine/monitor.js';
import { evalStatus, type AdversarialReport, type Dimension, type EvalStatus } from '../evaluation/adversarial.js';
import { GOLDEN_CASES, metricMeetsTarget, type Check, type GoldenReport, type Metric } from '../evaluation/golden.js';
import { ADVERSARIAL_CASES } from '../evaluation/adversarial.js';

/**
 * The Evaluation Lab's view of the existing suites. Nothing is scored here: every number is a count
 * the evaluators produced ("11 of 11 checks", "0 of 3 emails were not warranted"). Dimensions group
 * those measurements under the questions a PM asks; mixed units are never summed into one figure.
 */

export type LabDimensionKey = 'grounding' | 'causality' | 'detection' | 'attention' | 'dedupe' | 'tool_selection' | 'approval';

export const LAB_DIMENSION_LABEL: Record<LabDimensionKey, string> = {
  grounding: 'Evidence grounding',
  causality: 'Causality restraint',
  detection: 'Detection',
  attention: 'Attention assessment',
  dedupe: 'Deduplication',
  tool_selection: 'Tool selection',
  approval: 'Approval enforcement',
};

const ADVERSARIAL_DIMS: Record<LabDimensionKey, Dimension[]> = {
  grounding: ['grounding'],
  causality: ['causality', 'uncertainty'],
  detection: [],
  attention: ['severity', 'false_interruption'],
  dedupe: ['dedupe'],
  tool_selection: ['tool_selection', 'stopping'],
  approval: ['approval'],
};

const GOLDEN_METRICS: Record<LabDimensionKey, string[]> = {
  grounding: ['grounding', 'deep_links'],
  causality: ['overclaim'],
  detection: ['precision', 'recall', 'correlation'],
  attention: ['severity', 'false_interruption_rate'],
  dedupe: ['dedupe'],
  tool_selection: [],
  approval: [],
};

export interface LabMeasurement {
  suite: 'golden' | 'adversarial';
  label: string;
  /** In the evaluator's own words, e.g. "11 of 11 checks pass", "0 of 3 emails were not warranted". */
  text: string;
  ok: boolean;
  /** Failures that sit in documented-limitation cases, kept failing on purpose. */
  limitation?: boolean;
}

export type LabStatus = 'holding' | 'limitation' | 'regression' | 'pending';

export interface LabDimension {
  key: LabDimensionKey;
  label: string;
  status: LabStatus;
  measurements: LabMeasurement[];
}

export function labDimensions(golden: GoldenReport | null, adversarial: AdversarialReport | null): LabDimension[] {
  return (Object.keys(LAB_DIMENSION_LABEL) as LabDimensionKey[]).map((key) => {
    const measurements: LabMeasurement[] = [];
    for (const m of golden?.metrics.filter((x) => GOLDEN_METRICS[key].includes(x.key)) ?? []) {
      measurements.push({ suite: 'golden', label: m.label, text: goldenText(m), ok: metricMeetsTarget(m) });
    }
    for (const dim of ADVERSARIAL_DIMS[key]) {
      if (!adversarial) continue;
      const checks = adversarial.results.flatMap((r) => r.checks.filter((c) => c.dimension === dim).map((c) => ({ c, known: !!r.knownFailure })));
      if (!checks.length) continue;
      const failed = checks.filter((x) => !x.c.passed);
      const onlyKnown = failed.length > 0 && failed.every((x) => x.known);
      measurements.push({
        suite: 'adversarial',
        label: ADVERSARIAL_LABEL[dim],
        text: `${checks.length - failed.length} of ${checks.length} checks pass${onlyKnown ? ` — ${failed.length} in documented limitation${failed.length === 1 ? '' : 's'}` : ''}`,
        ok: failed.length === 0,
        limitation: onlyKnown,
      });
    }
    const pending = !golden || (ADVERSARIAL_DIMS[key].length > 0 && !adversarial);
    const status: LabStatus = pending && !measurements.length ? 'pending' : measurements.some((m) => !m.ok && !m.limitation) ? 'regression' : measurements.some((m) => m.limitation) ? 'limitation' : 'holding';
    return { key, label: LAB_DIMENSION_LABEL[key], status, measurements };
  });
}

const ADVERSARIAL_LABEL: Record<Dimension, string> = {
  causality: 'No causal overclaim',
  grounding: 'Grounded evidence',
  false_interruption: 'No false interruption',
  tool_selection: 'Tool selection',
  stopping: 'Stopping behaviour',
  uncertainty: 'Uncertainty stated',
  dedupe: 'Deduplication',
  severity: 'Severity',
  approval: 'Approval gates',
};

/** The metric's own "x of y" detail, plus its target — the value is never re-expressed as a score. */
function goldenText(m: Metric): string {
  return `${m.detail} (target: ${m.higherIsBetter ? 'all' : 'none'})`;
}

// ─────────────────────────────────────────────────────────────
// Scenarios
// ─────────────────────────────────────────────────────────────

export interface LabScenario {
  id: string;
  suite: 'golden' | 'adversarial';
  title: string;
  scenario: string;
  expected: string;
  actual: string;
  status: EvalStatus | 'pending';
  checks: Check[];
  knownFailure?: string;
  /** The investigation to show as the relevant trace, when the run is at hand (golden cases). */
  trace?: WatchInvestigation;
  /** Connection states for that run, so the trace's source tags stay honest. */
  connections?: SourceConnection[];
  /** Adversarial runs are not retained; the trace can be reproduced on demand (deterministic). */
  reproducible: boolean;
}

/** What the engine actually did, in one line: investigations opened (attention · area · status) and emails. */
export function actualOf(r: MonitoringResult): string {
  const live = r.investigations.filter((i) => i.status !== 'DISMISSED');
  const dismissed = r.investigations.length - live.length;
  const emails = r.emails.filter((e) => e.kind === 'alert').length;
  const parts = live.length ? live.map((i) => `${i.attention} ${i.area} investigation (${i.status.toLowerCase()})`) : ['No investigation opened'];
  if (dismissed) parts.push(`${dismissed} dismissed as a fluctuation`);
  parts.push(emails ? `${emails} email${emails === 1 ? '' : 's'}` : 'no email');
  return parts.join(' · ');
}

const leadInvestigation = (r: MonitoringResult) => {
  const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  return [...r.investigations].filter((i) => i.status !== 'DISMISSED').sort((a, b) => order.indexOf(a.attention) - order.indexOf(b.attention))[0] ?? r.investigations[0];
};

export function labScenarios(golden: GoldenReport | null, adversarial: AdversarialReport | null): LabScenario[] {
  const g: LabScenario[] = GOLDEN_CASES.map((gc) => {
    const res = golden?.cases.find((c) => c.id === gc.id);
    return {
      id: gc.id,
      suite: 'golden',
      title: gc.title,
      scenario: gc.scenario,
      expected: gc.expected,
      actual: res ? actualOf(res.result) : '',
      status: res ? evalStatus(res) : 'pending',
      checks: res?.checks ?? [],
      trace: res ? leadInvestigation(res.result) : undefined,
      connections: res?.result.connections,
      reproducible: false,
    };
  });
  const a: LabScenario[] = ADVERSARIAL_CASES.map((c) => {
    const res = adversarial?.results.find((x) => x.id === c.id);
    const own = res?.checks ?? [];
    const failed = own.find((k) => !k.passed);
    return {
      id: c.id,
      suite: 'adversarial',
      title: c.title,
      scenario: `Trap: ${c.trap}`,
      expected: own.length ? own.slice(0, 2).map((k) => k.label).join(' · ') : 'Avoid the trap',
      actual: res ? (failed ?? own[0])?.detail ?? '' : '',
      status: res ? evalStatus(res) : 'pending',
      checks: own,
      knownFailure: c.knownFailure,
      reproducible: true,
    };
  });
  return [...g, ...a];
}

/**
 * The suite does not retain adversarial runs. Reproducing one re-runs that case's fixture night
 * through the engine — deterministic, and the same run the suite made — to show its trace.
 */
export async function reproduceAdversarialCase(id: string): Promise<{ investigation?: WatchInvestigation; connections: SourceConnection[] }> {
  const c = ADVERSARIAL_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown adversarial case ${id}`);
  const connections = c.connections ? c.connections(defaultConnections()) : defaultConnections();
  const r = await runMonitoring({ world: c.world(), watches: c.watches(), connections, brief: defaultBriefSchedule() });
  return { investigation: r.investigations.length ? leadInvestigation(r) : undefined, connections };
}
