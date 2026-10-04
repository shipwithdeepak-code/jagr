# Jagr Golden Path Product Audit

## Executive Summary

**Jagr has a coherent product idea and an understandable investigation document, but it does not yet have a complete, dependable self-service golden path for a first live beta user.** The preferred Amplitude + Sentry + GitHub investigation is supported by connector/core concepts but blocked by the current watch wizard's provider lists. Queued first-check results are not tracked through completion, and simulated action completion can appear inside a live workspace. These are product boundary problems, not reasons to reopen infrastructure work.

Audit date: 2026-10-03. Target: production baseline `7ef8b00ab160c4406f69d230fe85beccdb84d288`. This is a static implementation/contract audit, not a live usability session or provider verification. UI/state/catalog/connectors/agent files inspected in the isolated candidate have no diff from this baseline. Baseline server/core behavior was inspected; drain/release changes are excluded from this product assessment. No browser, live provider, production app or database test was performed. Claims about user confusion are audit inferences, not observed user-study results.

Original dirty worktree and stopped release candidate are left untouched. This report lives in a separate audit directory, so it does not enter the production release candidate. Code pointers below are repository-relative paths at the audited baseline.

The five P0s are: make one live watch selectable with actual connected providers; make its required signal mapping understandable; distinguish queued/running/completed/gapped checks; label actions as drafts/recorded decisions rather than external execution; stop labeling missing evidence as healthy.

## Current Product Mental Model

The public headline, “Know what changed while you were away,” gives an immediate outcome. Supporting copy explains watch → meaningful change → investigation → attention. The example says conversion declined, errors increased and a release preceded the decline, explicitly separating observed, inferred and unknown. This is a useful opening for PMs responsible for product behavior, stability and cross-team triage; the audience is implicit rather than narrowly named.

The application then introduces a workspace, sources, a standing question called a watch, scheduled checks, investigations, attention levels and a brief. Those concepts are aligned. A first user nevertheless encounters parallel experiences: live server workspace, imported files, sample workspace, and scripted Demo Night. These are labeled, but they offer different activation paths and action semantics.

Terms that need a plain explanation at their point of use: “evidence source,” “signal,” “capabilities,” “work_items,” “baseline,” “corroborated,” and “cadence.” Technical audit vocabulary such as planner, validator verdict, tool call, pass, dedupe key and replay already sits mainly in advanced views; keep it there. “Connect the tools where your product changes show up” is a clearer source-selection lead than raw role names.

Evidence: `src/pages/attention-day.production.html`, `Landing.tsx`, `components/onboarding.tsx`, `ProductOverview.tsx`, `AppShell.tsx`.

## Current Golden Path

1. Open `/`. Choose Continue with Google when that provider is configured, or Explore locally / Demo Night. Public/gate entry only exposes Google; account settings can list all configured sign-in providers, including GitHub.
2. Sign in, open an existing workspace (one can auto-open), or create a named workspace with Live sources or Imported files. Live workspace explains that checks continue with the browser closed.
3. Overview shows the first-run illustration; “Set up my first watch” acknowledges it and reveals Quick Start. Quick Start asks for one verified live evidence source, a compatible watch and a first check.
4. Open `/sources`, choose a registered provider, configure its resource and credential, and Connect and test. Only owner/admin can manage sources. A healthy quick-start connection can return the user to Overview.
5. Open `/watches?new=1`. Choose a fixed template and traverse six steps: question, change threshold, sources, frequency, interrupt level and morning brief. Save, then Run monitoring now.
6. In a connected server workspace, Run now queues durable work and reloads the snapshot once. It is not a guarantee that the investigation has finished. The user may need a later refresh/revisit to see the result.
7. A detected finding appears on Overview/Investigations and opens `/investigations/w/:id`. The detail presents signal, impact, timeline, evidence, explanation, unknowns and next action. A quiet check can be valid; no investigation should be manufactured.
8. Review a recommendation/approval or create a task. Current external actions are simulated/recorded; Tasks uses a browser-local simulated tracker even when launched from a server investigation.
9. Return to the server workspace to see persisted investigation/decision/run history and briefs. Task status in the shared local tracker is not proof of a production fix or durable server outcome across devices.

