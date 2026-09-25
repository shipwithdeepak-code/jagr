import { clsx } from 'clsx';
import {
  Activity,
  BarChart3,
  Bell,
  CreditCard,
  FlaskConical,
  GitPullRequest,
  LifeBuoy,
  ListChecks,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { ConfidenceBand, InvestigationStatus, RiskLevel, Severity, SourceKind } from '@/domain/types';
import { SOURCE_LABELS } from '@/domain/defaults';

export { clsx as cx };

// ── Buttons ─────────────────────────────────────────────────
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; icon?: LucideIcon }) {
  return (
    <button
      {...rest}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-[background,border,color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-[13px]' : 'h-8.5 px-3 text-[13px]',
        variant === 'primary' && 'bg-ink text-canvas shadow-card hover:opacity-90',
        variant === 'secondary' && 'border border-line bg-surface text-ink shadow-card hover:border-line-strong hover:bg-subtle',
        variant === 'ghost' && 'text-ink-2 hover:bg-subtle hover:text-ink',
        variant === 'danger' && 'border border-line bg-surface text-crit shadow-card hover:bg-crit-soft',
        variant === 'success' && 'bg-ok text-surface shadow-card hover:opacity-90',
        className,
      )}
    >
      {Icon && <Icon size={size === 'sm' ? 13 : 14} strokeWidth={2} />}
      {children}
    </button>
  );
}

// ── Badges ──────────────────────────────────────────────────
const TONE: Record<string, string> = {
  crit: 'bg-crit-soft text-crit',
  high: 'bg-high-soft text-high',
  med: 'bg-med-soft text-med',
  ok: 'bg-ok-soft text-ok',
  info: 'bg-info-soft text-info',
  accent: 'bg-accent-soft text-accent',
  neutral: 'bg-subtle text-ink-2 ring-1 ring-inset ring-line',
};

export type Tone = keyof typeof TONE;

export function Badge({ tone = 'neutral', children, dot, className }: { tone?: Tone; children: ReactNode; dot?: boolean; className?: string }) {
  return (
    <span className={clsx('inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 text-[12px] font-medium', TONE[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export const SEVERITY_TONE: Record<Severity, Tone> = { critical: 'crit', high: 'high', medium: 'med', low: 'info', normal: 'ok' };
const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', normal: 'Normal' };

export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  return (
    <Badge tone={SEVERITY_TONE[severity]} dot className={className}>
      {SEVERITY_LABEL[severity]}
    </Badge>
  );
}

export function RiskBadge({ risk }: { risk: RiskLevel }) {
  return <Badge tone={risk === 'high' ? 'crit' : risk === 'medium' ? 'high' : 'ok'}>{risk.toUpperCase()} risk</Badge>;
}

export const STATUS_LABEL: Record<InvestigationStatus, string> = {
  investigating: 'Investigating',
  concluded: 'Concluded',
  low_confidence: 'Low confidence',
  insufficient_evidence: 'Insufficient evidence',
  dismissed: 'Dismissed — transient',
};

export function InvestigationStatusBadge({ status }: { status: InvestigationStatus }) {
  const tone: Tone = status === 'concluded' ? 'accent' : status === 'insufficient_evidence' ? 'med' : status === 'dismissed' ? 'neutral' : 'high';
  return <Badge tone={tone}>{STATUS_LABEL[status]}</Badge>;
}

export function SimulationBadge({ label = 'Simulation' }: { label?: string }) {
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded border border-dashed border-line-strong px-1.5 text-[12px] font-medium text-ink-3">
      {label}
    </span>
  );
}

// ── Surfaces ────────────────────────────────────────────────
export function Card({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <div className={clsx('rounded-lg border border-line bg-surface', padded && 'p-4 sm:p-5', className)}>{children}</div>;
}

export function SectionTitle({ children, action, hint, id }: { children: ReactNode; action?: ReactNode; hint?: ReactNode; id?: string }) {
  return (
    <div id={id} className="mb-3 flex scroll-mt-20 items-end justify-between gap-3">
      <div>
        <h2 className="text-[13px] font-semibold tracking-tight text-ink">{children}</h2>
        {hint && <p className="mt-0.5 text-[13px] text-ink-3">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('text-[12px] font-medium text-ink-3', className)}>{children}</div>;
}

export function PageHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5">{eyebrow}</div>}
        <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-[14px] text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'crit' | 'high' | 'ok' | 'default' }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[12px] text-ink-3">{label}</div>
      <div className={clsx('tabular mt-0.5 text-[20px] font-semibold tracking-tight', tone === 'crit' ? 'text-crit' : tone === 'high' ? 'text-high' : tone === 'ok' ? 'text-ok' : 'text-ink')}>{value}</div>
      {hint && <div className="mt-0.5 text-[12px] text-ink-3">{hint}</div>}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line-strong bg-surface/60 px-6 py-14 text-center">
      <div className="mb-3 grid size-10 place-items-center rounded-lg border border-line bg-surface text-ink-2 shadow-card">
        <Icon size={18} />
      </div>
      <div className="text-[14px] font-semibold text-ink">{title}</div>
      {children && <div className="mt-1 max-w-md text-[13px] text-ink-2">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ── Forms ───────────────────────────────────────────────────
export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40',
        checked ? 'bg-ink' : 'bg-line-strong',
      )}
    >
      <span className={clsx('absolute top-0.5 left-0.5 size-4 rounded-full bg-surface shadow transition-transform duration-150', checked && 'translate-x-4')} />
    </button>
  );
}

export function Select<T extends string>({ value, onChange, options, label, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string; className?: string }) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={clsx('h-8 rounded-lg border border-line bg-surface px-2 pr-7 text-[13px] text-ink shadow-card hover:border-line-strong', className)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ── Overlays ────────────────────────────────────────────────
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal surface's keyboard contract: focus moves inside on open (the first field, else the first
 * control), Tab and Shift+Tab stay inside, Escape closes, and focus returns to whatever opened it.
 */
export function useDialogFocus(open: boolean, onClose: () => void, ref: RefObject<HTMLElement | null>) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const box = ref.current;
    const first = box?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled])') ?? box?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? box)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== 'Tab' || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const [a, z] = [items[0], items[items.length - 1]];
      if (e.shiftKey && document.activeElement === a) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && document.activeElement === z) {
        e.preventDefault();
        a.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, [open, ref]);
}

