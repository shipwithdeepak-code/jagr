import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ActionDecision, BriefSchedule, ConnectionState, ProposedAction, ProviderId, Watch } from '@/product/types';
import { decide as decideAction } from '@/product/agent/decisions';
import { fetchPlannerHealth, llmAvailability, resolvePlanner, type PlannerHealth } from './plannerConfig';
import { defaultBriefSchedule, defaultWatches } from '@/product/catalog';
import { defaultConnections } from '@/product/integrations/adapters';
import { defaultWorld } from '@/product/integrations/world';
import { runMonitoring as runEngine } from '@/product/engine/monitor';
import { importFile, type ImportedDataset, type ImportKind } from '@/product/imports/schemas';
import { buildImportedWorld, watchesForImportedData } from '@/product/imports/world';
import { reduceProgress, startProgress, type RunProgress } from '@/product/progress';
import type { RunEvent } from '@/product/engine/monitor';
import { ProductContext, type ProductApi, type ProductState, type WorkspaceMode } from './productContext';
import { migrateStoredProductState } from './productMigration';
import { exportLocalWorkspace, localWorkspaceFromExport, planImport, type ImportPlan } from '@/product/export/workspace';
import { EMAIL_FROM } from '@/product/catalog';

/** Recorded in exports this browser produces. */
const APP_VERSION = '1.1.0';

/**
 * Product workspace, persisted in this browser (localStorage). Two data modes:
 *   sample   — the simulated sample night (clearly labelled SIMULATED)
 *   imported — the user's own CSV / JSON evidence (labelled USER IMPORT)
 * Either way the same engine, planner, validator and approval rules run.
 */

const KEY = 'jagr:product:v3';
/** Workspaces saved before the role-based refactor. Read once, migrated, then removed. */
const LEGACY_KEY = 'jagr:product:v2';
const CLOCK = '2026-09-24T08:05:00.000Z';

function initial(): ProductState {
  return { version: 3, connections: defaultConnections(), watches: defaultWatches(), brief: defaultBriefSchedule(), stale: false, clock: CLOCK, decisions: {} };
}

function emptyImportedWorkspace(planner: ProductState['planner']): ProductState {
  const now = new Date().toISOString();
  return { ...initial(), workspace: { mode: 'imported', createdAt: now }, watches: [], imports: [], connections: buildImportedWorld([], now).connections, clock: now, planner };
}

function load(): ProductState {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (!raw) return initial();
    return migrateStoredProductState(JSON.parse(raw)) ?? initial();
  } catch {
    return initial();
  }
}

const hhmmUtc = (iso: string) => iso.slice(11, 16);