**Current path limits:** GitHub alone can create its explicit change watch; that primarily reports releases/deployments and opens findings for failed deployments, not for every successful release. Connecting Amplitude/Sentry/GitHub does not unlock a suitable cross-source checkout template in the current wizard. API capability does not equal a usable UI path.

## Proposed Golden Path

For the controlled beta, offer one product question: **“Is checkout conversion changing, and what else changed around it?”**

1. Understand one concrete example, visibly illustrative.
2. Sign in and open a Live sources workspace.
3. Connect Amplitude (conversion), Sentry (relevant errors) and GitHub (production releases). An assisted beta can pre-agree resource IDs, event names and read-only permissions; do not conceal that preparation.
4. Create one checkout watch using those verified sources and existing configured metrics. Start with existing reasonable defaults; show what is watched, evidence coverage, check frequency and attention policy before saving.
5. Run the first check and see pending → completed with either a finding, a genuine quiet result, or an evidence gap. A queued check must not be described as completed.
6. If a real change exists, open an investigation showing conversion relative to its baseline, relevant errors and release timing, source links and freshness. If not, show when Jagr checked and what it could actually read.
7. Read “the decline is observed; this release is a possible association; cause is unproven,” then one practical next step.
8. Record a decision or prepare/copy a task. Make external execution status explicit; do not imply Jira/production was changed.
9. Return later to the recorded investigation/check/decision. Distinguish observed recovery from “someone fixed it.”

No connector implementation, action executor, new scheduler or guaranteed incident is implied. A sample/imported walkthrough is a separate clearly labeled route for learning the full narrative when the user's real product has no anomaly.

## First-Time User Journey

| Step | What appears / required action | Likely friction / next-step clarity |
|---|---|---|
| Landing | Clear headline, explanatory example; Google, Explore locally, Demo Night | Three experiences require a choice before the user knows their consequences; local exploration opens sample data. Google absent means public live entry is hidden even if another provider exists |
| Sign-in | OAuth entry and restoring workspace gate | No end-to-end sign-in availability verified here. Reauthentication preserves destination; settings has broader provider support than public entry |
| Workspace | Name, Live sources / Imported files | Simple and useful; “workspace” adds administration but explains background watching. Existing single workspace auto-opens |
| First-time Overview | Welcome illustration → Quick Start | “Set up my first watch” initially acknowledges welcome rather than opening creation. Illustration is teaching material, not evidence from this workspace |
| Sources | Provider cards, purpose in connect modal, read-only permissions, test result | Selection cards expose roles rather than the product questions they answer. Mapping metrics can require JSON. Credential health is not proof that useful metric data exists |
| First watch | Six-step wizard, compatibility blockers, defaults | Good local explanations, but fixed provider lists block the target providers. Many policy choices before seeing value |
| First check | Run now, running copy, one refreshed snapshot | Submission and asynchronous completion are conflated. No completion polling is evident in product state; server error is preserved but prior results can still be displayed |
| First investigation | Needs attention → evidence document | Good summary and disclosure. PM still needs a clear distinction between confidence in a signal and a possible cause |
| Return | Last checked, run history, sources, briefs, prior decisions | Dates/history support continuity; local task state and simulated approvals break the expectation of a real team outcome |

Sources: `App.tsx`, `state/surface.ts`, `WorkspaceGate.tsx`, `state/firstRun.ts`, `onboarding.tsx`, `serverWorkspace.tsx`, `state/product.tsx`.

## Source Connection Audit

“Implemented” means a registered adapter and UI setup path, not verified production readiness.

