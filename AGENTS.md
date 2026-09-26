# AGENTS.md

This file contains repository-wide guidance for agents working on Jagr. Follow more specific instructions if a nested `AGENTS.md` is added later.

## Product context

Jagr is an autonomous product-monitoring and investigation system for product managers. Its core promise is to watch the product while the PM is away, investigate meaningful changes across connected sources, and tell the PM what actually needs attention.

The product loop is:

```text
CONNECT → DEFINE WHAT MATTERS → SCHEDULE/MONITOR → OBSERVE → DETECT → INVESTIGATE → CORRELATE → DECIDE ATTENTION → NOTIFY → DEEP-LINK TO EVIDENCE/ACTION
```

Protect that loop when changing the product. Jagr is not merely a dashboard, alert feed, or generic agent interface.

## Architecture

- The frontend is React 19 with Vite. UI, routes, pages, components, and browser state live under `src/`, outside the portable core.
- `src/product/` is the portable TypeScript product core. It contains the domain types, role-based evidence interfaces, investigation engine, planners and policy, application services, imports/exports, evaluation suites, connectors, and infrastructure ports.
- The portable core must remain independent of React, browser APIs, Node APIs, databases, and deployment hosts. Its dependency boundary is enforced by `tsconfig.product.json` and architecture tests.
- `server/` contains Node infrastructure: HTTP routing, authentication, identity-provider adapters, Postgres repositories and jobs, encrypted secret storage, migrations, and runtime composition.
- `api/` contains thin Vercel entry points. Host-specific code should delegate into the server/runtime layers rather than recreate product behavior.
- Browser-local workspaces use local persistence and may contain sample or imported data. Server workspaces use the API and Postgres but map into the same product state and UI concepts.
- Source integrations implement role-based interfaces such as metrics, changes, work items, and feedback. Keep vendor-specific API behavior inside connectors/adapters and expose neutral records with provenance to the investigator.
- The investigation engine owns detection, evidence gathering, hypotheses, correlation, attention, notification, and stopping behavior.
- AI planning is optional and provider-agnostic. A model may propose the next evidence-gathering step, but deterministic validation and policy decide whether a known tool may execute. The model does not control actions, budgets, stopping, or approval enforcement.
- Demo Night is a separate scripted environment and engine. Do not mix its state, records, or behavior into real workspace investigations.

The intended dependency direction is:

```text
UI and api/ → server infrastructure and state adapters → src/product portable core
```

Reuse the existing ports, role interfaces, application services, state providers, and view builders. Do not create parallel domain models or a second execution path when an existing abstraction covers the behavior.

## Investigation semantics

- Keep Observed, Inferred, Assumption, and Unknown distinct in storage, logic, and presentation.
- Never present correlation as causation without evidence that supports a causal conclusion. Timing alone is not causation.
- Preserve provenance, source timing, freshness, and evidence snapshots.
- Keep evidence gaps explicit. “No result was found” and “the source could not be checked” are different outcomes.
- A failed, stale, unavailable, unconfigured, or unauthorized source must never silently become sample data or a negative finding.
- Prefer breadth before depth: test competing explanations before repeatedly probing the most familiar hypothesis.
- Respect investigation and tool-call budgets, repeat-query rules, failed-source handling, and deterministic stopping conditions.
- AI may propose only the next permitted evidence-gathering step. The deterministic validator must select and authorize the actual tool invocation from known options.
- Fail closed to deterministic behavior when a model response is malformed, unavailable, unsafe, outside the investigation, repetitive, over budget, or otherwise policy-invalid.
- Do not weaken causal-language checks, evidence grounding, deduplication, replay fidelity, or verdict-lock expectations without explicit product direction.

## Attention and notifications

Jagr exists to reduce unnecessary alerts, not create more of them.