export function ProductProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ProductState>(load);
  const [running, setRunning] = useState(false);
  const [storageError, setStorageError] = useState<string | undefined>();
  const [health, setHealth] = useState<PlannerHealth | undefined>();
  useEffect(() => {
    void fetchPlannerHealth().then(setHealth);
  }, []);
  const ref = useRef(state);
  ref.current = state;

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      // The migrated copy is saved; the pre-migration copy would only waste the storage quota.
      localStorage.removeItem(LEGACY_KEY);
      setStorageError(undefined);
    } catch {
      // Never pretend it saved: imported data can exceed the browser's storage quota.
      setStorageError('This browser could not save the workspace (storage full or blocked). It works for this session, but will be lost when the tab closes. Remove some imports to free space.');
    }
  }, [state]);

  const mode: WorkspaceMode | undefined = state.workspace?.mode;
  const importedWorld = useMemo(() => (mode === 'imported' ? buildImportedWorld(state.imports ?? [], state.clock) : undefined), [mode, state.imports, state.clock]);

  // Live progress: events fold into a ref and reach React at most once per frame.
  const [progress, setProgress] = useState<RunProgress | undefined>();
  const progressRef = useRef<RunProgress | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const onEvent = useCallback((e: RunEvent) => {
    if (!progressRef.current) return;
    progressRef.current = reduceProgress(progressRef.current, e);
    if (frame.current === undefined && typeof requestAnimationFrame !== 'undefined') {
      frame.current = requestAnimationFrame(() => {
        frame.current = undefined;
        setProgress(progressRef.current);
      });
    }
  }, []);

  const execute = useCallback(async (s: ProductState) => {
    setRunning(true);
    progressRef.current = startProgress();
    setProgress(progressRef.current);
    try {
      const imported = s.workspace?.mode === 'imported';
      const iw = imported ? buildImportedWorld(s.imports ?? [], s.clock) : undefined;
      if (imported && !iw?.world) {
        setState((prev) => ({ ...prev, result: undefined, stale: false }));
        return undefined;
      }
      const world = iw?.world ?? defaultWorld();
      const connections = iw?.connections ?? s.connections;
      const watches = iw ? watchesForImportedData(s.watches, connections) : s.watches;
      // Imported data has its own time range: compose the brief at the end of it.
      const brief = iw ? { ...s.brief, time: hhmmUtc(world.end), timezone: 'UTC' } : s.brief;
      const { planner, info } = await resolvePlanner(s.planner ?? 'deterministic');
      const result = await runEngine({ planner, world, watches, connections, brief, onEvent, appBaseUrl: typeof window !== 'undefined' ? window.location.origin : undefined });
      const states = connections.filter((c) => c.provider !== 'email' && c.state !== 'not_configured').map((c) => c.state);
      const data = imported ? 'imported' : states.every((x) => x !== 'connected') ? 'simulated' : states.every((x) => x === 'connected') ? 'live' : 'mixed';
      setState((prev) => ({ ...prev, result: { ...result, planner: { ...info, data } }, stale: false, clock: imported ? world.end : CLOCK }));
      return result;
    } finally {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
      progressRef.current = undefined;
      setProgress(undefined);
      setRunning(false);
    }
  }, [onEvent]);
  const runMonitoring = useCallback(() => execute(ref.current), [execute]);

  // Sample workspace, first visit: run the sample night so there is something real to look at.
  // A brand-new visitor (no workspace yet) sees the welcome instead.
  useEffect(() => {
    if (ref.current.workspace?.mode === 'sample' && !ref.current.result) void runMonitoring();
  }, [runMonitoring]);

  const createWorkspace = useCallback(
    (m: WorkspaceMode) => {
      const next = m === 'imported' ? emptyImportedWorkspace(ref.current.planner) : { ...initial(), workspace: { mode: 'sample' as const, createdAt: new Date().toISOString() }, planner: ref.current.planner };
      setState(next);
      if (m === 'sample') void execute(next);
    },
    [execute],
  );

  const addImport = useCallback((kind: ImportKind, filename: string, text: string): ImportedDataset => {
    const importedAt = new Date().toISOString();
    const ds = importFile(kind, filename, text, importedAt, `imp-${kind}-${Date.parse(importedAt)}-${Math.random().toString(36).slice(2, 7)}`);
    // A file that could not be read at all is reported, not stored.
    if (!ds.error) {
      setState((s) => {
        const imports = [...(s.imports ?? []), ds];
        return { ...s, imports, connections: buildImportedWorld(imports, s.clock).connections, stale: true };
      });
    }
    return ds;
  }, []);

  const removeImport = useCallback(
    (id: string) =>
      setState((s) => {
        const imports = (s.imports ?? []).filter((d) => d.id !== id);
        return { ...s, imports, connections: buildImportedWorld(imports, s.clock).connections, stale: true };
      }),
    [],
  );

  const createWatch = useCallback((watch: Watch) => setState((s) => ({ ...s, watches: [...s.watches, watch], stale: true })), []);
  const setWatchStatus = useCallback(
    (id: string, status: Watch['status']) => setState((s) => ({ ...s, watches: s.watches.map((w) => (w.id === id ? { ...w, status, updatedAt: s.clock } : w)), stale: true })),
    [],
  );
  const setConnection = useCallback(
    // `freshAsOf` simulates a source whose last successful sync stops early (stale); omitted = current.
    (provider: ProviderId, state: ConnectionState, detail: string, opts?: { freshAsOf?: string }) =>
      setState((s) => (s.workspace?.mode === 'imported' ? s : { ...s, connections: s.connections.map((c) => (c.provider === provider ? { ...c, state, detail, updatedAt: CLOCK, freshAsOf: opts?.freshAsOf } : c)), stale: true })),
    [],
  );
  const setBrief = useCallback((brief: BriefSchedule) => setState((s) => ({ ...s, brief, stale: true })), []);
  const decide = useCallback((action: ProposedAction, input: { status: ActionDecision['status']; optionId?: string; note?: string }) => {
    const decision = decideAction(action, { ...input, at: ref.current.clock });
    setState((s) => ({ ...s, decisions: { ...s.decisions, [action.id]: decision } }));
    return decision;
  }, []);
  const setPlannerChoice = useCallback((planner: 'deterministic' | 'llm') => setState((s) => ({ ...s, planner, stale: true })), []);
  /** Back to the first-run welcome. Deletes this browser's workspace (imports included); the planner choice stays. */
  const clearWorkspace = useCallback(() => setState({ ...initial(), planner: ref.current.planner }), []);
  const reset = useCallback(() => {
    // Reset restores the simulated workspace; the planner selection is a preference and survives it.
    const fresh = { ...initial(), planner: ref.current.planner };
    setState({ ...fresh, workspace: { mode: 'sample', createdAt: new Date().toISOString() } });
    void execute(fresh);
  }, [execute]);

  const exportWorkspace = useCallback(() => exportLocalWorkspace(ref.current, { now: new Date().toISOString(), appVersion: APP_VERSION }), []);
  const previewImport = useCallback((text: string): ImportPlan => planImport(text, { alreadyImported: ref.current.importedExportIds ?? [] }), []);
  const applyImport = useCallback((plan: ImportPlan) => {
    if (!plan.report.ok || !plan.doc) throw new Error('Cannot import: the dry run reported problems.');
    const local = localWorkspaceFromExport(plan.doc, { emailFrom: EMAIL_FROM });
    setState({ ...initial(), ...local, version: 3, stale: !local.result, planner: local.planner ?? ref.current.planner, importedExportIds: [...(ref.current.importedExportIds ?? []), plan.doc.exportId] });
  }, []);

  const api = useMemo<ProductApi>(
    () => ({
      state,
      running,
      runMonitoring,
      progress,
      createWatch,
      setWatchStatus,
      setConnection,
      setBrief,
      decide,
      reset,
      plannerChoice: state.planner ?? 'deterministic',
      llmOption: llmAvailability(health),
      setPlannerChoice,
      mode,
      createWorkspace,
      addImport,
      removeImport,
      importedWorld,
      storageError,
      clearWorkspace,
      exportWorkspace,
      previewImport,
      applyImport,
    }),
    [exportWorkspace, previewImport, applyImport, state, running, progress, runMonitoring, createWatch, setWatchStatus, setConnection, setBrief, decide, reset, health, setPlannerChoice, mode, createWorkspace, addImport, removeImport, importedWorld, storageError, clearWorkspace],
  );
  return <ProductContext.Provider value={api}>{children}</ProductContext.Provider>;
}
