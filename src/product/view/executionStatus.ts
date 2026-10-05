import type { ManualExecutionStatus } from '../app/executionStatus.js';

/** Execution bookkeeping says nothing about causality or external action execution. */
export function executionStatusText(status?: ManualExecutionStatus): string {
  if (!status) return 'Status unavailable';
  if (status.result?.disposition === 'blocked') return 'Check could not run — admission or entitlement did not permit this check';
  if (status.result?.disposition === 'skipped') return 'Check skipped — watch paused or removed';
  switch (status.execution.state) {
    case 'queued': return 'Queued';
    case 'running': return 'Checking';
    case 'retrying': return 'Checking — retry scheduled';
    case 'recovering': return 'Checking — awaiting worker recovery';
    case 'failed': return 'Check failed';
    case 'settled':
      if (!status.result) return 'Completed — check result unavailable';
      if (status.result.disposition === 'checked' && status.result.classification === 'findings') return 'Meaningful change detected.';
      if (status.result.disposition === 'checked' && status.result.classification === 'no_meaningful_change') return 'No meaningful change detected.';
      if (status.result.disposition === 'checked' && (status.result.sourceFailures?.length || status.result.metrics?.some((metric) => metric.finalDecision === 'source_unavailable'))) return `Jagr couldn't read this source during the check.`;
      return 'Not enough evidence to determine whether this changed.';
  }
}
