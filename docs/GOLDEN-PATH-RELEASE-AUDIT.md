# Golden Path Production Release Audit

## Release Candidate

Inspection date: 2026-10-04. Worktree: `/private/tmp/jagr-golden-path`; branch: `golden-path`.

Declared deployed production baseline and current HEAD: `7ef8b00ab160c4406f69d230fe85beccdb84d288`. Baseline tree: `e88557b4842f2a04bf1b2f60bdf1eb625789d462`.

**Important release-boundary finding:** `git diff 7ef8b00ab160c4406f69d230fe85beccdb84d288 HEAD` is empty: zero changed/added/deleted/renamed files, zero insertions/deletions. HEAD does not contain the Golden Path implementation. The actual candidate is the uncommitted working tree: 15 modified tracked files and 15 untracked additions before this audit. No files are staged. The audit therefore inspects both the tracked working diff against the baseline and every untracked candidate file. A HEAD-only comparison would incorrectly exclude the entire release.

Candidate changed-file content fingerprint, excluding this subsequently added audit: SHA-256 `ed76555dbab8d3b200d01371f31bc32afe82f28e9a1b167ca92afd6009becd91`. Algorithm: sort the 30 candidate paths; concatenate `path<TAB>SHA256(file bytes)<NEWLINE>`; hash that UTF-8 manifest. This fingerprints the inspected content but is not a release commit or evidence of what a deployment would package.

This audit creates only this document. Runtime, tests and pre-existing documents remain unchanged. No original-worktree commands, production queries, provider calls, test reruns or deployment operations were performed. The previous implementation validation recorded preservation of 418 original-worktree file hashes and exact Git status; this audit does not independently re-read that worktree.

## Intended Scope

- **P0.1:** select verified healthy workspace Amplitude/Sentry/GitHub; explain missing/unavailable sources and require Amplitude for the narrow conversion experience.
- **P0.2:** ordinary event/error-filter/threshold inputs; explicitly persist shared source mappings using existing validated configuration APIs without credential replacement or JSON editing.
- **P0.3:** authenticated manual execution read, public lifecycle/result semantics, attempt-linked receipt capture, owned investigation references and truthful UI display.
- Supporting contracts, audit findings and focused/regression tests only.

No introduced Phase 4A, memory architecture, shadow mode/comparison, bounded-concurrency drain, scheduler scaling/experiments, queue optimization, batch-claim changes, lease redesign, worker redesign, capacity benchmark, Gate A artifact, disposable benchmark infrastructure, experimental migration, new connector, autonomous external action or unrelated refactor was found. Historical documentation mentions deferred experiments; it does not introduce their code. Two potentially misleading file/function names are explained below: `ports/memory.ts` is an existing test/local persistence adapter, and `drainJobs` retains baseline sequential batch execution with receipt capture added.

## Changed Files

Statistics before adding this audit:

| Comparison | Modified | Added | Deleted | Renamed | Insertions | Deletions |
|---|---:|---:|---:|---:|---:|---:|
| Baseline commit → HEAD | 0 | 0 | 0 | 0 | 0 | 0 |
| Baseline → tracked working files | 15 | 0 | 0 | 0 | 154 | 51 |
| Untracked candidate files | 0 | 15 | 0 | 0 | 1,315 lines | 0 |
| Complete candidate content | 15 | 15 | 0 | 0 | 1,469 | 51 |

Untracked additions are counted as new-file lines; normal `git diff --stat` omits them. This audit is an additional documentation file and is excluded from these candidate statistics.

Every production/runtime file is mapped to its requirement:

| Status / file | Requirement and concrete reason |
|---|---|
| Modified `server/app.ts` | P0.3: adds GET manual execution status under the existing authenticated workspace router; validates one bounded key, restricts method/path, and returns private/no-store owned results. Existing watch/configuration/run POST handlers are unchanged. |
| Added `server/postgres/executionStatus.ts` | P0.3: one MVCC SQL read joins the tenant-owned manual job with its current-attempt audit receipt. It validates workspace/organization/mode/kind/key/attempt/job/watch and investigation ownership before exposing a result. No job write or claim SQL. |
| Modified `src/product/app/monitoring.ts` | P0.3: adds optional result metadata for checked/skipped/denied work and best-effort receipt capture in the existing two worker entry points. Needed to distinguish a settled job's product result from settlement alone. Existing detection/persistence/delivery and queue control remain in place. |
| Added `src/product/app/executionStatus.ts` | P0.3: receipt/result schemas, deterministic job-key-plus-attempt receipt identity, optional audit append and public status mapping. Receipt failure is caught; pending/failed attempts cannot publish a success result. |
| Modified `src/product/engine/monitor.ts` | P0.3: records findings/coverage from the existing observation pass so missing/short/stale/unavailable evidence is not called quiet. Adds metadata only; no new reads, thresholds, detection branches, investigation policy or second evaluation. |
| Modified `src/product/ports/persistence.ts` | P0.3: optional typed executionReceipt in existing AuditEntry JSON. No new persistence port/table or required field on old rows. |
| Modified `src/product/ports/memory.ts` | P0.3: duplicate suppression only for receipt-bearing audit entries, matching existing Postgres conflict behavior. Ordinary audit appends remain unchanged. This is not memory architecture work. |
| Modified `src/product/types.ts` | P0.3: optional findings/coverage metadata on the existing scheduler log entry; it describes observation, not scheduler selection or behavior. |
| Added `src/components/executionStatus.tsx` | P0.3: requested-check panel, explicit refresh, unavailable/last-known-state warning and receipt-linked investigation navigation. No external action execution. |
| Added `src/product/view/executionStatus.ts` | P0.3: PM-facing lifecycle/result copy, distinguishing queue/retry/recovery/failure/quiet/gaps/skips/denial and avoiding claims of causation. |
| Modified `src/state/serverApi.ts` | P0.3: adds encoded GET client call for the status endpoint; all existing client requests remain unchanged. |
| Modified `src/state/productContext.ts` | P0.3: optional status/error fields for the existing server UI context. |
| Modified `src/state/product.tsx` | P0.3: retains enqueue keys, performs status reads on request/explicit refresh, guards responses by generation and exposes only matching-workspace status. Enqueue/worker execution remain server-owned. |
| Modified `src/pages/ProductOverview.tsx` | P0.3: displays requested status, distinguishes requesting from executing and removes unsupported healthy/quiet reassurance based on absence of investigations. |
| Modified `src/pages/Watches.tsx` | P0.1: healthy connected provider selection, unavailable/required source blockers and connection links. P0.2: source-before-mapping flow, existing checkout templates, mapping editor, draft retention and pre-save blocker. P0.3: requested status and enqueue-aware run/success copy. Name length matches the existing API limit. No new watch API model. |
| Added `src/product/view/checkoutWizard.ts` | P0.1/P0.2: stable provider/connection selection, persisted-mapping validation and narrow schema-validated configuration construction preserving keys, filters and unrelated bindings. Existing connector schemas own validation. |
| Added `src/components/checkoutMapping.tsx` | P0.2: ordinary event/filter/threshold inputs, read-only permission/environment handling and explicit shared configuration saves via existing PUT. Credential fields are omitted. |
| Modified `src/product/view/quickStart.ts` | P0.1: one recommendation change makes the existing checkout wizard reachable for healthy connected Amplitude. No onboarding state/model redesign. |
| Modified `src/product/view/watchCard.ts` | P0.3: server enqueue submission says Requesting checks rather than implying execution; local wording is preserved. |

Supporting modified files:

- `src/product/view/quickStart.test.ts`: connected Amplitude/Sentry/GitHub recommendation regression.
- `src/product/view/watchCard.test.ts`: enqueue/requesting wording regression.

Supporting added files:

- `server/checkoutWizard.test.ts`: real existing HTTP contracts over disposable PGlite, tenant access, stable connection/target identity, configured metric signals, enqueue key and queued status.
- `server/executionStatus.test.ts`: ownership, current-attempt gating, retries/lease recovery, checked/skipped/denied/failure, unavailable coverage/receipt, duplicate identity and investigation reference validation.
- `src/components/checkoutMapping.test.ts`: ordinary controls without JSON and read-only/shared-scope UI.
- `src/components/executionStatus.test.ts`: lifecycle copy and settled receipt investigation links.
- `src/product/app/executionStatus.test.ts`: receipt deduplication and no premature/false quiet publication.
- `src/product/view/checkoutWizard.test.ts`: source health, required mappings, schema limits and preservation/collision behavior.
- `docs/GOLDEN-PATH-IMPLEMENTATION.md`: P0.1/P0.2 contracts, limitations and validation.
- `docs/GOLDEN-PATH-PRODUCT-AUDIT.md`: historical product audit plus material implementation update.
- `docs/P0-3-EXECUTION-STATUS-CONTRACT.md`: P0.3 design, narrow authorization history, implementation and validation.

