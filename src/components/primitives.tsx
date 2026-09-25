import { ChevronRight, Loader2, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AgentHypothesis, AttentionLevel, ConnectionState, EvidenceItem as EvidenceRecord } from '@/product/types';
import { fmtTime } from '@/lib/time';
import { cx } from './ui';

/**
 * Jagr's design primitives. Every status in the product is expressed through StatusBadge, every
 * section through SectionHeader, every piece of evidence through EvidenceItem — so meaning looks the
 * same everywhere, and nothing depends on colour alone (each status carries text and a shape).
 */

// ─────────────────────────────────────────────────────────────
// StatusBadge — one vocabulary for sources, attention, evidence strength and risk
// ─────────────────────────────────────────────────────────────

type Tone = 'crit' | 'high' | 'med' | 'ok' | 'info' | 'accent' | 'strong' | 'neutral' | 'faint';
const TONE: Record<Tone, string> = {
  crit: 'text-crit bg-crit-soft ring-crit/25',
  high: 'text-high bg-high-soft ring-high/25',
  med: 'text-med bg-med-soft ring-med/25',
  ok: 'text-ok bg-ok-soft ring-ok/25',
  info: 'text-info bg-info-soft ring-info/25',
  accent: 'text-accent bg-accent-soft ring-accent/25',
  strong: 'text-ink bg-subtle ring-line-strong',
  neutral: 'text-ink-2 bg-subtle ring-line',
  faint: 'text-ink-3 bg-transparent ring-line',
};

export type StrengthValue = 'strong' | 'moderate' | 'weak' | 'ruled_out' | 'unknown';

/** Source status. STALE is not a connection state: it is derived (data stops before the run window ends). */
export type SourceStatusValue = ConnectionState | 'stale';
const SOURCE: Record<SourceStatusValue, { label: string; tone: Tone; shape: 'dot' | 'ring' | 'dash' | 'half' }> = {
  connected: { label: 'Connected', tone: 'ok', shape: 'dot' },
  imported: { label: 'User import', tone: 'accent', shape: 'dot' },
  simulated: { label: 'Simulated', tone: 'info', shape: 'dash' },
  not_configured: { label: 'Not configured', tone: 'faint', shape: 'ring' },
  unavailable: { label: 'Unavailable', tone: 'high', shape: 'ring' },
  error: { label: 'Error', tone: 'crit', shape: 'ring' },
  needs_reconnect: { label: 'Needs reconnection', tone: 'high', shape: 'ring' },
  stale: { label: 'Stale', tone: 'med', shape: 'half' },
};
const ATTENTION: Record<AttentionLevel, Tone> = { LOW: 'neutral', MEDIUM: 'med', HIGH: 'high', CRITICAL: 'crit' };
const STRENGTH: Record<StrengthValue, { label: string; tone: Tone; bars: number }> = {
  // Strength is not a severity or an action: neutral ink, with the bars carrying the amount.
  strong: { label: 'Strong', tone: 'strong', bars: 3 },
  moderate: { label: 'Moderate', tone: 'strong', bars: 2 },
  weak: { label: 'Weak', tone: 'neutral', bars: 1 },
  ruled_out: { label: 'Ruled out', tone: 'faint', bars: 0 },
  unknown: { label: 'Unknown', tone: 'faint', bars: 0 },
};

/** A hypothesis's evidence strength in the product's words. Untested → UNKNOWN; never a probability. */
export function strengthOf(h: Pick<AgentHypothesis, 'status' | 'strength'>): StrengthValue {
  if (h.status === 'ruled_out') return 'ruled_out';
  if (h.status === 'untested' || h.strength === 'none') return 'unknown';
  return h.strength;
}

type StatusProps =
  | { kind: 'source'; value: SourceStatusValue }
  | { kind: 'attention'; value: AttentionLevel }
  | { kind: 'strength'; value: StrengthValue }
  | { kind: 'risk'; value: AttentionLevel };