| Source | Actual current role and setup | Readiness distinction |
|---|---|---|
| Amplitude | Real Dashboard REST adapter; conversion/event bindings, annotations, region/key/secret | Registered and configurable. Normal form does not expose numerator/denominator event bindings; advanced JSON carries them. Docs explicitly lack successful live credential verification. Hourly complete buckets mean sustained-drop detection can take roughly three complete hours |
| Sentry | Real error/crash metrics, issues and releases; org/projects/environment/token; 15-minute source checks with durable normalized events | Registered, fixture/e2e coverage exists. Metric keys/query mappings remain advanced configuration. Live configured-provider success not established by this audit; connector documentation's summary table omits Sentry despite implementation |
| GitHub | Real read-only deployments/releases; repositories/environment names/token | Best documented live read-path evidence; docs say token authentication was not verified in that exercise. “Production” vs “production” matters. Valid connection can still find no deployments |
| Jira Cloud | Reads issues and released versions for one project | Registered read path; does not create/update Jira tasks. Docs do not establish successful configured live verification |
| Intercom | Reads customer-started support conversations | Registered read path; successful live credential verification not established by docs |
| Slack | Posts alerts/briefs only; bot/channel setup | Delivery channel, not an investigation source. No Slack message reading or interactive decision endpoint |
| GA4, App Store, Google Play | Catalog/template/sample vocabulary | Not registered live connectors in CONNECTORS. Do not promise live setup merely because template/copy names them |
| Email, Teams | Delivery choices represented in UI | Explicitly unavailable / coming soon; email previews are not proof of email delivery |
| Linear | Tracker concept/demo interface | No registered live connection/action execution path identified |

Source purposes are explained in connect modals, but selection cards mainly say “metrics · changes · work_items.” A PM should see “conversion and usage,” “errors and stability,” and “releases near the change” before choosing. The current UI correctly separates delivery channels from evidence sources and explains encrypted storage and read-only access.

Connection testing validates credentials/resource access. It does not by itself prove correct funnel mapping, sufficient baseline history, matching environment or relevant error scope. Do not treat a healthy credential as complete investigation coverage.

Evidence: `integrations/connectors/index.ts`, `connectionTypes.ts`, `view/connectionForm.ts`, `components/serverWorkspace.tsx`, `docs/CONNECTORS.md`. No provider credentials requested or accessed.

## Watch Creation Audit

A watch is already explained as a standing question (“Is checkout healthy?”). The wizard asks understandable questions and provides disabled-button reasons, missing-source explanations, daily-time selection, alert guidance and a post-create Run now action. Keep those strengths.

**Core mismatch:** `catalog.ts` checkout_health/conversion/revenue source lists still use GA4/Jira/app-store providers. `Watches.tsx` derives initial selection, source rows and availability directly from `tpl.sources`; `view/watchWizard.ts` only intersects those IDs with connection state. It does not use portable evidence roles to include Amplitude/Sentry/GitHub. The server watch POST can accept selected connected sources explicitly and add their configured area/telemetry metrics, so there is an existing boundary to use rather than inventing a parallel model.

Cadence means how often to check, not how soon evidence becomes detectable. The wizard recommends 30 minutes, while Amplitude's hourly data can require several complete hours of sustained change. “Critical immediately” means upon a detecting run, not continuous real-time observation. The brief has its own schedule; interrupt/brief thresholds are separate choices and can overwhelm a first user.

Smallest first-watch experience: one question, relevant verified sources/mapped metric, review of existing defaults, save and a clearly tracked first check. Threshold tuning, daily cadence, alert policy and brief filtering can remain editable without six compulsory decisions. Do not remove their underlying controls or alter detection policy in this audit.

## Detection → Investigation Audit

Real connected flow: connection configuration → available role sources → scheduled/manual queued watch work; Sentry additionally observes SourceTargets and persists deduplicated NormalizedEvents, maps relevant observations to watch slots and carries event references. Other connectors use watch-run reads. Monitoring reads tenant-scoped sources, the complete paged canonical investigation history and the selected watches. Missing/unavailable sources are gaps, never replacement fixtures.

Detection evaluates unusual sustained metric movement / issue-feedback volume; successful changes add context rather than automatically opening incidents. GitHub failed deployments have a dedicated finding path. The engine groups relevant signals, consults available evidence roles, compares release timing and independent signals, records hypotheses/unknowns, applies deterministic attention/approval rules and produces next steps. Optional AI planning proposes permitted evidence steps; it is not required to understand the product or a promise of autonomous fixes.

Investigations merge subsequent checks rather than creating a fresh alert every time; recovery/reopening semantics are evidence-driven. Slack delivery requires a configured channel; in-app findings and briefs can exist without outbound delivery.

