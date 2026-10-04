# Customer, demo and internal-tool UX boundary

Local implementation against production Golden Path commit `1448112ff1dbaf5a7fadf4e997065e3d6f1682db`, in the independent clone `/private/tmp/jagr-golden-path-main-release`. Uncommitted; no production access, push, merge or deployment.

## Findings before editing

The legacy `WorkspaceProvider` initializes a browser-global simulated tracker with `seedTasks()` and persists it under `nightwatch:workspace:v4`. Demo runs add scripted tasks to that tracker. `createSimulatedIssueTracker()` allocates each team's next numeric ID: seeded PAY-283 leads to scripted PAY-284, and a subsequent simulated draft can become PAY-285. PAY-285 is not a literal signup fixture; its exact original browser record was not inspected. The watch investigation UI also called that simulated tracker for server investigations, despite its lacking workspace/tenant identity. The Tasks drawer searched all tracker tasks, and opening/closing a task replaced search parameters, dropping `env=demo`.

Server workspace creation in `server/app.ts` creates the workspace and owner membership with default settings; it does not seed demo tasks/investigations. No production records were inspected or removed. Existing actual server investigation data remains visible.

## Minimal boundary correction

Reuse the existing URL-derived workspace/demo environment and contexts. Customer Tasks and Approvals follow that environment immediately; remove the customer mixed-environment selector. Server Tasks render recommendations and decisions from the currently authorized ProductContext snapshot, never from the global simulated tracker. Browser-local simulated tasks must match both investigation ID and watch fingerprint in the current browser workspace. Lists, direct-link drawers and sidebar counts use that same filter. Demo task navigation preserves its query parameters.

Server investigation decisions continue through their existing API. They no longer additionally create browser tracker tasks. Browser simulated drafts remain available, with explicit simulation wording and links to the actual browser investigation. Replay input and simulated draft adapters are scoped to their existing environment. Replay commits preserve browser-workspace tasks even if the demo allocates an identical local ID; task-status edits target the record’s environment. Nothing is deleted, migrated or reassigned.

## Customer experience

Onboarding, landing navigation, workspace navigation and demo entry use “See how Jagr works.” The existing full replay remains intact, with detection, investigation, evidence, hypotheses, confidence, recommendations and the morning brief. The persistent header says “DEMO · SCRIPTED REPLAY · No changes are made to your workspace.” Start the demo launches the existing guided replay; the existing replay with current settings remains available.

The overview example explicitly says scripted example / not your workspace data. Its brief is an example brief. Primary setup, secondary demo and tertiary skip remain separate. The empty watches panel teaches setup and links to the demo without filling real activity with fixtures.

Tasks distinguish simulated work from recommendations, approvals and decisions recorded in Jagr. Existing `executed`/`done` action statuses are not external receipts, so they do not imply external completion. No external execution capability or invented confirmation state was added. Evidence and causal uncertainty remain intact.

## Internal tools

Use the existing Vite `import.meta.env.DEV` build distinction. Evaluation Lab and Agent Trace remain available in development; production customer navigation omits them and direct routes show an internal-tool notice. The detailed planner trace section in watch investigations is also development-only; customer evidence, replay and investigation history remain. Evaluation implementations and the authenticated evaluation API are unchanged. This is presentation gating, not a new server authorization system.

## Planner

Deterministic remains default, with fixed-rule next-step selection explained as predictable, auditable and capable of the complete investigation. AI planning specifically chooses the next evidence step and remains unavailable without a provider. The saved AI-egress policy retains its stored value; the toggle is disabled when no provider is available, with explicit saved-policy wording. No provider, planner execution or backend policy changed.

## Verification

- Focused UI/boundary/environment/onboarding/account/quick-start/planner tests: 93 tests / 7 files passed.
- Architecture, architecture protection, authorization, single-tenant and connection tests: 29 tests / 5 files passed. Full suite also covers security and authorization checks.
- Full suite: 917 tests / 83 files passed.
- Typecheck, production build and `git diff --check`: passed.
- Local browser: created an empty server workspace against an in-memory PGlite database with a disposable test identity. Verified zero real watches/signals/investigations/tasks, guided replay and morning brief, simulated task labels, demo drawer query preservation, and returning to an empty real workspace and Tasks.
- Local Settings: deterministic selected; AI radio unavailable; saved AI policy toggle disabled and explained.
- Local production build: no Evaluation Lab/Agent Trace navigation; direct Evaluation Lab route blocked by internal-tool notice.
- Local development build: Evaluation Lab functional (10/10 golden cases, 15/17 adversarial cases with the existing two documented limitations; zero regressions; legacy suite 7/7); internal trace remains accessible.

No live production test was run. No external tasks or notifications were sent. Test database migrations only initialize the disposable database using unchanged existing migrations.

## Limits and preserved behavior

The precise provenance of the originally reported PAY-285 cannot be established without that browser's saved record; the inspected code explains its possible allocation and the rendering leak. The simulated store retains existing records; server workspaces cannot render them. Current backend action contracts have no external execution receipt; UI conservatively represents recorded decisions. Internal-tool presentation gating does not restrict the existing authenticated evaluation API. Existing Vite native-config and bundle-size warnings remain.

Connected watch selection, signal mappings, execution receipts/status and all production core, connector, worker, scheduler, queue, lease, retry, migration and deployment files are unchanged. The original dirty worktree was not used for edits or commands. HEAD remains the deployed Golden Path merge; no commit was created.

## Files changed

- `src/App.tsx`
- `src/components/AppShell.tsx`
- `src/components/RunPlayer.tsx`
- `src/components/WorkspaceGate.tsx`
- `src/components/agent.tsx`
- `src/components/onboarding.test.ts`
- `src/components/onboarding.tsx`
- `src/components/product.tsx`
- `src/components/serverWorkspace.tsx`
- `src/components/work.tsx`
- `src/pages/Approvals.tsx`
- `src/pages/Evaluations.tsx`
- `src/pages/Overview.tsx`
- `src/pages/ProductOverview.tsx`
- `src/pages/Settings.tsx`
- `src/pages/Tasks.tsx`
- `src/pages/WatchInvestigation.tsx`
- `src/pages/attention-day.production.html`
- `src/state/environment.test.ts`
- `src/state/customerBoundary.ts`
- `src/state/customerBoundary.test.ts`
- `src/state/store.tsx`
- `src/state/workspace.ts`
- `docs/CUSTOMER-DEMO-UX-BOUNDARY.md`
