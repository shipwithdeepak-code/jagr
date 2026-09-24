import type { RunEvent } from './engine/monitor';
import type { ToolName, TraceStep } from './types';

/**
 * Live run progress, folded from the engine's real events. A stage is only ever marked from a
 * trace step that was actually recorded — nothing is shown as done that did not happen, and
 * stages never reached are reported as "not needed", not as completed.
 */
export const STAGES = [
  { id: 'detect', label: 'Detecting signal' },
  { id: 'releases', label: 'Checking recent releases' },
  { id: 'issues', label: 'Checking related issues' },
  { id: 'customer', label: 'Gathering customer evidence' },
  { id: 'alternatives', label: 'Testing alternative explanations' },
  { id: 'severity', label: 'Assessing severity' },
  { id: 'recommend', label: 'Preparing recommendation' },
] as const;

export type StageId = (typeof STAGES)[number]['id'];

export interface RunProgress {
  startedAt: number;
  job?: { index: number; total: number; watchName: string; at: string };
  investigation?: { id: string; title: string; firstPass: boolean };
  investigations: number;
  toolCalls: number;
  /** Stages reached in the current investigation, in the order they were reached. */
  reached: StageId[];
  active?: StageId;
  latest?: string;
}

const TOOL_STAGE: Partial<Record<ToolName, StageId>> = {
  getJiraRelease: 'releases',
  getStoreReleases: 'releases',
  getRecentJiraIssues: 'issues',
  getAppStoreReviews: 'customer',
  getPlayStoreReviews: 'customer',
};

export function stageOf(step: TraceStep, reached: readonly StageId[]): StageId | undefined {
  if (step.tool && TOOL_STAGE[step.tool]) return TOOL_STAGE[step.tool];
  switch (step.kind) {
    case 'signal':
      return 'detect';
    case 'tool_call':
    case 'result':
      // Metric reads: the first one re-reads the signal; later ones test other explanations.
      return reached.length === 0 || (reached.length === 1 && reached[0] === 'detect') ? 'detect' : 'alternatives';
    case 'hypothesis':
      return 'alternatives';
    case 'assessment':
    case 'uncertainty':
    case 'attention':
      return 'severity';
    case 'action':
    case 'approval':
    case 'notify':
    case 'stop':
      return 'recommend';
    default:
      return undefined;
  }
}

export function startProgress(now = Date.now()): RunProgress {
  return { startedAt: now, investigations: 0, toolCalls: 0, reached: [] };
}

export function reduceProgress(p: RunProgress, e: RunEvent): RunProgress {
  if (e.type === 'job') return { ...p, job: { index: e.index, total: e.total, watchName: e.watchName, at: e.at } };
  if (e.type === 'investigation') return { ...p, investigation: { id: e.id, title: e.title, firstPass: e.firstPass }, investigations: p.investigations + 1, reached: [], active: undefined, latest: undefined };
  const stage = stageOf(e.step, p.reached);
  return {
    ...p,
    toolCalls: p.toolCalls + (e.step.kind === 'tool_call' ? 1 : 0),
    reached: stage && !p.reached.includes(stage) ? [...p.reached, stage] : p.reached,
    active: stage ?? p.active,
    latest: e.step.kind === 'planner' ? p.latest : e.step.title,
  };
}
