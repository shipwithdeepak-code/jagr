import type { ISO, ProviderId, ToolName, TraceStep } from '../types';
import { truthfulNotificationText } from '../presentation';

/**
 * The Agent Trace as an audit trail: what Jagr did, when, with which source, and what came back —
 * in words a PM reads, not a developer log. One event per recorded step (a tool call and its
 * result read as INVESTIGATING → FOUND). Planner reasoning is limited to the auditable summaries
 * the planner was asked to record; there is no hidden chain of thought to show.
 */

export type AuditStage =
  | 'detected'
  | 'linked'
  | 'investigating'
  | 'planned'
  | 'found'
  | 'normal'
  | 'not_checked'
  | 'hypotheses'
  | 'updated'
  | 'next'
  | 'stopped'
  | 'assessing'
  | 'uncertain'
  | 'attention'
  | 'action'
  | 'awaiting_approval'
  | 'notified'
  | 'rechecked'
  | 'decided';

export const AUDIT_STAGE_LABEL: Record<AuditStage, string> = {
  detected: 'Detected',
  linked: 'Linked',
  investigating: 'Investigating',
  planned: 'Planned',
  found: 'Found',
  normal: 'Checked · normal',
  not_checked: 'Not checked',
  hypotheses: 'Explanations',
  updated: 'Updated',
  next: 'Next question',
  stopped: 'Stopped',
  assessing: 'Assessing',
  uncertain: 'Uncertain',
  attention: 'Attention',
  action: 'Action',
  awaiting_approval: 'Awaiting approval',
  notified: 'Notified',
  rechecked: 'Re-checked',
  decided: 'Human decision',
};

export type AuditTone = 'signal' | 'work' | 'finding' | 'quiet' | 'warn' | 'conclusion' | 'human';

export const AUDIT_TONE: Record<AuditStage, AuditTone> = {
  detected: 'signal',
  linked: 'quiet',
  investigating: 'work',
  planned: 'work',
  found: 'finding',
  normal: 'quiet',
  not_checked: 'warn',
  hypotheses: 'work',
  updated: 'finding',
  next: 'work',
  stopped: 'quiet',
  assessing: 'conclusion',
  uncertain: 'warn',
  attention: 'conclusion',
  action: 'conclusion',
  awaiting_approval: 'warn',
  notified: 'conclusion',
  rechecked: 'quiet',
  decided: 'human',
};

export interface AuditEvent {
  id: string;
  at: ISO;
  stage: AuditStage;
  /** What Jagr did. */
  action: string;
  /** What came back, concisely. */
  result?: string;
  sources: ProviderId[];
  /** Expandable detail: query, why, planner summary, validator verdict. */
  detail: { label: string; text: string }[];
  /** The underlying step, for provenance. */
  stepId: string;
}

const TOOL_ACTION: Record<ToolName, string> = {
  getMetric: 'Reading a metric',
  getMetricBreakdown: 'Breaking a metric down',
  getChanges: 'Checking recent changes',
  getWorkItems: 'Checking related work items',
  getFeedback: 'Checking customer feedback',
  getFeedbackVolume: 'Checking feedback volume',
};

/** "Analytics → checkout_conversion" → "checkout conversion". */
const metricOf = (step: TraceStep) => (step.input ?? step.title.split('→')[1] ?? '').trim().replace(/_/g, ' ');

function toolAction(step: TraceStep): string {
  if (!step.tool) return step.title;
  if (step.tool === 'getMetric') return `Reading ${metricOf(step)}`;
  if (step.tool === 'getMetricBreakdown') return `Breaking down ${metricOf(step)}`;
  return TOOL_ACTION[step.tool];
}

/** "getMetric(sessions)" → "reading sessions"; "getChanges" → "checking recent changes". */
function toolPhrase(tool: string): string {
  const m = /^(\w+)(?:\(([^)]*)\))?/.exec(tool);
  if (!m) return tool;
  const [, name, arg] = m;
  if (name === 'getMetric' && arg) return `reading ${arg.replace(/_/g, ' ')}`;
  if (name === 'getMetricBreakdown' && arg) return `breaking down ${arg.replace(/_/g, ' ')}`;
  return (TOOL_ACTION as Record<string, string>)[name]?.toLowerCase() ?? name;
}

/** The planner line, from the structured decision — who proposed what — never from free text. */
function plannerAction(s: TraceStep): string {
  const d = s.planner;
  if (!d) return s.title;
  if (d.type === 'LLM' && d.failure) return s.title;
  const tool = d.type === 'LLM' ? d.proposedTool : d.executedTool;
  if (!tool) return s.title;
  const who = d.type === 'LLM' ? 'Model planner proposed' : d.type === 'DETERMINISTIC' ? 'Deterministic planner chose' : 'Deterministic fallback chose';
  return `${who}: ${toolPhrase(tool)}`;
}

