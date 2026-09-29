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
      if (limit <= 0) return [];
      return sql.transaction(async (c) => {
        // Serialize only the short claim decision, never execution. A persistent turn prevents an
        // old backlog from one organization from hiding another organization's due work.
        const gate = await c.query<{ next_turn: string }>('select next_turn from job_claim_sequence where id = 1 for update');
        let turn = BigInt(gate.rows[0]?.next_turn ?? 0);
        const claimed: LeasedJob[] = [];
        for (let i = 0; i < Math.min(limit, 100); i++) {
          const candidate = await c.query<{ id: string; tenant_key: string }>(
            `select j.id, coalesce(w.doc->>'organizationId', 'workspace:' || j.workspace_id) as tenant_key
             from jobs j
             left join workspaces w on w.id = j.workspace_id
             left join job_tenant_turns t on t.tenant_key = coalesce(w.doc->>'organizationId', 'workspace:' || j.workspace_id)
             where j.run_at <= $1 and (j.state = 'queued' or (j.state = 'leased' and j.lease_until <= $1))
               and ($2::text[] is null or j.kind = any($2::text[]))
             order by t.last_turn nulls first, j.run_at, j.id
             limit 1 for update of j skip locked`,
            [now, kinds?.length ? kinds : null],
          );
          const chosen = candidate.rows[0];
          if (!chosen) break;
          const result = await c.query<Row>(
            `update jobs set state = 'leased', attempts = attempts + 1, lease_token = $2, lease_until = $3,
               first_attempted_at = coalesce(first_attempted_at, $4), last_attempted_at = $4, updated_at = $4
             where id = $1
             returning id, idempotency_key, kind, workspace_id, payload, run_at, attempts, max_attempts, lease_token, lease_until`,
            [chosen.id, `${workerId}:${randomUUID()}`, plus(leaseMs), now],
          );
          claimed.push(toJob(result.rows[0]));
          turn++;
          await c.query('insert into job_tenant_turns (tenant_key, last_turn) values ($1, $2) on conflict (tenant_key) do update set last_turn = excluded.last_turn', [chosen.tenant_key, turn.toString()]);
        }
        if (claimed.length) await c.query('update job_claim_sequence set next_turn = $1 where id = 1', [turn.toString()]);
        return claimed;
      });
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
    async status() {
      const counts = await sql.query<{ state: JobState; count: string }>('select state, count(*)::text as count from jobs group by state');
      const byState = Object.fromEntries(counts.rows.map((row) => [row.state, Number(row.count)]));
      const oldest = (await sql.query<{ run_at: string | Date }>("select run_at from jobs where state = 'queued' order by run_at, id limit 1")).rows[0];
      const expired = (await sql.query<{ count: string }>("select count(*)::text as count from jobs where state = 'leased' and lease_until <= $1", [clock.now()])).rows[0];
      const dead = await sql.query<{ id: string; workspace_id: string; organization_id: string | null; source_target_id: string | null; kind: LeasedJob['kind']; attempts: number; last_failed_at: string | Date | null }>(
        `select j.id, j.workspace_id, w.doc->>'organizationId' as organization_id,
           case when j.kind = 'source.check' then j.payload->>'sourceTargetId' end as source_target_id,
           j.kind, j.attempts, j.last_failed_at
         from jobs j left join workspaces w on w.id = j.workspace_id
         where j.state = 'dead' order by j.last_failed_at desc nulls last, j.id desc limit 20`,
      );
      return {
        queued: byState.queued ?? 0,
        leased: byState.leased ?? 0,
        dead: byState.dead ?? 0,
        expiredLeases: Number(expired?.count ?? 0),
        oldestQueuedAt: oldest ? iso(oldest.run_at) : undefined,
        recentDead: dead.rows.map((row) => ({ jobId: row.id, workspaceId: row.workspace_id, ...(row.organization_id ? { organizationId: row.organization_id } : {}), ...(row.source_target_id ? { sourceTargetId: row.source_target_id } : {}), kind: row.kind, attempts: row.attempts, failedAt: row.last_failed_at ? iso(row.last_failed_at) : undefined })),
      };
    },
  };
}
