import { useMemo, useState } from 'react';
import { Bot, Check, ChevronDown, ChevronRight, CircleSlash, Lock, ShieldAlert, Wrench, X } from 'lucide-react';
import type { ActionRisk, AgentHypothesis, EvidenceItem, EvidenceStrength, PlannerDecision, PlannerRunInfo, SourceConnection, TraceStep, WatchInvestigation } from '@/product/types';
import { HYPOTHESIS_ID } from '@/product/agent/planner';
import type { EffectiveAction } from '@/product/agent/decisions';
import { hypothesisLabel } from '@/product/agent/investigator';
import { confidenceBand } from '@/product/engine/monitor';
import { fmtTime } from '@/lib/time';
import { useProduct } from '@/state/productContext';
import { useToast } from './toast';
import { Badge, Button, Card, cx, Eyebrow, Mono, type Tone } from './ui';
import { AttentionBadge, attentionRoute, ProviderName } from './product';

// ─────────────────────────────────────────────────────────────
// Source label
// ─────────────────────────────────────────────────────────────

/** Every tool result says where it came from. Simulated data is never presented as live. */
export function SourceStateTag({ state }: { state?: SourceConnection['state'] }) {
  if (!state || state === 'connected') return state ? <Badge tone="ok">CONNECTED</Badge> : null;
  if (state === 'imported') return <span className="rounded bg-accent-soft px-1.5 py-px text-[10px] font-semibold tracking-wide text-accent">USER IMPORT</span>;
  if (state === 'not_configured') return <span className="rounded bg-subtle px-1.5 py-px text-[10px] font-semibold tracking-wide text-ink-2 ring-1 ring-inset ring-line">NOT CONFIGURED</span>;
  if (state === 'simulated') return <span className="rounded border border-dashed border-info/50 bg-info-soft px-1.5 py-px text-[10px] font-semibold tracking-wide text-info">SIMULATED SOURCE</span>;
  return <span className="rounded bg-high-soft px-1.5 py-px text-[10px] font-semibold tracking-wide text-high">{state === 'error' ? 'SOURCE ERROR' : 'SOURCE UNAVAILABLE'}</span>;
}

// ─────────────────────────────────────────────────────────────
// Agent trace
// ─────────────────────────────────────────────────────────────

const STEP_LABEL: Record<TraceStep['kind'], string> = {
  signal: 'Signal',
  plan: 'Plan',
  hypothesis: 'Hypotheses',
  gap: 'Evidence gap',
  planner: 'Planner',
  tool_call: 'Tool call',
  result: 'Result',
  assessment: 'Assessment',
  uncertainty: 'Uncertainty',
  stop: 'Stop',
  attention: 'Attention',
  action: 'Action',
  approval: 'Needs approval',
  notify: 'Notify',
  recheck: 'Re-check',
  human: 'Human decision',
};

const STEP_TONE: Partial<Record<TraceStep['kind'], string>> = {
  signal: 'text-crit',
  gap: 'text-high',
  tool_call: 'text-accent',
  stop: 'text-ink',
  attention: 'text-ink',
  approval: 'text-high',
  human: 'text-ok',
};

interface Pass {
  pass: number;
  at: string;
  steps: TraceStep[];
  calls: number;
  rechecks: TraceStep[];
}

function groupPasses(steps: TraceStep[]): Pass[] {
  const by = new Map<number, Pass>();
  for (const s of steps) {
    const p = by.get(s.pass) ?? { pass: s.pass, at: s.at, steps: [], calls: 0, rechecks: [] };
    if (s.kind === 'recheck') p.rechecks.push(s);
    else p.steps.push(s);
    if (s.kind === 'tool_call') p.calls++;
    if (s.at < p.at) p.at = s.at;
    by.set(s.pass, p);
  }
  return [...by.values()].sort((a, b) => a.pass - b.pass);
}

/**
 * The agent's work, step by step: TIME · STEP · TOOL · INPUT · RESULT · WHY · WHAT CHANGED.
 * Tool calls and their results are folded into one row so input and output read together.
 */
