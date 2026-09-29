# Critical contracts and invariants

These contracts state what must remain true. Consult the named source types and contract tests before changing them.

## Identity and tenancy

### PrincipalContext

`server/authorization.ts` is the single resolution boundary from authenticated Principal to organization/workspace authority. It requires current workspace membership, the workspace's organization ownership, and current organization membership. Permissions derive from those memberships; client state is never authority.

### Organization and workspace

Organization is the commercial/security boundary; workspace is the operational/data boundary. A server workspace belongs to one organization. Every workspace record access includes or derives workspace ID; sensitive history/event reads also verify organization ID. Cross-tenant absence must not disclose foreign records.

## Source identity and observation

### Connection ownership

A Connection belongs to one workspace and describes provider/configuration/roles. It may contain only an opaque SecretRef. SecretStore operations verify workspace and connection ownership; credentials never enter exports, evidence, client responses, audit, logs, or prompts.

### SourceTarget identity

A SourceTarget is a stable monitored provider resource under one organization, workspace, and connection. Its identity is not mutable display text. A target cannot be read or scheduled outside its recorded tenant/connection ownership.

### SourceState and checkpoints

SourceState belongs to one target and records observation progress, not watch progress. A successful checkpoint advances only after events are durable and required watch-slot jobs are enqueued. Provider/auth/rate-limit/timeout/configuration failures remain distinguishable and never mean “no change.” Updates remain retry-safe.

### NormalizedEvent identity

A NormalizedEvent is schema-versioned and carries organization, workspace, connection, SourceTarget, provider, occurrence/observation times, dedupe key, and provenance. Event ID is deterministic for target + provider dedupe key. Payload is bounded; canonical payload remains in the event repository.

### Event/watch relationship

Connector/source-check relevance determines whether an event affects a watch. Each relevant event/watch pair maps durably to one stable cadence slot. Retry may finish missing enqueue work but cannot remap or duplicate completed slots. Jobs carry references; investigations/evidence carry bounded event references.

## Investigation and execution

### Investigation cadence identity

Operational investigation execution is scoped by workspace + watch + cadence slot. Source checks may be more frequent, but coalesce into the watch slot. Do not turn each event into a job or mix events from another tenant/slot.

### Job identity and idempotency

`idempotencyKey` is durable across every job state. Existing keys produce duplicates rather than new work. At-least-once delivery requires retry-safe handlers. Deleting terminal identities can re-enable duplicate enqueue and is not currently safe.

### Lease tokens

A claimed job is owned by its lease token. Only that token may extend, complete, or fail it. Expired leases can be reclaimed; after takeover, the old worker receives `LeaseLost` and cannot settle. Heartbeats keep long work inside its lease.

### Lock ownership and expiry

Locks are workspace-scoped, keyed, expiring, and owned by opaque tokens. Acquire is atomic; renew/release requires the owner. Monitoring uses a workspace run lock; source checking a target-specific lock. Lost ownership prevents safe settlement; expiry provides crash recovery.

## Control plane

### Entitlement and admission boundary

EntitlementPolicy answers capability/limit questions but performs no writes. Admission alone orchestrates subscription activity, organization resource counts, workspace ownership, and usage reservation. Commercial state stays out of jobs, events, investigations, notifications, and source state.

### Usage reservation and idempotency

UsageEvent is immutable and unique by organization + durable operation ID. That ID remains stable across retry. Existing usage is a permitted duplicate, not a second charge. Periods use valid subscription bounds or deterministic UTC calendar months; this is internal accounting, not a customer promise.

## Historical state

### Bounded pagination

History pages are keyset-based and capped at 100. Cursor identity binds version, organization, workspace, collection, sort key, and record ID. Cursors advance, cannot cross tenant/collection boundaries, and use stable ordering keys. “First page” never means “complete history.”

### Snapshot and export consistency

Server snapshot and Export v1 traverse every required page in one repeatable-read, read-only transaction. They preserve complete logical content and deterministic ordering. Above the 8,000,000-character technical bound they fail with `HistorySizeError`/HTTP 413 `history_too_large`; partial documents are forbidden. Export retains redaction and fail-closed sensitive-data scanning.

### Tenant-scoped repository access

Repository calls constrain workspace data by workspace ID. History and normalized-event reads also assert organization ownership. Point lookups by action, notification dedupe key, investigation, or event retain workspace scope. Memory and Postgres implementations satisfy the same port contracts.
