import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ActionDecision, BriefSchedule, ConnectionState, ProposedAction, ProviderId, Watch } from '@/product/types';
import { decide as decideAction } from '@/product/agent/decisions';
import { fetchPlannerHealth, llmAvailability, resolvePlanner, type PlannerHealth } from './plannerConfig';
import { defaultBriefSchedule, defaultWatches } from '@/product/catalog';
import { defaultConnections } from '@/product/integrations/adapters';
import { defaultWorld } from '@/product/integrations/world';
import { runMonitoring as runEngine } from '@/product/engine/monitor';
import { ProductContext, type ProductApi, type ProductState } from './productContext';

/**
 * Product workspace: sources, watches, the brief schedule and the latest monitoring run.
 * Persisted per browser. Monitoring runs the real engine over the deterministic fixture night.
 */

const KEY = 'jagr:product:v2';
const CLOCK = '2026-09-24T08:05:00.000Z';

function initial(): ProductState {
  return { version: 2, connections: defaultConnections(), watches: defaultWatches(), brief: defaultBriefSchedule(), stale: false, clock: CLOCK, decisions: {} };
}

function load(): ProductState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return initial();
    const parsed = JSON.parse(raw) as ProductState;
    return parsed.version === 2 ? parsed : initial();
  } catch {
    return initial();
  }
}

export function ProductProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ProductState>(load);
  const [running, setRunning] = useState(false);
  const [health, setHealth] = useState<PlannerHealth | undefined>();
  useEffect(() => {
    void fetchPlannerHealth().then(setHealth);
  }, []);
  const ref = useRef(state);
  ref.current = state;

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* storage unavailable — still works for this session */
    }
  }, [state]);

  const execute = useCallback(async (s: ProductState) => {
    setRunning(true);
    try {
      const { planner, info } = await resolvePlanner(s.planner ?? 'deterministic');
      const result = await runEngine({
        planner,
        world: defaultWorld(),
        watches: s.watches,
        connections: s.connections,
        brief: s.brief,
        appBaseUrl: typeof window !== 'undefined' ? window.location.origin : undefined,
      });
      const states = s.connections.filter((c) => c.provider !== 'email').map((c) => c.state);
      const data = states.every((x) => x !== 'connected') ? 'simulated' : states.every((x) => x === 'connected') ? 'live' : 'mixed';
      setState((prev) => ({ ...prev, result: { ...result, planner: { ...info, data } }, stale: false, clock: CLOCK }));
      return result;
    } finally {
      setRunning(false);
    }
  }, []);
  const runMonitoring = useCallback(() => execute(ref.current), [execute]);

  // First visit: run last night's monitoring so there is something real to look at.
  useEffect(() => {
    if (!ref.current.result) void runMonitoring();
  }, [runMonitoring]);

  const createWatch = useCallback((watch: Watch) => setState((s) => ({ ...s, watches: [...s.watches, watch], stale: true })), []);
  const setWatchStatus = useCallback(
    (id: string, status: Watch['status']) => setState((s) => ({ ...s, watches: s.watches.map((w) => (w.id === id ? { ...w, status, updatedAt: CLOCK } : w)), stale: true })),
    [],
  );
  const setConnection = useCallback(
    (provider: ProviderId, state: ConnectionState, detail: string) =>
      setState((s) => ({ ...s, connections: s.connections.map((c) => (c.provider === provider ? { ...c, state, detail, updatedAt: CLOCK } : c)), stale: true })),
    [],
  );
  const setBrief = useCallback((brief: BriefSchedule) => setState((s) => ({ ...s, brief, stale: true })), []);
  const decide = useCallback((action: ProposedAction, input: { status: ActionDecision['status']; optionId?: string; note?: string }) => {
    const decision = decideAction(action, { ...input, at: CLOCK });
    setState((s) => ({ ...s, decisions: { ...s.decisions, [action.id]: decision } }));
    return decision;
  }, []);
  const setPlannerChoice = useCallback((planner: 'deterministic' | 'llm') => setState((s) => ({ ...s, planner, stale: true })), []);
  const reset = useCallback(() => {
    // Reset restores the simulated workspace; the planner selection is a preference and survives it.
    const fresh = { ...initial(), planner: ref.current.planner };
    setState(fresh);
    void execute(fresh);
  }, [execute]);

  const api = useMemo<ProductApi>(
    () => ({ state, running, runMonitoring, createWatch, setWatchStatus, setConnection, setBrief, decide, reset, plannerChoice: state.planner ?? 'deterministic', llmOption: llmAvailability(health), setPlannerChoice }),
    [state, running, runMonitoring, createWatch, setWatchStatus, setConnection, setBrief, decide, reset, health, setPlannerChoice],
  );
  return <ProductContext.Provider value={api}>{children}</ProductContext.Provider>;
}
