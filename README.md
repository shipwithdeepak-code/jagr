# JAGR

**AI Product Operations Agent**

> Investigate what changed. Act before it becomes an incident.
>
> Your product doesn't sleep. Neither does JAGR.

JAGR is an AI product-operations agent that works while the team is away. It monitors product signals overnight, investigates meaningful changes, gathers evidence across systems, decides what needs attention, files the work, and prepares a morning brief. Consequential actions wait for a human.

This is a portfolio build. **Every integration is a deterministic simulation** behind a typed adapter interface. No external system is connected.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 50 tests: detection, evidence, hypotheses, confidence, policy, tasks, approvals, evaluation suite
npm run typecheck
npm run build      # static build in dist/ — deploy to Vercel/Netlify (SPA rewrites included)
```

No API key is needed. The whole product runs in the browser.

## The 3-minute demo

1. **Overview** — "This is JAGR, an autonomous product operations agent."
2. **Demo Mode** (sidebar) — resets the workspace and replays the night from 6:00 PM in ~30s. Every line shown is a real event from the orchestrator.
3. **Morning brief** — Subscription conversion −11.8%, 87% confidence, Klarna regression after v4.8.1. What JAGR did / did not do.
4. **Open investigation** → evidence graph (click a node for source data; click a hypothesis to see what it rests on) → confidence breakdown.
5. **Task PAY-284** — why JAGR created it, the policy decision, and the evidence refreshed at 08:00.
6. **Approvals** — why disabling Klarna or rolling back needs a human. Try *Request More Evidence*.
7. **Evaluations** — 7 scenarios, 0 false alerts, 0 approval violations. "An agent that acts without evaluation isn't something I'd trust."
8. Back to the **brief**.

To show it's not scripted, go to **Integrations**, switch GitHub off, then **Run Overnight**. The same night now concludes "Klarna checkout regression (cause not yet identified)" at 72%, and no rollback is proposed.

## Architecture

```
src/
  domain/       Types (Signal → Evidence → Investigation → Hypothesis → Action → Task) and defaults
  adapters/     Adapter interfaces: Analytics, Payments, GitHub, Support, Experiments, IssueTracker, Notifications
  simulation/   Metric catalogue, scenario builder, 5 raw-data scenarios, simulated adapters
  agents/       Orchestrator and stages: detection, evidence playbooks, hypotheses & confidence,
                risk & autonomy policy, actions/tasks/approvals, morning brief, reasoning engines
  evaluation/   Behavioural evaluation suite (7 scenarios)
  state/        Workspace store (browser-persisted)
  components/   UI system, evidence graph, charts, run player
  pages/        Overview, Investigations, Tasks, Signals, Agent Trace, Approvals, Evaluations, Integrations, Settings, About
```

**The loop** (`agents/orchestrator.ts`): every 30 simulated minutes from 18:00 to 08:00 →
`collectSignals` → `detectAnomalies` (threshold + ≥3σ + persistence) → `prioritizeSignals` (metric-tree clustering) →
`investigateSignal` → `gatherEvidence` (playbook per surface) → `generateHypotheses` → `evaluateConfidence`
(log-odds scorer + reserved "unexplained" mass) → `assessRisk` → `determineAction` (autonomy policy) →
`createTask` / `createIncident` / `requestApproval` → pre-brief evidence refresh → `generateMorningBrief`.

**Nothing is hard-coded.** Scenarios hold raw data only: metric series, provider error codes, deploys, PR file lists, tickets and experiment allocations. The Klarna/v4.8.1 conclusion and its 87% are derived at runtime.

**Autonomy.** L0 Observe · L1 Investigate · L2 Recommend · L3 Execute low-risk (tasks, incident drafts, on-call, evidence) · L4 Human approval (rollback, payment methods, pricing, refunds, customer comms, production config). L4 gates can only be *require approval* or *disabled*. The executor independently refuses any L4 action without an approved record; evaluation scenario 07 sabotages the planner to prove it.

**LLM.** `agents/modelReasoner.ts` implements a model-backed reasoner: structured JSON, Zod schema validation, rejection of hallucinated evidence ids, a timeout, and deterministic fallback. It isn't wired to a key because a browser app shouldn't hold one — it needs a small server-side proxy implementing `ModelClient`. Confidence always comes from the deterministic scorer.

## Replacing the simulation

Implement the interfaces in `src/adapters/types.ts` (e.g. `AnalyticsAdapter` over Amplitude, `IssueTrackerAdapter` over Linear) and build an `AdapterSet` in place of `createSimulationAdapters` in `agents/runScenario.ts`. The orchestrator, evaluation suite and UI don't change.

## Limitations

- Integrations, approvals and "executed" actions affect simulated state only.
- Likelihood weights are hand-set; production would calibrate them against labelled incidents.
- State is per-browser (localStorage); there is no scheduler, backend or auth, by design.
- The overnight run is computed instantly and replayed in compressed time.