Deleted files: **none**. Renamed files: **none**. Suspicious/unrelated runtime changes: **none found**. Formatting verbosity in the wizard is nonfunctional; it does not introduce another runtime path. The release provenance discrepancy remains a separate P0 blocker.

## Runtime Changes

| Surface | Production impact |
|---|---|
| API routes | One additional authenticated GET `/api/workspaces/:workspaceId/runs/status?key=...`. GET-only exact route, key length 1–1024; owned unknown/nonmanual execution returns 404. Existing callers retain existing endpoints/payloads. No-store prevents status cache reuse. |
| Worker handlers | Existing monitor.watch success/skip/denial branches append an optional attempt receipt before normal settlement. Source-check/brief handler behavior is unchanged; receipt helper ignores their kinds. Scheduled monitor.watch executions also receive receipts, although the public endpoint exposes only manual keys. |
| Database access | Adds one bounded job/receipt read per requested key, up to 100 owned investigation references, and one idempotent receipt audit insert per successful/skipped/denied monitor.watch attempt. Uses existing tables and repository append. No additional connector/evidence read. |
| Auth/authorization | Auth/session/CSRF/membership code is unchanged. New route runs after existing principal/workspace resolution and additionally binds SQL to organization/workspace/manual identity. Existing owner/admin checks govern mapping updates. |
| Connection configuration | Backend unchanged. Explicit UI saves existing supported ratio/error fields to shared workspace connections and stable targets; keeps stored credentials. Existing filters and unrelated bindings remain. These are durable configuration edits, not watch-local settings. |
| Watch creation | Backend unchanged. Existing provider IDs are resolved to workspace targets and served metric keys. Required Amplitude/mapping checks are the narrow wizard contract; the broader watch API retains baseline source choices. |
| Monitoring | Existing engine results gain observational coverage/findings metadata. Existing algorithms, threshold application, findings, investigation reopening, notifications and approval behavior are unchanged. |
| Investigation reads | New status lookup verifies ownership of bounded references. Actual investigation API/read routes and keyset history are unchanged; UI uses the existing investigation route. |
| UI routes | No new route definitions. Existing Overview/Watches gain panels/editor and reuse `/sources` and `/investigations/w/:id`. Browser/sample/import paths keep their existing models. |
| Environment variables | No added/changed environment configuration. No secret inspection or new required credential. |
| Deployment configuration | `vercel.json`, package/lockfile, composition root, API host files and workflows unchanged. No dependency or infrastructure addition. |

## Database / Migration Analysis

**No new or changed migration; no new schema; no new startup migration requirement.** The repository uses `server/postgres/migrations.ts` as its migration registry rather than a separate migrations directory. Its bytes are identical to the deployed baseline, and no new migration path was added. `server/runtime.ts` and its existing startup migration behavior are also identical.

The baseline already defines `audit_log(workspace_id,id,at,doc jsonb)` with `(workspace_id,id)` uniqueness; repository append already uses `ON CONFLICT DO NOTHING`. Receipt data occupies this JSON document. Existing jobs columns support state/attempt/timestamp reads, and workspace_docs already contains owned investigations. No new SQL table, column, index, trigger, data backfill or migration entry is required.

This proves compatibility with the schema encoded by the supplied production baseline. It does not independently prove which migrations are applied on the live database; no production access was performed or required by this audit.

## Production Compatibility

