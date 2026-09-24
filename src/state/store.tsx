import { useCallback, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import type { AgentEvent, ApprovalRequest, Evidence, OvernightRun, Task, TaskDraft, TaskStatus, WorkspaceSettings } from '@/domain/types';
import { defaultSettings, HISTORICAL_STATS, seedTasks, TEAMS } from '@/domain/defaults';
import { runScenario } from '@/agents/runScenario';
import { executeApprovedAction, gatherSupplementalEvidence } from '@/agents/followup';
import { createSimulationAdapters } from '@/simulation/adapters';
import { checkoutRegressionScenario } from '@/simulation/scenarios';
import type { EvaluationReport } from '@/evaluation/scenarios';
import { addMinutes } from '@/lib/time';
import { WorkspaceContext, type WorkspaceApi, type WorkspaceState } from './workspace';

/**
 * Workspace state. The UI reads from here and never from the simulation directly —
 * runs come from the orchestrator, work goes through the issue-tracker adapter.
 */

type Msg =
  | { type: 'run_completed'; run: OvernightRun }
  | { type: 'task_created'; task: Task; draftFingerprint: string; event: AgentEvent }
  | { type: 'task_status'; taskId: string; status: TaskStatus; event: AgentEvent }
  | { type: 'approval_updated'; approval: ApprovalRequest; event: AgentEvent }
  | { type: 'settings'; settings: WorkspaceSettings; event?: AgentEvent }
  | { type: 'evaluation'; report: EvaluationReport }
  | { type: 'reset' };

const STORAGE_KEY = 'nightwatch:workspace:v4';
const BRIEF_READ_AT = '2026-09-24T08:05:00.000Z';

function initialState(): WorkspaceState {
  return { version: 3, settings: defaultSettings(), runCount: 0, tasks: seedTasks(), drafts: [], approvals: [], humanEvents: [], clock: BRIEF_READ_AT };
}

function reducer(state: WorkspaceState, msg: Msg): WorkspaceState {
  switch (msg.type) {
    case 'run_completed': {
      const decided = state.approvals.filter((a) => a.status !== 'pending' && !msg.run.approvals.some((n) => n.fingerprint === a.fingerprint));
      const createdIds = new Set(msg.run.tasks.map((t) => t.id));
      const tasks = [...state.tasks.filter((t) => !createdIds.has(t.id)), ...msg.run.tasks];
      return {
        ...state,
        run: msg.run,
        runCount: state.runCount + 1,
        tasks,
        drafts: msg.run.drafts.filter((d) => !tasks.some((t) => t.fingerprint === d.fingerprint)),
        approvals: [...msg.run.approvals, ...decided],
        clock: BRIEF_READ_AT,
      };
    }
    case 'task_created':
      return {
        ...state,
        tasks: [...state.tasks, msg.task],
        drafts: state.drafts.filter((d) => d.fingerprint !== msg.draftFingerprint),
        humanEvents: [...state.humanEvents, msg.event],
        clock: msg.event.at,
      };
    case 'task_status':
      return {
        ...state,
        tasks: state.tasks.map((t) => (t.id === msg.taskId ? { ...t, status: msg.status } : t)),
        humanEvents: [...state.humanEvents, msg.event],
        clock: msg.event.at,
      };
    case 'approval_updated':
      return {
        ...state,
        approvals: state.approvals.map((a) => (a.id === msg.approval.id ? msg.approval : a)),
        humanEvents: [...state.humanEvents, msg.event],
        clock: msg.event.at,
      };
    case 'settings':
      return { ...state, settings: msg.settings, humanEvents: msg.event ? [...state.humanEvents, msg.event] : state.humanEvents };
    case 'evaluation':
      return { ...state, evaluation: msg.report };
    case 'reset':
      return initialState();
  }
}

function load(): WorkspaceState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialState();
    const parsed = JSON.parse(raw) as WorkspaceState;
    return parsed.version === 3 ? parsed : initialState();
  } catch {
    return initialState();
  }
}

