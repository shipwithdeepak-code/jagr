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
      if (status.publicStatus === 'quiet') return 'No meaningful change';
      if (status.result.disposition === 'checked' && status.result.classification === 'findings') return status.result.coverage === 'complete' ? 'Change detected' : 'Change detected — evidence coverage incomplete or unknown';
      return 'Completed — evidence incomplete or unknown';
  }
}