- **Existing schema:** compatible with baseline tables/columns/JSON storage; no required backfill.
- **Existing API callers:** existing handler bodies and contracts remain; additional GET is opt-in. JSON additions are optional. Strict third-party consumers of raw audit documents outside the repository are not independently verified.
- **Existing worker jobs:** payload, enqueue identity, claim and settlement contracts remain. Previously settled/manual jobs without a receipt correctly return completed/result-unavailable; old or malformed receipts fail closed. During a mixed-version rollout an old worker may complete without a receipt; the new read handles that case.
- **Scheduled jobs:** schedule/selection/enqueue code unchanged. Receipt capture additionally writes audit rows for scheduled monitor.watch work; status endpoint still accepts only correctly bound manual identities.
- **Connections:** same connector schemas, secrets, stable IDs and targets. No automatic conversion/reconfiguration on deployment. New explicit UI saves affect all watches using the edited mapping. Environment-managed connections cannot be edited here.
- **Watches:** no required new field or migration. Existing watches retain their stored definitions. New wizard behavior applies to checkout/conversion creation; it requires healthy Amplitude and does not offer other providers in this narrow path.
- **Workspaces/auth:** same workspace modes, organization/workspace scope, principal and session behavior. Only connected workspaces expose manual receipts; no demo data substitution.
- **Rollback readers/export:** baseline repositories read JSON without requiring a receipt field; existing snapshot/export logic does not require this new optional metadata. The baseline connector schemas already accept every new wizard-generated configuration. No incompatible persisted format is introduced.

Limits: live source account readiness, actual database migration state, deployment contents/settings, external API consumers and a real browser/provider end-to-end journey cannot be established by this repository-only audit. Previous validation uses disposable PGlite/synthetic connectors and UI rendering/pure helpers, not production accounts. The declared deployment SHA is supplied by the user and present locally; this audit did not query the deployment host to re-attest it.

## Worker Safety

The complete monitoring diff was inspected, including both worker entry points. `server/postgres/jobs.ts`, `server/runtime.ts`, `src/product/scheduler.ts` and `src/product/app/sourceChecking.ts` are byte-identical to baseline.

| Invariant | Finding |
|---|---|
| Claim | runOneJob still claims limit 1. Baseline drainJobs still claims its existing limit and executes sequentially; no new batch claiming or concurrency implementation. Underlying claim SQL and tenant rotation unchanged. |
| Lease | Same lease token, extend and lost-ownership checks. No new ownership model. |
| Heartbeat | Same interval and lifecycle; receipt append is inside the existing handler/heartbeat lifetime. |
| Retry | Same error capture, busy-workspace delay, exponential backoff and max-attempt/dead behavior. Receipt append exceptions are swallowed and cannot trigger retries. |
| Settlement | Same token-owned complete/fail branches. A receipt before completion is not exposed as a result until the job is done. Lost/stale attempts cannot publish the current result because reads bind to job ID/key/current attempt. |
| Concurrency | No added concurrent jobs, pool, parallel drain or worker limit change. |
| Scheduler/queue | No selection/enqueue/idempotency/payload/fairness policy changes. |
| Handler behavior | Detection/persist/delivery occur as before; result metadata is derived afterward. Missing/inactive watch and controlled denial retain normal done settlement while receiving explicit result dispositions. |

Worker change is **only additive receipt capture/result metadata**. It adds awaited database work and audit storage, so it is not literally zero runtime cost. There is no new receipt-specific timeout; baseline SQL request behavior applies. Receipt insertion failure is best effort and becomes result-unavailable, not false quiet. Existing tests exercise normal settlement, retry/dead, lease takeover, lost ownership, skipped/denied results, receipt failure and historical done jobs.

## Test Evidence

Already completed validation, recorded in the preceding implementation task and `docs/GOLDEN-PATH-IMPLEMENTATION.md`:

| Evidence | Result |
|---|---|
| P0.1/P0.2/wizard/Quick Start plus P0.3 focused | 70 tests / 8 files, PASS |
| Combined architecture protection, authorization, connection-security and focused regression | 89 tests / 12 files, PASS |
| Full suite after final runtime changes | 907 tests / 82 files, PASS |
| Typecheck | PASS |
| Production build | PASS; existing Vite config-loader/extension and large-chunk warnings |
| Whitespace/diff | PASS; tracked and untracked candidate files checked |

The 89-test count includes focused regressions; it is not 89 additional independent tests. No expensive tests were rerun for this inspection-only task. Current tracked `git diff --check` also passes. Historical evidence is not represented as a new live-production check.