let humanSeq = 0;
function humanEvent(state: WorkspaceState, e: Omit<AgentEvent, 'id' | 'seq' | 'runId' | 'agent' | 'at' | 'stage'>): AgentEvent {
  humanSeq += 1;
  const at = addMinutes(state.clock, 1);
  return { id: `human-${Date.now()}-${humanSeq}`, seq: 10_000 + state.humanEvents.length, runId: state.run?.id ?? 'workspace', agent: 'you', at, stage: 'human', ...e };
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, load);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage unavailable (private mode) — the app still works for this session */
    }
  }, [state]);

  const adapters = useCallback(() => {
    const s = stateRef.current;
    return createSimulationAdapters(checkoutRegressionScenario(), { availability: s.settings.integrations, seedIssues: s.tasks, teams: TEAMS });
  }, []);

  /** `fresh` runs against a clean workspace (Demo Mode) regardless of pending state updates. */
  const runOvernight = useCallback(async (fresh = false) => {
    const s = fresh ? initialState() : stateRef.current;
    return runScenario('checkout-regression', s.settings, { runId: `run-${String(HISTORICAL_STATS.runs + s.runCount + 1).padStart(3, '0')}`, seedTasks: s.tasks });
  }, []);

  const commitRun = useCallback((run: OvernightRun) => dispatch({ type: 'run_completed', run }), []);

  const createTaskFromDraft = useCallback(
    async (draft: TaskDraft) => {
      const s = stateRef.current;
      const at = addMinutes(s.clock, 1);
      try {
        const task = await adapters().issueTracker.createIssue(draft, at);
        const created: Task = { ...task, createdBy: 'nightwatch' };
        dispatch({
          type: 'task_created',
          task: created,
          draftFingerprint: draft.fingerprint,
          event: humanEvent(s, { action: `Created task ${task.id} from Nightwatch draft`, tool: 'issueTracker.createIssue', input: draft.title, output: task.id, result: `${task.id} created in simulated issue tracker`, status: 'ok', risk: 'low', approvalStatus: 'not_required', investigationId: draft.investigationId }),
        });
        return created;
      } catch (err) {
        dispatch({
          type: 'settings',
          settings: s.settings,
          event: humanEvent(s, { action: 'Create task failed', tool: 'issueTracker.createIssue', input: draft.title, result: err instanceof Error ? err.message : String(err), status: 'error', investigationId: draft.investigationId }),
        });
        return null;
      }
    },
    [adapters],
  );

  const setTaskStatus = useCallback((taskId: string, status: TaskStatus) => {
    const s = stateRef.current;
    const label = { todo: 'To do', in_progress: 'In progress', done: 'Done' }[status];
    dispatch({ type: 'task_status', taskId, status, event: humanEvent(s, { action: `Moved ${taskId} to ${label}`, tool: 'issueTracker.updateStatus', result: label, status: 'ok' }) });
  }, []);

  const approve = useCallback((approvalId: string) => {
    const s = stateRef.current;
    const a = s.approvals.find((x) => x.id === approvalId);
    if (!a || (a.status !== 'pending' && a.status !== 'more_evidence_requested')) return;
    const at = addMinutes(s.clock, 1);
    const approved: ApprovalRequest = { ...a, status: 'approved', decidedAt: at };
    let result: string;
    let ok = true;
    try {
      result = executeApprovedAction(approved, at);
    } catch (err) {
      ok = false;
      result = err instanceof Error ? err.message : String(err);
    }
    dispatch({
      type: 'approval_updated',
      approval: { ...approved, executionResult: result },
      event: humanEvent(s, { action: `Approved: ${a.title}`, tool: 'approvals.approve', input: a.reason, output: result, result, decision: 'approved', status: ok ? 'ok' : 'error', risk: a.risk, approvalStatus: 'approved', investigationId: a.investigationId }),
    });
  }, []);

  const reject = useCallback((approvalId: string, note?: string) => {
    const s = stateRef.current;
    const a = s.approvals.find((x) => x.id === approvalId);
    if (!a) return;
    const at = addMinutes(s.clock, 1);
    dispatch({
      type: 'approval_updated',
      approval: { ...a, status: 'rejected', decidedAt: at, decisionNote: note ?? 'Rejected by PM' },
      event: humanEvent(s, { action: `Rejected: ${a.title}`, tool: 'approvals.reject', input: note, result: 'Not executed. Nightwatch will not retry this action for this finding.', decision: 'rejected', status: 'ok', risk: a.risk, approvalStatus: 'rejected', investigationId: a.investigationId }),
    });
  }, []);

  const requestMoreEvidence = useCallback(
    async (approvalId: string) => {
      const s = stateRef.current;
      const a = s.approvals.find((x) => x.id === approvalId);
      const inv = s.run?.investigations.find((i) => i.id === a?.investigationId);
      if (!a || !inv) return;
      const at = addMinutes(s.clock, 1);
      const { evidence, notes } = await gatherSupplementalEvidence(a, inv, adapters(), s.run?.brief.window.end ?? at);
      const merged: Evidence[] = [...a.supplementalEvidence.filter((e) => !evidence.some((n) => n.id === e.id)), ...evidence];
      dispatch({
        type: 'approval_updated',
        approval: { ...a, status: 'more_evidence_requested', supplementalEvidence: merged },
        event: humanEvent(s, { action: `Requested more evidence: ${a.title}`, tool: 'nightwatch.followUp', result: evidence.length ? `Nightwatch attached ${evidence.length} new observation${evidence.length === 1 ? '' : 's'}` : notes.join(' '), output: [...evidence.map((e) => e.title), ...notes].join(' · '), status: 'ok', risk: a.risk, approvalStatus: 'pending', investigationId: a.investigationId }),
      });
    },
    [adapters],
  );

  const updateSettings = useCallback((settings: WorkspaceSettings, description?: string) => {
    const s = stateRef.current;
    dispatch({ type: 'settings', settings, event: description ? humanEvent(s, { action: 'Updated workspace settings', tool: 'settings.update', result: description, status: 'ok' }) : undefined });
  }, []);

  const setEvaluation = useCallback((report: EvaluationReport) => dispatch({ type: 'evaluation', report }), []);
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  const api = useMemo<WorkspaceApi>(
    () => ({ state, runOvernight, commitRun, createTaskFromDraft, setTaskStatus, approve, reject, requestMoreEvidence, updateSettings, setEvaluation, reset }),
    [state, runOvernight, commitRun, createTaskFromDraft, setTaskStatus, approve, reject, requestMoreEvidence, updateSettings, setEvaluation, reset],
  );
  return <WorkspaceContext.Provider value={api}>{children}</WorkspaceContext.Provider>;
}