/** Came back empty or within normal range — a check, not a finding. */
const NORMAL = /^(no |0 )|within its normal range|nothing /i;

const sourcesOf = (s: TraceStep): ProviderId[] => s.sources ?? (s.source ? [s.source] : []);

export function auditEvents(steps: TraceStep[]): AuditEvent[] {
  const out: AuditEvent[] = [];
  for (const s of steps) {
    const base = { id: s.id, at: s.at, stepId: s.id, sources: sourcesOf(s) };
    const why = s.why ? [{ label: 'Why', text: s.why }] : [];
    switch (s.kind) {
      case 'signal':
        out.push({ ...base, stage: /^(Handed over|Also seen by)/.test(s.title) ? 'linked' : 'detected', action: s.title.replace(/^Signal: /, ''), detail: s.detail ? [{ label: 'Detail', text: s.detail }] : [] });
        break;
      case 'plan':
        out.push({ ...base, stage: 'investigating', action: 'Opened the investigation', detail: s.detail ? [{ label: 'Plan', text: s.detail }] : [] });
        break;
      case 'planner': {
        const d = s.planner;
        const detail: AuditEvent['detail'] = [];
        if (d?.evidenceGap) detail.push({ label: 'Gap it addresses', text: d.evidenceGap });
        if (d?.reason) detail.push({ label: 'Planner summary', text: d.reason });
        if (d) detail.push({ label: 'Validator', text: d.validator === 'APPROVED' ? 'Approved' : d.validator === 'REJECTED' ? `Rejected${d.rejection ? ` — ${d.rejection.reason}` : ''}` : 'Not run' });
        if (d) detail.push({ label: 'Planner', text: `${d.plannerLabel}${d.model ? ` · ${d.model}` : ''}${typeof d.latencyMs === 'number' && !d.cached ? ` · ${d.latencyMs} ms` : ''}${d.cached ? ' · reused plan' : ''}` });
        if (d?.failure) detail.push({ label: 'Planner failure', text: d.failure.detail });
        if (d?.providerFallback) detail.push({ label: 'Fallback', text: `Primary planner unavailable (${d.providerFallback.from}); fallback provider used.` });
        out.push({ ...base, stage: 'planned', action: plannerAction(s), result: d ? (d.validator === 'REJECTED' ? 'Rejected by the validator — not executed' : d.validator === 'APPROVED' ? 'Approved by the validator' : undefined) : undefined, detail });
        break;
      }
      case 'tool_call':
        out.push({ ...base, stage: 'investigating', action: toolAction(s), detail: [...(s.input ? [{ label: 'Query', text: s.input }] : []), ...why] });
        break;
      case 'result': {
        const failed = !!s.status && s.status !== 'ok';
        const updates = (s.changed ?? []).filter((c) => !c.startsWith('No change'));
        // The source is shown once, on the INVESTIGATING line that asked it.
        out.push({ ...base, sources: [], stage: failed ? 'not_checked' : NORMAL.test(s.title) ? 'normal' : 'found', action: s.title, detail: [] });
        if (updates.length) out.push({ ...base, sources: [], id: `${s.id}-u`, stage: 'updated', action: updates.join(' · '), detail: [] });
        break;
      }
      case 'hypothesis':
        out.push({ ...base, stage: 'hypotheses', action: s.title, detail: s.detail ? [{ label: 'Explanations', text: s.detail }] : [] });
        break;
      case 'gap':
        out.push({ ...base, stage: 'next', action: s.title.replace(/^Scope gap: /, ''), detail: s.detail ? [{ label: 'Detail', text: s.detail }] : [] });
        break;
      case 'stop':
        out.push({ ...base, stage: 'stopped', action: s.title, result: s.detail, detail: [] });
        break;
      case 'assessment':
        out.push({ ...base, stage: 'assessing', action: s.title, result: s.detail, detail: [] });
        break;
      case 'uncertainty':
        out.push({ ...base, stage: 'uncertain', action: s.title, result: s.detail, detail: [] });
        break;
      case 'attention':
        out.push({ ...base, stage: 'attention', action: s.title.replace(/^Attention: /, ''), result: s.detail, detail: [] });
        break;
      case 'action':
        out.push({ ...base, stage: 'action', action: s.title, result: s.result ?? s.detail, detail: why });
        break;
      case 'approval':
        out.push({ ...base, stage: 'awaiting_approval', action: s.title, result: s.detail, detail: why });
        break;
      case 'notify':
        out.push({ ...base, stage: 'notified', action: truthfulNotificationText(s.title), result: s.detail, detail: [] });
        break;
      case 'recheck':
        out.push({ ...base, stage: 'rechecked', action: s.title, result: s.detail, detail: [] });
        break;
      case 'human':
        out.push({ ...base, stage: 'decided', action: s.title, result: s.result, detail: [...(s.detail ? [{ label: 'Detail', text: s.detail }] : []), ...why] });
        break;
    }
  }
  return out;
}
