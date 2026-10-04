import type { SqlClient } from './sql.js';
import type { JobStatus } from '../../src/product/ports/jobs.js';
import { ExecutionReceiptSchema, executionStatus } from '../../src/product/app/executionStatus.js';

/** Single MVCC read of one owned manual job and its current-attempt receipt. */
export async function readManualExecution(sql: SqlClient, scope: { organizationId: string; workspaceId: string }, key: string, asOf: string) {
  const rows = await sql.query<{
    id: string; watch_id: string; due_at: string; state: JobStatus['state']; attempts: number;
    run_at: string | Date; created_at: string | Date; first_attempted_at: string | Date | null;
    last_attempted_at: string | Date | null; completed_at: string | Date | null;
    last_failed_at: string | Date | null; lease_until: string | Date | null; receipt: unknown; refs_owned: boolean;
  }>(`select j.id, j.payload->>'watchId' as watch_id, j.payload->>'dueAt' as due_at,
      j.state, j.attempts, j.run_at, j.created_at, j.first_attempted_at, j.last_attempted_at,
      j.completed_at, j.last_failed_at, j.lease_until, a.doc->'executionReceipt' as receipt,
      not exists (select 1 from jsonb_array_elements_text(
        case when jsonb_typeof(a.doc#>'{executionReceipt,result,investigationIds}') = 'array' then
          case when jsonb_array_length(a.doc#>'{executionReceipt,result,investigationIds}') <= 100
            then a.doc#>'{executionReceipt,result,investigationIds}' else '[]'::jsonb end
          else '[]'::jsonb end) as ref(id)
        where not exists (select 1 from workspace_docs d where d.workspace_id = j.workspace_id
          and d.collection = 'investigations' and d.id = ref.id)) as refs_owned
    from jobs j join workspaces w on w.id = j.workspace_id
    left join audit_log a on a.workspace_id = j.workspace_id
      and a.id = 'execution-result:' || j.idempotency_key || ':' || j.attempts::text
      and a.doc->>'workspaceId' = j.workspace_id and a.doc->>'action' = 'monitor.execution_result' and a.doc->>'target' = j.payload->>'watchId'
    where j.idempotency_key = $1 and j.workspace_id = $2 and w.doc->>'organizationId' = $3
      and w.doc->>'mode' = 'connected' and j.kind = 'monitor.watch'
      and j.idempotency_key = j.workspace_id || ':manual:' || (j.payload->>'watchId') || ':' || (j.payload->>'dueAt')`,
  [key, scope.workspaceId, scope.organizationId]);
  const row = rows.rows[0];
  if (!row?.watch_id || !row.due_at || !Number.isFinite(Date.parse(row.due_at))) return null;
  const parsed = ExecutionReceiptSchema.safeParse(row.receipt);
  const receipt = parsed.success ? parsed.data : null;
  const matching = receipt && receipt.jobId === row.id && receipt.executionKey === key && receipt.workspaceId === scope.workspaceId && receipt.watchId === row.watch_id && receipt.attempt === row.attempts;
  let result = matching ? receipt.result : null;
  if (result?.disposition === 'checked') {
    if (!row.refs_owned) result = null;
    else if (result.classification === 'no_meaningful_change' && result.coverage !== 'complete') result = null;
  }
  const iso = (v: string | Date | null) => v ? new Date(v).toISOString() : undefined;
  return executionStatus({ workspaceId: scope.workspaceId, watchId: row.watch_id, executionKey: key, requestedAt: row.due_at }, {
    state: row.state, attempts: row.attempts, runAt: iso(row.run_at)!, createdAt: iso(row.created_at)!,
    firstAttemptedAt: iso(row.first_attempted_at), lastAttemptedAt: iso(row.last_attempted_at), completedAt: iso(row.completed_at), lastFailedAt: iso(row.last_failed_at), leaseUntil: iso(row.lease_until),
  }, result, asOf);
}