- Determine whether human attention is warranted before interrupting the PM.
- Preserve the meanings of severity, confidence, attention level, confirmation, and each watch's notification policy.
- Low-value fluctuations should remain quiet. Morning briefs, alerts, and immediate interruptions have different purposes.
- Keep notification deduplication and delivery idempotency intact.
- Notification channels render decisions made by the engine; they must not independently reinterpret attention or approval policy.

## Action safety

- Observation, investigation, correlation, and recommendations may proceed within established policies.
- Actions that affect production behavior, pricing, refunds, customer communication, rollouts, rollbacks, or destructive state require the appropriate human approval.
- Preserve server-side approval enforcement and optimistic-concurrency behavior. A UI confirmation alone is not an authorization boundary.
- Never invent evidence, credentials, source responses, successful actions, production state, or verification results.
- When a source cannot answer, report the gap instead of guessing.

## Current integrations

Currently implemented integrations include:

- Amplitude: metrics and annotations/change evidence.
- GitHub: deployment and release change evidence.
- Jira Cloud: work items and released-version change evidence.
- Intercom: customer-support feedback.
- Sentry: customer-product error/crash telemetry, releases, and issue evidence.
- Slack: outbound alerts and morning briefs; it is a notification channel, not an evidence source.
- Google and GitHub: user identity and sign-in providers.
- Gemini, Claude, OpenAI, and OpenAI-compatible endpoints: optional investigation-planner providers.
- Postgres/Neon: production persistence, queues, workspace documents, and encrypted secret references.
- PGlite: local server development and deterministic server tests.
- CSV/JSON imports: browser-local or imported-workspace evidence normalized into the same role model.

Sentry's connector supplies telemetry about the customer's product for Jagr investigations. It is not, by itself, application observability for Jagr. Do not describe customer evidence integrations as monitoring Jagr's own frontend, API, jobs, or connector health unless dedicated application-observability instrumentation is actually implemented and verified.

An integration may be implemented without being configured or live-verified. Preserve that distinction in code, UI, tests, and documentation.

## UI and UX principles

- The public landing experience is a separate surface from the workspace application shell.
- Keep workspace switching and account controls consistent with the current sidebar information architecture.
- Preserve direct navigation and deep links to investigations, evidence, approvals, and other workspace records.
- Preserve session-expiry and sign-in-return behavior. Do not flash stale, sample, or previous-workspace data while session or workspace state is resolving.
- Keep mobile navigation accessible: focus management, Escape behavior, inert background content, usable labels, and responsive layouts matter.
- Respect reduced-motion preferences and existing accessibility conventions.
- Never leak sample data into authenticated, connected, or imported workspace flows.
- Keep Demo Night visibly and behaviorally separate from real workspace investigations.

## Development rules

Before implementation:

1. Read the relevant README and documentation, then inspect the affected code and tests.
2. Trace the existing architecture and reuse its types, ports, adapters, application services, and utilities.
3. Check for an existing implementation path before adding a new system.
4. Prefer a small, coherent change with an explicit behavioral boundary.
5. Do not change product semantics unless the task explicitly requires it.

For every meaningful change:

1. Add or update focused regression tests for changed behavior.
2. Run the relevant test subset, then the broader deterministic suite when warranted.
3. Run `npm run typecheck`.
4. Run `npm run build` when the change affects compilation, bundling, routes, deployment entry points, or production behavior.
5. Run `git diff --check`.
6. Inspect the complete final diff and repository status before delivery.

Do not paper over failures. Explain pre-existing or environment-dependent failures and keep them separate from regressions introduced by the change.

## Git and delivery workflow

- `main` represents the current integrated product.
- Do not perform feature work directly on `main` unless explicitly instructed.
- Create a focused feature branch for implementation work.
- Keep commits coherent and limited to the requested change.
- Push the feature branch and open a GitHub pull request when delivery is requested.
- Wait for CI and Vercel checks, then review the final diff and preview before merging.
- Merge only after verification and only with authorization appropriate to the task.
- Do not push, open a PR, merge, or deploy when the user requested inspection or local-only work.
- Do not deploy manually unless explicitly requested.