export function AgentTraceTimeline({ steps, connections, defaultOpen }: { steps: TraceStep[]; connections: SourceConnection[]; defaultOpen?: number[] }) {
  const passes = useMemo(() => groupPasses(steps), [steps]);
  const lastFull = [...passes].reverse().find((p) => p.calls > 0)?.pass;
  const [open, setOpen] = useState<Set<number>>(() => new Set(defaultOpen ?? (lastFull !== undefined ? [lastFull] : [])));
  const conn = (p?: string) => connections.find((c) => c.provider === p)?.state;
  const toggle = (n: number) => setOpen((s) => {
    const next = new Set(s);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    return next;
  });

  return (
    <div className="space-y-2">
      {passes.map((p) => {
        const isOpen = open.has(p.pass);
        const headline = p.steps.find((s) => s.kind === 'signal')?.title ?? p.steps[0]?.title ?? 'Re-checks';
        const stop = p.steps.find((s) => s.kind === 'stop');
        const human = p.steps.some((s) => s.kind === 'human');
        return (
          <Card key={p.pass} padded={false} className="overflow-hidden">
            <button onClick={() => toggle(p.pass)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left hover:bg-subtle/60" aria-expanded={isOpen}>
              {isOpen ? <ChevronDown size={14} className="text-ink-3" /> : <ChevronRight size={14} className="text-ink-3" />}
              <Mono className="text-ink-3">{fmtTime(p.at)}</Mono>
              <span className="text-[13px] font-medium">Pass {p.pass}</span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">{headline}</span>
              <span className="flex items-center gap-2 text-[11.5px] text-ink-3">
                {p.calls > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <Wrench size={11} /> {p.calls} tool {p.calls === 1 ? 'call' : 'calls'}
                  </span>
                )}
                {p.rechecks.length > 0 && <span>{p.rechecks.length} re-check{p.rechecks.length === 1 ? '' : 's'}, no material change</span>}
                {human && <Badge tone="ok">human decision</Badge>}
              </span>
            </button>
            {isOpen && (
              <div className="border-t border-line">
                <div className="hidden grid-cols-[48px_104px_150px_minmax(0,1fr)_minmax(0,0.9fr)] gap-3 border-b border-line bg-subtle/50 px-4 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3 lg:grid">
                  <span>Time</span>
                  <span>Agent step</span>
                  <span>Tool · input</span>
                  <span>Result</span>
                  <span>Why · what changed</span>
                </div>
                {foldCalls(p.steps).map((row) => (
                  <TraceRow key={row.step.id} step={row.step} result={row.result} source={conn(row.step.source)} />
                ))}
                {p.rechecks.length > 0 && (
                  <div className="border-t border-dashed border-line px-4 py-2 text-[12px] text-ink-3">
                    {p.rechecks.length} later re-check{p.rechecks.length === 1 ? '' : 's'} ({[...new Set(p.rechecks.map((r) => fmtTime(r.at)))].join(', ')}) re-read the sources and found nothing that changed the assessment — recorded, not repeated.
                  </div>
                )}
                {!stop && p.calls > 0 && <div className="px-4 py-2 text-[12px] text-high">No stop recorded for this pass.</div>}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

/** The planner decision: who proposed, what, why (a summary, not hidden reasoning), and what policy did with it. */
function PlannerRow({ step, d }: { step: TraceStep; d: PlannerDecision }) {
  const model = d.type === 'LLM';
  const rejected = d.validator === 'REJECTED';
  const failed = !!d.failure && model;
  return (
    <div className={cx('grid gap-x-3 gap-y-1 border-b border-line px-4 py-2.5 text-[12.5px] last:border-b-0 lg:grid-cols-[48px_104px_150px_minmax(0,1fr)_minmax(0,0.9fr)]', (rejected || failed) && 'bg-high-soft/25')}>
      <Mono className="text-ink-3">{fmtTime(step.at)}</Mono>
      <span className="flex flex-col items-start gap-1">
        <span className="font-medium text-ink-2">Planner</span>
        <span className={cx('rounded px-1.5 py-px text-[10px] font-semibold tracking-wide', model ? 'bg-accent-soft text-accent' : 'bg-subtle text-ink-2 ring-1 ring-inset ring-line')}>{model ? (d.plannerLabel.startsWith('Scripted test planner') ? 'SCRIPTED TEST PLANNER' : 'MODEL') : d.type === 'DETERMINISTIC' ? 'DETERMINISTIC' : 'DETERMINISTIC FALLBACK'}</span>
      </span>
      <span className="min-w-0">
        {d.proposedTool ? <code className="block truncate font-mono text-[11.5px] text-ink">{d.proposedTool}</code> : <span className="text-ink-3">no plan</span>}
        {d.hypothesesAffected && <span className="block text-[11px] text-ink-3">{d.hypothesesAffected.join(', ')}</span>}
      </span>
      <span className="min-w-0">
        <span className="block">{step.title}</span>
        {d.evidenceGap && <span className="mt-0.5 block text-ink-2"><span className="text-ink-3">Gap:</span> {d.evidenceGap}</span>}
        {d.expectedEvidence && <span className="mt-0.5 block text-ink-2"><span className="text-ink-3">Expects:</span> {d.expectedEvidence}</span>}
        {d.resultSummary && <span className="mt-0.5 block text-ink-3">Result: {d.resultSummary}</span>}
        <span className="mt-0.5 block text-[11px] text-ink-3">
          {d.plannerLabel}
          {d.model ? ` · ${d.model}` : ''}
          {typeof d.latencyMs === 'number' && !d.cached ? ` · ${d.latencyMs} ms` : ''}
          {d.cached ? ' · reused plan for an identical investigation state' : ''}
        </span>
        {d.providerFallback && (
          <span className="mt-0.5 block text-[11px] font-medium text-high">
            {d.failure ? `Primary planner (${d.providerFallback.from}) and fallback provider (${d.plannerLabel}) both unavailable.` : `Primary planner unavailable (${d.providerFallback.from}). Fallback provider used.`}
          </span>
        )}
      </span>
      <span className="min-w-0 text-ink-2">
        {d.reason && <span className="block">{d.reason}</span>}
        <span className={cx('mt-1 block text-[11.5px] font-medium', d.validator === 'APPROVED' ? 'text-ok' : d.validator === 'REJECTED' ? 'text-crit' : 'text-ink-3')}>
          Validator: {d.validator === 'NOT_RUN' ? 'not run — no valid plan' : d.validator}
        </span>
        {d.rejection && <span className="block text-[11.5px] text-ink-2">{d.rejection.reason}</span>}
        {d.failure && <span className="block text-[11.5px] text-ink-3">{d.failure.detail}</span>}
      </span>
    </div>
  );
}

function foldCalls(steps: TraceStep[]): { step: TraceStep; result?: TraceStep }[] {
  const rows: { step: TraceStep; result?: TraceStep }[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const next = steps[i + 1];
    if (s.kind === 'tool_call' && next?.kind === 'result') {
      rows.push({ step: s, result: next });
      i++;
    } else rows.push({ step: s });
  }
  return rows;
}

function TraceRow({ step, result, source }: { step: TraceStep; result?: TraceStep; source?: SourceConnection['state'] }) {
  if (step.kind === 'planner' && step.planner) return <PlannerRow step={step} d={step.planner} />;
  const isCall = step.kind === 'tool_call';
  const failed = result && result.status && result.status !== 'ok';
  const changed = result?.changed ?? step.changed;
  const materially = changed?.some((c) => !c.startsWith('No change'));
  return (
    <div className={cx('grid gap-x-3 gap-y-1 border-b border-line px-4 py-2.5 text-[12.5px] last:border-b-0 lg:grid-cols-[48px_104px_150px_minmax(0,1fr)_minmax(0,0.9fr)]', step.kind === 'human' && 'bg-ok-soft/40', step.kind === 'approval' && 'bg-high-soft/30')}>
      <Mono className="text-ink-3">{fmtTime(step.at)}</Mono>
      <span className={cx('font-medium', STEP_TONE[step.kind] ?? 'text-ink-2')}>{STEP_LABEL[step.kind]}</span>
      <span className="min-w-0">
        {isCall ? (
          <>
            <code className="block truncate font-mono text-[11.5px] text-ink">{step.tool}</code>
            <span className="block truncate text-[11.5px] text-ink-3" title={step.input}>
              {step.input}
            </span>
          </>
        ) : step.source ? (
          <ProviderName provider={step.source} short className="text-ink-3" />
        ) : (
          <span className="text-ink-3">—</span>
        )}
      </span>
      <span className="min-w-0">
        {isCall && result ? (
          <>
            <span className={cx(failed && 'text-high')}>{result.title}</span>
            <span className="mt-1 flex flex-wrap items-center gap-1.5">
              {step.source && <ProviderName provider={step.source} short className="text-[11px] text-ink-3" />}
              <SourceStateTag state={failed ? (result.status === 'error' ? 'error' : 'unavailable') : source} />
            </span>
          </>
        ) : (
          <>
            <span className={cx(step.kind === 'stop' || step.kind === 'attention' ? 'font-medium' : '')}>{step.title}</span>
            {step.detail && <span className="mt-0.5 block text-ink-2">{step.detail}</span>}
            {step.result && <span className="mt-0.5 block text-ink-3">{step.result}</span>}
          </>
        )}
      </span>
      <span className="min-w-0 text-ink-2">
        {step.why && <span className="block">{step.why}</span>}
        {changed && (
          <span className="mt-1 block">
            {changed.map((c) => (
              <span key={c} className={cx('block text-[11.5px]', materially && !c.startsWith('No change') ? 'font-medium text-accent' : 'text-ink-3')}>
                {materially && !c.startsWith('No change') ? '→ ' : ''}
                {c}
              </span>
            ))}
          </span>
        )}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Hypotheses
// ─────────────────────────────────────────────────────────────

const STRENGTH_STEPS: EvidenceStrength[] = ['weak', 'moderate', 'strong'];
const STATUS_TONE: Record<AgentHypothesis['status'], Tone> = { untested: 'neutral', open: 'info', supported: 'accent', contested: 'med', ruled_out: 'neutral' };
const STATUS_LABEL: Record<AgentHypothesis['status'], string> = { untested: 'Untested', open: 'Open', supported: 'Supported', contested: 'Contested', ruled_out: 'Ruled out' };

export function StrengthMeter({ strength }: { strength: EvidenceStrength }) {
  const n = STRENGTH_STEPS.indexOf(strength) + 1;
  return (
    <span className="inline-flex items-center gap-1.5" title={`Evidence strength: ${strength}`}>
      <span className="flex gap-0.5">
        {STRENGTH_STEPS.map((_, i) => (
          <span key={i} className={cx('h-1.5 w-4 rounded-full', i < n ? 'bg-accent' : 'bg-line-strong/60')} />
        ))}
      </span>
      <span className="text-[11.5px] text-ink-2">{strength === 'none' ? 'no evidence' : strength}</span>
    </span>
  );
}

export function HypothesisCards({ hypotheses, evidence }: { hypotheses: AgentHypothesis[]; evidence: EvidenceItem[] }) {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const order: AgentHypothesis['status'][] = ['supported', 'contested', 'open', 'untested', 'ruled_out'];
  const sorted = [...hypotheses].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || STRENGTH_STEPS.indexOf(b.strength) - STRENGTH_STEPS.indexOf(a.strength));
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-ink-3">
        <span className="font-medium text-ink-2">Evidence strength</span> is how much independent evidence lines up with an explanation — not the probability that it is the cause. Timing alone never makes an explanation strong.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {sorted.map((h) => (
          <Card key={h.kind} className={cx(h.status === 'ruled_out' && 'opacity-60')}>
            <div className="flex flex-wrap items-center gap-2">
              <Mono className="text-[11px] text-ink-3">{HYPOTHESIS_ID[h.kind]}</Mono>
              <span className="text-[13px] font-semibold">{hypothesisLabel(h.kind)}</span>
              <Badge tone={STATUS_TONE[h.status]}>{STATUS_LABEL[h.status]}</Badge>
              <span className="ml-auto">{h.status !== 'ruled_out' && h.status !== 'untested' && <StrengthMeter strength={h.strength} />}</span>
            </div>
            <p className="mt-1 text-[12.5px] text-ink-2">{h.statement}</p>
            <EvidenceList label="For" tone="text-ok" ids={h.evidenceFor} byId={byId} empty="Nothing yet" />
            <EvidenceList label="Against" tone="text-crit" ids={h.evidenceAgainst} byId={byId} empty="Nothing against" />
            {h.unknowns.length > 0 && (
              <div className="mt-2">
                <Eyebrow className="mb-0.5 text-high">Unknown</Eyebrow>
                <ul className="space-y-0.5 text-[12px] text-ink-2">
                  {h.unknowns.map((u) => (
                    <li key={u}>{u}</li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

function EvidenceList({ label, tone, ids, byId, empty }: { label: string; tone: string; ids: string[]; byId: Map<string, EvidenceItem>; empty: string }) {
  return (
    <div className="mt-2">
      <Eyebrow className={cx('mb-0.5', tone)}>{label}</Eyebrow>
      {ids.length === 0 ? (
        <p className="text-[12px] text-ink-3">{empty}</p>
      ) : (
        <ul className="space-y-0.5 text-[12px]">
          {ids.map((id) => {
            const e = byId.get(id);
            return (
              <li key={id} className="flex gap-1.5">
                {e && <ProviderName provider={e.provider} short className="shrink-0 text-ink-3" />}
                <span>{e?.statement ?? id}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Attention decision
// ─────────────────────────────────────────────────────────────

const BAND_TEXT = {
  high: 'Several independent sources agree the problem is real.',
  moderate: 'The problem is probably real, but corroboration is partial.',
  low: 'The signal may be noise or a measurement issue; Jagr has not confirmed it.',
};

export function AttentionDecision({ inv, interruptAt }: { inv: WatchInvestigation; interruptAt?: WatchInvestigation['attention'] }) {
  const band = confidenceBand(inv.confidence);
  return (
    <Card>
      <Eyebrow className="mb-2">Attention decision</Eyebrow>
      <div className="flex items-center gap-2">
        <AttentionBadge level={inv.attention} />
        <span className="text-[13px] font-medium">{attentionRoute(inv.attention, interruptAt)}</span>
      </div>
      <p className="mt-2 text-[12.5px] text-ink-2">{inv.attentionReason}</p>
      <div className="mt-3 border-t border-line pt-3">
        <div className="text-[12px] text-ink-3">Investigation confidence</div>
        <div className="text-[15px] font-semibold capitalize">{band}</div>
        <p className="mt-1 text-[12px] text-ink-2">
          {BAND_TEXT[band]} This is confidence that <em>the problem is real</em> — never that any explanation is the cause.
        </p>
      </div>
      {inv.stopReason && (
        <div className="mt-3 border-t border-line pt-3 text-[12px]">
          <div className="text-ink-3">Why Jagr stopped · {inv.toolCalls} tool calls</div>
          <p className="mt-0.5 text-ink-2">{inv.stopReason}</p>
        </div>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// Actions & approvals
// ─────────────────────────────────────────────────────────────

const RISK_TONE: Record<ActionRisk, Tone> = { LOW: 'ok', MEDIUM: 'med', HIGH: 'high', CRITICAL: 'crit' };
const AUTONOMY_TEXT: Record<ActionRisk, string> = {
  LOW: 'Jagr did this on its own — low risk and reversible.',
  MEDIUM: 'Jagr recommends this. One click to do it.',
  HIGH: 'Jagr prepared this and notified you. It will not run without approval.',
  CRITICAL: 'Consequential. Nothing happens without explicit human approval.',
};

export function RiskBadge({ risk }: { risk: ActionRisk }) {
  return <Badge tone={RISK_TONE[risk]}>{risk} risk</Badge>;
}

export function ActionRow({ action, onDo }: { action: EffectiveAction; onDo?: () => void }) {
  const { decide } = useProduct();
  const toast = useToast();
  const done = action.effective === 'executed' || action.effective === 'done' || action.effective === 'approved';
  const doIt = () => {
    onDo?.();
    const d = decide(action, { status: 'done' });
    toast({ tone: 'success', title: action.title, body: d.result });
  };
  return (
    <div className="border-b border-line px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <RiskBadge risk={action.risk} />
        <span className="min-w-0 flex-1 text-[13px] font-medium">{action.title}</span>
        {done ? (
          <Badge tone="ok" dot>
            {action.effective === 'executed' ? 'Done by Jagr' : action.effective === 'approved' ? 'Approved' : 'Done'}
          </Badge>
        ) : action.effective === 'rejected' ? (
          <Badge tone="neutral">Rejected</Badge>
        ) : action.risk === 'MEDIUM' ? (
          <Button size="sm" icon={Check} onClick={doIt}>
            Do it (simulated)
          </Button>
        ) : (
          <a href={`#approve-${action.id}`} className="text-[12px] font-medium text-high hover:underline">
            Awaiting approval ↓
          </a>
        )}
      </div>
      <p className="mt-1 text-[12px] text-ink-3">{AUTONOMY_TEXT[action.risk]}</p>
      {(action.decision?.result ?? action.result) && <p className="mt-1 text-[12px] text-ink-2">{action.decision?.result ?? action.result}</p>}
    </div>
  );
}

/** ACTION · WHY · EVIDENCE · RISK · WHAT WILL HAPPEN · WHAT COULD GO WRONG · APPROVE / REJECT / MODIFY */
export function AgentApprovalCard({ action, inv }: { action: EffectiveAction; inv?: WatchInvestigation }) {
  const { decide } = useProduct();
  const toast = useToast();
  const [optionId, setOptionId] = useState(action.options?.[0]?.id);
  const [note, setNote] = useState('');
  const decided = action.decision;
  const option = action.options?.find((o) => o.id === (decided?.optionId ?? optionId));

  const act = (status: 'approved' | 'rejected') => {
    const d = decide(action, { status, optionId: status === 'approved' ? optionId : undefined, note: note.trim() || undefined });
    toast({ tone: status === 'approved' ? 'success' : 'info', title: status === 'approved' ? 'Approved' : 'Rejected', body: `${d.result} Recorded in the Agent Trace.` });
  };

  return (
    <Card padded={false} className={cx('overflow-hidden', !decided && 'ring-1 ring-high/40')}>
      <div id={`approve-${action.id}`} className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <ShieldAlert size={15} className={action.risk === 'CRITICAL' ? 'text-crit' : 'text-high'} />
        <span className="text-[14px] font-semibold">{action.title}</span>
        <RiskBadge risk={action.risk} />
        {!action.reversible && <Badge tone="crit">Not easily reversible</Badge>}
        <span className="ml-auto text-[11.5px] text-ink-3">
          Proposed {fmtTime(action.proposedAt)}
          {inv && <> · {inv.title}</>}
        </span>
      </div>
      <div className="grid gap-4 px-4 py-4 md:grid-cols-2">
        <Field label="Why">{action.why}</Field>
        <Field label="Evidence">
          <ul className="space-y-0.5">
            {action.evidence.map((e) => (
              <li key={e} className="flex gap-1.5">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-ink-3" />
                {e}
              </li>
            ))}
          </ul>
        </Field>
        <Field label="What will happen">{option ? `${option.label} — ${option.description}` : action.whatWillHappen}</Field>
        <Field label="What could go wrong" tone="text-crit">
          {action.whatCouldGoWrong}
        </Field>
        <Field label="Risk">
          {action.risk} · {AUTONOMY_TEXT[action.risk]} {action.reversible ? 'Reversible.' : 'Hard to undo.'}
        </Field>
      </div>

      {decided ? (
        <div className={cx('flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 text-[12.5px]', decided.status === 'approved' ? 'bg-ok-soft/50' : 'bg-subtle')}>
          {decided.status === 'approved' ? <Check size={14} className="text-ok" /> : <CircleSlash size={14} className="text-ink-3" />}
          <span className="font-medium">{decided.status === 'approved' ? `Approved${option ? `: ${option.label}` : ''}` : 'Rejected'}</span>
          <span className="text-ink-2">{decided.result}</span>
          {decided.note && <span className="w-full text-ink-3">Note: “{decided.note}”</span>}
        </div>
      ) : (
        <div className="space-y-3 border-t border-line bg-subtle/40 px-4 py-3">
          {action.options && action.options.length > 1 && (
            <fieldset>
              <legend className="mb-1 text-[11.5px] font-semibold uppercase tracking-wider text-ink-3">Modify — choose what to approve</legend>
              <div className="flex flex-wrap gap-2">
                {action.options.map((o) => (
                  <label key={o.id} className={cx('flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px]', optionId === o.id ? 'border-accent bg-accent-soft' : 'border-line bg-surface')}>
                    <input type="radio" name={`opt-${action.id}`} className="mt-0.5" checked={optionId === o.id} onChange={() => setOptionId(o.id)} />
                    <span>
                      <span className="font-medium">{o.label}</span>
                      <span className="block text-ink-3">{o.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note for the audit trail (optional)"
            aria-label="Decision note"
            className="h-8 w-full rounded-lg border border-line bg-surface px-3 text-[12.5px] outline-none focus:border-accent"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="success" icon={Check} onClick={() => act('approved')}>
              Approve{action.options && action.options.length > 1 && option ? `: ${option.label}` : ''}
            </Button>
            <Button variant="danger" icon={X} onClick={() => act('rejected')}>
              Reject
            </Button>
            <span className="flex items-center gap-1 text-[11.5px] text-ink-3">
              <Lock size={11} /> Simulated environment — approving changes no production system.
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}

function Field({ label, children, tone }: { label: string; children: React.ReactNode; tone?: string }) {
  return (
    <div className="text-[12.5px]">
      <Eyebrow className={cx('mb-1', tone)}>{label}</Eyebrow>
      <div className="text-ink">{children}</div>
    </div>
  );
}

export function AgentWorkingLine({ inv }: { inv: WatchInvestigation }) {
  const passes = new Set(inv.trace.filter((s) => s.kind === 'tool_call').map((s) => s.pass)).size;
  const sources = new Set(inv.trace.filter((s) => s.kind === 'tool_call').map((s) => s.source)).size;
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-2">
      <Bot size={13} className="text-accent" />
      Jagr made {inv.toolCalls} tool calls to {sources} sources over {passes} investigation {passes === 1 ? 'pass' : 'passes'}
    </span>
  );
}

/** Which planner chose the tools for this run — model, scripted test planner, or deterministic. */
export function PlannerModeLine({ info }: { info?: PlannerRunInfo }) {
  const i = info ?? { mode: 'deterministic' as const, label: 'Deterministic planner', reason: 'No LLM planner is configured in this build.' };
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-[12px] text-ink-2">
      <span className="text-ink-3">Environment:</span>
      <span className="rounded bg-subtle px-1.5 py-px text-[10px] font-semibold tracking-wide text-ink-2 ring-1 ring-inset ring-line">WORKSPACE</span>
      <span className="ml-1 text-ink-3">Data:</span>
      {i.data === 'imported' ? (
        <span className="rounded bg-accent-soft px-1.5 py-px text-[10px] font-semibold tracking-wide text-accent">USER IMPORT</span>
      ) : (
        <span className="rounded border border-dashed border-info/50 bg-info-soft px-1.5 py-px text-[10px] font-semibold tracking-wide text-info">{(i.data ?? 'simulated').toUpperCase()}</span>
      )}
      <span className="ml-1 text-ink-3">Planner:</span>
      <span className={cx('rounded px-1.5 py-px text-[10px] font-semibold tracking-wide', i.mode === 'llm' ? 'bg-accent-soft text-accent' : i.mode === 'test_double' ? 'bg-high-soft text-high' : 'bg-subtle text-ink-2 ring-1 ring-inset ring-line')}>
        {i.mode === 'llm' ? 'MODEL' : i.mode === 'test_double' ? 'SCRIPTED TEST PLANNER' : 'DETERMINISTIC'}
      </span>
      <span>
        {i.label}
        {i.model ? ` · ${i.model}` : ''}
      </span>
      {i.fallback && (
        <span className="text-ink-3">
          · fallback provider: {i.fallback.label}
          {i.fallback.model ? ` · ${i.fallback.model}` : ''}
        </span>
      )}
      {i.reason && <span className="text-ink-3">— {i.reason}</span>}
      <span className="text-ink-3">· every proposal passes the policy validator before a tool runs</span>
    </span>
  );
}
