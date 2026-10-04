# P0.3 Execution Status Contract

## 1. Problem

Design only, inspected on 2026-10-03 in `/private/tmp/jagr-golden-path`, branch `golden-path`, HEAD `7ef8b00ab160c4406f69d230fe85beccdb84d288`. No implementation or live execution is part of this document. Findings describe that exact baseline, not experimental worktrees.

A connected workspace's manual request acknowledges enqueueing, but cannot subsequently read the matching execution and its result. A snapshot's latest successful watch run is not proof that this manual request completed. Empty investigations are not proof of quiet, failure, or evidence coverage.

Existing jobs are sufficient for queue lifecycle visibility. They are **not sufficient for the complete product result contract**: `done` includes successful checks, skipped inactive/deleted watches, and controlled admission denial. Monitoring results are not durably linked to the enqueue identity. The smallest complete addition therefore needs a scoped job read plus a structured result receipt, without a second execution-state system.

## 2. Existing Execution Lifecycle

1. `server/app.ts`, workspace `POST /runs`: authentication and `resolveWorkspaceContext` precede access. Connected mode lists active watches and captures one `clock.now()` timestamp. For each watch it checks execution admission and enqueues `monitor.watch`, with payload `{watchId, dueAt: at}` and `runAt: at`. HTTP 202 returns `{kind: 'run_queued', workspaceId, watches, jobs: [{watchId, idempotencyKey, enqueued}]}`. Zero active watches yields zero jobs. The loop is not one all-or-nothing enqueue transaction: a later admission/error can leave earlier jobs queued without a successful response. Do not silently change this behavior here.
2. `server/postgres/jobs.ts`: enqueue inserts a random `job_<UUID>`, unique idempotency key, workspace, kind, reference payload, queued state, timestamps, and default five attempts. Conflict on the key does nothing, returning false.
3. Claim serializes a short tenant-turn decision, picks due queued jobs or expired leased jobs, and uses `FOR UPDATE ... SKIP LOCKED`. Ordering is organization turn, due time, job ID. Claim sets `leased`, increments attempts, issues a new token, and records first/last attempted timestamps. No execution-result identity is written.
4. `server/app.ts` cron worker calls `runOneJob` with a 60-second lease. `src/product/app/monitoring.ts` claims exactly one job and heartbeats at one third of the lease duration. Admission is rechecked for source/check monitoring jobs. Controlled denial skips the handler and settles `done`; the denial reason is returned only in the operator worker response.
5. `runWatchJob` obtains a separate workspace run lock (15 minutes, renewed every five minutes). Missing workspace throws. Inactive or deleted watch returns an empty summary without observation or monitoring audit. Otherwise it loads canonical events for the watch/due slot, builds sources, reads the complete investigation ledger through pages, and runs the existing engine at `payload.dueAt`.
6. `persistRun` transactionally saves investigations, deduplicated in-app notifications, and a `monitor.watch` audit entry targeted at the watch. Audit time is **due time**, not worker completion time. Its detail is bounded prose/counts. The returned summary includes touched investigation IDs, but the worker discards it. Connected outbound delivery happens after this transaction and before handler return.
7. Successful handler return leads to token-owned `complete`: state `done`, `completed_at` set. Errors call token-owned `fail`, retaining bounded internal error text. WorkspaceBusy retries after one minute; other errors back off `min(60, 2^attempts)` minutes. Attempts below the configured maximum requeue; exhausted attempts become `dead`. A failure in heartbeat shutdown or settlement can leave the job leased until recovery rather than creating a recorded retry.
8. Extend/complete/fail require the matching lease token and leased state. Expiry alone does not invalidate that token: an expired owner can renew/settle until takeover. Takeover changes the token and increments attempts; stale settlement throws LeaseLost. This fences settlement, not every preceding engine/database/external side effect.

Relevant evidence: `server/app.ts`; `server/postgres/jobs.ts`; `server/postgres/migrations.ts` migrations 001 and 004; `src/product/app/monitoring.ts`; `src/product/app/scheduler.ts`; `src/product/app/sourceChecking.ts`; `src/product/engine/monitor.ts`; `docs/CONTRACTS.md` and `docs/DECISIONS.md`.

## 3. Existing Source of Truth

`jobs` is authoritative for `queued | leased | done | dead`, attempts, due/retry time, creation, first/last attempt, completion, last failure, and lease expiry. `JobQueue.inspect(key)` exposes these internally, but omits workspace, kind, watch, and job identity; it is **not tenant-scoped** and cannot be forwarded to a browser unchanged. `lastError` may contain provider details and must not be public.

