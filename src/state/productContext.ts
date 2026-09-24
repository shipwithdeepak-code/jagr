import { createContext, useContext } from 'react';
import type { ActionDecision, BriefSchedule, ConnectionState, MonitoringResult, ProposedAction, ProviderId, SourceConnection, Watch } from '@/product/types';

export interface ProductState {
  version: 2;
  connections: SourceConnection[];
  watches: Watch[];
  brief: BriefSchedule;
  result?: MonitoringResult;
  /** True when watches or sources changed after the last monitoring run. */
  stale: boolean;
  /** Simulated "now": just after the morning brief. */
  clock: string;
  /** Human decisions on proposed actions, keyed by stable action id. Survive re-runs. */
  decisions: Record<string, ActionDecision>;
  /** Which planner investigates the (simulated) data. Default: deterministic. */
  planner?: 'deterministic' | 'llm';
}

export interface PlannerOptionInfo {
  available: boolean;
  label: string;
  reason?: string;
}

export interface ProductApi {
  state: ProductState;
  running: boolean;
  runMonitoring(): Promise<MonitoringResult>;
  createWatch(watch: Watch): void;
  setWatchStatus(id: string, status: Watch['status']): void;
  setConnection(provider: ProviderId, state: ConnectionState, detail: string): void;
  setBrief(brief: BriefSchedule): void;
  /** Approve / reject / modify an action. Execution goes through the same approval gate as the agent. */
  decide(action: ProposedAction, decision: { status: ActionDecision['status']; optionId?: string; note?: string }): ActionDecision;
  /** The selected planner and what "Configured LLM" resolves to (never keys). */
  plannerChoice: 'deterministic' | 'llm';
  llmOption: PlannerOptionInfo;
  setPlannerChoice(choice: 'deterministic' | 'llm'): void;
  reset(): void;
}

export const ProductContext = createContext<ProductApi | null>(null);

export function useProduct(): ProductApi {
  const v = useContext(ProductContext);
  if (!v) throw new Error('useProduct must be used inside ProductProvider');
  return v;
}