export function Drawer({ open, onClose, title, children, width = 'max-w-xl', subtitle }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; width?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(open, onClose, ref);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="absolute inset-0 bg-black/25" onClick={onClose} />
      <div ref={ref} tabIndex={-1} className={clsx('animate-slide-in absolute inset-y-0 right-0 flex w-full flex-col border-l border-line bg-surface shadow-pop outline-none', width)}>
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[16px] font-semibold tracking-tight">{title}</h2>
            {subtitle && <div className="mt-0.5 text-[13px] text-ink-3">{subtitle}</div>}
          </div>
          <button onClick={onClose} className="rounded p-1 text-ink-3 hover:bg-subtle hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus(open, onClose, ref);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[60] grid place-items-center overflow-y-auto p-4" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div ref={ref} tabIndex={-1} className={clsx('animate-fade-up relative w-full rounded-xl border border-line bg-surface p-5 shadow-pop outline-none', wide ? 'max-w-lg' : 'max-w-md')}>
        <h2 id={titleId} className="text-[16px] font-semibold tracking-tight">{title}</h2>
        <div className="mt-2 text-[14px] text-ink-2">{children}</div>
        {footer && <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ── Tabs ────────────────────────────────────────────────────
export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[] }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-subtle p-0.5" role="tablist">
      {items.map((it) => (
        <button
          key={it.value}
          role="tab"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          className={clsx(
            'h-7 whitespace-nowrap rounded px-2.5 text-[13px] font-medium transition-colors',
            value === it.value ? 'bg-surface text-ink shadow-card' : 'text-ink-2 hover:text-ink',
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ── Domain bits ─────────────────────────────────────────────
export const SOURCE_ICON: Record<SourceKind, LucideIcon> = {
  analytics: BarChart3,
  payments: CreditCard,
  github: GitPullRequest,
  support: LifeBuoy,
  experiments: FlaskConical,
  issue_tracker: ListChecks,
  notifications: Bell,
};

export function SourceChip({ source, className }: { source: SourceKind; className?: string }) {
  const Icon = SOURCE_ICON[source] ?? Activity;
  return (
    <span className={clsx('inline-flex items-center gap-1 text-[12px] text-ink-3', className)}>
      <Icon size={12} />
      {SOURCE_LABELS[source]}
    </span>
  );
}

export function ConfidenceMeter({ value, band, size = 'md' }: { value?: number; band?: ConfidenceBand; size?: 'sm' | 'md' }) {
  if (value === undefined || band === 'insufficient') {
    return <span className="text-[13px] font-medium text-med">Insufficient evidence</span>;
  }
  const pct = Math.round(value * 100);
  const color = band === 'high' ? 'bg-ink' : band === 'medium' ? 'bg-ink-2' : 'bg-high';
  return (
    <span className="inline-flex items-center gap-2">
      <span className={clsx('relative overflow-hidden rounded-full bg-muted', size === 'sm' ? 'h-1.5 w-14' : 'h-1.5 w-24')}>
        <span className={clsx('absolute inset-y-0 left-0 rounded-full', color)} style={{ width: `${pct}%` }} />
      </span>
      <span className="tabular text-[13px] font-semibold text-ink">{pct}%</span>
      {band && size === 'md' && <span className="text-[12px] capitalize text-ink-3">{band}</span>}
    </span>
  );
}

export function KeyValue({ items, className }: { items: { k: ReactNode; v: ReactNode }[]; className?: string }) {
  return (
    <dl className={clsx('grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-2 text-[13px]', className)}>
      {items.map((it, i) => (
        <div key={i} className="contents">
          <dt className="text-ink-3">{it.k}</dt>
          <dd className="min-w-0 text-ink">{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx('font-mono text-[12px]', className)}>{children}</span>;
}
