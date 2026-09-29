# Architecture decisions through Phase 3C

Concise memory for the frozen Phase 3C system. `docs/ARCHITECTURE.md` is the detailed reference.

## Phase 0A — portable boundaries and tenant identity

- **Problem:** Product behavior was coupled to browser/runtime assumptions; server ingestion needed stable tenant/source identities.
- **Decision:** Keep product rules in `src/product/` and infrastructure in `server/`; make organization the security/commercial boundary and workspace the operational boundary. Separate Connection, SourceTarget, SourceState, and Watch; define a tenant-aware NormalizedEvent contract.
- **Reason:** The domain must be reusable across browser-local and server execution without vendor/host coupling.
- **Consequence:** Dependencies point inward, repositories are scoped, credentials stay behind SecretStore, and architecture tests enforce portability.
- **Deferred:** Event processing, webhooks, enterprise tenancy features, and new infrastructure.

## Phase 1 — durable server execution

- **Problem:** Monitoring needed to run with the browser closed without duplicating work or weakening authorization.
- **Decision:** Add authenticated server workspaces, Postgres repositories, encrypted secrets, thin host entry points, a leased job queue, scheduler/worker separation, workspace locks, and Workspace Export v1.
- **Reason:** Durable work requires server identity, ownership, retry, concurrency protection, and a portable migration boundary.
- **Consequence:** Jobs are at-least-once and handlers idempotent; lease/lock tokens are ownership boundaries; approvals remain server-enforced.
- **Deferred:** Alternative queues, blob storage, automatic retention, and unapproved production actions.

## Phase 2A — source-aware observation

- **Problem:** Polling per watch duplicated provider reads and mixed observation cadence with investigation cadence.
- **Decision:** Schedule `source.check` per SourceTarget. Persist/deduplicate connector events, map relevant event/watch pairs to stable cadence slots, enqueue coalesced monitoring, then advance SourceState.
- **Reason:** Observation belongs to the target; investigation belongs to the watch. Separation makes overlap/retry safe.
- **Consequence:** Failures remain explicit, checkpoints follow durable downstream work, and one observation can fan out without payload copies in jobs.
- **Deferred:** Broad webhook/event-bus infrastructure.

## Phase 2B — canonical investigation context

- **Problem:** A monitoring job needed its triggering events without embedding mutable payloads.
- **Decision:** Resolve canonical events by organization, workspace, watch, and cadence slot; persist bounded references in investigations/evidence.
- **Reason:** References preserve provenance/replay while keeping jobs small and tenant-safe.
- **Consequence:** Canonical payloads stay in the event repository; reads are scoped, ordered, and capped; one reference job remains per watch slot.
- **Deferred:** Unbounded event retrieval, event deletion, and a general event bus.

## Phase 3A — admission and usage

- **Problem:** Resource/execution limits needed one retry-safe organization-owned boundary.
- **Decision:** Store Subscription and immutable UsageEvent records. EntitlementPolicy describes limits; admission locks subscription state, counts resources, validates ownership, and records usage by operation ID.
- **Reason:** Commercial policy stays separate from execution records and retries cannot double-count.
- **Consequence:** Creation is transactionally admitted; manual/scheduled execution share the boundary; controlled denial does not run or retry.
- **Deferred:** Billing providers, invoices, checkout, plan UX, and customer billing promises.

## Phase 3B — bounded and fair execution

- **Problem:** A large tenant/backlog could monopolize capacity; source relevance needed one owner.
- **Decision:** Rotate claims by organization, keep oldest-due order per tenant, cap/rotate scheduler workspace selection, make source checkers own relevance, and expose bounded credential-free queue status.
- **Reason:** Existing Postgres coordination can provide fairness/diagnostics without new infrastructure.
- **Consequence:** Claim transactions stay short; failed workspaces retain successful checkpoints; missing relevance fails configuration.
- **Deferred:** Redis/Kafka/Temporal, distributed schedulers, multiregion execution, and sharding.

## Phase 3C — bounded history

- **Problem:** History consumers loaded whole collections in one database read; naive limits would break semantics or silently truncate exports.
- **Decision:** Add tenant-bound keyset pages capped at 100. Traverse all pages where logically required; use window/existence/dedupe/point queries elsewhere. Assemble snapshot/export in repeatable-read, read-only transactions and fail above the 8,000,000-character bound.
- **Reason:** Bound database reads without changing dedupe, reopening, failed-deployment, brief, decision, snapshot, or export behavior.
- **Consequence:** Public histories expose isolated cursors; notification dedupe is targeted; snapshot/export never silently truncate. Monitoring still materializes the fully paged ledger.
- **Deferred:** Incremental-engine redesign, streaming export, retention deletion, and invented retention periods.