export function StatusBadge(props: StatusProps & { className?: string; size?: 'sm' | 'md' }) {
  const base = cx('inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded font-semibold tracking-wide uppercase ring-1 ring-inset', props.size === 'md' ? 'h-6 px-2 text-[12px]' : 'h-5 px-1.5 text-[12px]', props.className);
  if (props.kind === 'source') {
    const s = SOURCE[props.value];
    return (
      <span className={cx(base, TONE[s.tone])} title={`Source status: ${s.label}`}>
        <Shape shape={s.shape} />
        {s.label}
      </span>
    );
  }
  if (props.kind === 'strength') {
    const s = STRENGTH[props.value];
    return (
      <span className={cx(base, TONE[s.tone])} title={`Evidence strength: ${s.label} — how much independent evidence lines up, not a probability`}>
        <span aria-hidden className="flex gap-px">
          {[0, 1, 2].map((i) => (
            <span key={i} className={cx('h-2 w-[3px] rounded-[1px]', i < s.bars ? 'bg-current' : 'bg-current opacity-20')} />
          ))}
        </span>
        {s.label}
      </span>
    );
  }
  const tone = ATTENTION[props.value];
  return (
    <span className={cx(base, TONE[tone])} title={props.kind === 'risk' ? `${props.value} risk` : `${props.value} attention`}>
      <span aria-hidden className={cx('size-1.5 rotate-45 rounded-[1px] bg-current', props.value === 'LOW' && 'opacity-50')} />
      {props.value}
      {props.kind === 'risk' && <span className="font-medium normal-case tracking-normal opacity-80">risk</span>}
    </span>
  );
}

function Shape({ shape }: { shape: 'dot' | 'ring' | 'dash' | 'half' }) {
  if (shape === 'half') return <span aria-hidden className="size-1.5 rounded-full ring-1 ring-current [background:linear-gradient(90deg,currentColor_50%,transparent_50%)]" />;
  if (shape === 'dot') return <span aria-hidden className="size-1.5 rounded-full bg-current" />;
  if (shape === 'ring') return <span aria-hidden className="size-1.5 rounded-full ring-1 ring-current" />;
  return <span aria-hidden className="h-px w-2 bg-current" />;
}

// ─────────────────────────────────────────────────────────────
// SectionHeader — the only section heading style
// ─────────────────────────────────────────────────────────────

