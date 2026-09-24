# JAGR

**Your product keeps moving after you leave. Jagr investigates what changed.**

An autonomous product investigator for PMs. Product signals live across analytics, tickets, releases and customer feedback. Jagr is not another dashboard. It notices a meaningful change, gathers evidence across those sources, and tests competing explanations. It separates what it observed from what it inferred and what it doesn't know. It only interrupts you when it matters, and consequential actions wait for your approval.

```
WATCH → DETECT → INVESTIGATE → CORRELATE → ASSESS → NOTIFY → APPROVE → ACT
```

This is a V1, **not production-ready**. There are no accounts: a workspace lives in the browser it was created in.

## Try it with your own data (about 5 minutes)

1. Open Jagr and choose **Use my own data**.
2. **Sources → Upload data**: upload CSV or JSON files. Download the four sample files from the same panel to see the format.

   | Type | Required columns | Optional |
   |---|---|---|
   | Metrics | `timestamp, metric, value` | `baseline` |
   | Issues | `id, title, created_at` | `status, labels, priority, type, version, component` |
   | Releases | `id, name, date` | `status, version, rollout, platform` |
   | Changes | `id, kind, title, at` | `timing (actual / planned / reported), version, status, platform, rollout` |
   | Customer feedback | `id, text, created_at` | `rating (1–5; required for reviews and surveys), channel (review / support / survey / request), tags, title, version` |

   - Metrics V1 can investigate: `checkout_conversion`, `signup_conversion`, `purchase_revenue`, `sessions`, `search_usage`.
   - Timestamps must be ISO 8601; ambiguous dates like `09/24/2026` are rejected, not guessed.
   - Every rejected row is shown with its line number and reason. Nothing is silently dropped.
   - Changes are deploys, releases, flag / experiment / config changes, annotations and incidents. A `planned` timestamp is shown as evidence but never used as timing; an annotation defaults to `reported`.
3. **Create a watch**, e.g. *Checkout health*.
4. Choose the planner: **Deterministic**, or the **AI planner** if the deployment has one configured.
5. **Run monitoring**, then open the investigation:
   - what changed, why it matters, and what Jagr checked
   - evidence, each item with its source, `USER IMPORT` status and time
   - hypotheses, and Observed / Inferred / Unknown
   - attention, the recommended next step and approvals
   - the Agent Trace

Imported files are normalized into the same evidence model the engine already uses. The investigator doesn't know the data came from a file, and it can't replace your data with sample data. Channels are renamed accordingly: evidence reads *Metrics*, *Issues & releases* and *Feedback*, never "Jira" or "App Store". Actions don't claim an external tracker: a Jira incident becomes a draft you can copy.

**Moving a workspace.** Sources → *Workspace export* downloads a Jagr Workspace Export v1 file (watches, imports with their rejected rows, investigations with their evidence and trace, decisions). It never contains credentials, sessions or email addresses; addresses inside imported text are redacted. *Import an export…* validates the file first (dry run), shows what it will do, and replaces this browser's workspace only after you confirm; the same export is never imported twice.

**Privacy.** Imported data is used to run investigations in this workspace and is stored in this browser (`localStorage`). If AI planning is enabled, investigation context (including summaries of your evidence) is sent to the configured model provider. There is no telemetry.

## Data modes

| Mode | Data | Status label |
|---|---|---|
| **My data** (workspace) | Your CSV / JSON imports | `USER IMPORT` (sources without imports: `NOT CONFIGURED`) |
| **Sample workspace** | A simulated night where checkout conversion drops 18% | `SIMULATED` |
| **Demo night** | The original agent's scripted Klarna replay, separate from any workspace | `SIMULATED` |
| **Jira Cloud** | A real connector exists (REST v3, tested against mocked responses) but needs server-side credentials, so it is shown as `NOT CONFIGURED` | `CONNECTED` once configured |

## What is real and what is simulated

