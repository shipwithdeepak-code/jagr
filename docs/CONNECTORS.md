# Connectors

A connector turns one workspace connection — non-secret configuration plus a credential read from the
SecretStore — into a **role source** (`MetricSource`, `ChangeSource`, `WorkItemSource`, `FeedbackSource`).
The investigation engine never sees a connector: it asks for evidence by role, and the registry answers
from whichever sources the workspace has.

Code: `src/product/integrations/connectors/` (pure TypeScript; all I/O through the `HttpClient` port).

## The contract

`ConnectorDescriptor` (`connectors/types.ts`):

| Field | Meaning |
|---|---|
| `id` | Connector id, stored as `Connection.provider` |
| `source` | Source id its records carry |
| `roles` | Roles it implements |
| `config` | zod schema for the non-secret configuration (validated before anything is built) |
| `secretKinds` | Credential kinds it accepts |
| `hosts(config)` | The only hosts it may call; the runtime refuses everything else, and plain http |
| `build(ctx)` | Returns the role implementations — no network calls |
| `check(ctx)` | One cheap authenticated call proving the credential works |

Every connector must pass `testkit/connectorContract.ts` against recorded provider responses:

- the role-source contract: complete provenance on every record, records inside the requested window, a
  failing source throws
- at least the expected number of records per role from the recording (the mapping works)
- `connected` provenance naming its own connection, with an https deep link
- only declared hosts, only https
- invalid configuration refused before any request
- 401/403 → `ConnectorAuthError` (connection → *needs reconnect*), 429 → `ConnectorRateLimited`,
  5xx / network / timeout → *unavailable*, unreadable body → error — **a failed read is never an empty answer**
- no credential in any record, error message or check result; no email address in any record
- isolation: two connections of the same connector never carry each other's credential
- `check()` reports `connected` / `needs_reconnect` / `unavailable` / `error` without throwing

## Health

- **At run time** (`app/monitoring.ts → sourcesForRun`): a connection without a registered connector, in
  `needs_reconnect` / `not_configured`, with a missing credential or with invalid configuration is
  reported as a gap for that run. One broken connection never stops the others.
- **On demand** (`checkConnection`, `POST /api/workspaces/:id/connections/:cid/check`): a rejected credential
  marks the connection `needs_reconnect` (it is not read again until reconnected); an unreachable provider
  only records `lastError` — an outage is not a configuration change.
- During an investigation, a provider failure becomes a recorded gap. It is never evidence that
  something did not happen.

## Personal data

`connectors/redact.ts` removes email addresses, phone numbers, links, card numbers and credential-looking
strings from customer text before it becomes a record — so it is never stored, shown as evidence, exported
or sent to an AI planner. Names are not removed.

## Connectors in this build

| Connector | Roles | Status |
|---|---|---|
| (reference, test only) deploy log | changes | Framework reference in `framework.test.ts` |
| Amplitude | metrics, changes (annotations) | Implemented; contract-tested on fixtures in the documented API shape; **not yet verified against a live project** (`npm run eval:connectors`) |
| GitHub | changes (deployments, releases) | Implemented; contract-tested on fixtures in the documented API shape; **not yet verified against a live repository** |
| Jira Cloud | work items, changes (released versions) | Implemented on the existing Jira Cloud client; contract-tested on fixtures in the documented API shape; **not yet verified against a live site** |

## Amplitude

Dashboard REST API, Basic auth with the project **API key + secret key** (read-only use). Hosts: `amplitude.com`
(US) or `analytics.eu.amplitude.com` (EU).

- **Metrics** — `GET /api/2/events/segmentation`, hourly (`i=-3600000`). Each metric is a *binding*:
  - `count`: one event, `totals` or `uniques`
  - `ratio`: numerator uniques / denominator uniques × 100 (a conversion rate, in percent)
- Each read covers the run's window plus the previous 7 days. The **baseline** is the median of the same hours
  of day on those 7 days (standard deviation floored at 1 % of the mean), so a daily rhythm is not a drop. With
  less history the baseline falls back to the median of earlier readings, and says so.