`JobQueue.status()` and cron `/status` provide aggregate operator diagnostics, protected by the cron secret. They are not product reads. Workspace snapshot `runs` projects audit entries to `{watchId, at, outcome}`; workspace/audit, watch reads, investigation history, replay, and canonical-event reads lack request-correlated execution status. Investigation runs carry watch/time, not manual enqueue identity. SourceState describes observation progress, not this watch execution. Notification dedupe is not completion proof.

No cancellation state, superseded job state, lease-lost terminal state, job deletion/retention policy, or durable result field exists. Lease tokens and queue payloads stay internal.

## 4. Enqueue Key Semantics

| Question | Baseline answer |
|---|---|
| Durable job ID? | No. The random job ID is separate. |
| Idempotency key? | Yes, globally unique in jobs across all states. |
| Deterministic identity? | Manual key is `${workspaceId}:manual:${watchId}:${requestTimestamp}`; deterministic for that tuple, not for a user gesture independent of time. |
| Multiple requests same key? | Yes if workspace/watch and captured timestamp coincide. A repeated click with a later timestamp normally creates another job. There is no client-generated request token. |
| Multiple jobs for one key? | No under the unique constraint; repeated enqueue returns false even for terminal jobs. |
| Superseded/coalesced? | Manual jobs are not coalesced. Scheduler skips older missed slots before enqueue; source checks coalesce onto `${workspaceId}:source-slot:${watchId}:${slot}`. Neither turns an existing manual job into superseded. |
| Safe to expose? | Already returned to authorized clients; contains tenant/watch/time identities, no credential. Treat as opaque and potentially predictable, never as a bearer authorization token. |
| Safe lookup? | Only after current organization/workspace authorization and a database ownership predicate, not by parsing or trusting its workspace prefix. |

Keep the existing POST response and keys. `enqueued: false` means an existing identity, not failure or completion. A manual request covering several watches returns several independently tracked executions; do not invent one overall job status.

## 5. Result Linkage

Today no complete durable execution → result link exists. Engine logs have synthetic `run:<watchId>:<dueAt>` IDs, findings, touched investigation IDs, and notification IDs. Persisted watch audit uses a time-derived audit ID and watch target, not the durable job key. Scheduled and manual jobs may share watch/time. Investigation histories are mutable and may reuse/reopen an investigation. Result count `r.investigations.length` includes the loaded ledger, so it is not the count of findings or newly created investigations.

Propose one **result receipt per claim attempt**, stored as a typed, versioned audit document with action `monitor.execution_result`, target watch ID, and deterministic ID derived from an unambiguous encoding/hash of `(idempotencyKey, attempts)`. The existing `(workspace_id, id)` primary key supports a point lookup. Its structured field contains identity, attempt, disposition (`checked | skipped | blocked`), check due time, recorded time, finding classification, coverage, and bounded investigation references. It does not duplicate queue state or contain credentials/commercial subscription data. Blocked is an operational disposition only; do not copy subscription/usage records or raw admission reasons.

Record the checked receipt after successful handler work, including outbound delivery returning, and before queue completion. A receipt alone is never completion proof. A read exposes a terminal result only when job state is `done` and receipt attempt equals job attempts. Stale attempts cannot overwrite a newer attempt's receipt. Receipts from failed attempts remain nonterminal/internal. Reads must obtain the job and matching receipt from one consistent database read. A crash between receipt and completion leaves a leased/reclaimable job; after takeover, the new attempt requires its own receipt.

Record skipped/blocked dispositions at those existing terminal paths before their normal `complete`. Instrument both `runOneJob` and the existing batch `drainJobs` path; do not import the experimental drain driver. Existing jobs without a receipt return result unavailable, not quiet. A dead job can already have persisted investigations/notifications from an earlier partial attempt; failure does not imply that no side effects occurred.

For honest quiet, add **observational metadata only** to the existing engine result: findings including watching/anomalous signals and failed deployments, actual signal/role reads, and missing/unavailable/insufficient evidence. Current `gaps` only records ProviderUnavailableError; missing metric source, null series, no compatible reader, and short series can yield no finding without entering gaps. `readMetric` treats fewer than four points as normal. Therefore no findings + empty gaps or prose “All signals within normal range” is insufficient. Report coverage unknown/incomplete until each configured signal's applicable reader and sufficient evidence are positively accounted for. Preserve existing detection and connector policies; do not reinterpret source connection health as coverage. Findings may coexist with gaps.

