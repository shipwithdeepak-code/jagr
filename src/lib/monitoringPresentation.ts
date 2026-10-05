import type { SchedulerLogEntry, Watch } from '@/product/types';
import type { ExecutionResult, ManualExecutionStatus } from '@/product/app/executionStatus';
import { executionStatusText } from '@/product/view/executionStatus';

/** Stored evidence controls the wording; absence is not a healthy result. */
export function checkResultText(check: SchedulerLogEntry['check'] | Extract<ExecutionResult, { disposition: 'checked' }>, fallback = 'Check result unavailable'): string {
  if (!check) return fallback;
  if (check.sourceFailures?.length || check.metrics?.some((m) => m.finalDecision === 'source_unavailable')) return "Source unavailable — Jagr couldn't complete every required check.";
  if (check.classification === 'inconclusive' || check.metrics?.some((m) => m.finalDecision === 'inconclusive')) return 'Not enough evidence to determine whether this changed.';
  if (check.classification === 'findings') return 'Important change detected — review the investigation.';
  if (check.metrics?.some((m) => m.finalDecision === 'watching')) return 'Possible change observed — not yet confirmed.';
  if (check.metrics?.some((m) => m.finalDecision === 'normal' && m.relativeDecline !== null && m.threshold !== null && m.relativeDecline >= m.threshold && (m.persistencePassed === false || (typeof m.zScore === 'number' && m.zScore < 3)))) return 'Change observed, but anomaly gates were not fully satisfied.';
  if (check.classification === 'no_meaningful_change' && (check.coverage === 'complete' || (!!check.metrics?.length && check.metrics.every((m) => m.coverage === 'complete')))) return 'No important change detected.';
  return 'Check completed — available history does not establish a complete result.';
}

export function requestedCheckText(status?: ManualExecutionStatus, asOf?: string): string {
  if (!status) return 'Requested — waiting for status';
  if (status.execution.state === 'retrying' || status.execution.state === 'recovering') return 'Delayed — Jagr will try again automatically';
  if (status.execution.state === 'queued') {
    if (asOf && Date.parse(asOf) - Date.parse(status.execution.createdAt) > 30 * 60_000) return 'Delayed — this request has waited more than 30 minutes and has not started yet.';
    return 'Queued — waiting to check';
  }
  if (status.execution.state === 'settled' && status.result?.disposition === 'checked') {
    return 'Completed · ' + checkResultText(status.result);
  }
  return executionStatusText(status);
}

export function watchDelayText(watch: Watch, lastRun: SchedulerLogEntry | undefined, snapshotAt: string): string | undefined {
  if (watch.status !== 'active') return undefined;
  const interval = { '15m': 15, '30m': 30, '1h': 60, '4h': 240, daily: 1440 }[watch.schedule.frequency] * 60_000;
  const elapsed = Date.parse(snapshotAt) - Date.parse(lastRun?.scheduledAt ?? watch.createdAt);
  if (elapsed > interval * 2) return 'No recent check recorded — automatic checks may be delayed. The next scheduled time is an expectation, not confirmation that a check has run.';
}