Browser sample mode runs the same product engine over fixture data; imported mode uses the uploaded world/window; Demo Night is a separate scripted environment. “Explore locally” auto-runs sample monitoring. Those results cannot prove live connector readiness or future production behavior.

Experience breaks before and after the engine: target watch selection fails, first-check pending state is unclear, and recommendations can look externally executed. A lack of incident is not a failure; beta should assess both valid quiet checks and an explicitly labeled incident walkthrough.

Evidence: baseline `server/app.ts` watch/runs routes, `app/monitoring.ts`, `app/sourceChecking.ts`, `engine/detect.ts`, `engine/monitor.ts`, `state/product.tsx`.

## Investigation Experience Audit

The watch investigation route already has the desired structure. Avoid replacing it with a generic alert feed or new dashboard.

| Content | First-investigation treatment |
|---|---|
| Problem/change | Essential immediately: title, observed metric/baseline, onset and signal state |
| Impact | Essential: current attentionReason describes significance, not necessarily measured lost revenue/users. Do not invent quantitative impact |
| Conclusion/next step | Essential: Decision summary contains why it matters, likely explanation, unknown and recommendation |
| Confidence | Essential but label its object: confidence the signal is real, separate from evidence supporting a cause |
| Evidence + source links/freshness | Essential, following summary; observed and correlated stages present |
| Timeline/releases | Essential to orient evidence; preserve “timing shows order, not causation.” Date plus time would help returning across days |
| Support/issues | Relevant supporting/contradicting evidence when present, not an obligatory empty panel or fabricated corroboration |
| Hypotheses | Leading possible explanation helpful; full alternatives/support counts secondary. “Possible explanations” is more natural PM language |
| Assumptions/unknowns | Visible and concrete, especially missing sources; assumptions remain separate from findings |
| Actions/approvals | Essential scope/result honesty; recommended, approved and executed must remain distinct |
| Created tasks | Secondary until chosen; show draft/local destination and whether anything was filed externally |
| Reasoning/trace/replay | Secondary; already collapsed under How Jagr investigated. It is a structured record, not private model chain-of-thought |
| Run history/audit | Useful on return; retain timestamps/decisions, hide dedupe keys and validator/tool vocabulary from main reading |

`WatchInvestigation.tsx` repeats impact/explanation/next step between Decision summary and later sections. This is a P1 condensation opportunity, not a missing architecture. `Investigations.tsx` also contains legacy Demo Night detail/routes; the core beta should consistently link to the watch-investigation route and keep environments explicit.

## Trust & Evidence Audit

Strong existing foundations: observed/correlated/inferred/assumed/unknown stages; recorded provenance mode wins over current source state; provider names, timestamps, freshness and record links; “Cause not established”; signal confidence explicitly separated from cause; timeline timing caveat; unavailable sources recorded as gaps; ordinary negative checks progressively disclosed.

Remaining trust gaps:

- Overview computes healthy watches largely from absence of an open attention finding. A gapped or never-run watch can contribute to reassuring counts; individual card health can become Healthy after any recorded run without checking its evidence completeness. A later paragraph may admit a gap while the main summary says healthy.
- Credential verified is not enough to say relevant signals fully feed an investigation; distinguish connection access from actual data availability.
- Action UI uses approved/done/executed as completion-like statuses, even though external execution is simulated. Approval is a decision, not a production outcome.
- “Independent sources moved together” should be read as corroborating signals, not proof that each source independently establishes root cause. Release proximity must retain its uncertainty.

Keep the present source/evidence distinctions. Fix the summaries that collapse them rather than adding a new confidence system.

## Empty / Loading / Error States