Investigation references come from the matching run's structured result, not a latest-watch query. Bound the receipt/API list (proposed cap 100); overflow has `truncated: true` and an execution-bound continuation requirement, never silent omission. Defining that continuation is a separate follow-up if real golden-path runs exceed the cap. No finding is inferred from merely resolving/touching an existing investigation.

## 6. Proposed Contract

Proposed single manual-watch read:

`GET /api/workspaces/:workspaceId/runs/status?key=<URL-encoded idempotencyKey>`

This is a new endpoint, not an existing one. Restrict it to connected-mode `monitor.watch` rows whose stored key exactly equals the manual identity constructed from the authorized workspace, stored payload watch ID, and stored due time. Do not accept arbitrary operator jobs, key-prefix matches, or lists of guessed keys. Suggested input limit: one nonempty key up to 1024 characters; validate before querying. Reuse session authentication and PrincipalContext. GET is nonmutating. Set `Cache-Control: private, no-store`.

Conceptual response (optional fields omitted when inapplicable):

```ts
{
  workspaceId: string;
  watchId: string;             // validated from the owned job
  executionKey: string;
  asOf: string;               // server clock used for lease-expiry mapping
  execution: {
    state: 'queued' | 'running' | 'retrying' | 'recovering' | 'settled' | 'failed';
    attempts: number;
    requestedAt: string;      // payload.dueAt, not mutable run_at
    createdAt: string;
    firstAttemptedAt?: string;
    lastAttemptedAt?: string;
    completedAt?: string;
    lastFailedAt?: string;
    nextAttemptAt?: string;   // queued retry only; not a start-time guarantee
  };
  publicStatus: 'queued' | 'checking' | 'completed' | 'quiet' | 'failed';
  result: null | {
    disposition: 'checked' | 'skipped' | 'blocked';
    classification: 'findings' | 'no_meaningful_change' | 'inconclusive';
    coverage: 'complete' | 'incomplete' | 'unknown';
    investigationIds: string[];
    truncated: boolean;
    reason?: 'watch_inactive_or_missing' | 'check_not_permitted';
  };
  resultAvailability: 'pending' | 'available' | 'unavailable';
  failure?: { code: 'execution_failed'; retryable: false };
}
```

Use discriminated response variants in implementation: blocked/skipped need no classification/coverage; checked requires both. No raw errors, tokens, entire payload, source secrets, external execution claims, global counters, or internal lease token. Backend result validation must reject contradictory variants. HTTP 401 for no current session; generic 404 for inaccessible workspace, missing/wrong-scope/wrong-kind key; 400 for malformed input. Authorized deleted-watch jobs may still be read: authorize the job's stored workspace/watch identity, not continued watch existence. Any existing watch row must belong to this workspace. Missing result for an owned job is HTTP 200 with unavailable/pending, not HTTP 404.

This one read serves both phases: read-only status initially and receipt-enriched results later. Do not call the full golden path complete until result linkage is implemented and validated.

## 7. Internal → Public State Mapping

| Durable condition | Execution state | Public status / qualifier |
|---|---|---|
| queued, no recorded failed attempt | queued | Queued |
| queued, last_failed_at present | retrying | Checking — retry scheduled; not actively executing |
| leased, lease_until later than asOf | running | Checking — worker claimed the check; not proof a provider read has started |
| leased, lease_until at/before asOf | recovering | Checking — awaiting worker recovery; do not claim worker is currently alive |
| done, matching checked receipt, findings | settled | Completed — findings available; show coverage gaps alongside findings |
| done, matching checked receipt, no findings, complete coverage | settled | Quiet — no meaningful change detected in the checked evidence/window |
| done, matching checked receipt, incomplete/unknown coverage | settled | Completed — evidence incomplete / result inconclusive |
| done, matching skipped receipt | settled | Completed — check skipped; no claim evidence was checked |
| done, matching blocked receipt | settled | Failed — check could not run; not a dead-lettered execution |
| done, absent/invalid/mismatched receipt | settled | Completed — job settled; check result unavailable |
| dead | failed | Failed — execution stopped after recorded failure |

`done` maps to **settled**, not successful observation. Missing key is not an execution state. Superseded/cancelled are not returned because these job states do not exist. Source-slot coalescence and scheduler pre-enqueue skips remain internal scheduling facts.

## 8. State Semantics

