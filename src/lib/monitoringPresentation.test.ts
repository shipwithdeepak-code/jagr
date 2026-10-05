import { expect, it } from 'vitest';
import type { SchedulerLogEntry, MetricEvaluationSummary } from '@/product/types';
import { watchFromTemplate } from '@/product/catalog';
import { checkResultText, requestedCheckText, watchDelayText } from './monitoringPresentation';
import { executionStatus } from '@/product/app/executionStatus';
const metric: MetricEvaluationSummary = { source: 'amplitude', metricKey: 'checkout_conversion', metricName: 'Checkout conversion', coverage: 'complete', currentPointCount: 4, baselinePointCount: 5, currentValue: 55, baselineValue: 80, relativeDecline: 31.25, threshold: 10, zScore: 1.25, persistencePassed: true, finalDecision: 'normal', inconclusiveReason: null };
const check: NonNullable<SchedulerLogEntry['check']> = { findings: false, classification: 'no_meaningful_change', coverage: 'unknown', sourceFailures: [], metrics: [metric] };
it('never describes a material decline failing a gate as no change', () => {
  expect(checkResultText(check)).toContain('Change observed');
  expect(checkResultText({ ...check, metrics: [{ ...metric, zScore: 4, persistencePassed: false }] })).toContain('Change observed');
});
it('distinguishes normal, inconclusive, unavailable, anomaly, and historical unknown', () => {
  expect(checkResultText({ ...check, metrics: [{ ...metric, relativeDecline: 2 }] })).toBe('No important change detected.');
  expect(checkResultText({ ...check, classification: 'inconclusive' })).toContain('Not enough evidence');
  expect(checkResultText({ ...check, sourceFailures: ['amplitude'] })).toContain('Source unavailable');
  expect(checkResultText({ ...check, findings: true, classification: 'findings' })).toContain('review the investigation');
  expect(checkResultText({ ...check, metrics: [{ ...metric, finalDecision: 'watching' }] })).toContain('not yet confirmed');
  expect(checkResultText({ ...check, metrics: [] })).toContain('does not establish');
  expect(checkResultText(undefined)).toBe('Check result unavailable');
});
it('labels a long-queued request delayed based on stored timestamps without claiming it ran', () => {
  const at = '2026-10-05T10:00:00Z';
  const status = executionStatus({ workspaceId: 'ws', watchId: 'watch', executionKey: 'key', requestedAt: at }, { state: 'queued', attempts: 0, createdAt: at, runAt: at }, null, at);
  expect(requestedCheckText(status, '2026-10-05T10:15:00Z')).toContain('Queued');
  expect(requestedCheckText(status, '2026-10-05T10:45:00Z')).toContain('Delayed');
  expect(requestedCheckText(status, '2026-10-05T10:45:00Z')).not.toContain('Completed');
});
it('warns about missing automatic checks without claiming a scheduler failure or changing a paused watch', () => {
  const watch = watchFromTemplate('watch', 'checkout_health', {}, '2026-10-05T10:00:00Z');
  watch.schedule.frequency = '30m';
  expect(watchDelayText(watch, undefined, '2026-10-05T10:30:00Z')).toBeUndefined();
  expect(watchDelayText(watch, undefined, '2026-10-05T12:00:00Z')).toContain('may be delayed');
  expect(watchDelayText({ ...watch, status: 'paused' }, undefined, '2026-10-05T12:00:00Z')).toBeUndefined();
});
