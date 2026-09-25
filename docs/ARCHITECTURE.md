# Jagr V1 — Integration & Backend Architecture

Status: **approved; in implementation** — see §12 for what is built · Branch: `jagr-v1-productized`

> **Portable by design, single implementation by default.**
> Every piece of infrastructure Jagr depends on sits behind a small port owned by the product. Each port has exactly one production implementation (plus an in-memory one where tests need it). Nothing is abstracted that isn't genuinely replaceable.

---

## 0. Decisions this document encodes

| # | Decision |
|---|---|
| D1 | Deploy history, error monitoring and feature-flag changes are first-class **change/cause evidence**, stronger than Jira release dates. |
| D2 | App Store / Google Play are **P1** (Jagr is a general PM product). |
| D3 | **Amplitude** is the first real `MetricSource`; Mixpanel plugs into the same interface later. |
| D4 | A **real server-side backend** is a P0 prerequisite. No faked OAuth; no provider credentials in the browser. |
| D5 | The investigator asks for evidence **by role, never by vendor**. |
| D6 | CSV/JSON import stays a **universal fallback** for every role. |
| D7 | The backend is **infrastructure-portable**: Vercel / managed Postgres / Vercel Cron / Google+GitHub sign-in are implementations, not dependencies. |
| D8 | A versioned **Jagr Workspace Export v1** is the only path between a browser-local workspace and a server workspace (and, later, between backends). |
| D9 | **Owner-configured single-tenant mode** is the early dogfooding path. |
| D10 | Intercom is the first `FeedbackSource`. Slack is **outbound only**. No provider writes except Slack notifications. |

---

## 1. Final architecture

```
┌─────────────────────────────── Browser (React) ──────────────────────────────────┐
│ UI · Local mode (My data / Sample workspace / Demo night) · local persistence    │
│ adapter (localStorage, src/state) · Export/Import buttons                        │
└───────────────┬──────────────────────────────────────────────────┬───────────────┘
                │ HTTPS + session cookie (never provider secrets)   │ local mode runs the
                ▼                                                   ▼ same core in-browser
┌──────────── Host entry points (thin, deployment-specific) — api/** ──────────────┐
│ Vercel functions: api/[...route].ts · api/cron/tick.ts · api/planner.ts          │
│ (only job: translate the host's request into a call on server/runtime)           │
└───────────────┬──────────────────────────────────────────────────────────────────┘
                ▼
┌──────────── Infrastructure adapters — server/** (Node) ──────────────────────────┐
│ http/ neutral router + node adapter · postgres/ repositories, job queue,         │
│ encrypted secret store, migrations · identity/ google, github ·                  │
│ crypto/ env key provider · runtime/ composition root (wires ports → services)    │
└───────────────┬──────────────────────────────────────────────────────────────────┘
                ▼  implements ports ▲ depends on nothing below
┌──────────── Product core — src/product/** (pure TypeScript) ─────────────────────┐
│ app/     application services: runWatch · schedulerTick · syncConnection ·       │
│          connectSource · decideApproval · exportWorkspace · importWorkspace      │
│ ports/   Repositories · JobQueue · SecretStore · IdentityProvider ·              │
│          NotificationChannel · HttpClient · Clock                                │
│ roles/   MetricSource · ChangeSource · WorkItemSource · FeedbackSource ·         │
│          ConversationSource · ContextSource · SourceRegistry · EvidenceService   │
│ engine/ agent/  detection · investigator · planner · policy · attention (exists) │
│ integrations/connectors/<vendor>/  pure connectors (HttpClient + credential)     │
│ imports/  CSV/JSON → role records (exists)      export/  Workspace Export v1     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Dependency rule: **arrows point inward only.** `api/ → server/ → src/product/`. `src/ui` (React) → `src/product/`. `src/product/` imports nothing outside itself except `zod`.

---

## 2. Infrastructure ports

All ports live in `src/product/ports/`. Each is a TypeScript interface with no infrastructure types in its signature (no `pg` rows, no Vercel request, no SDK objects).

| # | Port | Owns | Initial implementation | Replaceable by (later, not built) |
|---|---|---|---|---|
| 1 | **Repositories** + `Transactor` | Durable domain state | `server/postgres/*` (managed Postgres; driver behind the adapter) | Any SQL DB, a document store |
| 2 | **JobQueue** | Durable background work | Postgres table, `FOR UPDATE SKIP LOCKED` leases | SQS, Cloud Tasks, Redis queue |
| 3 | **Scheduler** (inbound) + `Clock` | *When* work becomes due | Vercel Cron → `api/cron/tick.ts` → `schedulerTick()` | Node interval, k8s CronJob, Cloud Scheduler |
| 4 | **SecretStore** (+ internal `KeyProvider`) | Provider credentials | AES-256-GCM envelope encryption in Postgres; master key from env | KMS for key management; Vault/Secrets Manager for storage |
| 5 | **IdentityProvider** | *Who* the user is | Google (OIDC) and GitHub (OAuth) | Any OIDC provider, enterprise SSO (not built) |
| 6 | **BlobStore** | Large binary objects | **Not required in P0** — see §2.6 | S3/R2/GCS if ever needed |
| 7 | **NotificationChannel** | Outbound messages | In-app/email renderer (exists) and Slack | Email provider, Teams |
| — | **HttpClient** | Outbound HTTP for connectors and planner | Platform `fetch`, injected | — (already the pattern in `jiraCloud.ts` and the planner) |

`HttpClient` and `Clock` are not infrastructure choices; they exist so the core never touches globals and tests stay deterministic.

### 2.1 Repositories

```ts
interface Repositories {
  workspaces:     { get(id): Promise<Workspace | null>; create(w): Promise<void>; update(w, expectedVersion): Promise<void> };
  members:        { forUser(userId): Promise<Membership[]>; forWorkspace(wsId): Promise<Membership[]>; add(m): Promise<void> };
  users:          { byIdentity(provider, subject): Promise<User | null>; create(u): Promise<User> };
  sessions:       { create(s): Promise<void>; get(id): Promise<Session | null>; revoke(id): Promise<void> };
  watches:        { list(wsId); get(wsId, id); save(wsId, w); remove(wsId, id) };
  metricDefs:     { list(wsId); save(wsId, d); remove(wsId, key) };
  connections:    { list(wsId); get(wsId, id); save(wsId, c); remove(wsId, id) };   // holds a SecretRef, never a secret
  records:        { upsert(wsId, connId, batch: RoleRecordBatch); query(wsId, q: RoleRecordQuery); purge(wsId, connId) };
  metricCache:    { get(wsId, key); put(wsId, key, series, expiresAt) };
  cursors:        { get(connId, stream); set(connId, stream, cursor) };
  investigations: { save(wsId, inv /* incl. evidence snapshot + trace */); get(wsId, id); list(wsId, filter) };
  approvals:      { list(wsId, filter); decide(wsId, actionId, decision, expectedVersion) };   // optimistic concurrency
  imports:        { list(wsId); save(wsId, dataset); remove(wsId, id) };
  audit:          { append(entry: AuditEntry): Promise<void> };
}
interface Transactor { run<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> }
```

- Every method takes `wsId`: tenant scoping is in the contract, not a convention.
- Implementations: **Postgres** (production) and **in-memory** (tests, and the reference implementation for the contract suite). No others.
- Browser-local mode does **not** implement `Repositories`; it keeps its single JSON document and moves to the server only through the export format (§8).

### 2.2 JobQueue

```ts
interface JobQueue {
  enqueue(job: { kind: JobKind; workspaceId: string; payload: unknown; runAt?: ISO; idempotencyKey: string }): Promise<void>;
  claim(opts: { workerId: string; kinds?: JobKind[]; limit: number; leaseMs: number }): Promise<LeasedJob[]>;
  complete(jobId: string, leaseToken: string): Promise<void>;
  fail(jobId: string, leaseToken: string, error: string, retryAt?: ISO): Promise<void>;   // retryAt absent → dead-letter
  extend(jobId: string, leaseToken: string, leaseMs: number): Promise<void>;
}
type JobKind = 'monitor.watch' | 'sync.connection' | 'notify.deliver' | 'brief.compose';
```

Semantics are at-least-once; every handler is idempotent (keyed by `idempotencyKey`). Handlers are chunked to finish well inside the host's function time limit.

### 2.3 Scheduler

The scheduler is an **inbound** port: something outside the product calls the product on a cadence.

```ts
// src/product/app/scheduler.ts — pure; reuses the existing deterministic scheduler (src/product/scheduler.ts)
function schedulerTick(deps: { repos: Repositories; queue: JobQueue; clock: Clock }): Promise<TickReport>;
interface Clock { now(): ISO }
```

`schedulerTick` computes due watch runs, due syncs and due briefs since the last tick and enqueues them (idempotency key = `kind:target:dueAt`, so overlapping or duplicate ticks are harmless), then drains a bounded number of jobs. The Vercel Cron adapter is ~20 lines in `api/cron/tick.ts`: verify the cron secret, call `schedulerTick`. Replacing Vercel Cron means calling the same function from something else.

### 2.4 SecretStore

```ts
interface SecretStore {
  put(owner: { workspaceId: string; connectionId: string }, secret: SecretPayload): Promise<SecretRef>;
  get(ref: SecretRef): Promise<{ secret: SecretPayload; version: number }>;
  replace(ref: SecretRef, expectedVersion: number, secret: SecretPayload): Promise<void>;  // compare-and-swap: safe rotating refresh tokens
  delete(ref: SecretRef): Promise<void>;
}
type SecretPayload =
  | { kind: 'api_key'; fields: Record<string, string> }                       // Amplitude key + secret
  | { kind: 'oauth'; accessToken: string; refreshToken?: string; expiresAt?: ISO; scopes: string[] }
  | { kind: 'app_installation'; installationId: string };                     // GitHub App (private key is a deployment secret, not a tenant secret)
