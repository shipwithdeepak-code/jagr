import { beforeAll, describe, expect, it } from 'vitest';
import { GOLDEN_CASES, metricMeetsTarget, runGoldenSuite, type GoldenReport } from './evaluation/golden';

let report: GoldenReport;
beforeAll(async () => {
  report = await runGoldenSuite();
});

describe('golden evaluation set', () => {
  for (const gc of GOLDEN_CASES) {
    it(`${gc.id} — ${gc.title}`, () => {
      const cr = report.cases.find((c) => c.id === gc.id)!;
      const failed = cr.checks.filter((c) => !c.passed);
      expect(failed, JSON.stringify(failed)).toEqual([]);
    });
  }

  it('single-source anomaly (EVAL-005) is less confident than three-source degradation (EVAL-006)', () => {
    const conf = (id: string, area: string) => report.cases.find((c) => c.id === id)!.result.investigations.find((i) => i.area === area)!.confidence;
    expect(conf('EVAL-005', 'signup')).toBeLessThan(conf('EVAL-006', 'checkout'));
    expect(conf('EVAL-008', 'checkout')).toBeLessThan(conf('EVAL-006', 'checkout'));
  });

  it('meets every product metric target', () => {
    const missed = report.metrics.filter((m) => !metricMeetsTarget(m));
    expect(missed, JSON.stringify(missed)).toEqual([]);
    expect(report.metrics.find((m) => m.key === 'false_interruption_rate')!.value).toBe(0);
    expect(report.metrics.find((m) => m.key === 'overclaim')!.value).toBe(0);
  });
});
