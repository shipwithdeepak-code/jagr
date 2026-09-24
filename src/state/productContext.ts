import type { RunProgress } from '@/product/progress';
import { createContext, useContext } from 'react';
import type { ActionDecision, BriefSchedule, ConnectionState, MonitoringResult, ProposedAction, ProviderId, SourceConnection, Watch } from '@/product/types';
import type { ImportedDataset, ImportKind } from '@/product/imports/schemas';
import type { ImportedWorld } from '@/product/imports/world';

/** sample = the simulated sample night · imported = the user's own CSV / JSON evidence. */
export type WorkspaceMode = 'sample' | 'imported';

export interface ProductState {
  /** 3 = role-based signals, tools and actions. Older stored workspaces are migrated on load. */
  version: 3;
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
  /** Which planner investigates the data. Default: deterministic. */
  planner?: 'deterministic' | 'llm';
  /** Absent until the user chooses (first-run welcome). */
  workspace?: { mode: WorkspaceMode; createdAt: string };
  /** User-imported evidence (imported workspaces). Stored in this browser only. */
  imports?: ImportedDataset[];
}

export interface PlannerOptionInfo {
  available: boolean;
  label: string;
  reason?: string;
}

export interface ProductApi {
  state: ProductState;
  running: boolean;
  /** Live progress of the current run, from real engine events. Undefined when idle. */
  progress?: RunProgress;
  /** Undefined when an imported workspace has nothing to investigate yet. */
  runMonitoring(): Promise<MonitoringResult | undefined>;
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
  mode?: WorkspaceMode;
  createWorkspace(mode: WorkspaceMode): void;
  /** Parse, validate and store an uploaded file. Returns the result (including rejected rows) for display. */
  addImport(kind: ImportKind, filename: string, text: string): ImportedDataset;
  removeImport(id: string): void;
  importedWorld?: ImportedWorld;
  /** Set when the browser refused to save the workspace. */
  storageError?: string;
  clearWorkspace(): void;
  reset(): void;
}

export const ProductContext = createContext<ProductApi | null>(null);

export function useProduct(): ProductApi {
  const v = useContext(ProductContext);
  if (!v) throw new Error('useProduct must be used inside ProductProvider');
  return v;
}