```

- Initial implementation: encrypted rows in Postgres. A per-secret data key encrypts the payload (AES-256-GCM); the data key is wrapped by a master key from `server/crypto` `KeyProvider` (`currentKey()`, `key(version)`). The master key comes from an environment variable; **KMS replaces only the `KeyProvider`**, not the store.
- `replace` with an expected version prevents two workers from racing a rotating Jira refresh token.
- Secrets never enter domain objects, logs, traces, exports, or HTTP responses. Connections hold an opaque `SecretRef`.

### 2.5 IdentityProvider

```ts
interface IdentityProvider {
  readonly id: 'google' | 'github';
  authorizationUrl(i: { state: string; codeVerifier: string; redirectUri: string }): string;
  exchange(i: { code: string; codeVerifier: string; redirectUri: string }): Promise<VerifiedIdentity>;
}
interface VerifiedIdentity { provider: string; subject: string; email?: string; emailVerified: boolean; displayName?: string }
```

- The **application** (`app/auth.ts`) owns users, sessions and memberships. It links identities by `(provider, subject)`, **never by email alone** (prevents account takeover via an unverified email).
- Implementations use plain OAuth 2.0 / OIDC over `HttpClient` in `server/identity/`. No auth SDK or hosted-auth vendor in `src/product/`.
- **Integration OAuth (Jira, Intercom, Slack) is not identity.** It uses a separate, generic `OAuth2Descriptor` (authorize URL, token URL, scopes, PKCE support) that each connector declares as data; the token exchange runs in `app/connectSource.ts` over `HttpClient`, and tokens go to `SecretStore`.

### 2.6 BlobStore — not required in P0

Jagr stores **normalized records**, not raw files: an uploaded CSV is parsed and validated, and its records are kept (as today). Exports are generated as JSON and streamed. The one pressure point is request size on the host (Vercel functions cap request bodies at roughly 4.5 MB — *verify*); P0 handles large imports and workspace exports with a **chunked upload** endpoint rather than blob storage. A `BlobStore` port is added only if Jagr starts keeping raw uploads or attachments.

### 2.7 NotificationChannel

```ts
interface NotificationChannel {
  readonly kind: 'in_app' | 'slack';
  send(msg: NotificationMessage, target: DeliveryTarget): Promise<DeliveryReceipt>;
}
interface NotificationMessage {           // domain-level; each channel renders it
  kind: 'investigation_confirmed' | 'approval_requested' | 'morning_brief' | 'resolved';
  workspaceId: string; title: string; attention: AttentionLevel; summary: string;
  observed: string[]; inferred: string[]; unknown: string[];
  links: { label: string; href: string }[];         // signed deep links into Jagr
  approval?: { actionId: string; risk: ActionRisk; what: string };
}
```

- **In-app/email renderer** (exists today; renders, never sends) is the first implementation.
- **Slack** renders Block Kit and posts with `chat:write` to user-selected channels. Approvals are *requested* in Slack and *decided* in Jagr by a signed-in member.

### 2.8 Enforcing the boundary

1. **Separate compiler settings for the core.** `tsconfig.product.json` compiles `src/product/**` with `lib: ["ES2022"]` — **no `DOM`, no `node` types** — plus a tiny `src/product/runtime.d.ts` declaring the only universal globals the core may use (`setTimeout`, `clearTimeout`, `TextEncoder`/`TextDecoder`). `window`, `localStorage`, `document`, `process` and `fetch` then **fail typecheck** inside the core. `npm run typecheck` runs both configs.
2. **Architecture test** (`src/product/architecture.test.ts`): walks `src/product/**` and fails on imports of `node:*`, `react*`, `@vercel/*`, `pg`, `postgres`, `@neondatabase/*`, any auth SDK, `vite`, `@/state/*`, `@/components/*`, `@/pages/*`; and asserts `api/**` imports only `server/runtime`.
3. **Existing violations to fix** (found by audit — everything else in `src/product/` is already clean):
   - `src/product/agent/providers/node.ts` imports `node:http` → moves to `server/http/node.ts`.
   - `src/product/live/plannerComparison.live.ts` reads env via `vite` → moves to `scripts/eval/`.
   - `src/product/integrations/jiraCloud.ts` types its client as `typeof fetch` → uses the `HttpClient` port.

---

## 3. Role-based source interfaces

(Unchanged from the approved plan; summarized.) The investigator's Toolbox talks only to an `EvidenceService`, which fans a role query out to every source registered for that role and merges results with provenance.

```ts
type Role = 'metrics' | 'changes' | 'work_items' | 'feedback' | 'conversations' | 'context';
interface SourceHealth { connectionId; provider; mode: 'connected'|'imported'|'simulated';
  state: 'ok'|'stale'|'unavailable'|'error'|'rate_limited'|'not_configured'; freshAsOf?: ISO; detail?: string }
interface RoleResult<T> { records: T[]; coverage: SourceHealth[] }   // "found nothing" ≠ "couldn't look"

interface MetricSource      { listMetrics(); getSeries(q); listDimensions(metricKey); getBreakdown(q) }
interface ChangeSource      { getChanges(q: { window; kinds?: ChangeKind[]; area? }) }
interface WorkItemSource    { getWorkItems(q: { window; types?; area? }) }
interface FeedbackSource    { getFeedback(q: { window; area?; negativeOnly? }); getVolume(q) }
interface ConversationSource{ searchMessages(q) }   // P1 — interface only in P0
interface ContextSource     { findDocuments(q) }    // P2 — interface only in P0
```

Planner-visible tools become role tools: `getMetric`, `getMetricBreakdown`, `getChanges`, `getWorkItems`, `getFeedback`, `getFeedbackVolume`. The 9-call budget, policy validator and approval gate are unchanged. `ActionKind` becomes role-neutral (`create_jira_task` → `draft_work_item`, `pause_rollout` → `pause_change_rollout`, …).

| Source | Roles | Phase |
|---|---|---|
| Amplitude | Metric, Change (annotations) | P0 |
| GitHub | Change (deployments `actual`, releases) | P0 |
| Jira | WorkItem, Change (versions `planned`) | P0 |
| Intercom | Feedback | P0 |
| CSV/JSON import · Simulated | all roles | exists / extended in P0 |
| Sentry | Metric (error rate), Change (`incident`) | architecture + import in P0; connector P1 |
| Feature flags (LaunchDarkly/Statsig) | Change (`flag_change`, `experiment_change`) | architecture + import in P0; connector P1 |
| Mixpanel, GA4, App Store, Google Play, Zendesk | Metric / Change / Feedback | P1 |
| Slack inbound | Conversation | P1 |
| Confluence, Notion / Canny, Dovetail | Context / Feedback | P2 |

---

## 4. Integration data model

Normalized records carry one provenance block (`connectionId, provider, mode, externalId, url?, observedAt, fetchedAt`):

- `MetricDefinition { key, name, unit, badDirection, mode, threshold, area, binding: { connectionId, query } }`
- `MetricSeries`, `SegmentSeries { dimension, segment }`
- `ChangeRecord { kind: deploy|release|flag_change|experiment_change|config_change|annotation|incident, at, timing: actual|planned|reported, status?, version?, environment?, service?, scope?: { platform?, area?, rolloutPct? } }`
- `WorkItem { type: bug|incident|task|other, priority: critical|high|medium|low, status, labels, components, area?, versions, createdAt, resolvedAt? }`
- `FeedbackItem { channel: support|review|survey|request, text (redacted), rating?, tags, area?, version?, createdAt }`

`timing` feeds hypothesis strength: temporal alignment with an `actual` change may reach *moderate*; with a `planned` date it is capped at *weak*. The causality guard is unchanged.

Server tables (Postgres implementation detail, not a contract): `users, identities, sessions, workspaces, memberships, connections, secrets, sync_cursors, metric_definitions, watches, change_records, work_items, feedback_items, metric_cache, imports, investigations, investigation_snapshots, actions, approvals, notifications, jobs, audit_log`.

---

## 5. Credential & security model

- Browser holds a session cookie only (httpOnly, Secure, SameSite=Lax; CSRF token on mutations). Provider secrets are POSTed once and never returned.
- Secrets: `SecretStore` (§2.4). Decrypted only inside the request/job that uses them; scrubbed from errors and logs.
- Least privilege per provider:

| Provider | Auth | Scope / permission |
|---|---|---|
| Amplitude | API key + secret key | Dashboard REST API read (key is project-wide — disclosed in UI) |
| GitHub | GitHub App installation, org-selected repos | Deployments: read · Contents: read · Metadata: read; 1-hour installation tokens |
| Jira | Atlassian OAuth 2.0 (3LO) | `read:jira-work`, `offline_access`; rotating refresh via `SecretStore.replace` |
| Intercom | Intercom OAuth | read conversations + tags *(verify token lifetime & app review for multi-workspace install)* |
| Slack | Slack OAuth v2 bot | `chat:write` only |

- OAuth: session-bound `state`, PKCE where supported, allow-listed redirect URIs.
- Webhooks: HMAC verification (GitHub `X-Hub-Signature-256`), idempotent by delivery id; data re-fetched rather than trusted.
- Tenant isolation: `wsId` on every repository method.
- LLM egress: PII redaction on feedback and work-item text before any planner call; per-workspace AI toggle.
- Disconnect: revoke at provider where supported → delete secret → optional purge of synced records.
- Approvals enforced server-side (`can_approve`); Slack carries a signed deep link, never an approve button in P0.
- Audit log: connection lifecycle, secret rotation, approvals, outbound notifications, workspace import/export.
- **Single-tenant mode** (§9): credentials come from deployment environment variables and are *seeded into* `SecretStore` at startup; sign-in is restricted to an owner allowlist. Same code path as multi-tenant from then on.

---

## 6. Sync model

| Role | P0 source | Mode | Cadence | Stored |
|---|---|---|---|---|
| Metrics | Amplitude | query at monitoring time + cache | watch cadence | aggregated series cache; investigation snapshot. No raw events. |
| Changes | GitHub | webhook + reconcile poll | real-time; hourly reconcile | ChangeRecords |
| Changes | Amplitude annotations | poll with metrics | watch cadence | ChangeRecords (`reported`) |
| Work items / changes | Jira | JQL `updated >= watermark − overlap` | 15 min | WorkItems; versions as `planned` ChangeRecords |
| Feedback | Intercom | `updated_at > watermark` | 15 min | redacted FeedbackItems + volume series |
| Outbound | Slack | on event | immediate | delivery log |

- **Freshness rule:** negative evidence ("no deploys in window") is asserted only when every source for that role is `ok` and fresh through the window end; otherwise it becomes a recorded gap.
- Backfill 30 days; retain normalized records 90 days; investigation snapshots live as long as the investigation.
- One sync in flight per connection; honor `Retry-After`; jittered backoff.

---

## 7. Where things live

```
src/product/            core: domain + application (pure TS)       ← no browser, Node, Vercel, Postgres, auth SDKs
  ports/  roles/  app/  export/  (new)
  engine/ agent/ imports/ integrations/ … (existing; no reshuffle)
  integrations/connectors/{amplitude,github,jira,intercom,slack}/   (new; pure)
server/                 infrastructure adapters (Node)
  http/ postgres/ identity/ crypto/ runtime/
api/                    host entry points (Vercel) — thin
src/state, src/components, src/pages   browser UI + local persistence adapter
scripts/eval/           manual live evaluations (planners, connectors)
```

---

## 8. Jagr Workspace Export v1

The portable, versioned representation of one workspace. It is defined by a zod schema in `src/product/export/v1.ts`, is **not** derived from Postgres tables, and is the only supported path for:

- browser-local workspace → server workspace
- server workspace → file (backup) → server workspace
- backend A → backend B (future)

### 8.1 Shape

```jsonc
{
  "format": "jagr.workspace-export",
  "version": 1,
  "exportId": "01J…",                       // unique per export; makes re-import detectable
  "exportedAt": "2026-09-25T09:00:00Z",
  "producer": { "app": "jagr", "appVersion": "1.1.0", "origin": "browser-local" | "server" },

  "workspace": {
    "id": "ws_…", "name": "…", "mode": "imported" | "sample" | "connected",
    "createdAt": "…",
    "settings": { "planner": "deterministic" | "llm", "aiEgressAllowed": true, "timezone": "Europe/London" },
    "brief": { /* BriefSchedule */ }
  },

  "connections": [                          // configuration only — NEVER secrets
    { "id": "conn_…", "provider": "amplitude", "roles": ["metrics","changes"], "mode": "connected",
      "externalAccount": "Amplitude project 12345", "config": { /* non-secret: repos, projects, area mappings */ } }
  ],
  "metricDefinitions": [ { "key": "checkout_conversion", "…": "…", "binding": { "connectionId": "conn_…", "query": {} } } ],
  "watches": [ /* Watch, role-based signal keys */ ],

  "imports": [                              // user-imported datasets: the data IS the source, so records are included
    { "id": "imp_…", "kind": "metrics" | "changes" | "work_items" | "feedback",
      "filename": "metrics.csv", "format": "csv", "importedAt": "…", "columns": [], "totalRows": 0,
      "records": [ /* role records */ ], "rejected": [ { "line": 7, "reason": "…" } ], "notes": [] }
  ],

  "investigations": [
    { /* WatchInvestigation: signal, evidence, hypotheses, observed/inferred/unknown, attention, state history */
      "trace": [ /* TraceStep[] */ ],
      "snapshot": { "metrics": [], "changes": [], "workItems": [], "feedback": [], "coverage": [] }   // exactly what the investigation saw
    }
  ],
  "actions":   [ { "id": "…", "investigationId": "…", "kind": "draft_work_item", "risk": "HIGH", "status": "awaiting_approval", "draft": {} } ],
  "approvals": [ { "actionId": "…", "decision": "approved" | "rejected" | "modified", "decidedAt": "…", "actor": { "ref": "actor_1", "displayName": "Deepak" }, "note": "…" } ],
  "notifications": [ /* delivered notification history (rendered content, channel kind, deliveredAt) */ ]
}
```

"Tasks" in the product workspace are the proposed **actions** and their drafts (e.g. a copyable work-item draft), plus their approval decisions. Demo night's scripted tasks are not a workspace and are never exported.

### 8.2 Rules

- **Never contains:** secrets, `SecretRef`s, session data, provider tokens, raw webhook payloads, or email addresses. Actors are exported as `{ ref, displayName }`; on import they map to the importing user or remain historical actors.
- **Connected-source data** is not bulk-exported: only the configuration plus each investigation's evidence snapshot. After import, connections arrive as `needs_reconnect`, and the target backend re-syncs.
- **Imported-source data** (CSV/JSON) is included, because it is the source.
- **IDs** are preserved within the workspace (so traces, evidence and approvals stay linked). The target assigns a new workspace id and records `importedFrom: { exportId, workspaceId, origin }`.
- **Versioning:** the importer accepts `version <= current`, applies a forward migration chain (`v1 → v2 → …`, pure functions in `src/product/export/migrations/`), then validates. A newer-than-supported version is rejected with a clear message. Exporters always write the current version.
- **Idempotency:** importing an `exportId` already imported into that workspace is refused; "import as a new workspace" is always available.
- **Validation before commit:** import runs as a dry run first and returns a report (counts per section, anything rejected and why); nothing is written until the user confirms.
- **Size:** streamed on export; chunked upload on import (§2.6).

### 8.3 Local → server flow

1. User signs in. Jagr offers **Move this workspace to your account**.
2. The browser builds Export v1 from local state (`jagr:product:v2`, after the role refactor's local migration).
3. Chunked upload → server dry run → report shown → user confirms → workspace created in one transaction.
4. The local copy is **kept** until the user deletes it; Jagr never deletes it automatically.
5. **Download export** / **Import export** are available in both local and server mode (backup and portability for free).

### 8.4 Guarantees tested

- Round trip: local state → export → import (in-memory repositories) → export → equal, apart from `exportId`/`exportedAt`/workspace id.
- Committed golden fixture `export-v1.sample.json`: every future version must still import it.
- Secret scanner test: no export ever contains a field from `SecretPayload` or a token-shaped string.

---

## 9. Owner-configured single-tenant mode (dogfooding)

Not a separate architecture — a deployment configuration of the same backend.

- `JAGR_MODE=single-tenant`, `JAGR_OWNER_IDENTITIES=google:<sub>,github:<id>` (sign-in allowlist).
- Provider credentials as deployment env vars (`JAGR_AMPLITUDE_API_KEY/SECRET`, `JAGR_GITHUB_APP_*`, `JAGR_JIRA_SITE/EMAIL/API_TOKEN`, `JAGR_INTERCOM_TOKEN`, `JAGR_SLACK_BOT_TOKEN/CHANNEL`) are **seeded into `SecretStore` at startup** and bound to the owner's single workspace.
- Consequence: each connector can be dogfooded with static owner credentials **before** its multi-tenant connect flow (OAuth UI) exists. Each connector step therefore ships in two halves: (a) connector + single-tenant dogfood, (b) multi-tenant connect flow.
- Nothing is stored in the browser; nothing about OAuth is faked — static tokens are labelled as owner-configured in Sources.

---

## 10. P0 implementation sequence

Every step ends green: `npm test`, both typechecks, build, and **unchanged verdicts** on the golden, adversarial and planner evaluation suites.

| # | Step | Delivers | Exit criteria | Backend? | Size |
|---|---|---|---|---|---|
| 1 | **Role-based source refactor** | `roles/`, `SourceRegistry`, `EvidenceService`, role tools, planner schema/prompt/policy on roles, role-neutral `ActionKind`, role-based `SignalKey`; simulated + imported worlds as role sources; local-state migration `v2 → v3` | Evaluation verdicts unchanged; no vendor names in `ToolName`/`SignalKey`; local workspaces survive reload | No | L |
| 2 | **Change & freshness evidence** | `ChangeRecord.timing`, deploy/flag/incident kinds, coverage/freshness gaps, timing-aware strength; sample workspace gains a deploy | New golden cases for actual-vs-planned timing and stale-source gaps | No | M |
| 3 | **Import extensions** | Changes dataset (deploys, flag changes, incidents); feedback `channel`/`tags`; sample files | BYOD tests for each new column and rejection reason | No | S |
| 4 | **Ports + Workspace Export v1** | `ports/` (all §2 interfaces), in-memory Repositories/JobQueue/SecretStore for tests, repository & queue **contract suites**, `tsconfig.product.json`, architecture test, the 3 boundary fixes, Export v1 schema + exporter/importer + Download/Import in local mode | Architecture test + product typecheck pass; round-trip and golden-fixture export tests pass | No | M–L |
| 5 | **Backend foundation** | `server/`: Postgres repositories + migrations, Postgres JobQueue, encrypted SecretStore + env KeyProvider, Google/GitHub IdentityProvider, sessions, neutral HTTP router, cron tick, server-side `runWatch`, local→server move via Export v1, audit log, **single-tenant mode** | Postgres adapters pass the same contract suites as in-memory; overnight run happens with the browser closed | Yes | L |
| 6 | **Amplitude** | MetricSource + annotations ChangeSource; metric-mapping UI; (a) single-tenant dogfood, (b) key-based connect flow | Connector contract suite; manual `eval:connectors` live check | Yes | M |
| 7 | **GitHub** | GitHub App: deployments + releases, webhook ingress, reconcile; (a) dogfood, (b) install flow | Webhook signature + idempotency tests | Yes | M |
| 8 | **Jira** | Existing connector → role interfaces; (a) dogfood with API token, (b) Atlassian OAuth 3LO with rotating refresh | Refresh-race test via `SecretStore.replace` | Yes | M |
| 9 | **Intercom** | FeedbackSource: conversations, tags, volume; PII redaction; (a) dogfood, (b) OAuth | Redaction tests on planner input | Yes | M |
| 10 | **Slack outbound** | NotificationChannel: Block Kit rendering, channel picker, signed deep links, delivery log; (a) dogfood, (b) OAuth install | Rendering snapshots; no approval executes from Slack | Yes | S–M |

Steps 1–4 need no accounts or hosting and can proceed while hosting/database accounts are set up.

### What can be delivered without accounts/auth (steps 1–4)

Provider-agnostic role engine · deploy/flag/incident evidence with timing-aware strength · freshness gaps · Changes import (Sentry and flag data via CSV/JSON today) · all ports with in-memory implementations and contract suites · enforced core boundary · Workspace Export v1 with download/import in local mode.

### What requires real backend infrastructure (steps 5–10)

Accounts and sessions · shared/multi-device workspaces · every OAuth/App install flow · encrypted credential storage and token refresh · webhooks · monitoring while the browser is closed · Slack delivery · server-enforced approvals for multiple users · audit log · durable investigation snapshots · single-tenant dogfood deployment.

---

## 11. Explicitly NOT built in P0

- **Second implementations of any port** (no MySQL/SQLite, no SQS, no KMS, no other identity providers, no BlobStore). Only the boundaries.
- **Connectors:** Mixpanel, Sentry, feature flags, App Store, Google Play, GA4, Zendesk (P1); Confluence, Notion, Canny, Dovetail (P2). Sentry and flags exist as role mappings + CSV/JSON import only.
- **Slack inbound** of any kind; `ConversationSource` and `ContextSource` are interfaces only and not exposed to the planner.
- **Provider writes:** no Jira issue creation, rollbacks, flag toggles, GitHub actions, Intercom replies. Actions remain drafts/recommendations; the only outbound write is Slack messages to user-selected channels.
- **Approve from Slack** (interactive buttons) — P1.
- Jira and Intercom **webhooks** (polling in P0); raw event warehousing; backfill beyond 30 days.
- Enterprise SSO/SAML, SCIM, billing, org hierarchy, RBAC beyond owner/admin/member + `can_approve`, SOC 2 work, regional data hosting.
- Public marketplace listings/app reviews (Slack, Atlassian, Intercom); P0 apps are installed by design partners directly *(verify each provider's non-marketplace install limits)*.
- Real email delivery, telemetry, training on customer data, UI redesign beyond sign-in / connections / metric mapping / export-import, and any change to Demo night.

---

## 12. Implementation status

| Step | Status | Notes |
|---|---|---|
| 1 Role-based source refactor | **Done** | Role interfaces + `SourceRegistry` (`src/product/roles/`); role tools replace vendor tools; `SignalKey` is `metric:<key>` / `work_items` / `feedback` / `changes`; action kinds vendor-neutral; native adapters bridged to roles with provenance (`integrations/bridge.ts`); stored workspaces migrate v2 → v3 (`migrations/roles.ts`, tested on a real v2 workspace); every golden/adversarial/planner verdict and investigation conclusion matches the pre-refactor baseline (`evaluation/verdicts.baseline.json`). Brought forward from step 4 so the core compiles alone: `HttpClient` port, `tsconfig.product.json`, architecture test, and the three boundary moves. |

| 2 Change + freshness evidence | **Done** | `ChangeRecord.kind` (deploy, release, flag/experiment/config change, annotation, incident) and `timing` (actual / planned / reported). Only actual or reported timing can form a temporal association; a planned date is shown as evidence and kept as an unknown ("only its planned date is known"), and while a source with real timing is left, the timing question stays open. Incidents are evidence, never a preceding change. `getChanges` is one role query across every change source in the watch, with per-source coverage: a source that is down, unconfigured or stale is a gap, and "no releases" is recorded only for sources that answered completely. `SourceConnection.freshAsOf` marks stale data; the simulated connector hides anything after it. |

| 3 Import extensions | **Done** | A `changes` import kind (deploy, release, flag / experiment / config change, annotation, incident; timing, status, platform, rollout — each validated with line-numbered rejections); feedback `channel` (review / support / survey / request; unrated support and requests accepted) and `tags` (used for area classification). Imported changes join the imported change channel and reach the engine through the same role source as a connector, with `import` provenance. Imports are treated as complete as of upload (never stale). Datasets saved before this step load unchanged. |

| 4 Ports + Workspace Export v1 | **Done** | Ports in `src/product/ports/`: Repositories + Transactor (workspace-scoped, optimistic), JobQueue (leases, idempotency keys, retries, dead-letter), Clock, SecretStore (compare-and-swap replace), IdentityProvider, NotificationChannel, HttpClient, BlobStore (declared, unused). In-memory implementations (`ports/memory.ts`) and contract suites (`testkit/portContracts.ts`) that every real adapter must pass. `app/scheduler.ts`: the scheduler tick (grid-aligned runs, idempotent keys, latest-missed-run only). Workspace Export v1 (`export/`): zod-validated envelope, canonical JSON, email redaction and fail-closed secret/token scan, `upgradeExport` chain, dry-run `planImport` with a validation report, `commitServerImport` in one transaction (duplicate export refused in the dry run and again inside the write), browser-local export/import with a confirmation step (Sources → Workspace export). Committed fixture `export/__fixtures__/export-v1.sample.json`. |

| 5 Backend foundation | **Done** | `server/`: Postgres adapters behind the ports (`postgres/`: SQL client for `pg` and PGlite, ordered migrations, document-per-row repositories, SKIP LOCKED job queue, envelope-encrypted secret store with key rotation), `crypto/keys.ts` (env KeyProvider — KMS replaces only this), Google and GitHub `IdentityProvider`s (PKCE; identities linked by provider + subject), sessions (hashed at rest, httpOnly cookies), signed OAuth state, double-submit CSRF, a framework-neutral API (`app.ts`), the composition root (`runtime.ts`), Node / Vercel adapters (`http/api.ts`, `api/[...route].ts`), Vercel Cron → `/api/cron/tick` (scheduler tick + bounded job drain). Server-side monitoring in the core (`app/monitoring.ts`): scheduled watch runs continue stored investigations (`runMonitoring({ jobs, investigations })`); imported and sample workspaces run on demand. Local → server: dry run + confirmed commit (`/api/import/plan`, `/api/import/commit`), and a thin "copy to my account" step on the export card when a backend is present. The Postgres adapters pass the same contract suites as the in-memory ones, on real Postgres (PGlite). |

| 6 Single-tenant dogfood mode | **Done** | `server/singleTenant.ts`: with `JAGR_MODE=single-tenant`, runtime start creates the owner workspace (`ws_owner`, connected) and one connection per provider whose env credentials are complete (Amplitude, GitHub token or App, Jira, Intercom, Slack). Credentials are copied into the encrypted SecretStore; the connection holds only a `SecretRef` and non-secret config (the Jira account email is part of the credential, so it lives in the secret). A keyed fingerprint (HMAC with the session secret, stored as a workspace cursor, not exported) detects env changes: a changed value is rotated in place (CAS `replace`), a removed one marks the connection `not_configured` and deletes the stored secret. Audit entries name env var names, never values. Sign-in is limited to `JAGR_OWNER_IDENTITIES`; the owner is added to the owner workspace on sign-in. Watches: `POST/DELETE /api/workspaces/:id/watches` (template + sources that exist in the workspace). Connectors read these connections through the same `ConnectorFactory` path as future OAuth ones; until one is registered the source is reported as a gap ("No connector …"), never sample data. |

| 7 Connector contracts | **Done** | `integrations/connectors/`: `ConnectorDescriptor` (zod config, accepted credential kinds, declared hosts, `build`, `check`), `restrictHosts` (https + declared hosts only, so a config can never point a credential elsewhere), `requestJson` (timeouts; 401/403 → `ConnectorAuthError`, 429 → `ConnectorRateLimited` with Retry-After, 5xx/network/timeout → unavailable, unreadable → error; messages never echo URLs, headers or bodies), `provenance()`, `redactPersonalData()`, `connectorsFrom()`. `testkit/connectorContract.ts`: the role-source contract plus mapping, provenance, host, config, failure-classification, no-leak, isolation and health checks, run against recorded responses. Monitoring: one broken connection (missing credential, invalid config) is a gap for that run; `checkConnection` records health (rejected credential → `needs_reconnect`; outage → `lastError` only). `POST /api/workspaces/:id/connections/:cid/check`. See `docs/CONNECTORS.md`. |

| 8 Amplitude | **Done (fixtures), live unverified** | `integrations/connectors/amplitude.ts`: MetricSource over hourly event segmentation (count and ratio bindings, seasonal same-hour 7-day baseline, complete hours only, breakdowns by configured properties) and ChangeSource over chart annotations (timed → `reported`, date-only → day precision, never timing evidence; personal data redacted). Passes the connector contract on fixtures in the documented response shape; an end-to-end test runs a scheduled watch on a connected workspace backed only by Amplitude and gets a detected, investigated drop with connected (non-simulated) evidence. Server watches in connected workspaces take their metric signals from the metrics the workspace's sources actually serve. `npm run eval:connectors` is the manual live check (skipped when credentials are absent; it was not run against a live project in this build). |

| 9 GitHub | **Done (fixtures), live unverified** | `integrations/connectors/github.ts`: ChangeSource over deployments (time = first `success` status → `actual`; failures at their failure time; still-running → `in_progress`, `reported`, as of the run) and releases (published, non-draft → `reported`, with "when users received it is not known"). Rate-limit 403s are classified as rate limits (`requestJson` gained an `isRateLimited` hook). End-to-end with Amplitude: a deploy finishing 15 min before a connected drop is reported as a temporal association with actual timing — never as a cause; with GitHub down, the change question stays open and the gap is named. Token auth only: GitHub App credentials are refused as invalid configuration (documented debt). |

| 10 Jira | **Done (fixtures), live unverified** | `integrations/connectors/jira.ts` on the existing `JiraCloudAdapter`: WorkItemSource (issues created in the window; reporter identity dropped; customer contact details redacted; `/browse` deep links) and ChangeSource (released versions, `planned` day-precision timing). The client's own HTTP now goes through `requestJson` (it previously echoed network error messages) and fails closed on unreadable bodies. Config accepts only `https://<name>.atlassian.net` sites. |

