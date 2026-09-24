# JAGR

**Autonomous product monitoring and investigation for PMs.**

> Investigate what changed. Act before it becomes an incident.

Jagr watches the tools a PM already uses (Jira, Google Analytics 4, App Store Connect, Google Play Console). It investigates meaningful changes across them and tells the PM what actually needs attention: one email per real problem, with the evidence, the uncertainty and links into each source, plus a morning brief.

```
WATCH → DETECT → INVESTIGATE → CORRELATE → ASSESS → NOTIFY → APPROVE → ACT
```

This is a portfolio build, **not production-ready**. External product data is **simulated** unless a connector is actually connected; in this build none is. Simulated data is labelled everywhere it appears.

## What is real and what is simulated

| Real (implemented and tested) | Simulated |
|---|---|
| Investigation engine: detection, evidence gaps, hypotheses, stopping rules, 9-call budget | Analytics (GA4) data |
| Provider-agnostic LLM planner and provider adapters (Claude, Gemini, OpenAI, OpenAI-compatible) | App Store Connect data |
| Real Gemini planner calls (verified with `gemini-3.1-flash-lite`) | Google Play data |
| Deterministic policy validator between every plan and every tool call | Jira data (the Jira Cloud connector exists but is not configured) |
| Hypotheses (for / against / unknown, weak / moderate / strong), Observed / Inferred / Unknown | Email delivery (rendered in-app, never sent) |
| Causality guard, deduplication, attention and risk model | Production actions (rollout pause, rollback, customer messages) |
| Approval enforcement in the execution layer (HIGH / CRITICAL) | Demo night's scripted scenario |
| Agent Trace, golden / adversarial / planner evaluation suites | |
| Jira Cloud connector boundary (REST v3, tested against mocked responses) | |

## Two environments

- **Workspace**: the product. Your watches, monitoring runs, investigations, approvals and the planner switch (Deterministic, or the configured LLM). Sources are labelled *Simulated sources*. The golden scenario is the checkout conversion −18% night.
- **Demo night**: a separate, deterministic, scripted replay of the original agent's overnight scenario (a Klarna payment-provider regression), with its own *Reset & replay*. It has no LLM planner. Resetting it never touches the workspace, including tasks filed from workspace investigations.

The **Workspace | Demo night** switch in the header selects the environment, and the choice survives a reload. Tasks and Approvals show the current environment's records by default; *All environments* is an explicit option, and every record carries its environment badge.

## Run it

```bash
npm install
npm run dev              # http://localhost:5173 (includes the dev-only planner endpoint)
npm test                 # 241 tests: engine, golden, adversarial, planner, providers, environments
npm run typecheck
npm run build            # static build in dist/ (plans deterministically: no planner endpoint)
npm run eval:planners    # MANUAL: real provider calls for configured providers; never part of npm test
```

No API key is needed: without one, Jagr uses the deterministic planner. To plan with an LLM, see *Provider-agnostic planning* below. Keys go in `.env.local`, which is git-ignored and read only by the dev server.

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
src/
  product/                  ← the watch product
    types.ts                Watch, SourceConnection, WatchInvestigation, EmailNotification, MorningBriefDoc…
    catalog.ts              Signals, watch templates, default workspace
    scheduler.ts            Deterministic scheduler: monitoring ≠ briefing, frequencies, timezones, cron mapping
    integrations/           IntegrationAdapter (getMetrics/getIssues/getReleases/getReviews/getEvents/getChanges),
                            simulated Jira/GA4/App Store/Play adapters, email outbox, fixture worlds, deep links
    integrations/jiraCloud.ts  Real Jira Cloud REST v3 connector (tested with mocked responses; not configured)
    agent/tools.ts          Explicit tools: getAnalyticsMetric, getAnalyticsTraffic, getJiraRelease,
                            getRecentJiraIssues, getStoreReleases, getStoreCrashRate, getApp/PlayStoreReviews
    agent/investigator.ts   The agent loop: planner → policy validator → tool call → hypotheses → stop
    agent/planner.ts        Policy validator (provider-independent) + planner exports
    agent/plannerSchema.ts  PlannerProposalSchema: the normalized proposal every planner must produce
    agent/plannerPrompt.ts  Investigation state → provider-neutral prompt
    agent/plannerManager.ts PlannerManager: timeouts, circuit breaker, plan reuse, explicit provider fallback
    agent/providers/        Server-side only: config, registry, adapters (anthropic, gemini, openai[-compatible]), endpoint
    live/*.live.ts          Manual live-provider comparison (npm run eval:planners) — never part of npm test
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

- **Where keys live:** in the Vite dev server process, read only by `providers/config.ts` and used only inside adapters. The browser talks to `/api/planner/health`, `/api/planner/plan` and `/api/planner/test`, and never receives a key. Keys never go into URLs, the bundle, storage or the trace, and upstream error text is redacted. The static production build has no planner endpoint, so it runs the deterministic planner.
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

**Replacing the simulation.** Implement `IntegrationAdapter` for a real API (Jira Cloud REST, GA4 Data API, App Store Connect API, Play Developer Reporting API) and pass it in `createAdapters`. The engine, evaluations and UI don't change. `planJobs` output maps directly onto cron or queue jobs.

## Limitations

- The Jira Cloud connector is real but not configured: Jira API tokens can't safely live in a browser app, so it needs a server. Jira stores release *dates*, not times, so minute-level release timing has to come from the stores or deploy events. Every other source is simulated and labelled SIMULATED SOURCE in the trace.
- Live LLM planning has been verified with **Gemini only** (`gemini-3.1-flash-lite`, real API calls, checkout −18% with and without Jira). Claude and OpenAI adapters are tested against mocked native responses and a local mock server, not the live APIs. One scenario doesn't show that LLM planning beats the deterministic planner; `npm run eval:planners` is the tool for that comparison.
- Live planning is slow and at the provider's mercy: real Gemini calls took about 0.6–18 s each (a full night takes 1–2 minutes), with intermittent 503 "high demand" errors that fall back to the deterministic planner. The planner endpoint exists only in the dev server, so the static deployment always plans deterministically.
- Demo night is the original scripted engine: it does not use the investigation engine or the planner, and it replays a different scenario from the workspace golden case.
- A planner with a different strategy can spend the full 9-call budget where the deterministic planner stops early (seen in ADV-01 and ADV-12 with the impact-first test planner). The budget bounds it; the outcome was unchanged.
- Known failures, from the adversarial set:
  - **ADV-16:** corroboration is counted per provider, so a revenue drop from the same GA4 source doesn't count as independent confirmation. A −18% conversion / −16% revenue night with nothing else goes to the brief instead of an email.
  - **ADV-17:** complaint bursts are dismissed as "did not persist" once they age out of the rolling window.
- No OAuth or email delivery. Everything runs on fixture data in the browser; state is per browser.
- One simulated night (18:00–08:05 UTC). Timezones are supported by the scheduler, but the demo world is anchored to UTC.
- Detection thresholds and confidence weights are hand-set. The golden set was written alongside the engine, so its perfect score shows the rules behave as designed — not that they generalise. Calibration needs labelled incidents from real sources.
- Review and issue classification is keyword-based.