Queued means accepted for execution, with no promise of immediate start. Checking is an umbrella with explicit running/retry/recovery qualifier; it must not conceal that a worker may not currently be executing. Completed means durable job settlement; checked/skipped/unavailable qualifiers are mandatory. Quiet is a terminal checked result with positive coverage proof and no findings, scoped to that check's window. Failed includes terminal execution failure or a recorded operational block, with those causes distinguished.

Completed is not a mandatory intermediate animation before Quiet. Return the current state directly. Never show Healthy for queued, running, retrying, recovering, skipped, unavailable, or gapped evidence. Never say an investigation was created merely because a related investigation exists. Never turn a status-read network error into execution failure; keep last authoritative state and say status unavailable. UI request activity ends independently of background execution.

## 9. Authorization / Tenant Boundaries

`server/auth.ts` rebuilds the principal from the hashed server session and current workspace and organization memberships. `server/authorization.ts` resolves organization → workspace authorization. Reuse both on every status read; keys are not authorization.

Add a narrowly scoped read to the existing queue boundary rather than widening unscoped `inspect`. Query predicates must bind exact key, jobs.workspace_id, monitor.watch kind, manual identity, and workspaces.doc organization ID. Validate the payload watch reference and optional current watch row in workspace scope. Point-read the receipt using workspace and deterministic ID, and verify its identity/version/attempt. Do not scan latest audits or unrelated investigations. Parameterize SQL. The existing idempotency unique index gives a bounded single-row job read; audit primary key gives a bounded receipt read.

Return only investigation IDs validated in that workspace; subsequent investigation/event reads retain current organization/workspace binding. A removed result is unavailable, not a cross-tenant fallback. No source lookup is needed for basic status; any coverage references must originate in the authorized watch execution and retain source-target tenant ownership. No new ability to inspect another workspace's source, queue, or operational error text. Predictable keys may identify jobs only inside an authorized workspace; no anonymous or cross-tenant enumeration endpoint. This follows existing member-readable workspace history, not requester-only visibility.

## 10. Retry / Failure Semantics

Retrying is derived from queued state plus recorded failure, not from attempts alone: attempts can increase on lease reclamation. `run_at` becomes the retry schedule, while payload dueAt remains the original check window. All attempts reuse the same execution key; no new usage charge or identity is introduced. Attempts are claim count, not provider failure count.

Dead is terminal under current behavior, including explicit fail without retryAt or exhausted attempts. Expose a fixed safe failure code; do not parse last_error into an unsupported taxonomy. Retryable failure displays retry timing from the durable row, without guaranteeing worker availability. Previous last_failed_at/error can remain on a subsequently done row: state, not presence of error, determines terminal failure.

Lease expiry means reclaimable, not failed or cancelled. LeaseLost returned by a worker is not a durable job state and must not be persisted as a competing UI state. Refresh the authoritative row after takeover. Results persisted before an eventual dead-letter are not evidence that the overall execution succeeded. A missing key returns generic not found; UI says “Status not available,” not “Quiet” or “Failed.” Old jobs retain their actual state: no useful-status expiry window or terminal-job deletion exists. Do not invent a TTL, expire pending jobs based on age, or delete idempotency identities.

## 11. Migration Requirement

**Lifecycle-only read: no migration and no new durable state required.** Existing jobs fields and indexes suffice, with an authorized scoped projection. It cannot supply reliable quiet, blocked/skipped disposition, or result identity.

**Complete product contract: additional durable result data is necessary, but a database migration is not structurally required.** Existing audit_log JSON documents and `(workspace_id, id)` primary key can hold the versioned attempt receipt and retrieve it by deterministic ID. Add a typed structured field to the AuditEntry contract, not serialized machine data hidden in detail prose. No new table, column, or index is needed for point lookup. Keep receipt contents bounded and credential-free. This is new result persistence, not a second job lifecycle table.

Old records need no backfill: report unavailable. Existing generic audit history/export readers must tolerate the additive document field/action; verify bounds and export/replay compatibility. Postgres append already ignores duplicate primary keys; the memory adapter currently pushes duplicates, so receipt idempotence requires adapter parity testing and a narrow dedupe adjustment if used. Do not implement any of this in the design task.

## 12. Compatibility

Leave enqueue identities, default attempts, claim SQL/fairness, worker claim count, scheduler/source-slot coalescence, lease/token ownership, heartbeat cadence, backoff, workspace locks, admission accounting, detection thresholds, investigation dedupe/reopening, and notification idempotency unchanged. Keep manual POST compatible, including duplicate response semantics and current per-watch admission behavior. No source reconfiguration, queue management, cancel/retry mutation endpoint, or autonomous action execution.