## Release Risks

| Priority | Release-specific risk | Smallest remediation / handling |
|---|---|---|
| **P0 — blocks release** | No Golden Path release commit exists: HEAD equals production baseline, baseline→HEAD diff is empty, and 15 required files remain untracked. A deployment identified by HEAD would either omit this work or have ambiguous dirty-tree content. This is a release provenance/package boundary problem, not an implementation test failure. | In a separately authorized task, freeze and commit exactly the audited Golden Path files plus supporting audit, capture the new SHA, compare it with the baseline, verify the exact manifest/scope and associate the intended deployment artifact with that SHA. Do not add experiments or change runtime as part of this remediation. This audit does not authorize or perform that commit/deployment. |
| **P1 — address soon** | Mapping editor submits complete shared connection configuration without a new version/concurrency guard; another admin can overwrite overlapping edits. Canceling watch creation does not undo a separately saved mapping. | Controlled beta: use one configuration editor at a time and review shared changes. Future change protection requires separate scope; existing UI already discloses shared persistence. |
| **P1 — address soon** | Mapping save ignores the returned check health, and server refresh can resolve after a failed snapshot load. Clearing the pending flag can leave a stale connection view; successful persistence does not prove verification or that the UI has the latest mapping. | Add focused coverage for failed probe/refresh and explicitly distinguish saved configuration from verification/refresh success in a separately authorized fix. Existing execution reports unavailable evidence honestly; this is not permission to claim readiness from a successful PUT. |
| **P2 — acceptable controlled beta** | Manual keys/status are session-local, explicitly refreshed and not recovered across a page reload. No polling/history selector is added. | Disclose refresh/session limitation; retain existing investigation/history navigation. |
| **P2 — acceptable controlled beta** | Metric series have no portable completeness guarantee. Even sufficiently populated Amplitude/Sentry checks remain coverage-unknown and do not become Quiet merely because no finding was detected. | Treat Completed — evidence incomplete or unknown as honest; do not promise a quiet conversion result or weaken coverage checks. |
| **P2 — acceptable controlled beta** | Receipt writes increase audit rows for scheduled as well as manual monitor.watch attempts; append latency is inside execution, and failed append leaves result unavailable. | Observe existing operational/database behavior during controlled beta; no new benchmark infrastructure or worker redesign is justified by this audit. |
| **P2 — acceptable controlled beta** | Live account/provider/browser end-to-end readiness is unverified, and helper edits only the first matching checkout ratio/error binding; other matching metrics remain included. | Agree on one beta mapping and review configured scope. Keep unsupported/hidden configuration read-only or blocked; do not imply connecting guarantees evidence. |

No other release-specific P0 runtime/schema defect was established by this audit. Passing tests alone do not remove the provenance blocker.

## Rollback

Exact declared current deployed baseline: **`7ef8b00ab160c4406f69d230fe85beccdb84d288`**.

**Application rollback only. No database rollback or incompatible schema reversal is required by this slice.** Deploy the baseline application artifact through the separately authorized release process; do not reset the worktree or delete records. Existing queue/schema/connector formats remain usable. Receipt audit rows can remain as historical records and are ignored by baseline code. Newly saved mappings and watches also remain valid baseline data.

Application rollback restores application behavior; it does not automatically undo customer/admin mapping edits or watch creation performed through the new UI. Any desired restoration of configuration is a separate explicit data/configuration action, not a schema rollback. This audit performs neither.

## Final Release Decision

**BLOCKED**

Exact blocker: the validated implementation exists only as modified/untracked working-tree content; the release HEAD still identifies the deployed baseline and contains none of the Golden Path changes. An exact committed release boundary/deployment provenance has not been established.

Smallest remediation: a separately authorized narrow release commit containing exactly this inspected candidate and its supporting audit, followed by baseline-to-new-SHA scope verification and deployment artifact association. No migration or implementation expansion is necessary to resolve this blocker. Deployment remains unperformed and unauthorized by this inspection.

Audit-only change: `docs/GOLDEN-PATH-RELEASE-AUDIT.md`. Production touched: NO. Original dirty worktree touched: NO. Runtime/code fixed: NO. Commit: NO. Push: NO. Merge/rebase/reset: NO. Deploy: NO.
