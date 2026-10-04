# P0.1 + P0.2 — connected checkout watch

Worktree: `/private/tmp/jagr-golden-path`; branch `golden-path`; base HEAD `7ef8b00ab160c4406f69d230fe85beccdb84d288`. Existing P0.3 work is retained. No commits, pushes, deployment or production database access.

## P0.1: connected source selection

For the existing `checkout_health` and `conversion` templates in server workspaces, the wizard selects sources before configuring signals. Only workspace-scoped ConnectionViews with matching stable provider/source identity, source kind, connected status and healthy verification appear as selectable. Amplitude is required for this conversion path; Sentry and GitHub are optional technical/release context. Unavailable providers are named separately with the existing `/sources` connection path. Unavailable selected sources block continuation and saving. Quick Start's only change is to recommend `checkout_health` for healthy connected Amplitude. Browser/sample/imported paths retain their existing source/template behavior.

No duplicate source model is introduced. Existing POST watch creation resolves selected provider IDs to tenant-owned SourceTarget IDs. Tests verify persisted connection/target identity, organization/workspace binding and rejection of unauthorized workspace access and missing sources.

## P0.2: understandable signal mapping

Normal inputs expose Amplitude ratio numerator/denominator event names and relative drop threshold (above 0, up to 100%), plus Sentry's existing error search filter and relative increase threshold (above 0, up to 1000%). An empty Sentry filter means all errors. Amplitude is a ratio of unique users for two events, not a sequential funnel. Completed hourly buckets are compared against the same hours in the previous seven days; sustained changes must also exceed normal variation. No new baseline/window controls or detection policy are introduced.

The first matching checkout ratio/error binding is edited, retaining its stable key, event filters and other settings. A missing checkout binding can be added only to an otherwise valid existing connector configuration, within existing metric limits and without overwriting colliding keys or unrelated metrics. Existing connector schemas validate the complete output. Hidden, invalid or unsupported configurations fail closed and link to Sources. No JSON editing is required on this already-connected path. Other configured metrics matching the selected template remain included by existing server behavior.

Mapping saves are explicit and clearly labeled as shared across workspace watches. They use existing PUT connection configuration with no credential field, retaining the server's stored credential. Owners/admins can edit workspace-managed connections; members and environment-managed connections see read-only mappings. Unsaved or missing mappings block watch creation. Editor instances remain mounted across wizard steps and source deselection, retaining drafts. GitHub exposes no invented per-watch controls: context is the existing configured repositories' releases/deployments and commit links. Timing does not establish causation.

## Contracts reused

- Authenticated workspace snapshot ConnectionView list, existing health derivation and membership authorization.
- `PUT /api/workspaces/:id/connections`: existing provider/config schema validation, ownership checks, credential retention, connection probe and stable SourceTarget update.
- `POST /api/workspaces/:id/watches`: existing templateId/sources/name/schedule/notificationPolicy fields; configured metric discovery and tenant-owned sourceTargetIds resolution. No API contract change.
- Existing AmplitudeConfig and SentryConfig schemas, checkout templates, SourceTarget and Connection records.
- Existing manual run enqueue and P0.3 status endpoint/panel/result links; unchanged status contract.

The required-Amplitude rule is a wizard rule for this specific conversion experience. The general watch API continues supporting its broader baseline source choices. Custom thresholds here are existing shared connector binding thresholds; no unsupported per-watch Sentry override beyond the watch endpoint's 100% bound is sent.

## Validation

Final validation:

- Focused Golden Path/wizard/Quick Start/P0.3: **70 tests, 8 files, PASS**.
- Combined focused + architecture protection + authorization + connection lifecycle/security: **89 tests, 12 files, PASS**. Connection lifecycle coverage includes credential encryption/redaction and permission isolation.
- Full suite after final source changes: **907 tests, 82 files, PASS** (15 new tests beyond P0.3's 892).
- Typecheck: **PASS**.
- Production build: **PASS**. Existing Vite extension/config-loader and large-chunk warnings remain.
- Tracked diff and new/changed-file whitespace: **PASS**; complete task diff inspected.
- Original dirty worktree: **418 file hashes and exact Git status preserved**.
- Existing P0.3 implementation files outside the extended Watches page: **byte-for-byte unchanged**. The existing Watches execution-status panel/request flow is retained.
- HEAD remains the deployed baseline SHA; branch is `golden-path`. Work is uncommitted.
- No migrations, connector implementation, queue, worker, lease, scheduler, drain, Phase 4A or shadow changes in this task. No production access, commit, push, merge or deploy.

Tests use PGlite and synthetic connector reads, never production or live provider calls. Added coverage includes healthy/unhealthy/disconnected source selection, required sources and mappings, schema limits, preserved keys/filters, collision-safe mapping additions, ordinary UI inputs/read-only permissions, Quick Start reachability, real HTTP watch persistence and stable source identity, workspace authorization, manual enqueue keys and status reads. Existing P0.3 regression tests remain included.

## Remaining limitations

This is one narrow already-connected checkout path. Advanced event filters, dimensions, multiple binding selection, resource connection setup and generic query building remain in their existing surfaces. Mapping updates affect all watches using those source bindings. Existing configuration updates have no new concurrency/version contract; no such backend mechanism is added. Connection verification does not guarantee later evidence availability. A mapping saves before the watch; canceling the wizard does not roll back a separately saved shared mapping. P0.3's refresh behavior and result-coverage limits remain unchanged. Live account readiness and end-to-end provider behavior were not evaluated.

## Files changed by this task

- `src/pages/Watches.tsx`
- `src/product/view/checkoutWizard.ts`
- `src/product/view/checkoutWizard.test.ts`
- `src/components/checkoutMapping.tsx`
- `src/components/checkoutMapping.test.ts`
- `src/product/view/quickStart.ts`
- `src/product/view/quickStart.test.ts`
- `server/checkoutWizard.test.ts`
- `docs/GOLDEN-PATH-IMPLEMENTATION.md`
- `docs/GOLDEN-PATH-PRODUCT-AUDIT.md` (historical audit copied into this worktree, implementation update appended)