A scoped read can leave all execution code untouched. The full result contract **cannot** leave all worker/monitoring code untouched: it requires additive result capture on checked/skipped/blocked paths and observational engine metadata. This must be separately reviewed; it is not a claim that a read endpoint alone solves P0.3. Receipt write failures introduce a persistence failure point; they must fail closed through the existing retry/lease recovery paths rather than falsely confirming a result. Validate that existing side-effect idempotence survives such retries. If strict zero worker implementation changes is retained, approve only lifecycle visibility and keep full P0.3 blocked.

## 13. Minimal Implementation Plan

Four logical change groups for the complete contract (not four files; ports, adapters and tests span more):

1. **Scoped read:** add a tenant-bound manual-execution read to the existing queue port/adapters, returning allowlisted state/identity and a matching receipt via consistent point lookup. Preserve operator inspect/status.
2. **Result projection:** carry per-check findings, coverage, and investigation references out of the existing engine/application result. Account for missing/null/short-series evidence observationally without changing detection decisions.
3. **Receipt persistence:** extend the typed audit document with bounded result metadata and write one idempotent attempt receipt on existing checked/skipped/blocked terminal paths in both worker entry paths. Reuse audit storage; do not add lifecycle state. Preserve settlement fencing and handle crash/retry ordering explicitly.
4. **HTTP contract:** add the authenticated GET projection/mapping and validation above, using current PrincipalContext; no UI implementation yet.

A lifecycle-only first increment needs **two logical changes** (scoped read and HTTP route) and returns results unavailable. It is useful but incomplete. Review the receipt/result additions explicitly before claiming Quiet or offering request-linked investigation navigation. No scheduler or infrastructure changes are justified.

## 14. Tests Required

Design inspection read existing `server/app.test.ts` (including denied worker → done), `server/postgres/postgres.test.ts`, `src/product/app/hardening.test.ts`, `src/product/app/sourceChecking.test.ts`, and queue/persistence contract implementations. Tests were not run in this design-only task, and proposed behavior remains unvalidated.

Before implementation delivery require:

- Scoped HTTP reads: unauthenticated, revoked/expired session, removed organization/workspace memberships, wrong workspace/key/kind, malformed keys, predictable guessed foreign keys, deleted watch, and parameter injection. Uniform inaccessible/not-found response; no tokens/errors/secrets in output; private/no-store.
- Queue lifecycle: queued, live lease, expired lease, reclaimed lease, retry backoff, exhausted dead, success after failure with historical error retained, duplicate enqueue in every state, concurrent readers/settlement, no mutation from reads. Preserve existing fairness/ownership tests.
- Results: checked finding, quiet with proven coverage, unavailable sources, missing reader, null/short metric series, unsupported signal, no selected evidence, changes-only empty successful read, findings with gaps, resolving/touching old investigations, denied and skipped done rows. Never derive quiet from absence alone.
- Correlation: same watch/due time scheduled and manual executions; repeated manual timestamp/key; later timestamp/new key; reused investigations; matching attempt only; stale receipt after takeover; no legacy backfill inference.
- Crash/failure boundaries: after investigation persistence, after outbound delivery, after receipt before complete, receipt failure, heartbeat failure, settlement LeaseLost, retry then blocked/skipped, and both single-job and batch worker paths. Receipt presence must not override nonterminal/dead state or imply external delivery success.
- Boundedness/parity: exact-key/index point reads, no full-history materialization, receipt reference cap/overflow, Postgres/memory duplicate parity, additive audit history/snapshot/export and size-bound compatibility, unchanged replay/provenance.
- Run focused suites, then full tests, typecheck, build, architecture/security checks and diff check in the isolated worktree. Live provider/browser validation requires separate explicit configuration/authorization; no production validation implied.

## 15. Open Questions

1. Approve result instrumentation in worker/monitoring code, or restrict the first increment to lifecycle reads with unavailable results? Full requested semantics require the former.
2. Confirm operational blocked/skipped copy and the proposed conservative definition of quiet: no watching/anomalous findings or failed deployments and positively verified coverage. Partial data must remain inconclusive.
3. Confirm evidence sufficiency metadata for each existing role/connector, including freshness and metric bucket/window coverage. Four points alone is necessary under current detector, not universal freshness proof. Unsupported coverage remains unknown without changing provider policy.
4. If result references exceed 100, approve an execution-bound continuation read before promising complete navigation; no generic investigation-history fallback as request identity.
5. Partial multi-watch submission on HTTP error has no discoverable request batch identity. Keep that existing limitation documented; resolving it is outside this minimal read design.
6. Receipt persistence and side-effect retries need fault-injection validation. No claim is made that the baseline fences all side effects or that receipts solve stale-worker side effects.

