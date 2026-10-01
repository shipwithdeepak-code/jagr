# Jagr agent guide

Repository-wide guidance; nested `AGENTS.md` files may add narrower rules. Read relevant contracts and tests before changing behavior.

## Product and architecture

Jagr watches a product while a product manager is away, detects meaningful changes, investigates across evidence sources, decides whether attention is warranted, and links to evidence or approval. Protect this loop:

```text
CONNECT → DEFINE → SCHEDULE → OBSERVE → DETECT → INVESTIGATE
        → CORRELATE → DECIDE ATTENTION → NOTIFY → EVIDENCE/ACTION
```

Jagr is not a generic dashboard, alert feed, or unconstrained agent. Keep Observed, Inferred, Assumption, and Unknown distinct. Timing is not causation. Failed or unavailable sources are gaps, never negative findings or sample data.

Dependency direction:

```text
React UI and api/ → server infrastructure/adapters → src/product portable core
```

- `src/product/` is portable TypeScript: domain types, role interfaces, engine, deterministic policy, application services, connectors, imports/exports, ports, and evaluations. It must not depend on React, browser APIs, Node APIs, databases, or deployment hosts.
- `server/` contains HTTP/auth, identity adapters, Postgres repositories/jobs/migrations/secrets, and runtime composition.
- `api/` contains thin host entry points. Do not duplicate product policy there.
- `src/` outside `src/product/` contains React UI, browser state, and local-workspace adapters.
- Browser-local and server workspaces map to the same product concepts. Demo Night is a separate scripted environment.

See `docs/REPO-MAP.md`, `docs/CONTRACTS.md`, and `docs/DECISIONS.md` before adding an abstraction.

## Control plane, tenancy, and sources

The organization-owned control plane contains subscription state, entitlement decisions, resource admission, and immutable usage facts. The workspace execution/data plane contains connections, source targets/states, normalized events, watches, jobs, investigations, decisions, notifications, briefs, imports, and audit. Commercial state must not leak into execution records.

Tenancy is `organization → workspace`. Authentication builds a principal from a hashed server session and current memberships. `PrincipalContext` is the user-to-organization-to-workspace authorization boundary. Repository access stays workspace-scoped; history/event access additionally carries organization scope. Preserve membership rechecks, CSRF, secure cookies, secret redaction, and encrypted secret storage.

- `Connection` owns provider configuration and an opaque `SecretRef`; credentials never enter domain records, responses, exports, logs, or AI prompts.
- `SourceTarget` is the stable tenant-owned provider resource beneath a connection.
- `SourceState` is the target's durable observation/checkpoint state. Advance it only after event persistence and required enqueue attempts succeed.
- `NormalizedEvent` is versioned, tenant/target-scoped, deterministically identified, deduplicatable, provenance-bearing, and payload-bounded. Investigations carry references; canonical events remain in the repository.
- Source cadence controls observation; watch cadence controls investigation slots; connector relevance maps events to watches.

Do not collapse Connection, SourceTarget, SourceState, Watch, or NormalizedEvent into one model.

## Durable execution and admission

- The Postgres queue is at-least-once. Enqueue identity is the durable `idempotencyKey`; handlers remain retry-safe.
- A claim is owned by its lease token. Heartbeats extend leases. Expired leases may be reclaimed; stale workers cannot settle after losing ownership.
- Retryable failures back off; exhausted/terminal failures become dead jobs. Queue status is bounded and omits payload/error text.
- Monitoring and source checks use separate expiring owner-token locks. Never replace server-side ownership with a UI flag.
- Operational investigation identity is workspace + watch + cadence slot. Event/watch mappings use stable slots; jobs carry references, not event payloads.
- Claims rotate across organizations while retaining oldest-due order within a tenant. Scheduler selection is bounded and rotates by oldest attempt.
- `EntitlementPolicy` answers commercial capability/limit questions. Admission alone locks subscriptions, counts tenant resources, and reserves execution usage.
- `UsageEvent` is immutable and keyed by durable operation identity. Retries must not consume allowance twice. Controlled denial is terminal, not an execution retry.

## History, snapshot/export, and retention

- Historical pages use tenant-bound keyset cursors and are capped at 100. Never weaken organization/workspace/collection cursor binding.
- Snapshot and Export v1 traverse complete logical histories through bounded pages inside a repeatable-read, read-only transaction. They never silently truncate; documents over the 8,000,000-character technical bound fail with HTTP 413 `history_too_large`.
- Monitoring still materializes the complete investigation ledger after page traversal because deduplication, six-hour reopening, and permanent failed-deployment semantics need it. This is a known future capacity concern, not permission to add a `LIMIT`.
- No retention deletion or customer-facing retention period exists. Do not invent either.

## Non-negotiable invariants

- Inspect existing contracts, ports, application services, and tests before creating anything new. Do not build parallel models or paths when an existing boundary applies.
- Do not introduce infrastructure merely because it is familiar. Redis, Kafka, Temporal, graph/vector stores, embeddings, microservices, sharding, and multiregion systems are deferred until evidence requires them.
- Preserve provenance, freshness, evidence snapshots, causal-language checks, deduplication, replay fidelity, verdict locks, notification idempotency, and server-side approval enforcement.
- Optional provider-agnostic AI planning may propose only the next permitted evidence step. Deterministic validation owns tools, budgets, stopping, and approval; fail closed on invalid/unavailable model output.
- Consequential production, pricing, refund, rollout, rollback, and customer-communication actions require appropriate human approval.
- Never substitute sample data for a failed, stale, unauthorized, or unconfigured source.
- Never expose/request secrets or inspect `.env` contents unnecessarily.
- Keep vendor behavior in connectors/adapters and the portable core vendor-neutral.
- Add focused regression coverage for meaningful behavior changes; never loosen tests to get a pass.

## Validation and delivery

```text
npm test
npm run typecheck
npm run build
git diff --check
```

Run focused tests first where appropriate. Live `eval:*`, dogfood, browser, and production-smoke commands require explicit configuration and authorization.

Inspect the complete diff and `git status` before delivery. Do not commit, push, open a pull request, merge, or deploy unless explicitly requested. Never reset, revert, stash, clean, rebase, or discard existing work without explicit authorization.