| State | Current evidence / risk | Product need |
|---|---|---|
| No sources | Quick Start and Sources CTA; role-based cards | Explain which 2–3 sources answer one question; expose catalog-load failure rather than silently emptying connection types |
| No watches | Standing-question explanation and Create watch | Make the chosen live providers usable in the template |
| No changes | Quiet-check outcome/next time is explained | Only claim quiet/healthy when relevant evidence was available |
| Investigation running | Loading when missing investigation and running=true; running headline | Server flag tracks enqueue request, not durable execution completion |
| Investigation failed | Run errors retained in serverError; shell can report failure | Keep prior result timestamp and explicit failed/pending state, with retry/refresh action; do not infer success from existing snapshot |
| Connector failure | Test toast, source health, reconnect/error groups | Good actionable states; needs_reconnect group wording “without credentials” is narrower than rejected/invalid credentials |
| Stale source | Data-up-to and gap explanation | Carry freshness/coverage into Overview verdict, not just source detail |
| Insufficient evidence | Unknowns/gaps/confidence reason | Show limitation in decision summary; avoid healthy by absence |
| No related evidence | Unknowns and normal-check disclosure | “Could not check” versus “checked and none found”; do not require all sources to agree |
| Returning user | Historical run completes onboarding; last checked/history/briefs | Good continuity, but new job results require refresh; local task status is not server outcome |

## Simulated / Non-Production Actions

1. `product/agent/actions.ts:executeAction` returns simulated/draft strings, not live rollout, rollback, customer communication or external issue writes. Server decisions invoke this same function and persist the decision; approval enforcement is real, external execution is not.
2. `components/agent.tsx:ActionRow` labels a server-workspace button “Do it,” shows Done by Jagr/Done/Approved, and invokes task creation without awaiting it before recording done. Task creation failure or server decision rejection can coexist with an immediate success-like toast. This must not be interpreted as completed external work.
3. `WatchInvestigation.tsx` calls `useWorkspace().createTaskFromDraft`; `state/store.tsx` routes to simulation adapters/localStorage. Its server-context “Task filed” message omits the simulated qualifier, although the Tasks page globally explains the tracker is simulated.
4. The Decision summary maps approved alongside done/executed to “Already completed.” That overstates approval.
5. LOW issue-link proposals can describe adding external comments and be marked executed although no tracker write occurs. Action result/detailed trace sometimes clarifies simulation; the prominent label still misleads.
6. Demo Night approval/task state affects its scripted environment only. In-app email previews are content artifacts; actual supported outbound channel is Slack, not email.

There is no baseline UI identified for a distinct human outcome ledger proving a fix/rollback/customer communication occurred. Existing decisions/notes and observed recovery can support a limited return journey; do not invent Phase 4A outcomes or pretend task completion proves cause/remedy.

## P0 Changes

| P0 | Current problem / exact user impact | Smallest change and components |
|---|---|---|
| 1. One live-compatible watch | Verified Amplitude/Sentry/GitHub cannot be selected together in the checkout/conversion wizard; target user hits unavailable or gets a GitHub-only watch | Use existing connection roles and configured metric identities to offer one Checkout health path; preserve server watch validation. `Watches.tsx`, `view/watchWizard.ts`, `view/quickStart.ts`; avoid changing queue/core policy |
| 2. Human signal setup | Advanced JSON carries conversion event bindings and Sentry metric query; healthy credential can monitor placeholder/wrong signals | Expose only numerator/denominator and relevant error scope for this one beta question using existing validated config schema; show what metric/data check will read. `serverWorkspace.tsx`, `view/connectionForm.ts` |
| 3. First-check completion | Run now receives run_queued, clears running and refreshes once; PM cannot tell waiting from quiet | Reflect the existing enqueue response and recorded run identity, provide queued/waiting/completed/failed or refresh status without claiming immediate completion. `state/product.tsx`, `onboarding.tsx`, `ProductOverview.tsx`. Use existing contracts, no scheduler redesign |
| 4. Honest action destination/status | Live screen implies externally filed/completed work while actions/tracker are simulated; PM may believe engineering/customer action happened | Label Draft in Jagr / recorded decision / simulated task, keep approval distinct from execution, await task/decision outcome before success. `agent.tsx`, `WatchInvestigation.tsx`, `state/product.tsx`, shared task UI. No external executor required |
| 5. Coverage-aware reassurance | Gapped/not-run checks can count healthy; PM may stop investigating an unobserved problem | Derive summary/card wording from recorded check coverage/run outcome; show Needs setup / Pending / Checked with gaps / No qualifying change as appropriate. `ProductOverview.tsx`, `view/watchCard.ts`, `view/quickStart.ts`; do not change detection thresholds |