| 11 Intercom | **Done (fixtures), live unverified** | `integrations/connectors/intercom.ts`: FeedbackSource over customer-started conversations (support channel, rating and tags kept, author identity never read, text redacted at read time). Privacy guards: redaction moved to `lib/redact.ts` and applied to the whole AI planner prompt; `aiEgressAllowed = false` now actually withholds the AI planner in server runs (it was declared but not enforced). An end-to-end test runs a scheduled watch over all four connectors: deploy association with actual timing, corroboration from Jira and Intercom, no personal data in stored investigations or AI prompts, and no model call when egress is disallowed. Two fixes found by it: signal links were always marked simulated (now from the registry — unchanged for sample and imported data), and feedback wording said "1–2★ reviews" for support conversations (now "negative feedback" / channel-aware nouns; verdict lock unchanged). |

| 12 Slack outbound | **Done (fixtures), live unverified** | `app/notifications.ts` (vendor-neutral): alerts and briefs the engine already decides become `NotificationMessage`s and go to every connected outbound channel; idempotent per (channel connection, message) through the store's (channel, dedupe key) uniqueness; failed attempts logged under their own key and retried on the next delivery; never fails a run; connected workspaces only. `integrations/channels/slack.ts`: Block Kit rendering (snapshot-tested; escaped; redacted; https link buttons only) and `chat.postMessage` (API `ok:false`, 429, 5xx and network errors become failed receipts without the token). No Slack interactivity endpoint exists — approvals are decided in Jagr. Delivery log route; channel "check" reports that deliveries are verified in the log. The all-connector end-to-end test confirms: no Slack message on first detection (HIGH waits for confirmation), exactly one after the confirming run, linking back to Jagr, with no personal data or token. |

