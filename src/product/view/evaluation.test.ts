import { beforeAll, describe, expect, it } from 'vitest';
import { runAdversarialSuite, type AdversarialReport } from '../evaluation/adversarial';
import { runGoldenSuite, type GoldenReport } from '../evaluation/golden';
import { labDimensions, labScenarios, LAB_DIMENSION_LABEL } from './evaluation';

let golden: GoldenReport;
let adversarial: AdversarialReport;
beforeAll(async () => {
  [golden, adversarial] = await Promise.all([runGoldenSuite(), runAdversarialSuite()]);
}, 60_000);

describe('Evaluation Lab view', () => {
  it('reports the seven dimensions, each backed by real measurements', () => {
    const dims = labDimensions(golden, adversarial);
    expect(dims.map((d) => d.label)).toEqual(Object.values(LAB_DIMENSION_LABEL));
    for (const d of dims) {
      expect(d.measurements.length).toBeGreaterThan(0);
      expect(d.status).not.toBe('pending');
    }
  });

  it('never invents a score: every measurement is the evaluator’s own count, with no percentages', () => {
    for (const m of labDimensions(golden, adversarial).flatMap((d) => d.measurements)) {
      expect(m.text).toMatch(/\d+ (correct )?of \d+/);
      expect(m.text).not.toMatch(/%/);
    }
  });

  it('documented limitations are not reported as regressions', () => {
    const dims = labDimensions(golden, adversarial);
    const knownFailing = adversarial.results.filter((r) => r.knownFailure && !r.passed);
    const regressions = adversarial.results.filter((r) => !r.passed && !r.knownFailure);
    if (!regressions.length) expect(dims.some((d) => d.status === 'regression')).toBe(false);
    if (knownFailing.length) expect(dims.some((d) => d.status === 'limitation')).toBe(true);
  });

  it('lists every golden and adversarial scenario with expected, actual and status', () => {
    const s = labScenarios(golden, adversarial);
    expect(s.length).toBe(golden.cases.length + adversarial.results.length);
    for (const x of s) {
      expect(x.expected.length).toBeGreaterThan(0);
      expect(x.actual.length).toBeGreaterThan(0);
      expect(x.status).not.toBe('pending');
    }
    for (const x of s.filter((y) => y.suite === 'golden')) expect(x.reproducible).toBe(false);
  });

  it('before the suites run, nothing is claimed', () => {
    expect(labDimensions(null, null).every((d) => d.status === 'pending' && d.measurements.length === 0)).toBe(true);
    expect(labScenarios(null, null).every((s) => s.status === 'pending' && s.actual === '')).toBe(true);
  });
});