## Final Recommendation

1. **Can this be implemented entirely by exposing existing durable job state?** Lifecycle visibility yes; complete P0.3 no. Jobs do not distinguish checked/blocked/skipped done results or preserve result linkage/coverage.
2. **Minimum number of server changes?** Two logical changes for honest lifecycle-only visibility; four logical groups for complete status/result behavior: scoped read, result projection, attempt receipt persistence, HTTP projection. This is not a four-file estimate.
3. **Database migration?** No for the proposed design. Reuse jobs plus existing indexed audit JSON storage. The full design does require new typed durable result metadata and writes, explicitly subject to separate review.
4. **Exact UI read contract?** `GET /api/workspaces/:workspaceId/runs/status?key=<encoded returned idempotencyKey>`, using the existing authenticated session. One call per returned manual watch execution; current durable lifecycle, safe timestamps, result availability, matching terminal receipt and owned investigation references. Never consume cron status or infer request linkage from latest runs.
5. **UI per execution state?** Queued → “Check queued”; running → “Checking”; retrying → “Checking — retry scheduled”; recovering → “Checking — awaiting worker recovery”; checked done with findings → “Completed — findings available”; checked done with proven complete coverage/no findings → “Quiet — no meaningful change detected”; checked done with gaps → “Completed — evidence incomplete”; skipped done → “Completed — check skipped”; legacy/unmatched done → “Completed — check result unavailable”; blocked done → “Failed — check could not run”; dead → “Failed — execution stopped”; missing/unreadable status → “Status unavailable.” None of these warrants an unqualified Healthy claim.

Recommend reviewing the complete four-group addition, keeping jobs as the sole lifecycle authority and audit receipts as immutable attempt results. Do not implement until that review resolves the instrumentation and coverage questions. This task stops with this document.

## Implementation Review — Stopped at Worker-Change Boundary

Reviewed the implementation request on 2026-10-03 against the complete design and baseline code. **Implementation status: BLOCKED; no source implementation attempted.** The request explicitly says “STOP and report instead of expanding scope if” “worker changes are required.” That condition is met, even though additive result capture is part of the approved design.

Concrete required changes in `src/product/app/monitoring.ts`:

- `runOneJob` currently awaits `runWatchJob` and discards its returned summary. It holds the actual leased job and attempt identity, and would need to capture and persist a checked receipt before settlement.
- Its admission-denied branch bypasses `runWatchJob`, then calls `queue.complete`. A blocked receipt therefore requires changing this worker path; adding receipts only inside monitoring cannot cover it.
- Existing `drainJobs` also discards the monitoring summary and immediately completes denied jobs. It would require the same instrumentation. This is the baseline batch worker, not the experimental bounded-concurrency driver.
- Inactive/deleted watches return an empty summary from `runWatchJobLocked`. That summary would need an explicit skipped disposition; it is not currently a durable result receipt.

Moving receipt generation into queue completion would instead change the queue implementation and still lack checked-result/disposition metadata. Generating receipts in the read endpoint would infer history after execution and could not reliably distinguish blocked, skipped, quiet, or previous attempts. Neither is a safe workaround within this request.

**Files changed:** only this design document, with this implementation review appended. **Endpoint/read contract:** the proposed GET `/api/workspaces/:workspaceId/runs/status?key=<encoded idempotencyKey>` remains unimplemented. **Receipt mechanism:** unimplemented. State mapping, authorization, and retry/attempt rules remain proposed as documented above; no runtime semantics changed.

**Validation:** no focused implementation tests, full suite, typecheck, build, or architecture/security tests run because implementation stopped before source changes. Documentation whitespace and worktree scope were checked. No migration, scheduler, queue claim, worker, lease, drain, Phase 4A, shadow, connector, API, or UI source changes. Production was not accessed; original dirty worktree preserved. No commit, push, merge, or deployment.

**Exact next step:** resolve the worker-change stop condition before implementation. Completing the approved contract requires authorization for additive attempt-result capture in the existing single-job and batch worker paths and monitoring return values, preserving claim SQL, lease/heartbeat behavior, settlement ownership, admission, retries, and scheduling. A lifecycle-only read can avoid worker changes but would not complete the requested receipt/Quiet/result behavior; no partial implementation was substituted.