| 13 Live dogfood verification | **Partial** — GitHub read path live; the other four NOT VERIFIED (no credentials) | Real single-tenant runtime run end to end with a real GitHub credential (`npm run eval:dogfood`): bootstrap into encrypted storage, live `check()`, 3 real production deployments read and mapped. Real-vs-fixture differences: Vercel deployments carry the full SHA as `ref` (now shown short); environment names are `Production`/`Preview` (GitHub's filter is case-insensitive — no change); a single `success` status per deployment; no releases; Amplitude rejects bad credentials with 403, not 401 (already classified). The sandbox's egress proxy injects its own GitHub credential, so token authentication was not verifiable there. Negative paths verified against every real endpoint (`JAGR_EVAL_NEGATIVE=1`). No real end-to-end investigation was possible: a change source alone never starts one, and no signal source (Amplitude, Jira, Intercom) had credentials. Evidence links now point to the record itself (`provenance.url`: commit, `/browse/KEY`, inbox conversation, configured Amplitude URL) for connected sources; simulated and imported links are unchanged. Sanitised recorded GitHub responses run through the full connector contract. |

**Deliberate verdict changes in step 2** (baseline regenerated; attention, status, emails and every product metric unchanged; every golden/adversarial/planner case keeps its pass/fail):

- The Sample workspace's Jira release date is `planned` (a tracker's release date is bookkeeping, day-precision in real Jira). Release associations are now measured from the first *actual* rollout (App Store phased release, 18:40): "20 min before the drop", not 30.
- EVAL-003 (Jira release only) and EVAL-008 (stores down, only the Jira date left) no longer claim a timing association; release-related drops to weak. EVAL-003's check now asserts the planned date is shown as evidence and no timing is claimed from it.
- One change scan instead of one call per store: 2–4 fewer tool calls per investigation.
- PLN-05's scripted planner can no longer chase "another store release lookup" (there is one change query); it now chases corroboration for explanations already at their ceiling — the same NO_INFORMATION_VALUE policy, still exercised end to end.

