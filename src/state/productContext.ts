import type { RunProgress } from '@/product/progress';
import type { ImportPlan } from '@/product/export/workspace';
import type { WorkspaceExportV1 } from '@/product/export/v1';
import { createContext, useContext } from 'react';
import type { ActionDecision, BriefSchedule, ConnectionState, MonitoringResult, ProposedAction, ProviderId, SourceConnection, Watch } from '@/product/types';
import type { ImportedDataset, ImportKind } from '@/product/imports/schemas';
import type { ImportedWorld } from '@/product/imports/world';
import type { ConnectionView } from '@/product/connections/model';

/**
 * sample = the simulated sample night · imported = the user's own CSV / JSON evidence ·
 * connected = live sources (server workspaces only).
 */
export type WorkspaceMode = 'sample' | 'imported' | 'connected';

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
  /** Jagr exports already imported into this browser workspace (importing one twice is refused). */
  importedExportIds?: string[];
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
  setConnection(provider: ProviderId, state: ConnectionState, detail: string, opts?: { freshAsOf?: string }): void;
  setBrief(brief: BriefSchedule): void;
  /** Approve / reject / modify an action. Execution goes through the same approval gate as the agent. */
  decide(action: ProposedAction, decision: { status: ActionDecision['status']; optionId?: string; note?: string }): ActionDecision;
  /** The selected planner and what "Configured LLM" resolves to (never keys). */
  plannerChoice: 'deterministic' | 'llm';
  llmOption: PlannerOptionInfo;
  setPlannerChoice(choice: 'deterministic' | 'llm'): void;
  mode?: WorkspaceMode;
  createWorkspace(mode: WorkspaceMode): void;
  /** This browser's workspace mode, whichever workspace is open (undefined = not set up). */
  localMode?: WorkspaceMode;
  /** Create this browser's workspace, whichever workspace is open. Replaces the existing one. */
  createLocalWorkspace(mode: WorkspaceMode): void;
  /** Parse, validate and store an uploaded file. Returns the result (including rejected rows) for display. */
  addImport(kind: ImportKind, filename: string, text: string): ImportedDataset;
  removeImport(id: string): void;
  importedWorld?: ImportedWorld;
  /** Set when the browser refused to save the workspace. */
  storageError?: string;
  clearWorkspace(): void;
  reset(): void;
  /** Jagr Workspace Export v1 of this workspace (no secrets, sessions or email addresses). Server workspaces export on the server. */
  exportWorkspace(): Promise<WorkspaceExportV1>;
  /** Dry run: validate an export file and report what an import would do. Writes nothing. */
  previewImport(text: string): ImportPlan;
  /** Replace this browser workspace with a validated export. Only after the user confirmed the report. */
  applyImport(plan: ImportPlan): void;
  /** Where this workspace lives. Server workspaces are read and changed through the Jagr server API. */
  location: 'browser' | 'server';
  /** The open server workspace (absent for the browser workspace). */
  server?: {
    workspaceId: string;
    name: string;
    role: 'owner' | 'admin' | 'member';
    canApprove: boolean;
    /** Connections as the server reports them (health, account, last check) — never credentials. */
    connections: ConnectionView[];
    /** When the server snapshot was read (absent while loading). */
    snapshotAt?: string;
    settings: { planner: 'deterministic' | 'llm'; aiEgressAllowed: boolean };
    loading: boolean;
    /** The last failed server call, shown until the next successful one. */
    error?: string;
    refresh(): Promise<void>;
    setAiEgressAllowed(allowed: boolean): Promise<void>;
  };
}

export const ProductContext = createContext<ProductApi | null>(null);

export function useProduct(): ProductApi {
  const v = useContext(ProductContext);
  if (!v) throw new Error('useProduct must be used inside ProductProvider');
  return v;
}