## Implementation — Narrow Receipt Capture Authorized

Implemented on 2026-10-04 in the same `golden-path` worktree and baseline HEAD. The user's subsequent narrow authorization supersedes the preceding worker-change stop and the design's suggestion that receipt failures should enter execution retries. **Receipt persistence is best effort: logging failure cannot convert successful monitoring or controlled denial into worker failure.** Durable settlement remains authoritative; a missing receipt is explicitly unavailable.

### Files changed

- `server/app.ts`: workspace status route only.
- `server/postgres/executionStatus.ts`: new read-only, tenant-bound job/receipt query.
- `server/executionStatus.test.ts`: disposable Postgres HTTP/worker/correlation/security tests.
- `src/product/app/executionStatus.ts` and `.test.ts`: typed versioned receipts, safe capture helper, durable-state projection, receipt safety tests.
- `src/product/app/monitoring.ts`: additive monitoring summary and receipt capture in existing worker branches.
- `src/product/engine/monitor.ts`, `src/product/types.ts`: observational check metadata from the existing evaluation, without changing detection, investigation, or notification decisions.
- `src/product/ports/persistence.ts`: optional typed audit receipt; `src/product/ports/memory.ts`: receipt-only duplicate suppression matching Postgres primary-key behavior.
- `src/product/view/executionStatus.ts`: honest status copy.
- `src/components/executionStatus.tsx` and `.test.ts`: requested-check display, result links, explicit refresh, rendered UI tests.
- `src/state/serverApi.ts`, `src/state/productContext.ts`, `src/state/product.tsx`: client read and workspace-bound latest-request tracking with stale-read protection.
- `src/pages/ProductOverview.tsx`, `src/pages/Watches.tsx`: requested-check display and removal of Healthy/completion inference from server submission or absent investigations.
- `src/product/view/watchCard.ts` and `.test.ts`: distinguish requesting a check from worker execution in shell status.
- This document: implementation record appended; prior design preserved.

### Exact read and authorization

`GET /api/workspaces/:workspaceId/runs/status?key=<URL-encoded enqueue key>` uses the existing session and `resolveWorkspaceContext`. No cron credentials are used. The route accepts one nonempty key of at most 1024 characters, rejects other methods, and returns private/no-store on its successful/not-found execution responses. Unauthorized sessions return 401; inaccessible workspaces and foreign/missing/nonmanual jobs return 404. Malformed key input returns 400.

The SQL read binds exact key, organization, workspace, connected mode, monitor.watch kind, and the existing manual key formed from that row's watch and due time. A single MVCC statement reads the job and the current attempt's audit receipt, and checks bounded investigation references against workspace-owned documents. The current watch need not still exist because skipped/deleted-watch jobs remain readable. Watch identity comes from the owned manual job originally enqueued from that workspace's active watches. The response allowlists execution state, attempts, request/attempt/settlement/retry times, public status, result availability, and typed result. It does not expose database job IDs, payloads, lease tokens, provider errors, admission detail, or secrets.

### Worker paths, capture point, and receipt structure

Only the existing `runOneJob` and baseline batch `drainJobs` monitoring/denial branches were instrumented. Their claim, heartbeat, lease, backoff, admission decisions, settlement calls, concurrency, and return semantics are unchanged. The experimental drain/bounded-concurrency driver was not imported or changed.

`runWatchJobLocked` returns skipped metadata for its existing inactive/missing-watch early return. After the existing evaluation, persistence, and outbound delivery return, it attaches a result derived from that evaluation's structured check metadata and touched investigation references. It performs no second evaluation and does not parse audit prose. Workers capture this returned result before their existing settlement. Admission-denied monitoring jobs capture only a safe blocked disposition; source-check jobs do not write these receipts.

Audit action is `monitor.execution_result`, target is watch ID, and the optional structured `executionReceipt` is `{version: 1, jobId, executionKey, attempt, workspaceId, watchId, result}`. Checked results carry classification, coverage, investigation IDs (maximum 100), and a truncation flag. Skipped/blocked results carry a fixed safe reason. No commercial records or raw admission message are copied into execution data.

Receipt ID is `execution-result:<existing key>:<positive attempt integer>`. The final numeric suffix makes the tuple unambiguous; no new execution/attempt identity or schema is introduced. Postgres audit append already ignores duplicate IDs. Memory duplicate suppression is limited to receipt entries. Each claimed attempt has its own immutable receipt. The read validates schema, job/key/attempt/workspace/watch ownership, and reference ownership. It only publishes a result for `done` at the matching attempt; earlier, malformed, contradictory, or foreign receipts cannot yield Quiet. Failed/dead jobs never publish success receipts.

