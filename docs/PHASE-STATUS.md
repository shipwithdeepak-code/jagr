# Phase status

Frozen baseline:

```text
88feca4af967dd2745f65e444e45695892fc1e43
feat: freeze phase 3c bounded history
```

| Phase | Status | Frozen outcome |
| --- | --- | --- |
| Phase 0A | **Frozen** | Portable boundaries, organization/workspace tenancy, source identity and NormalizedEvent contracts. |
| Phase 1 | **Frozen** | Authenticated server workspaces, persistence/secrets, durable jobs/locks, export/import boundary. |
| Phase 2A | **Frozen** | Target checks, checkpoints/events, relevance fan-out, cadence-slot enqueue. |
| Phase 2B | **Frozen** | Tenant-scoped canonical event resolution and investigation/evidence references. |
| Phase 3A | **Frozen** | Subscription, central admission, resource limits, immutable retry-safe usage. |
| Phase 3B | **Frozen** | Tenant-fair claims, bounded scheduler selection, queue diagnostics, relevance ownership. |
| Phase 3C | **Frozen** | Tenant-bound keyset history, targeted reads, complete paged snapshot/export, explicit size failure. |

## Current limitation

Monitoring retrieves investigations in bounded pages but ultimately materializes the complete investigation ledger because the existing engine expects full history for same-signal deduplication, six-hour reopening, and permanent failed-deployment handling. This is a future capacity/redesign concern, not a Phase 3C correctness failure. Do not add an arbitrary limit that changes those semantics.

## Explicit non-features

- Retention deletion has **not** been implemented. No retention period is promised or approved.
- Phases 0A–3C introduced no new AI/LLM reasoning layer into runtime execution. Jagr retains its pre-existing optional provider-agnostic planner: it may propose the next evidence step, but deterministic validation owns tools, budgets, stopping, and approval. There is no model-controlled execution path.
- Redis, Kafka, Temporal, graph databases, vector stores, embeddings, microservices, multiregion execution, sharding, enterprise SSO, and similar expansion remain intentionally deferred unless measured requirements justify them.
- Billing-provider workflows and customer-facing billing behavior remain deferred; subscription/usage records are internal control-plane primitives.

Integration implementation, configuration, and verification status are separate; see `docs/CONNECTORS.md`.
