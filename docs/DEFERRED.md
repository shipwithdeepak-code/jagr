# Deliberately deferred work

Deferred means “not justified by the frozen system,” not implemented or promised. Re-evaluate only with concrete product, reliability, security, or scale evidence.

## Runtime infrastructure

- **Redis/cache:** Postgres and bounded queries currently provide persistence and coordination; no measured cache requirement exists.
- **Kafka/event bus:** Normalized events, durable cursors, and idempotent Postgres jobs cover current fan-out.
- **Temporal/workflow engine:** Queue leases, retries, locks, checkpoints, and cadence identities cover current workflows.
- **Microservices:** Portable core and thin server/host layers provide replaceable boundaries without distribution cost.
- **Blob storage:** Current imports/exports are normalized document flows; add only if retained raw files/attachments require it.

## AI and intelligence

- **New autonomous LLM control:** The optional planner proposes only an evidence step; deterministic validation owns execution. No evidence supports model control of budgets, stopping, authorization, or actions.
- **Embeddings/vector search:** Evidence is structured, role-based, tenant-scoped, and provenance-bearing; no retrieval requirement justifies it.
- **Knowledge/architecture graph:** Typed contracts and these context docs suffice; do not create an LLM-generated architecture database.
- **Model actions without approval:** Consequential actions remain human-gated and server-enforced.

## Integrations

- **Broad webhook ingestion:** Target polling and normalized events are implemented. Add provider webhooks only with signature, replay, ordering, and reconciliation requirements.
- **Additional vendors/write integrations:** Reuse role/connector contracts only for a product need; do not add placeholders.
- **GitHub App/enterprise variants:** Current connector docs record these gaps; they need explicit auth/deployment scope.

## Billing

- **Payment provider, invoices, checkout, plan UX:** Subscription/usage are internal control-plane primitives only.
- **Customer quotas or SLAs:** Entitlement limits do not define commercial promises.
- **External metering pipeline:** Immutable usage facts exist; export/aggregation requirements are not established.

## Enterprise and security

- **Enterprise SSO/SAML/SCIM:** Current identity providers/memberships do not imply enterprise lifecycle support.
- **Custom roles/ABAC:** Current organization/workspace roles and explicit approval capability are the implemented model.
- **Customer-managed keys, residency, certifications:** Encrypted secrets and tenant boundaries do not establish these commitments.
- **Cross-organization administration:** Organization remains the isolation boundary; no global customer-admin plane exists.

## Scale

- **Multiregion active-active:** Queue leases, locks, and transactions assume one consistent database authority.
- **Sharding:** Tenant fairness and bounded reads address current contention; no threshold/routing requirement exists.
- **Second queue/scheduler tier:** Scheduler selection and worker claims are bounded and fair in Postgres.
- **Incremental ledger engine:** Monitoring materializes the fully paged ledger to preserve dedupe, reopening, and failed-deployment semantics. Redesign requires explicit replacement contracts.
- **Streaming snapshot/export:** Current one-document APIs fail explicitly at a size bound; streaming needs a new format/client contract.

## Data architecture

- **Retention deletion:** No safe duration or complete reference/tombstone strategy exists; record classes have different correctness obligations.
- **Invented retention periods:** Earlier figures were proposals, not guarantees. Policy must precede implementation.
- **Event compaction/tombstones:** Canonical references/job idempotency must remain resolvable; safe expiry markers do not exist.
- **Relationalizing all JSON:** `workspace_docs` intentionally stores domain documents; typed columns/indexes exist only where enforcement or bounded queries require them.
