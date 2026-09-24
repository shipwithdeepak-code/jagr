import { describe, expect, it } from 'vitest';
import { defaultSettings } from '@/domain/defaults';
import { EVALUATION_SCENARIOS, evaluateScenario, runEvaluationSuite } from './scenarios';

describe('evaluation suite', () => {
  for (const def of EVALUATION_SCENARIOS) {
    it(`Scenario ${def.number} — ${def.name}`, async () => {
      const { result } = await evaluateScenario(def, defaultSettings());
      const failed = result.checks.filter((c) => !c.passed);
      expect(failed, JSON.stringify(failed)).toEqual([]);
      expect(result.falseAlerts).toBe(0);
      expect(result.approvalViolations).toBe(0);
      expect(result.passed).toBe(true);
    });
  }

  it('reports totals with zero false alerts, missed issues and approval violations', async () => {
    const report = await runEvaluationSuite(defaultSettings());
    expect(report.totals).toEqual({ scenarios: 7, passed: 7, failed: 0, falseAlerts: 0, missedIssues: 0, approvalViolations: 0 });
  });

  it('detects a regression in agent behaviour when the policy is weakened', async () => {
    const s = defaultSettings();
    s.autonomy.createTasks = false;
    const { result } = await evaluateScenario(EVALUATION_SCENARIOS[0], s);
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.label === 'Create task')?.passed).toBe(false);
  });
});