| Real (implemented and tested) | Simulated or not built |
|---|---|
| CSV / JSON import, validation and normalization into the evidence model | The sample workspace's analytics, App Store and Google Play data |
| Investigation engine: detection, evidence gaps, hypotheses, stopping rules, 9-call budget | Jira data in the sample workspace (the connector exists but is not configured) |
| Provider-agnostic LLM planner (Claude, Gemini, OpenAI, OpenAI-compatible) | Email delivery (rendered in-app, never sent) |
| Real Gemini planner calls (verified with `gemini-3.1-flash-lite`, including on imported data) | Production actions (rollout pause, rollback, customer messages) |
| Production planner endpoint (`api/planner.ts`, a Vercel function sharing the dev server's handler) | Accounts, sync across devices (the workspace is browser-local) |
| Deterministic policy validator between every plan and every tool call | Demo night's scripted scenario |
| Hypotheses, Observed / Inferred / Unknown, causality guard, deduplication, attention and risk model | |
| Approval enforcement in the execution layer (HIGH / CRITICAL) | |
| Agent Trace, and the golden / adversarial / planner / bring-your-own-data evaluation suites | |

## Environments

- **Workspace**: the product (*My data* or *Sample workspace*). Watches, monitoring runs, investigations, approvals and the planner switch.
- **Demo night**: a separate, deterministic, scripted replay with its own *Reset & replay*. It has no LLM planner, and resetting it never touches the workspace.

The **Workspace | Demo night** switch in the header selects the environment, and the choice survives a reload. Tasks and Approvals show the current environment's records by default; *All environments* is an explicit option.

## Run it

```bash
npm install
npm run dev              # http://localhost:5173 (includes the planner endpoint)
npm test                 # engine, golden, adversarial, planner, providers, environments, bring-your-own-data, role contracts, migrations, architecture boundaries, verdict lock
npm run typecheck        # the app, plus the portable core compiled alone with no DOM or Node types
npm run build
npm run eval:planners    # MANUAL: real provider calls for configured providers; never part of npm test
```

No API key is needed: without one, Jagr uses the deterministic planner and says "AI planner unavailable — deterministic investigation active".

**AI planner in production.**
- `api/planner.ts` is a Vercel serverless function built on the same handler as the dev server, and `vercel.json` routes `/api/planner/*` to it.
- The deployment owner sets `LLM_PROVIDER`, `LLM_MODEL` and `LLM_API_KEY` as server-side environment variables in the Vercel project (never `VITE_`-prefixed). Users don't paste their own keys.
- The endpoint spends the owner's model budget, so it accepts small requests only (64 KB) and applies a best-effort per-IP rate limit. Set spend limits with your provider as well.

## Backend (optional)

Without a backend Jagr is browser-local. With one, workspaces live in Postgres, monitoring runs on a schedule (Vercel Cron → `/api/cron/tick`) without a browser open, approvals are enforced on the server, and people sign in with Google or GitHub. See `.env.example` for the variables and `docs/ARCHITECTURE.md` for the design.

- Local development: `JAGR_DEV_DB=pglite JAGR_SESSION_SECRET=… JAGR_SECRET_KEY=… npm run dev` runs the API on an on-disk PGlite database.
- Production: set `DATABASE_URL`, `JAGR_APP_URL`, `JAGR_SESSION_SECRET`, `JAGR_SECRET_KEY`, `CRON_SECRET` and a sign-in provider. Migrations run on start.
- Single-tenant (dogfood): `JAGR_MODE=single-tenant` + `JAGR_OWNER_IDENTITIES` + provider credentials in the environment (`JAGR_AMPLITUDE_*`, `JAGR_GITHUB_*`, `JAGR_JIRA_*`, `JAGR_INTERCOM_*`, `JAGR_SLACK_*`). On start they are copied into encrypted storage for one owner workspace; only the listed identities can sign in. A source whose connector is not live yet shows as a gap, never as sample data.
- Moving a browser workspace: Sources → *Workspace export* → sign in → *Copy this workspace to my account* (dry run, then confirm).

## The product loop (2 minutes)

1. **Overview**: "2 things need your attention." What happened, what needs me, what Jagr is watching, when it checks next.
2. **Sources**: Jira, GA4, App Store, Google Play and Email, each labelled *Simulated*. Try *Simulate outage*.
3. **Watches → Create watch**: what to watch, where to look, how often, when to interrupt, morning brief. Then *Run monitoring*, with the planner of your choice.
4. **Investigation**: *Checkout health degraded*. Conversion is −18%, crash-free sessions are down, and there are checkout bugs in Jira and negative reviews. They are correlated into **one** investigation, with competing hypotheses and Observed / Inferred / Unknown. "Supports a temporal correlation with release 4.8.1, but does not establish causation."
5. **Email**: sent once, when confirmed, with links into the investigation and each source record.
6. **Agent Trace**: every planner decision (MODEL or DETERMINISTIC, provider and model), the validator's verdict, each tool call and result, what changed in each hypothesis, the stop reason, attention and actions.
7. **Approvals**: *Pause the 4.8.1 rollout* (HIGH risk) shows action, why, evidence, risk, what will happen and what could go wrong. Approve, reject or modify; the decision is written into the trace.
8. **Evaluations**: the golden set (EVAL-001…010), the adversarial set (ADV-01…17) and the planner boundary set (PLN-01…18). Intentional failures are shown, not hidden.

## Architecture

```
api/
  planner.ts                Production planner endpoint (Vercel function; same handler as the dev server)
server/
  http/node.ts              Node http glue for the planner endpoint (dev server + Vercel)
scripts/eval/*.live.ts      Manual live-provider comparison (npm run eval:planners) — never part of npm test
src/
  product/                  ← the portable core (no browser, Node, deployment or DB APIs; see docs/ARCHITECTURE.md)
    types.ts                Watch, SourceConnection, WatchInvestigation, EmailNotification, MorningBriefDoc…
    roles/                  Role-based sources: MetricSource, ChangeSource, WorkItemSource, FeedbackSource,
                            ConversationSource, ContextSource; neutral records with provenance; SourceRegistry
    ports/                  Infrastructure ports (HttpClient; more in later stages)
    catalog.ts              Metrics and signals by role, watch templates, default workspace
    scheduler.ts            Deterministic scheduler: monitoring ≠ briefing, frequencies, timezones, cron mapping
    integrations/           Native adapters (simulated Jira/GA4/App Store/Play fixtures, imports), email outbox,
                            deep links; bridge.ts turns any native adapter into role sources
    integrations/jiraCloud.ts  Real Jira Cloud REST v3 connector (tested with mocked responses; not configured)
    agent/tools.ts          Role tools: getMetric, getMetricBreakdown, getChanges, getWorkItems, getFeedback,
                            getFeedbackVolume — each names an opaque source id, never a vendor
    migrations/             Stored-workspace migrations (v2 vendor-named → v3 role-based)
    testkit/                The role-source contract every source must pass (test support)
    agent/investigator.ts   The agent loop: planner → policy validator → tool call → hypotheses → stop
    agent/planner.ts        Policy validator (provider-independent) + planner exports
    agent/plannerSchema.ts  PlannerProposalSchema: the normalized proposal every planner must produce
    agent/plannerPrompt.ts  Investigation state → provider-neutral prompt
    agent/plannerManager.ts PlannerManager: timeouts, circuit breaker, plan reuse, explicit provider fallback
    agent/providers/        Server-side only: config, registry, adapters (anthropic, gemini, openai[-compatible]), endpoint
    imports/                Bring your own data: CSV/JSON parsing, row validation, imports → World adapter
    agent/actions.ts        Risk-based autonomy and the approval gate (executeAction refuses without approval)
    agent/decisions.ts      Human approve / reject / modify, applied over results and appended to the trace
    engine/                 detect → investigate/correlate → attention → notify → brief, causality guard, monitor loop
    evaluation/golden.ts    EVAL-001…010 and product metrics
    evaluation/adversarial.ts  ADV-01…17: cases where the obvious answer is wrong
    evaluation/plannerEval.ts  PLN-01…18: the policy boundary around the model planner, attacked with scripted planners
  agents/ domain/ simulation/ evaluation/   ← the original demo-night agent (unchanged)
  state/  components/  pages/
```

**Attention.** LOW (fluctuation) → no email · MEDIUM (persistent, single-source or customer-only) → morning brief · HIGH (core funnel degradation corroborated by another source or a release) → email once confirmed · CRITICAL (severe impact) → email immediately, before confirmation.

**Deduplication.** One investigation per problem: same area on the same night, or any open investigation already tracking the same signal — across watches. One email per attention level.

**Correlation, not causation.** Confidence means "the problem is real", never "this caused it". Every investigation separates Observed / Inferred / Unknown; generated text is checked for causal overclaims (0% in the golden set).

**The agent loop.** Each investigation pass keeps competing explanations open (release-related, real product issue, demand shift, measurement artifact, outside connected sources, customer-only), then repeatedly picks the explanation with the biggest evidence gap and calls the tool that can test it. It works breadth before depth: the open explanation with the fewest calls so far goes next, so a familiar story like "it was the release" can't use up the budget. After a call to a source fails, it skips that source for the rest of the pass and looks for the same evidence elsewhere. It stops when:
- the impact question is settled and every alternative has been tested,
- no remaining tool can change anything,
- three calls in a row change nothing, or
- the 9-call budget runs out.

Once impact is confirmed, it makes up to two *scoping* calls (revenue, customer reviews), labelled as not answering the cause question.

**Model planner, policy boundary.** The model chooses only *which tool to call next*. It returns strict JSON: `nextTool`, `reason`, `evidenceGap`, `hypothesesAffected`, `expectedEvidence`. A deterministic validator then checks the plan before anything runs. It rejects:
- causal claims
- actions dressed up as tools
- unknown tools
- an exhausted budget
- tools outside this investigation
- unavailable or failed sources
- repeat queries
- unknown hypothesis IDs
- repetitive probing while another explanation is untested
- calls that can't change any open explanation

Only the investigator's own tool option is executed, never anything the model wrote. Malformed output, a timeout, an empty reply, an unreachable model or a rejected plan fails closed to the deterministic planner, and the trace says so. After three consecutive outages the model is not called again that run. Identical investigation states reuse one plan. Stopping, the 9-call budget, scoping calls and every action stay deterministic policy.

**Provider-agnostic planning.**

```
LLM planner (any provider) → provider adapter → normalized PlannerProposal → policy validator → tool executor
```

The investigation engine only calls `planner.plan(state)`. It never sees a provider name, a model, a request format or a key. Each adapter in `src/product/agent/providers/` converts its API's native structured output into the same `PlannerProposal`:
- **Claude:** a forced tool call.
- **Gemini:** `responseSchema` JSON mode.
- **OpenAI:** a strict `json_schema`.
- **OpenAI-compatible endpoints:** `json_schema`, `json_object` or prompt-only, configurable.

The shared schema is always enforced locally, and the validator is the same for every provider and for the deterministic planner. Changing provider changes the *proposal*; approvals, risk, allowed tools, the budget, outage rules, the causality guard and dedupe don't change.

Configure the planner in `.env.local` (git-ignored) and restart `npm run dev`:

```
# Deterministic (the default when nothing is configured)
PLANNER_MODE=deterministic

# Gemini
LLM_PROVIDER=gemini
LLM_MODEL=<gemini model id>
LLM_API_KEY=<key>            # or GEMINI_API_KEY

# Claude
LLM_PROVIDER=anthropic
LLM_MODEL=<claude model id>  # optional; defaults to claude-sonnet-5
LLM_API_KEY=<key>            # or ANTHROPIC_API_KEY (Phase 3 setup still works)

# OpenAI
LLM_PROVIDER=openai
LLM_MODEL=<openai model id>
LLM_API_KEY=<key>            # or OPENAI_API_KEY

# Any OpenAI-compatible endpoint (OpenRouter, Groq, Mistral, DeepSeek, xAI, Ollama, …)
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://host/v1
LLM_MODEL=<model id>
LLM_API_KEY=<key>            # optional for local endpoints
LLM_STRUCTURED_OUTPUT=json_object   # json_schema | json_object | prompt

# Optional: a second provider, used ONLY when the primary is unavailable
LLM_FALLBACK_PROVIDER=anthropic     # reads ANTHROPIC_* or LLM_FALLBACK_MODEL / _API_KEY / _BASE_URL
```

Jagr doesn't guess model names: Gemini and OpenAI need an explicit model.

**Choosing the planner in the app.** The environment and the simulated sources control the *data*. The **Planner** switch in the header controls how Jagr investigates it:
- **Deterministic** is the default.
- **Configured LLM** shows the real provider and model from `/api/planner/health` (e.g. *Gemini · gemini-3.1-flash-lite*). It is disabled, with the reason, when no provider is configured.

The choice is stored per browser and survives resets. The trace shows `Data: SIMULATED` next to `Planner: MODEL · provider · model` or `Planner: DETERMINISTIC`. Changing the planner changes who proposes each step; the validator, tools, budget, risk model and approvals don't change.

Notes from live Gemini testing:
- `gemini-2.5-flash` still appears in the model list but returns 404 ("no longer available to new users").
- Newer Flash models spend output tokens on thinking, so the adapter allows 4096 output tokens and reports a cut-off plan as `TRUNCATED_OUTPUT`.
- Busy models return 503 "high demand"; Jagr labels the failure and falls back.
- Real calls took about 0.6–18 s each, so a full monitoring run with an LLM planner takes a few minutes.

- **Where keys live:** in the server process (the Vite dev server locally, the Vercel function in production), read only by `providers/config.ts` and used only inside adapters. The browser talks to `/api/planner/health`, `/api/planner/plan` and `/api/planner/test`, and never receives a key. Keys never go into URLs, the bundle, storage or the trace, and upstream error text is redacted.
- **Fallback:**
  - A provider that is *unavailable* (timeout, unreachable, not configured, circuit open) hands over to the configured fallback provider, if there is one. The trace says *"Primary planner unavailable. Fallback provider used."*
  - A provider that returns *bad output* (malformed, empty, schema violation), or a plan the validator *rejects*, never triggers a provider switch; it goes straight to the deterministic planner.
  - The deterministic planner always runs behind the same validator.
  - Trace labels: `LLM`, `DETERMINISTIC` (no LLM configured) and `DETERMINISTIC_FALLBACK` (the LLM failed or was rejected).
- **Checking a configuration:** `curl localhost:5173/api/planner/health` shows the safe config (provider, model, problems). `curl -X POST localhost:5173/api/planner/test` sends a sample checkout −18% state to the configured provider.
- **Comparing providers on real calls:** set keys and models for the providers you have (`ANTHROPIC_*`, `GEMINI_*`, `OPENAI_*`) and run `npm run eval:planners`. It runs checkout −18%, with and without Jira, once for the deterministic planner and once per configured provider. It prints a table with:
  - tool order, and approved, rejected and fallback steps
  - the hypotheses, unknowns and final severity
  - actions, causal sentences and unvalidated calls
  - latency

  Providers without credentials are reported as skipped. The script doesn't pick a winner.
- **Adding a provider:** write an adapter implementing `ProviderAdapter.generate()` (native request → plan JSON text), add one entry to `PROVIDER_REGISTRY`, and add a row to the table-driven tests in `providers.test.ts`. The investigator, monitor, validator, tools, risk model, approvals and UI don't change; an architecture test fails if an engine file names a provider.

`?plannerFault=malformed` (or `timeout`, `hallucinated`, `alwaysUnavailableJira`, `impactFirst`, …) swaps in a scripted test planner for manual testing, labelled *not a model*.

**Evidence strength, not probability.** Each hypothesis has evidence for, evidence against and unknowns, plus a strength (weak / moderate / strong). Strength counts how much independent evidence lines up; it is not a probability, and release timing is capped at *moderate* so timing can never become causation. Investigation confidence (high / moderate / low) means "the problem is real".

**Risk-based autonomy.** LOW (link related issues): Jagr does it. MEDIUM (Jira task or incident): Jagr recommends it, one click. HIGH (pause a staged rollout): prepared, notified, waits for approval. CRITICAL (rollback, customer communication): approval required. `executeAction` throws without an approval, so the gate is in the engine, not only the UI. Jagr doesn't write to a source it knows is down: the Jira actions become drafts.

**Evidence by role, not by vendor.** The investigator asks for *metrics*, *changes*, *work items* and *feedback* — never "Jira issues" or "GA4". Each source implements the roles it can serve and returns neutral records carrying their provenance (source, connection, external id, observed and fetched times). A boundary test fails if the engine ever names a vendor.

**Replacing the simulation.** Implement the role interfaces in `src/product/roles/types.ts` for a real API (or implement a native `IntegrationAdapter` and wrap it with `roleSourceFromAdapter`), pass it the injected `HttpClient`, register it in a `SourceRegistry`, and run it through `testkit/roleContract.ts`. The engine, evaluations and UI don't change. `planJobs` output maps directly onto cron or queue jobs.

## Limitations

- The Jira Cloud connector is real but not configured: Jira API tokens can't safely live in a browser app, so it needs a server. Jira stores release *dates*, not times, so minute-level release timing has to come from the stores or deploy events. Every other source is simulated and labelled SIMULATED SOURCE in the trace.
- Live LLM planning has been verified with **Gemini only** (`gemini-3.1-flash-lite`, real API calls, checkout −18% with and without Jira). Claude and OpenAI adapters are tested against mocked native responses and a local mock server, not the live APIs. One scenario doesn't show that LLM planning beats the deterministic planner; `npm run eval:planners` is the tool for that comparison.
- Live planning is slow and at the provider's mercy: real Gemini calls took about 0.6–18 s each (a full night takes 1–2 minutes), with intermittent 503 "high demand" errors that fall back to the deterministic planner.
- The production planner function has been verified by compiling it exactly as Node ESM and calling it locally (including a real Gemini call), but it has not yet been exercised on a live Vercel deployment. Its rate limit is per instance, so it is best effort.
- Workspaces are browser-local: no accounts, no sync across devices, and a browser storage limit of a few MB (Jagr says so if a save fails). A hosted store with sign-in (e.g. Supabase and magic links) is the next step.
- Imported data: V1 recognizes five metric names, uses the analytics, issue-tracker and reviews evidence channels (no crash-rate import), counts issue and review volumes against fixed baselines, and has no per-watch custom thresholds.
- Demo night is the original scripted engine: it does not use the investigation engine or the planner, and it replays a different scenario from the workspace golden case.
- A planner with a different strategy can spend the full 9-call budget where the deterministic planner stops early (seen in ADV-01 and ADV-12 with the impact-first test planner). The budget bounds it; the outcome was unchanged.
- Known failures, from the adversarial set:
  - **ADV-16:** corroboration is counted per provider, so a revenue drop from the same GA4 source doesn't count as independent confirmation. A −18% conversion / −16% revenue night with nothing else goes to the brief instead of an email.
  - **ADV-17:** complaint bursts are dismissed as "did not persist" once they age out of the rolling window.
- No OAuth or email delivery. Everything runs on fixture data in the browser; state is per browser.
- One simulated night (18:00–08:05 UTC). Timezones are supported by the scheduler, but the demo world is anchored to UTC.
- Detection thresholds and confidence weights are hand-set. The golden set was written alongside the engine, so its perfect score shows the rules behave as designed — not that they generalise. Calibration needs labelled incidents from real sources.
- Review and issue classification is keyword-based.
