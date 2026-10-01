# Repository map

Important boundaries, not every file.

## Entry points and UI

- `api/[...route].ts`, `api/planner.ts` — thin deployment-host entry points delegating to server/runtime.
- `src/main.tsx`, `src/App.tsx`, `src/pages/`, `src/components/`, `src/state/` — React/Vite UI, routing, browser state, and local persistence.
- `src/demo/`, `src/simulation/` — scripted/sample behavior, separate from real workspace investigations.

## Portable product core

- `src/product/types.ts` — watches, investigations, evidence, actions, notifications, and briefs.
- `src/product/events.ts` — NormalizedEvent/reference contracts.
- `src/product/roles/` — vendor-neutral evidence roles and registry.
- `src/product/engine/`, `evidence/`, `agent/` — detection, investigation, evidence, hypotheses, attention, deterministic policy/validation, replay, optional planner boundary.
- `src/product/app/` — admission, connections, scheduler, source checking, monitoring, delivery, snapshots, replay, evaluations.
- `src/product/ports/` — persistence, jobs, history, entitlements/control plane, source checks, clock, HTTP, identity, secrets, notification contracts, and memory implementations.
- `src/product/integrations/` — vendor connectors and outbound channels behind roles/ports.
- `src/product/imports/`, `export/` — normalized imports and Workspace Export v1.
- `src/product/view/` — shared product view builders.

`tsconfig.product.json` and `src/product/architecture*.test.ts` enforce independence from React, browser, Node, database, and host APIs.

## Server and persistence

- `server/app.ts` — authenticated HTTP routing and application-service composition.
- `server/auth.ts`, `authorization.ts`, `identity/` — sessions, CSRF/OAuth, principals, PrincipalContext, identity adapters.
- `server/runtime.ts`, `singleTenant.ts` — runtime composition and optional owner-configured bootstrap.
- `server/postgres/repositories.ts` — Postgres repositories and transactions.
- `server/postgres/jobs.ts` — durable queue, lease/retry/dead state, tenant-fair claims, bounded status.
- `server/postgres/migrations.ts` — additive schema/index migrations.
- `server/postgres/secrets.ts`, `server/crypto/` — encrypted credentials and key infrastructure.
- `server/postgres/sql.ts`, `pglite.ts` — SQL boundary and local/test adapter.
- `server/http/` — neutral request/response and transport glue.

## Execution flow

- Scheduling: `src/product/app/scheduler.ts`; queue: `server/postgres/jobs.ts`.
- Source checking: `src/product/app/sourceChecking.ts` observes targets, persists events, maps slots, enqueues monitoring, settles SourceState.
- Monitoring: `src/product/app/monitoring.ts` builds evidence sources, runs investigations/briefs, persists, and delivers.
- Investigation semantics: `src/product/engine/`, `evidence/`, and `agent/` own detection, evidence, policy, attention, actions, stopping.
- History: `src/product/ports/history.ts`, repository page methods, `app/workspaceSnapshot.ts`, and `export/workspace.ts` own bounded reads/full documents.

## Tests and evaluation

- Co-located `*.test.ts` — deterministic unit, contract, architecture, regression, integration tests.
- `src/product/testkit/` — port, role, connector contract suites.
- `server/postgres/postgres.test.ts` and server tests — PGlite parity, auth, routing, queue, end-to-end server behavior.
- `scripts/eval/` — explicitly invoked live-provider, browser, dogfood, QA, production-smoke evaluations; not ordinary deterministic tests.

## Documentation

- `README.md` — product introduction/usage; some historical statements may lag server architecture.
- `docs/ARCHITECTURE.md` — detailed architecture and implementation history.
- `docs/CONNECTORS.md` — behavior, configuration, limitations, verification status.
- `docs/DEPLOY.md` — deployment/operations.
- `docs/DECISIONS.md`, `PHASE-STATUS.md`, `CONTRACTS.md`, `DEFERRED.md` — concise frozen-baseline context.