These are the five required product fixes for the specified live cross-source beta, not a broad redesign. An operator-assisted GitHub-only read-path beta has narrower requirements but does not demonstrate the proposed conversion investigation.

## P1 Changes

- Collapse first-watch advanced policy choices behind default review; preserve later editing. Reduce six mandatory decisions.
- Explain providers on selection cards with one product-purpose sentence. Align visible template copy/connector documentation with implemented providers, including Sentry; expose supported sign-in providers consistently.
- Remove repeated impact/explanation/next-step prose; keep evidence and confidence object obvious. Prefer Possible explanations, Investigation record and Source checks over Hypotheses/tool-call language in the first reading.
- Show full dates on multi-day investigation timelines and a clear return-to-investigation link from draft/decision history. Clarify actual delivery channel versus in-app preview.

## Deferred / Do Not Build Yet

P2: visual polish, advanced filters and richer trace/replay presentation after observing real beta use. Do not build more dashboards, speculative AI autonomy, more connectors, live production action execution, a new outcome model, Phase 4A memory/shadow, scheduler scaling, queue optimization or drain release as part of this product work. Do not invent causality, a real incident, connector success or executed remedy for a better demo.

## Recommended Beta Flow

Use one PM, one workspace and one agreed conversion metric/error scope/production repository. Preparation can be assisted and disclosed. First confirm access plus useful signal mappings, then create one meaningful watch and complete a visible first check. Observe real product changes only through authorized read-only sources; do not synthesize production incidents. If the product is quiet, accept the truthful quiet/gapped result and use a separately labeled sample/imported scenario to explain the multi-source investigation.

When a finding exists, ask the PM to explain what changed, why it matters, which records support it, what cause is only possible, what remains unknown and their next step. They should be able to distinguish a recorded recommendation/decision from an executed action. On return, test whether they can find the same investigation and tell observed recovery from local task status.

Success is comprehension and a complete evidence/decision loop, not an alert count or throughput claim. Live readiness of the exact Amplitude/Sentry/GitHub account combination remains unverified; this audit does not authorize provider evaluations or production activity.

## Final Product Principle

Give one PM one standing product question and a trustworthy answer: **“Here is what changed, here is the evidence we could read, here is what might explain it, and here is the next decision for you.”** A quiet product and unavailable evidence must remain different. A suggested action and an executed action must remain different.

1. **Coherent golden path today?** Coherent concept and investigation reading; incomplete self-service live path for the preferred source trio and outcome loop.
2. **Most important P0s?** Live-compatible first watch; simple validated signal mapping; truthful queued-check progress; honest action/draft completion; coverage-aware quiet/healthy states.
3. **Exact next implementation task:** Fix only the connected-workspace watch wizard/Quick Start compatibility so a healthy Amplitude + Sentry + GitHub workspace can create one Checkout health watch through the existing server contract. Include focused regressions for those providers/configured metric identities and prevent selection of missing sources. Do not change scheduling, queue, workers or detection policy. This task is recommended, not implemented or authorized by this audit.

Delivery: audit only. No code/UI/infrastructure changes. Original dirty worktree and isolated release candidate preserved. Production baseline unchanged; production database not touched. No commit, push or deploy.

## P0.1 / P0.2 implementation update — isolated Golden Path branch

The historical audit above is preserved. Its live-compatible first-watch and JSON-only signal-mapping findings have materially changed in `/private/tmp/jagr-golden-path`: the connected checkout/conversion wizard now offers verified, healthy workspace Amplitude, Sentry and GitHub connections, requires Amplitude, and exposes event/error mapping controls through existing connection configuration contracts. Quick Start recommends the existing checkout template for healthy connected Amplitude. Mapping saves explicitly affect shared workspace configuration; credentials are retained by the server. GitHub context means the connector's existing releases/deployments and commit links, not a new commit feed. No live provider evaluation or production activity was performed. P0.3's existing execution-status contract remains unchanged. The other audit findings and beta limitations remain applicable.