export function SectionHeader({ title, hint, action, id, count }: { title: ReactNode; hint?: ReactNode; action?: ReactNode; id?: string; count?: number }) {
  return (
    <div id={id} className="mb-3 flex scroll-mt-20 items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="flex items-baseline gap-2 text-[16px] font-semibold tracking-tight text-ink">
          {title}
          {count !== undefined && <span className="num text-[13px] font-normal text-ink-3">{count}</span>}
        </h2>
        {hint && <p className="mt-0.5 max-w-2xl text-[13px] text-ink-2">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// MetricValue — baseline → current, tabular, with the change
// ─────────────────────────────────────────────────────────────

export function MetricValue({ baseline, current, change, size = 'md' }: { baseline: string; current: string; change?: string; size?: 'md' | 'lg' }) {
  return (
    <span className={cx('num inline-flex flex-wrap items-baseline gap-x-2', size === 'lg' ? 'text-[16px]' : 'text-[13px]')}>
      <span className="text-ink-3">{baseline}</span>
      <span aria-hidden className="text-ink-3">→</span>
      <span className={cx('font-semibold text-ink', size === 'lg' && 'text-[20px] tracking-tight')}>{current}</span>
      {change && <span className="text-ink-2">{change}</span>}
      <span className="sr-only">
        from a baseline of {baseline} to {current}
      </span>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────
// AttentionBanner — the top of an investigation
// ─────────────────────────────────────────────────────────────

/** Attention is carried by the badge and one rule on the left edge — no glow, no tinted frame. */
export function AttentionBanner({ level, children }: { level: AttentionLevel; children: ReactNode }) {
  return (
    <section aria-label={`${level} attention`} className="relative overflow-hidden rounded-lg border border-line bg-surface">
      <span aria-hidden className={cx('absolute inset-y-0 left-0 w-[3px]', level === 'CRITICAL' ? 'bg-crit' : level === 'HIGH' ? 'bg-high' : level === 'MEDIUM' ? 'bg-med' : 'bg-line-strong')} />
      <div className="px-5 py-5 sm:px-6">{children}</div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// EvidenceItem — a fact, with where it came from, how it got here, and when
// ─────────────────────────────────────────────────────────────

const DIRECTION: Record<EvidenceRecord['direction'], { label: string; cls: string }> = {
  degraded: { label: 'Degraded', cls: 'bg-crit' },
  change: { label: 'Change', cls: 'bg-accent' },
  stable: { label: 'Normal', cls: 'bg-ok' },
  gap: { label: 'Not checked', cls: 'bg-high' },
};

export function EvidenceItem({ evidence, source, state, action }: { evidence: EvidenceRecord; source: ReactNode; state?: ConnectionState; action?: ReactNode }) {
  const d = DIRECTION[evidence.direction];
  return (
    <div className="flex items-start gap-3 py-2.5">
      <span aria-hidden className={cx('mt-[7px] size-1.5 shrink-0 rounded-full', d.cls)} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-snug text-ink">{evidence.statement.replace(/^[^:]{1,40}: /, '')}</p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
          {source}
          {state && <StatusBadge kind="source" value={state} />}
          {evidence.onsetAt && <span className="num font-mono">{fmtTime(evidence.onsetAt)} UTC</span>}
          <span>· {d.label}</span>
        </p>
      </div>
      {action}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// InvestigationTimeline — what happened, in order
// ─────────────────────────────────────────────────────────────

export interface TimelineEntry {
  key: string;
  at?: string;
  label: string;
  title: ReactNode;
  detail?: ReactNode;
  tone: 'signal' | 'change' | 'evidence' | 'normal' | 'gap' | 'assessment';
}

const DOT: Record<TimelineEntry['tone'], string> = {
  signal: 'bg-crit ring-crit/25',
  change: 'bg-accent ring-accent/25',
  evidence: 'bg-high ring-high/25',
  normal: 'bg-ok ring-ok/25',
  gap: 'bg-surface ring-high',
  assessment: 'bg-ink ring-ink/20',
};

export function InvestigationTimeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <ol className="stagger relative">
      {entries.map((e, i) => (
        <li key={e.key} style={{ ['--i' as string]: i }} className="relative grid grid-cols-[52px_16px_1fr] gap-x-3 pb-5 last:pb-0">
          <span className="num pt-0.5 text-right font-mono text-[12px] text-ink-3">{e.at ? fmtTime(e.at) : ''}</span>
          <span className="relative flex justify-center">
            {i < entries.length - 1 && <span aria-hidden className="absolute top-3 bottom-[-20px] w-px bg-line" />}
            <span aria-hidden className={cx('relative mt-1 size-2.5 rounded-full ring-4', DOT[e.tone])} />
          </span>
          <div className="min-w-0">
            <div className="text-[12px] font-medium text-ink-3">{e.label}</div>
            <div className="mt-0.5 text-[14px] font-medium text-ink">{e.title}</div>
            {e.detail && <div className="mt-0.5 text-[13px] text-ink-2">{e.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

// ─────────────────────────────────────────────────────────────
// Loading / empty
// ─────────────────────────────────────────────────────────────

export function LoadingState({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-16 text-[13px] text-ink-3">
      <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
      {label}
    </div>
  );
}

/** What this is · why it's empty · what to do next. */
export function EmptyPanel({ icon: Icon, title, why, action }: { icon?: LucideIcon; title: string; why: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line-strong px-6 py-10 text-center">
      {Icon && <Icon size={18} className="mx-auto text-ink-3" />}
      <p className="mt-2 text-[14px] font-semibold text-ink">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-[13px] text-ink-2">{why}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function LinkArrow({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-0.5 font-medium text-accent">
      {children}
      <ChevronRight size={13} />
    </span>
  );
}

// ─────────────────────────────────────────────────────────────
// SourceCoverage — how every evidence channel is fed, at a glance
// ─────────────────────────────────────────────────────────────

const SOURCE_ORDER: ConnectionState[] = ['imported', 'connected', 'simulated', 'not_configured', 'needs_reconnect', 'unavailable', 'error'];
const SOURCE_MEANING: Record<ConnectionState, string> = {
  imported: 'your uploaded files',
  connected: 'live credentials',
  simulated: 'fixture data, labelled',
  not_configured: 'left out of runs',
  unavailable: 'recorded as a gap',
  error: 'recorded as a gap',
  needs_reconnect: 'credentials needed — recorded as a gap',
};

export function SourceCoverage({ connections }: { connections: { provider: string; state: ConnectionState }[] }) {
  const counts = new Map<ConnectionState, number>();
  for (const c of connections) if (c.provider !== 'email') counts.set(c.state, (counts.get(c.state) ?? 0) + 1);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const usable = (counts.get('imported') ?? 0) + (counts.get('connected') ?? 0) + (counts.get('simulated') ?? 0);
  return (
    <div className="mb-6 rounded-lg border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[13px] font-semibold">
          Signal coverage{' '}
          <span className="num font-normal text-ink-2">
            {usable} of {total} evidence channels feeding investigations
          </span>
        </div>
      </div>
      <ul className="mt-2.5 flex flex-wrap gap-x-5 gap-y-2">
        {SOURCE_ORDER.filter((s) => counts.get(s)).map((s) => (
          <li key={s} className="flex items-center gap-2 text-[12px] text-ink-3">
            <StatusBadge kind="source" value={s} />
            <span className="num text-ink">{counts.get(s)}</span> {SOURCE_MEANING[s]}
          </li>
        ))}
      </ul>
    </div>
  );
}
