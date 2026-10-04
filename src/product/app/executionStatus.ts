import { z } from 'zod';
import type { JobStatus, LeasedJob } from '../ports/jobs.js';
import type { Repositories } from '../ports/persistence.js';

const Checked = z.object({ disposition: z.literal('checked'), classification: z.enum(['findings', 'no_meaningful_change', 'inconclusive']), coverage: z.enum(['complete', 'incomplete', 'unknown']), investigationIds: z.array(z.string().min(1)).max(100), truncated: z.boolean() }).strict();
const Skipped = z.object({ disposition: z.literal('skipped'), reason: z.literal('watch_inactive_or_missing') }).strict();
const Blocked = z.object({ disposition: z.literal('blocked'), reason: z.literal('check_not_permitted') }).strict();
export const ExecutionResultSchema = z.discriminatedUnion('disposition', [Checked, Skipped, Blocked]);
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;
export const ExecutionReceiptSchema = z.object({ version: z.literal(1), jobId: z.string(), executionKey: z.string(), attempt: z.number().int().positive(), workspaceId: z.string(), watchId: z.string(), result: ExecutionResultSchema }).strict();
export type ExecutionReceipt = z.infer<typeof ExecutionReceiptSchema>;
export const executionReceiptId = (key: string, attempt: number) => `execution-result:${key}:${attempt}`;

/** Optional result logging cannot change execution, admission, retry, or settlement. */
export async function captureExecutionReceipt(repos: Repositories, job: LeasedJob, result: ExecutionResult, at: string): Promise<void> {
  if (job.kind !== 'monitor.watch') return;
  try {
    const receipt: ExecutionReceipt = { version: 1, jobId: job.id, executionKey: job.idempotencyKey, attempt: job.attempts, workspaceId: job.workspaceId, watchId: String(job.payload.watchId), result };
    await repos.audit.append({ id: executionReceiptId(job.idempotencyKey, job.attempts), workspaceId: job.workspaceId, at, actor: { ref: 'system', displayName: 'Jagr' }, action: 'monitor.execution_result', target: receipt.watchId, executionReceipt: receipt });
  } catch {
    // A done job without a receipt is explicitly result-unavailable, never quiet.
  }
}

export interface ManualExecutionStatus {
  workspaceId: string;
  watchId: string;
  executionKey: string;
  asOf: string;
  execution: {
    state: 'queued' | 'running' | 'retrying' | 'recovering' | 'settled' | 'failed';
    attempts: number;
    requestedAt: string;
    createdAt: string;
    firstAttemptedAt?: string;
    lastAttemptedAt?: string;
    completedAt?: string;
    lastFailedAt?: string;
    nextAttemptAt?: string;
  };
  publicStatus: 'queued' | 'checking' | 'completed' | 'quiet' | 'failed';
  result: ExecutionResult | null;
  resultAvailability: 'pending' | 'available' | 'unavailable';
  failure?: { code: 'execution_failed'; retryable: false };
}

export function executionStatus(identity: { workspaceId: string; watchId: string; executionKey: string; requestedAt: string }, job: JobStatus, result: ExecutionResult | null, asOf: string): ManualExecutionStatus {
  const state = job.state === 'done' ? 'settled' : job.state === 'dead' ? 'failed' : job.state === 'queued' ? (job.lastFailedAt ? 'retrying' : 'queued') : !job.leaseUntil || job.leaseUntil <= asOf ? 'recovering' : 'running';
  const terminal = job.state === 'done' || job.state === 'dead';
  const checked = job.state === 'done' ? result : null;
  const quiet = checked?.disposition === 'checked' && checked.classification === 'no_meaningful_change' && checked.coverage === 'complete';
  return {
    workspaceId: identity.workspaceId, watchId: identity.watchId, executionKey: identity.executionKey, asOf,
    execution: { state, attempts: job.attempts, requestedAt: identity.requestedAt, createdAt: job.createdAt, firstAttemptedAt: job.firstAttemptedAt, lastAttemptedAt: job.lastAttemptedAt, completedAt: job.completedAt, lastFailedAt: job.lastFailedAt, ...(state === 'retrying' ? { nextAttemptAt: job.runAt } : {}) },
    publicStatus: state === 'failed' || checked?.disposition === 'blocked' ? 'failed' : quiet ? 'quiet' : state === 'settled' ? 'completed' : state === 'queued' ? 'queued' : 'checking',
    result: checked, resultAvailability: checked ? 'available' : terminal ? 'unavailable' : 'pending',
    ...(state === 'failed' ? { failure: { code: 'execution_failed' as const, retryable: false as const } } : {}),
  };
}