## Security

- Never expose secrets or credential material in source, logs, traces, tests, screenshots, responses, or documentation.
- Never print, inspect unnecessarily, or commit `.env` contents.
- Never ask a user to paste an API token, password, private key, session cookie, or connection secret into chat.
- Treat connector credentials and identity/session state as sensitive.
- Keep credentials in the existing encrypted secret-storage path; they must not enter domain objects, exports, audit details, client responses, or AI prompts.
- Preserve workspace membership checks, tenant isolation, CSRF protection, secure cookie behavior, secret redaction, and AI-egress policy.
- Never weaken authentication or authorization to make implementation easier.

## Testing

- Preserve existing tests and evaluation baselines.
- Add regression coverage for every meaningful behavior change or bug fix.
- Do not delete, skip, loosen, or rewrite tests merely to make a suite pass.
- Keep deterministic unit/integration tests free of live-provider requirements.
- Keep live provider, browser UI, dogfood, and production-smoke evaluations in their existing explicitly invoked commands under `scripts/eval/`.
- Use fixtures and injected HTTP/clock/port implementations for deterministic connector and engine tests.
- When changing investigation behavior, check relevant golden, adversarial, planner-policy, architecture, causality, approval, and verdict-lock coverage.

Common commands are:

```text
npm test
npm run typecheck
npm run build
npm run test:watch
npm run eval:planners
npm run eval:connectors
npm run eval:ui
npm run eval:qa
npm run eval:dogfood
npm run smoke:production
```

The `eval:*` and production-smoke commands may require explicit credentials, URLs, browsers, or opt-in environment variables. Do not run live or mutating checks without the required authorization and configuration.

## Documentation

- Keep `README.md`, `docs/ARCHITECTURE.md`, `docs/CONNECTORS.md`, `docs/DEPLOY.md`, examples, and UI copy consistent with actual behavior.
- Update documentation in the same change when architecture, integration support, setup, commands, or product semantics change.
- Do not claim an integration is live because a connector, fixture, mock, or contract test exists.
- Clearly distinguish implemented, configured, tested against mocks, rejection-path verified, live-read verified, and production verified states.
- Clearly distinguish customer-product telemetry sources from Jagr's own application observability.
- Do not describe simulated or imported evidence as connected/live data.

## Efficiency and minimal-diff principles

- Before writing code, determine whether the requested behavior already exists.
- Reuse existing helpers, utilities, types, components, ports, adapters and dependencies before creating new ones.
- Prefer standard-library or native platform capabilities when they are sufficient.
- Do not introduce abstractions, dependencies, files, or configuration that the task does not require.
- Trace the real flow before fixing a bug; prefer fixing the shared root cause over patching individual symptoms.
- Prefer the smallest coherent diff that fully solves the requested problem.
- Avoid duplicate file reads, searches, speculative edits, and unnecessary tool calls.
- Keep plans and progress reports concise when the repository instructions already contain the relevant context.
- Never trade security, validation, accessibility, error handling, data integrity, or explicit product requirements for fewer lines or fewer tokens.
- For non-trivial logic, leave focused regression coverage.

## Coding style

- Follow the repository's existing TypeScript and React conventions.
- Prefer existing types, ports, adapters, application services, view builders, and utilities.
- Keep vendor-specific request/response handling inside connectors or infrastructure adapters.
- Keep the portable product core vendor-neutral wherever its role and port boundaries provide that abstraction.
- Inject time, HTTP, persistence, notification, identity, and secret behavior through existing boundaries rather than reaching for globals in the core.
- Keep host entry points thin and avoid duplicating policy in UI or deployment glue.
- Favor explicit domain names and typed validation over loose objects or implicit state.
- Preserve provenance and deterministic behavior in all evidence transformations.
