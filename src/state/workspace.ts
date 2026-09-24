import { createContext, useContext } from 'react';
import type { AgentEvent, ApprovalRequest, OvernightRun, Task, TaskDraft, TaskStatus, WorkspaceSettings } from '@/domain/types';
import { TEAMS } from '@/domain/defaults';
import type { EvaluationReport } from '@/evaluation/scenarios';

export interface WorkspaceState {
  version: 3;
  settings: WorkspaceSettings;
  run?: OvernightRun;
  runCount: number;
  tasks: Task[];
  drafts: TaskDraft[];
  approvals: ApprovalRequest[];
  humanEvents: AgentEvent[];
  evaluation?: EvaluationReport;
  /** Simulated "now" for human actions: shortly after the brief. */
  clock: string;
}

export interface WorkspaceApi {
  state: WorkspaceState;
  runOvernight(fresh?: boolean): Promise<OvernightRun>;
  commitRun(run: OvernightRun): void;
  createTaskFromDraft(draft: TaskDraft): Promise<Task | null>;
  setTaskStatus(taskId: string, status: TaskStatus): void;
  approve(approvalId: string): void;
  reject(approvalId: string, note?: string): void;
  requestMoreEvidence(approvalId: string): Promise<void>;
  updateSettings(settings: WorkspaceSettings, description?: string): void;
  setEvaluation(report: EvaluationReport): void;
  reset(): void;
}

export const WorkspaceContext = createContext<WorkspaceApi | null>(null);

export function useWorkspace(): WorkspaceApi {
  const v = useContext(WorkspaceContext);
  if (!v) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return v;
}

/** All events for audit views: the agent's trace plus human decisions, in time order. */
export function allEvents(state: WorkspaceState): AgentEvent[] {
  return [...(state.run?.events ?? []), ...state.humanEvents].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq);
}

export function teamName(id: string): string {
  return TEAMS.find((t) => t.id === id)?.name ?? id;
}