- Only **complete** hours are returned; the current hour is dropped.
- **Breakdowns** by the configured dimensions (`platform → platform`, `app_version → version`, `country → country`
  by default), via `g=<property>`.
- **Changes** — `GET /api/2/annotations`. An annotation with a time is `reported` timing (can support a temporal
  association); a date-only annotation has day precision and is `planned`-strength (shown, never used to claim
  timing). Labels and details are redacted of personal data.

Configuration (`JAGR_AMPLITUDE_METRICS` in single-tenant mode, JSON):

```json
[
  { "kind": "ratio", "key": "checkout_conversion", "name": "Checkout conversion", "area": "checkout",
    "numerator": { "event_type": "Order Completed" }, "denominator": { "event_type": "Checkout Started" },
    "badDirection": "down", "threshold": 10 },
  { "kind": "count", "key": "signups", "name": "Sign-ups", "area": "signup",
    "event": { "event_type": "Sign Up", "filters": [{ "subprop_type": "event", "subprop_key": "platform", "subprop_op": "is", "subprop_value": ["iOS"] }] },
    "measure": "uniques", "badDirection": "down", "threshold": 20, "platform": "ios" }
]
```

Other settings: `JAGR_AMPLITUDE_REGION` (`us` | `eu`), `JAGR_AMPLITUDE_APP_URL` (evidence link target, e.g.
`https://app.amplitude.com/analytics/<org>`), `JAGR_AMPLITUDE_UTC_OFFSET_MINUTES` (the project's timezone offset).
Using the built-in keys (`checkout_conversion`, `signup_conversion`, `purchase_revenue`, `search_usage`) lets the
watch templates pick the metrics up; any other key is added to watches of its area.

Limitations: the project timezone is a fixed offset (DST not modelled — UTC projects are exact); with hourly buckets a
sustained drop is detected after about 3 complete hours; one Amplitude project per workspace.


## GitHub

REST API (`api.github.com`), read-only, with a **fine-grained personal access token** (Deployments: read,
Contents: read, Metadata: read) in `JAGR_GITHUB_TOKEN`. Repositories in `JAGR_GITHUB_REPOS`, environments in
`JAGR_GITHUB_ENVIRONMENTS` (default `production`).

- **Deployments** — `GET /repos/{repo}/deployments?environment=…` (newest first, up to 3 pages, back to 6 h before
  the window), then `GET …/deployments/{id}/statuses`. The time is the first `success` status: **actual** timing,
  when the change reached the environment. A failed deployment is recorded at its failure (`failed`). One still
  running — as of the run time; later statuses are not visible to it — is `in_progress` with `reported` timing at
  its start. Deep link: the commit.
- **Releases** — `GET /repos/{repo}/releases`. Published, non-draft only; `reported` timing at publication. GitHub
  does not know when users received a release, and the record says so.
- A 403 with `x-ratelimit-remaining: 0` is a rate limit, not a credential problem.
- A GitHub outage during an investigation is a recorded gap ("GitHub could not be checked"); the release question
  is never closed by it.

Not built: **GitHub App authentication** (App variables are reported as invalid configuration, never silently
ignored), GitHub Enterprise Server, workflow runs as deploy evidence.

## Jira Cloud

Built on the existing Jira Cloud client (`integrations/jiraCloud.ts`, REST v3), now over the shared connector
HTTP (typed failures, safe messages). Basic auth with an Atlassian account **email + API token**; the email is part
of the credential and is stored only in the SecretStore. Site (`https://<name>.atlassian.net` only) and project key
are configuration.

- **Work items** — `POST /rest/api/3/search/jql`, issues created in the window (token-paginated, up to 5 pages).
  Type and priority are mapped (Highest → critical); area from summary, components and labels. Reporter identity is
  not kept; customer contact details in summaries are redacted. Deep link: `/browse/<KEY>`.
- **Changes** — `GET /rest/api/3/project/{key}/versions`, released versions. A version's release date is
  bookkeeping with **day precision** → `planned` timing: shown as evidence, never used to claim a timing association.
- `check()` confirms the project is visible to the account.

Limitations: Jira Cloud only (no Data Center); JQL dates use the API user's timezone — use a service account set to
UTC; one project per workspace.
