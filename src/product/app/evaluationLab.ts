import type { ISO } from '../types';
import { runGoldenSuite } from '../evaluation/golden';
import { runAdversarialSuite } from '../evaluation/adversarial';
import { runPlannerSuite, type PlannerCaseResult } from '../evaluation/plannerEval';
import { labDimensions, labScenarios, type LabDimension, type LabScenario } from '../view/evaluation';

/**
 * The Evaluation Lab as product data: the existing golden and adversarial suites, run through the
 * real engine on their deterministic fixture nights (no network, no AI provider), reported as counts
 * and checks — the same builders the Evaluation Lab page uses. Nothing is scored or summed across
 * units, and no reasoning text or trace is exposed: only structured results.
 */

export const SCENARIO_KINDS = {
  conversion_drop_after_release: 'Conversion drop after a release',
  noise_deviation: 'Small or noise deviation',
  source_unavailable: 'Source unavailable',
  duplicate_incident: 'Duplicate incident',
  customer_evidence_only: 'Customer evidence only',
  planned_release_only: 'Planned release only',
  unsupported_causality: 'Causality the evidence does not support',
  multiple_corroborating_sources: 'Multiple corroborating sources',
  approval_enforcement: 'Approval enforcement',
} as const;
export type ScenarioKind = keyof typeof SCENARIO_KINDS;

/** Which cases exercise which product scenario. A case can cover several. */
export const SCENARIO_KIND_OF: Record<string, ScenarioKind[]> = {
  'EVAL-001': ['conversion_drop_after_release'],
  'EVAL-002': ['noise_deviation'],
  'EVAL-003': ['planned_release_only'],
  'EVAL-004': ['customer_evidence_only'],
  'EVAL-005': ['unsupported_causality'],
  'EVAL-006': ['multiple_corroborating_sources'],
  'EVAL-007': ['duplicate_incident'],
  'EVAL-008': ['source_unavailable'],
  'EVAL-009': ['noise_deviation'],
  'EVAL-010': ['multiple_corroborating_sources'],
  'ADV-01': ['conversion_drop_after_release'],
  'ADV-03': ['unsupported_causality'],
  'ADV-04': ['noise_deviation'],
  'ADV-05': ['source_unavailable'],
  'ADV-06': ['source_unavailable'],
  'ADV-07': ['unsupported_causality'],
  'ADV-08': ['duplicate_incident'],
  'ADV-09': ['unsupported_causality'],
  'ADV-10': ['noise_deviation'],
  'ADV-11': ['customer_evidence_only'],
  'ADV-13': ['duplicate_incident'],
  'ADV-14': ['approval_enforcement'],
  'ADV-15': ['approval_enforcement'],
  'ADV-16': ['unsupported_causality'],
};

export type LabScenarioResult = Omit<LabScenario, 'trace' | 'connections'> & { kinds: ScenarioKind[] };

export interface EvaluationLabReport {
  generatedAt: ISO;
  /** Deterministic planner on fixture nights: reproducible, no provider or model calls. */
  engine: { planner: 'deterministic'; data: 'fixtures' };
  suites: { golden: { passed: number; total: number }; adversarial: { passed: number; total: number }; planner: { passed: number; total: number } };
  /** Planner-attack cases: scripted planners that try to break policy; the validator must hold. */
  plannerCases: Omit<PlannerCaseResult, 'plannerLabel'>[];
  dimensions: LabDimension[];
  scenarios: LabScenarioResult[];
  /** Each product scenario, the cases covering it, and whether they hold. */
  coverage: { kind: ScenarioKind; label: string; cases: string[]; status: 'holding' | 'limitation' | 'regression' }[];
}

export async function evaluationLab(generatedAt: ISO): Promise<EvaluationLabReport> {
  const [golden, adversarial, planner] = await Promise.all([runGoldenSuite(), runAdversarialSuite(), runPlannerSuite()]);
  const scenarios: LabScenarioResult[] = labScenarios(golden, adversarial).map(({ trace: _t, connections: _c, ...s }) => (void _t, void _c, { ...s, kinds: SCENARIO_KIND_OF[s.id] ?? [] }));
  const coverage = (Object.keys(SCENARIO_KINDS) as ScenarioKind[]).map((kind) => {
    const cases = scenarios.filter((s) => s.kinds.includes(kind));
    const status: 'holding' | 'limitation' | 'regression' = cases.some((c) => c.status === 'REGRESSION') ? 'regression' : cases.some((c) => c.status === 'INTENTIONAL_FAILURE') ? 'limitation' : 'holding';
    return { kind, label: SCENARIO_KINDS[kind], cases: cases.map((c) => c.id), status };
  });
  return {
    generatedAt,
    engine: { planner: 'deterministic', data: 'fixtures' },
    suites: { golden: { passed: golden.passed, total: golden.passed + golden.failed }, adversarial: { passed: adversarial.passed, total: adversarial.passed + adversarial.failed }, planner: { passed: planner.passed, total: planner.results.length } },
    plannerCases: planner.results.map(({ plannerLabel: _l, ...c }) => (void _l, c)),
    dimensions: labDimensions(golden, adversarial),
    scenarios,
    coverage,
  };
}
