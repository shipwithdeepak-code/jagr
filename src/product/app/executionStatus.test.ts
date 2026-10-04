import { describe, expect, it } from 'vitest';
import { captureExecutionReceipt, executionStatus } from './executionStatus';
import { createMemoryPersistence } from '../ports/memory';
import type { LeasedJob } from '../ports/jobs';

const NOW = '2026-09-25T10:00:00.000Z';
const identity = { workspaceId: 'w', watchId: 'watch', executionKey: 'key', requestedAt: NOW };
describe('execution receipt safety', () => {
  it('deduplicates per attempt in the memory adapter without overwriting a prior receipt', async () => {
    const { repos } = createMemoryPersistence();
    const job = { id: 'job', kind: 'monitor.watch', workspaceId: 'w', payload: { watchId: 'watch', dueAt: NOW }, idempotencyKey: 'key', attempts: 1, runAt: NOW, maxAttempts: 5, leaseToken: 'lease', leaseUntil: NOW } satisfies LeasedJob;
    await captureExecutionReceipt(repos, job, { disposition: 'blocked', reason: 'check_not_permitted' }, NOW);
    await captureExecutionReceipt(repos, job, { disposition: 'skipped', reason: 'watch_inactive_or_missing' }, NOW);
    await captureExecutionReceipt(repos, { ...job, attempts: 2 }, { disposition: 'skipped', reason: 'watch_inactive_or_missing' }, NOW);
    const entries = await repos.audit.list('w');
    expect(entries).toHaveLength(2);
    expect(entries[0].executionReceipt).toMatchObject({ attempt: 1, result: { disposition: 'blocked' } });
    expect(entries[1].executionReceipt).toMatchObject({ attempt: 2, result: { disposition: 'skipped' } });
  });
  it('never publishes an early receipt or mistakes absent receipts for quiet', () => {
    const result = { disposition: 'checked', classification: 'no_meaningful_change', coverage: 'complete', investigationIds: [], truncated: false } as const;
    const job = { state: 'queued', attempts: 1, createdAt: NOW, runAt: NOW } as const;
    expect(executionStatus(identity, job, { ...result, investigationIds: [] }, NOW)).toMatchObject({ publicStatus: 'queued', result: null });
    expect(executionStatus(identity, { ...job, state: 'done' }, null, NOW)).toMatchObject({ publicStatus: 'completed', resultAvailability: 'unavailable' });
  });
});