Receipt write exceptions are contained by the helper. Settlement still follows the original success/denial path. An interrupted or failed receipt write can therefore leave a done job with unavailable result; this is intentional and tested. No receipt backfill or retry queue was added. Normal additional database-write latency still applies; this work does not introduce a request-wide execution deadline or claim to fence all baseline side effects.

### State and evidence semantics

Queued → Queued; live lease → Checking; queued after recorded failure → Checking / retry scheduled; expired lease → Checking / awaiting worker recovery; done with findings → Change detected; done with verified complete supported reads and no findings → No meaningful change; done with incomplete/unknown coverage → Completed / evidence incomplete or unknown; skipped → Check skipped; blocked → Check could not run / admission or entitlement; dead → Check failed; done without matching receipt → Completed / check result unavailable. Missing/unreadable status is not an execution failure.

The engine now exposes existing watching/anomalous findings and failed deployments as observational metadata. Missing sources/readers, null/short metric series, known stale sources, and unavailable reads produce incomplete coverage. Sufficient metric points still produce **unknown** coverage: the portable metric response does not guarantee data completeness/freshness, and this task does not change connectors. Consequently an apparently normal conversion/error metric check remains inconclusive rather than Quiet. Successful nonmetric role reads can support Quiet, scoped to what their query returned, never an unqualified product-health claim. Findings remain visible alongside coverage gaps.

Receipt state is execution bookkeeping, not evidence of causality or external action execution. Existing investigation evidence/provenance and Observed/Correlated/Inferred/Unknown interpretation remain unchanged.

### UI and limitations

Overview and Watches display the latest returned manual request keys for the selected workspace. Initial enqueue is not completion; status is read after submission and through the existing Refresh action / new Refresh status button. No background polling architecture was added. Older refresh responses cannot replace a newer status read. Read errors preserve explicitly labeled last-known states. Investigation navigation uses receipt references; no timestamp matching is used.

Tracking is in the current browser session and is not persisted across reload. Multiple-watch submission can still partially enqueue before returning an error; existing request semantics were preserved. No batch identity/discovery endpoint was added. Up to 100 result references are returned; truncation is explicit, and complete execution-bound continuation remains unimplemented. Existing scheduled and source-slot jobs are excluded from this manual status API. Historical done jobs without receipts remain unavailable. Full browser/provider usability validation has not been run; UI assertions render real components locally.

### Validation and preservation

Focused contract/UI/receipt and existing worker, queue, server authorization, and architecture suites passed. Full suite, typecheck, production build, and final diff checks are recorded below after the final verification run. Tests use disposable PGlite and synthetic source responses, without provider or production calls.

No database migration/schema, scheduler, queue claim/settlement adapter, lease implementation, heartbeat behavior, retry/dead-letter policy, admission policy, source-check implementation, Phase 4A, shadow, bounded-concurrency driver, connector, or external action executor changes. Worker execution semantics were preserved; additive receipt capture is the only worker-path change. Original dirty-worktree fingerprints and status are checked separately. No production access, commit, push, merge, or deployment.

Final verification results:

| Check | Result |
|---|---|
| Focused P0.3 server/receipt/rendered UI suites | PASS — 22 tests, 3 files |
| Focused worker/queue/server/authorization/architecture regression run | PASS — 127 tests, 11 files (before the final extra successful-retry case; that case passed in final focused/full runs) |
| Full existing suite plus additions | PASS — 892 tests, 79 files |
| Typecheck | PASS |
| Production build | PASS; existing Vite configuration/chunk-size warnings remain |
| Architecture/security | PASS — architecture, protection, authorization and server auth/security cases included in focused/full runs |
| Diff/whitespace and manual source review | PASS |
| Protected baseline files | UNCHANGED — migrations, jobs adapter, runtime, scheduler, source checking, cron workflow, package and Vercel configuration |
| Original dirty worktree | PRESERVED — all 418 recorded file hashes and exact porcelain status matched |
| Production, commit, push, deploy | NOT DONE |

Next validation: separately configured local/browser Golden Path exercise of a manual connected watch request, status refresh, and receipt-linked investigation navigation, including provider evidence gaps. Metric completeness remains unknown until an existing evidence contract can positively establish it; do not authorize connector or execution redesign implicitly to obtain a Quiet label.