Decisions taken during implementation (smallest reversible choice, per the brief):

- **Source ids stay opaque strings.** The built-in channels keep their ids (`jira`, `ga4`, `app_store`, `google_play`) so stored workspaces, deep links and evaluations are unaffected; the engine never branches on them (enforced by `architecture.test.ts`). New connectors register new ids.
- **Pure helpers moved into the core.** `lib/time` and `lib/rng` now live in `src/product/lib/` (re-exported from `src/lib/` for the UI and Demo night) so the core imports nothing outside itself except `zod`.
- **Allowed runtime globals** for the core are declared in `types/core-runtime.d.ts`: timers, `URL`, `AbortSignal.timeout`. Everything else — including `fetch` — comes through ports.
- **Rollout pre-checks** read every change source that reports rollout state (`ChangeSource.tracksRollout`); they are independent reads, so the verdict lock compares them as a set.
- **Change evidence is one role query** (`getChanges` fans out to every change source in the watch). Work items and feedback stay per source for now: each call is one source's answer, which keeps their evaluation traces unchanged. Metrics are per metric.
- **Export snapshot = the investigation's own evidence.** An investigation's `evidence` (statements, references, timing, gaps) and `trace` are what it saw; they are exported as-is. Raw role records are not duplicated, except user imports (the data is the source).
- **Notification channels are opaque ids** (`'in_app'`, `'slack'`) so no port type names a vendor.
- **Deep links in outbound messages are plain Jagr URLs**, not signed links: they carry no token and require sign-in, so a forwarded message grants nothing. (The earlier plan said "signed deep links"; a signature would only matter for unauthenticated access, which Jagr does not offer.)
- **Outbound delivery is inline, not a `notify.deliver` job**: failures are logged and retried on the next delivery of the same message. A durable retry queue is not built.
- **Morning-brief documents and the scheduler log are not exported** — they are regenerated from investigations; exporting them would freeze derived views.
- **Postgres stores documents, not domain columns.** Workspace data lives in `workspace_docs (workspace_id, collection, id, doc jsonb)`; typed columns only where the database enforces something (identities, versions, job leases, notification dedupe, secrets).
- **Scheduled monitoring is for connected workspaces only.** Sample and imported data have their own time range and run on demand, as in the browser.
- **Chunked upload is not built.** Imports go in one request (4 MB cap); larger exports need chunking later.
- **Channels are not sources.** `ProviderId` also names delivery channels (`CHANNEL_IDS`: email, Slack); `SourceId` excludes them and `isSourceId()` guards every source lookup, so a Slack connection can never be read as evidence.
- **Watch creation on the server is template-based** (the minimum the dogfood workspace needs to run); editing thresholds and schedules stays in the browser build until the UI talks to the API.
- **Evidence links use the record's own page** (`provenance.url`) for connected sources only; simulated and imported data keep the source's page, so nothing simulated ever links to something that looks real. Signal-only links (a signal's refs without matching evidence) still use the source's page.
- **GitHub is registered as a known source id** (`github`, role: changes) so deploy evidence can be tested now; it is not part of the Sample workspace and has no connector until step 7.

## 13. V1.2 productization — status

| Phase | Status | Notes |
|---|---|---|
| 1 Connections domain | **Done** | `connections/model.ts`: derived health (healthy, unverified, stale, degraded, needs_reconnect, error, not_configured, not_applicable) and `ConnectionView` — the only connection shape that leaves the server (no secret ref, no credential-looking config, no email as account). Records gain createdAt, lastSuccessfulCheckAt, lastErrorAt, capabilities; migration 002 backfills createdAt. Export maps connection fields explicitly. |
| 2 Connection API | **Done** | `app/connections.ts` + `integrations/connectionTypes.ts`: connect/configure, test, reconnect, disconnect; validation before storing or calling; secrets rotate in place; environment-managed connections read-only; owners/admins change, members read; audit by field name. Slack's test is `auth.test`. See docs/CONNECTORS.md. |
| 3 Server workspace in the browser | **Done** | `app/workspaceSnapshot.ts` maps a server workspace onto the same `ProductState` the browser workspace uses; the browser's `ProductProvider` gains a server mode where every change goes through the API (`src/state/serverApi.ts`, `serverSession.tsx`). Settings → *Where this workspace lives*; Sources → connect / test / reconnect / disconnect. `npm run eval:ui` drives the path in Chromium. |
| 4 Evidence chain | **Done** | Every evidence item stores its snapshot (`EvidenceItem.provenance`: data mode — absent when nothing was read —, sources, read time, records with ids/links/times, freshness, metric values and baseline window). Investigations store `assumptions` (`evidence/assumptions.ts`, derived from the evidence used). FACT / INFERENCE / ASSUMPTION / UNKNOWN are separate stages of the chain; the chain view uses the stored mode, so an old investigation keeps the data mode it was built on. Duplicate findings merge into one item with unique references. Scenario tests: missing, stale, conflicting, correlation without causality, planned vs actual, unavailable, duplicate. |
