import { randomUUID } from 'node:crypto';
import type { Clock } from '../../src/product/ports/clock.js';
import type { JobQueue, JobState, LeasedJob } from '../../src/product/ports/jobs.js';
import { LeaseLost } from '../../src/product/ports/jobs.js';
import type { SqlClient } from './sql.js';

/**
 * Postgres implementation of the JobQueue port. Due jobs are claimed with FOR UPDATE SKIP LOCKED, so
 * concurrent workers never take the same job; an expired lease makes a job claimable again. Time
 * comes from the Clock port (not the database), so leases are testable and consistent with the core.
 */

interface Row {
  id: string;
  idempotency_key: string;
  kind: LeasedJob['kind'];
  workspace_id: string;
  payload: Record<string, unknown>;
  run_at: string | Date;
  attempts: number;
  max_attempts: number;
  lease_token: string;
  lease_until: string | Date;
}

const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const toJob = (r: Row): LeasedJob => ({ id: r.id, kind: r.kind, workspaceId: r.workspace_id, payload: r.payload, idempotencyKey: r.idempotency_key, runAt: iso(r.run_at), attempts: r.attempts, maxAttempts: r.max_attempts, leaseToken: r.lease_token, leaseUntil: iso(r.lease_until) });

export function postgresJobQueue(sql: SqlClient, clock: Clock): JobQueue {
  const plus = (ms: number) => new Date(Date.parse(clock.now()) + ms).toISOString();
  // Ownership is the lease token: a lease that expired but that no other worker took over is still ours.
  const owned = async (id: string, token: string, update: string, params: unknown[]) => {
    const r = await sql.query(`update jobs set ${update} where id = $1 and state = 'leased' and lease_token = $2 returning id`, [id, token, ...params]);
    if (!r.rows.length) throw new LeaseLost();
  };
  return {
    async enqueue(spec) {
      const r = await sql.query('insert into jobs (id, idempotency_key, kind, workspace_id, payload, run_at, max_attempts, state, created_at, updated_at) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $9) on conflict (idempotency_key) do nothing returning id', [
        `job_${randomUUID()}`,
        spec.idempotencyKey,
        spec.kind,
        spec.workspaceId,
        JSON.stringify(spec.payload),
        spec.runAt ?? clock.now(),
        spec.maxAttempts ?? 5,
        'queued',
        clock.now(),
      ]);
      return r.rows.length > 0;
    },
    async claim({ workerId, kinds, limit, leaseMs }) {
      const now = clock.now();
      const params: unknown[] = [now, limit, `${workerId}:${randomUUID()}`, plus(leaseMs)];
      const kindFilter = kinds?.length ? `and kind = any($5::text[])` : '';
      if (kinds?.length) params.push(kinds);
      const r = await sql.query<Row>(
        `update jobs set state = 'leased', attempts = attempts + 1, lease_token = $3, lease_until = $4,
           first_attempted_at = coalesce(first_attempted_at, $1), last_attempted_at = $1, updated_at = $1
         where id in (select id from jobs where run_at <= $1 ${kindFilter} and (state = 'queued' or (state = 'leased' and lease_until <= $1))
                      order by run_at, id limit $2 for update skip locked)
         returning id, idempotency_key, kind, workspace_id, payload, run_at, attempts, max_attempts, lease_token, lease_until`,
        params,
      );
      return r.rows.map(toJob).sort((a, b) => a.runAt.localeCompare(b.runAt) || a.id.localeCompare(b.id));
    },
    complete: (id, token) => owned(id, token, `state = 'done', completed_at = $3, updated_at = $3`, [clock.now()]),
    fail: (id, token, error, retryAt) =>
      owned(id, token, `last_error = $3, last_failed_at = $4, updated_at = $4, state = case when $5::timestamptz is not null and attempts < max_attempts then 'queued' else 'dead' end, run_at = coalesce($5::timestamptz, run_at)`, [error, clock.now(), retryAt ?? null]),
    extend: (id, token, leaseMs) => owned(id, token, `lease_until = $3`, [plus(leaseMs)]),
    async inspect(key) {
      const r = await sql.query<{ state: JobState; attempts: number; run_at: string | Date; created_at: string | Date; first_attempted_at: string | Date | null; last_attempted_at: string | Date | null; completed_at: string | Date | null; last_failed_at: string | Date | null; lease_until: string | Date | null; last_error: string | null }>('select state, attempts, run_at, created_at, first_attempted_at, last_attempted_at, completed_at, last_failed_at, lease_until, last_error from jobs where idempotency_key = $1', [key]);
      const j = r.rows[0];
      return j ? { state: j.state, attempts: j.attempts, runAt: iso(j.run_at), createdAt: iso(j.created_at), firstAttemptedAt: j.first_attempted_at ? iso(j.first_attempted_at) : undefined, lastAttemptedAt: j.last_attempted_at ? iso(j.last_attempted_at) : undefined, completedAt: j.completed_at ? iso(j.completed_at) : undefined, lastFailedAt: j.last_failed_at ? iso(j.last_failed_at) : undefined, leaseUntil: j.lease_until ? iso(j.lease_until) : undefined, lastError: j.last_error ?? undefined } : null;
    },
  };
}
