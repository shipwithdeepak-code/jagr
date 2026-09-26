import type { ActionDecision, ISO, ProviderId, TraceStep, WatchInvestigation } from '../types.js';
import { presentTraceStep } from '../presentation.js';
import { traceWithDecisions } from '../agent/decisions.js';

/**
 * Investigation replay — the stored trace, one recorded step at a time. Nothing is re-run: every
 * frame is a TraceStep the engine recorded (or a human decision recorded afterwards), so a replay is
 * exactly what happened, never a re-enactment.
 */

export const REPLAY_STAGES = ['signal', 'started', 'planner', 'tool', 'evidence', 'hypothesis', 'next', 'correlation', 'attention', 'recommendation', 'action'] as const;
export type ReplayStage = (typeof REPLAY_STAGES)[number];

export const REPLAY_STAGE_LABEL: Record<ReplayStage, string> = {
  signal: 'Signal detected',
  started: 'Investigation started',
  planner: 'Planner decision',
  tool: 'Tool selected',
  evidence: 'Evidence returned',
  hypothesis: 'Hypothesis updated',
  next: 'Next step',
  correlation: 'Correlation',
  attention: 'Attention assessment',
  recommendation: 'Recommendation',
  action: 'Approval / action',
};

export interface ReplayFrame {
  /** Unique within the replay. The step it came from is `stepId`. */
  id: string;
  stepId: string;
  stage: ReplayStage;
  at: ISO;
  title: string;
  detail?: string;
  sources: ProviderId[];
  /** Failed or unavailable tool results. */
  warn?: boolean;
}

export interface ReplayPass {
  pass: number;
  at: ISO;
  /** Attention this pass concluded with, when it reached an assessment. */
  attention?: string;
  /** Whether this pass reached a full conclusion (assessment + attention). */
  concluded: boolean;
}

function framesOf(step: TraceStep): ReplayFrame[] {
  const base = { stepId: step.id, at: step.at, sources: step.sources ?? (step.source ? [step.source] : []) };
  switch (step.kind) {
    case 'signal':
      return [{ ...base, id: step.id, stage: 'signal', title: step.title.replace(/^Signal: /, ''), detail: step.detail }];
    case 'plan':
      return [{ ...base, id: step.id, stage: 'started', title: 'Investigation started', detail: step.detail }];
    case 'planner': {
      const d = step.planner;
      const verdict = d ? (d.validator === 'APPROVED' ? 'Validator approved' : d.validator === 'REJECTED' ? `Validator rejected${d.rejection ? ` — ${d.rejection.reason}` : ''}` : 'Validator not run') : undefined;
      return [{ ...base, id: step.id, stage: 'planner', title: step.title, detail: [d?.reason, verdict].filter(Boolean).join(' · ') || step.detail }];
    }
    case 'tool_call':
      return [{ ...base, id: step.id, stage: 'tool', title: step.title, detail: step.why }];
    case 'result': {
      const frames: ReplayFrame[] = [{ ...base, id: step.id, stage: 'evidence', title: step.title, warn: !!step.status && step.status !== 'ok' }];
      const updates = (step.changed ?? []).filter((c) => !c.startsWith('No change'));
      if (updates.length) frames.push({ ...base, id: `${step.id}-h`, stage: 'hypothesis', title: updates.join(' · ') });
      return frames;
    }
    case 'hypothesis':
      return [{ ...base, id: step.id, stage: 'hypothesis', title: step.title, detail: step.detail }];
    case 'gap':
    case 'stop':
    case 'recheck':
      return [{ ...base, id: step.id, stage: 'next', title: step.title, detail: step.detail }];
    case 'assessment':
    case 'uncertainty':
      return [{ ...base, id: step.id, stage: 'correlation', title: step.title, detail: step.detail }];
    case 'attention':
      return [{ ...base, id: step.id, stage: 'attention', title: step.title.replace(/^Attention: /, ''), detail: step.detail }];
    case 'action':
      return [{ ...base, id: step.id, stage: 'recommendation', title: step.title, detail: step.detail }];
    case 'approval':
    case 'notify':
    case 'human':
      return [{ ...base, id: step.id, stage: 'action', title: step.title, detail: [step.detail, step.result].filter(Boolean).join(' ') || undefined }];
    default:
      return [];
  }
}

export function replayPasses(inv: WatchInvestigation): ReplayPass[] {
  const byPass = new Map<number, TraceStep[]>();
  for (const s of inv.trace.map(presentTraceStep)) byPass.set(s.pass, [...(byPass.get(s.pass) ?? []), s]);
  return [...byPass.entries()]
    .sort(([a], [b]) => a - b)
    .map(([pass, steps]) => {
      const attention = steps.find((s) => s.kind === 'attention');
      return { pass, at: steps[0].at, attention: attention?.title.replace(/^Attention: /, ''), concluded: !!attention && steps.some((s) => s.kind === 'assessment') };
    });
}

/**
 * The original investigation: the first pass that reached the investigation's current attention.
 * Later passes that concluded the same are scheduled re-checks of that verdict.
 */
export function defaultReplayPass(inv: WatchInvestigation): number {
  const passes = replayPasses(inv);
  const concluded = passes.filter((p) => p.concluded);
  const match = concluded.find((p) => p.attention === inv.attention);
  return (match ?? concluded.at(-1) ?? passes.at(-1))?.pass ?? 1;
}

/**
 * Frames for one recorded pass, then every human decision recorded on the investigation.
 * Passes that re-checked without material change are stored as a single line — they replay as that line.
 */
export function replayFrames(inv: WatchInvestigation, decisions: Record<string, ActionDecision>, pass: number): ReplayFrame[] {
  const steps = traceWithDecisions(inv, decisions);
  const inPass = steps.filter((s) => s.kind !== 'human' && s.pass === pass);
  const human = steps.filter((s) => s.kind === 'human');
  return [...inPass, ...human].flatMap(framesOf);
}
