import { describe, expect, it, vi } from 'vitest';
import type { MetricEvaluationSummary, SchedulerLogEntry, Watch } from '@/product/types';
import type { ConnectionView } from '@/product/connections/model';
import type { ManualExecutionStatus } from '@/product/app/executionStatus';
import { effectiveMetricThreshold, metricDiagnosticText, ruleText, runCreatedWatch, runMetrics, runOutcomeText } from './Watches';

describe('onboarding-originated watch run', () => {
  it('returns only after monitoring succeeds', async () => {
    const returned = vi.fn();
    await runCreatedWatch(async () => undefined, returned);
    expect(returned).toHaveBeenCalledOnce();
  });

  it('does not return when monitoring fails', async () => {
    const returned = vi.fn();
    await expect(runCreatedWatch(async () => { throw new Error('run failed'); }, returned)).rejects.toThrow('run failed');
    expect(returned).not.toHaveBeenCalled();
  });
});

const watch = { sources: ['amplitude'] } as Pick<Watch, 'sources' | 'thresholds'>;
const amplitude = {
  id: 'conn-amplitude', provider: 'amplitude', source: 'amplitude', displayName: 'Amplitude', kind: 'source', status: 'connected', health: 'healthy', managedBy: 'workspace',
  config: { metrics: [{ kind: 'ratio', key: 'checkout_conversion', threshold: 10 }] },
} as unknown as ConnectionView;

describe('effective metric threshold rendering', () => {
  it('uses the connected Amplitude binding instead of the static sample default', () => {
    const threshold = effectiveMetricThreshold('checkout_conversion', watch, [amplitude]);
    expect(threshold).toBe(10);
    expect(ruleText('checkout_conversion', watch.thresholds, threshold)).toBe('drops more than 10% vs baseline');
  });

  it('uses a valid watch override before the connected binding', () => {
    const overridden = { ...watch, thresholds: { checkout_conversion: 12 } };
    const threshold = effectiveMetricThreshold('checkout_conversion', overridden, [amplitude]);
    expect(threshold).toBe(12);
    expect(ruleText('checkout_conversion', overridden.thresholds, threshold)).toBe('drops more than 12% vs baseline');
  });
});

const metric = (patch: Partial<MetricEvaluationSummary> = {}): MetricEvaluationSummary => ({
  source: 'amplitude', metricKey: 'checkout_conversion', metricName: 'Checkout conversion', coverage: 'complete',
  currentPointCount: 4, baselinePointCount: 5, currentValue: 55, baselineValue: 80, threshold: 10,
  relativeDecline: 31.25, zScore: 31.25, persistencePassed: false, finalDecision: 'normal', inconclusiveReason: null,
  ...patch,
});
const entry = (metrics: MetricEvaluationSummary[] = [metric()]): SchedulerLogEntry => ({
  jobId: 'run:watch:2026-10-05T04:52:32.704Z', type: 'watch_run', watchId: 'watch', scheduledAt: '2026-10-05T04:52:32.704Z',
  outcome: 'No meaningful change detected.', investigationIds: [], emailIds: [],
  check: { findings: false, classification: 'no_meaningful_change', coverage: 'unknown', sourceFailures: [], metrics },
});

describe('watch run diagnostics', () => {
  it('displays the persisted z-score and persistence result', () => {
    const text = metricDiagnosticText(metric());
    expect(text).toContain('z-score 31.25');
    expect(text).toContain('persistence not met');
  });

  it('renders historical diagnostics safely when gate fields are absent', () => {
    const historical = { ...metric(), zScore: undefined, persistencePassed: undefined } as unknown as MetricEvaluationSummary;
    expect(() => metricDiagnosticText(historical)).not.toThrow();
    expect(metricDiagnosticText(historical)).not.toMatch(/z-score|persistence/);
  });

  it('replaces the quiet wording only when a persisted anomaly gate failed', () => {
    expect(runOutcomeText(entry().outcome, [metric()])).toBe('Change observed, but anomaly gates were not fully satisfied. persistence gate not met.');
    expect(runOutcomeText(entry().outcome, [metric({ persistencePassed: true })])).toBe('No meaningful change detected.');
  });

  it('prefers matching authenticated receipt diagnostics and falls back to run history', () => {
    const receiptMetric = metric({ zScore: 2.5, persistencePassed: true });
    const status = {
      watchId: 'watch', execution: { requestedAt: entry().scheduledAt },
      result: { disposition: 'checked', metrics: [receiptMetric] },
    } as unknown as ManualExecutionStatus;
    expect(runMetrics(entry(), { key: status })).toEqual([receiptMetric]);
    expect(runMetrics(entry())).toEqual(entry().check!.metrics);
  });
});
