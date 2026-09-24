/**
 * JobQueue port — durable background work with leases.
 *
 * At-least-once: a job whose lease expires is handed out again, so every handler is idempotent.
 * `idempotencyKey` makes enqueueing idempotent too: the same key is never queued twice (duplicate or
 * overlapping scheduler ticks are harmless). Initial implementation: a Postgres table claimed with
 * FOR UPDATE SKIP LOCKED (server/).
 */

export type JobKind = 'monitor.watch' | 'sync.connection' | 'notify.deliver' | 'brief.compose';

export interface JobSpec {
  kind: JobKind;
  workspaceId: string;
  payload: Record<string, unknown>;
  /** Not before this time (default: now). */
  runAt?: string;
  idempotencyKey: string;
  maxAttempts?: number;
}

export interface LeasedJob extends Required<Omit<JobSpec, 'maxAttempts' | 'runAt'>> {
  id: string;
  runAt: string;
  attempts: number;
  maxAttempts: number;
  leaseToken: string;
  leaseUntil: string;
}

export type JobState = 'queued' | 'leased' | 'done' | 'dead';

export interface JobQueue {
  /** Returns false when a job with the same idempotency key already exists (in any state). */
  enqueue(job: JobSpec): Promise<boolean>;
  /** Claims due jobs, oldest first. Expired leases are claimable again. */
  claim(opts: { workerId: string; kinds?: JobKind[]; limit: number; leaseMs: number }): Promise<LeasedJob[]>;
  complete(jobId: string, leaseToken: string): Promise<void>;
  /** `retryAt` absent, or attempts exhausted → the job is dead-lettered. */
  fail(jobId: string, leaseToken: string, error: string, retryAt?: string): Promise<void>;
  extend(jobId: string, leaseToken: string, leaseMs: number): Promise<void>;
  /** For operations and tests. */
  inspect(idempotencyKey: string): Promise<{ state: JobState; attempts: number; lastError?: string } | null>;
}

export class LeaseLost extends Error {
  constructor() {
    super('The job lease expired or was taken by another worker.');
    this.name = 'LeaseLost';
  }
}
