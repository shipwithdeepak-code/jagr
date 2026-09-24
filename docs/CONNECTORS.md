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
