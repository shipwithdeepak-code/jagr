import { BarChart3, ExternalLink, Mail, Play, Smartphone, Ticket, type LucideIcon, GitBranch, Activity, MessageCircle, Hash } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { AttentionLevel, ConnectionState, EmailNotification, InvestigationState, ProviderId, SourceLink } from '@/product/types';
import { PROVIDERS } from '@/product/integrations/adapters';
import { fmtDate, fmtTime } from '@/lib/time';
import { Badge, cx, Eyebrow, type Tone } from './ui';
import { StatusBadge } from './primitives';
import { useContext, useEffect, useState } from 'react';
import { ProductContext } from '@/state/productContext';
import { useEnvironment, type EnvironmentScope } from '@/state/environment';

export const PROVIDER_ICON: Record<ProviderId, LucideIcon> = { jira: Ticket, ga4: BarChart3, app_store: Smartphone, google_play: Play, github: GitBranch, amplitude: Activity, intercom: MessageCircle, email: Mail, slack: Hash };

/** The source's display name in the current workspace (imported data renames channels). */
export function useProviderLabel(provider: ProviderId) {
  const ctx = useContext(ProductContext);
  return ctx?.state.connections.find((c) => c.provider === provider)?.label ?? PROVIDERS[provider];
}

export function useSourceState(provider: ProviderId): ConnectionState | undefined {
  const ctx = useContext(ProductContext);
  return ctx?.state.connections.find((c) => c.provider === provider)?.state;
}

export function ProviderName({ provider, short, className }: { provider: ProviderId; short?: boolean; className?: string }) {
  const Icon = PROVIDER_ICON[provider];
  const label = useProviderLabel(provider);
  return (
    <span className={cx('inline-flex items-center gap-1.5', className)}>
      <Icon size={13} className="shrink-0" />
      {short ? label.short : label.name}
    </span>
  );
}

/** One vocabulary for source status, everywhere. Never blur simulated, imported and connected data. */
export const CONNECTION: Record<ConnectionState, { tone: Tone; label: string }> = {
  connected: { tone: 'ok', label: 'Connected' },
  simulated: { tone: 'info', label: 'Simulated' },
  imported: { tone: 'accent', label: 'User import' },
  not_configured: { tone: 'neutral', label: 'Not configured' },
  unavailable: { tone: 'high', label: 'Unavailable' },
  error: { tone: 'crit', label: 'Error' },
  needs_reconnect: { tone: 'high', label: 'Needs reconnection' },
};

export function ConnectionBadge({ state }: { state: ConnectionState }) {
  // One source-status vocabulary everywhere: USER IMPORT / CONNECTED / SIMULATED / NOT CONFIGURED / UNAVAILABLE / ERROR.
  return <StatusBadge kind="source" value={state} />;
}

/** Which environment a record belongs to — shown wherever records from both could appear. */
export function EnvironmentBadge({ env }: { env: 'workspace' | 'demo' }) {
  return env === 'workspace' ? (
    <Badge tone="info">Workspace</Badge>
  ) : (
    <span className="inline-flex items-center rounded-md border border-dashed border-high/50 px-1.5 py-px text-[11px] font-medium text-high">Demo night</span>
  );
}

/** Scope follows the current environment; "All environments" is an explicit choice. */
export function useEnvironmentScope() {
  const { environment } = useEnvironment();
  const [scope, setScope] = useState<EnvironmentScope>(environment);
  useEffect(() => setScope(environment), [environment]);
  return [scope, setScope] as const;
}

const ATTENTION_TONE: Record<AttentionLevel, Tone> = { LOW: 'neutral', MEDIUM: 'med', HIGH: 'high', CRITICAL: 'crit' };

export function AttentionBadge({ level, className }: { level: AttentionLevel; className?: string }) {
  return (
    <Badge tone={ATTENTION_TONE[level]} className={cx('font-semibold tracking-wide', className)}>
      {level}
    </Badge>
  );
}

const STATE_TONE: Record<InvestigationState, Tone> = { DETECTED: 'neutral', INVESTIGATING: 'info', CONFIRMED: 'accent', DISMISSED: 'neutral', RESOLVED: 'ok' };

export function InvestigationStateBadge({ state }: { state: InvestigationState }) {
  return <Badge tone={STATE_TONE[state]}>{state.charAt(0) + state.slice(1).toLowerCase()}</Badge>;
}

export function attentionRoute(level: AttentionLevel, interruptAt: AttentionLevel = 'HIGH') {
  if (level === 'CRITICAL') return 'Emailed immediately';
  if (level === 'LOW') return 'No interruption';
  if ((interruptAt === 'MEDIUM' && level === 'MEDIUM') || level === 'HIGH') return 'Emailed once confirmed';
  return 'Morning brief';
}

/** A deep link into a source. Simulated records open Jagr's record view and say so. */
export function SourceLinkButton({ link, compact }: { link: SourceLink; compact?: boolean }) {
  const state = useSourceState(link.provider);
  const tag = state === 'imported' ? 'IMPORT' : link.simulated ? 'SIM' : undefined;
  return (
    <Link
      to={link.href}
      title={`Opens the ${link.simulated ? 'simulated ' : ''}record. With a live connector: ${link.externalUrl}`}
      className={cx('inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface font-medium shadow-card hover:bg-subtle', compact ? 'h-7 px-2 text-[12px]' : 'h-8 px-2.5 text-[12.5px]')}
    >
      <ProviderName provider={link.provider} short />
      {tag && <span className={cx('rounded px-1 text-[10px] font-semibold', tag === 'IMPORT' ? 'bg-accent-soft text-accent' : 'bg-info-soft text-info')}>{tag}</span>}
      <ExternalLink size={11} className="text-ink-3" />
    </Link>
  );
}

/** The data status of an email's source link, as of the current workspace: IMPORT, SIM, or nothing for live. */
function EmailButtonTag({ provider, simulated }: { provider?: ProviderId; simulated: boolean }) {
  const ctx = useContext(ProductContext);
  const state = provider ? ctx?.state.connections.find((c) => c.provider === provider)?.state : undefined;
  if (state === 'imported') return <span className="rounded bg-accent-soft px-1 text-[10px] font-semibold text-accent">IMPORT</span>;
  return simulated ? <span className="rounded bg-info-soft px-1 text-[10px] font-semibold text-info">SIM</span> : null;
}

/** Renders an email the way the PM would receive it. */
export function EmailPreview({ email }: { email: EmailNotification }) {
  const s = email.sections;
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-subtle/60 px-4 py-2 text-[11.5px] text-ink-3">
        <Mail size={13} />
        <span>
          <span className="font-medium text-ink-2">{email.from}</span> → {email.to}
        </span>
        <span className="ml-auto">
          {fmtDate(email.sentAt)} {fmtTime(email.sentAt)} · {email.trigger === 'immediate' ? 'sent immediately' : email.trigger === 'escalated' ? 'escalation' : 'sent once confirmed'}
        </span>
        <Badge tone="info" className="border border-dashed border-info/40">
          Simulated · not delivered
        </Badge>
      </div>
      <div className="px-5 py-4">
        <div className="text-[16px] font-semibold tracking-tight">{email.subject}</div>
        <div className="mt-4 space-y-4 text-[13.5px]">
          <Section label="What changed">
            <div className="text-[15px] font-semibold">{s.whatChanged}</div>
          </Section>
          <Section label="What Jagr found">
            <ul className="space-y-1">
              {s.whatJagrFound.map((f) => (
                <li key={f} className="flex gap-2">
                  <span className="mt-2 size-1 shrink-0 rounded-full bg-ink-3" />
                  {f}
                </li>
              ))}
            </ul>
          </Section>
          <Section label="Likely explanation">{s.likelyExplanation}</Section>
          <Section label="Uncertainty">{s.uncertainty}</Section>
          <Section label="Recommended next step">
            <span className="font-medium">{s.recommendedNextStep}</span>
          </Section>
        </div>
        <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
          {email.buttons.map((b) => (
            <Link
              key={b.label}
              to={b.href}
              className={cx(
                'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium',
                b.kind === 'jagr' ? 'bg-ink text-canvas hover:opacity-90' : 'border border-line bg-surface shadow-card hover:bg-subtle',
              )}
            >
              {b.label}
              <EmailButtonTag provider={b.provider} simulated={b.simulated} />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Eyebrow className="mb-1">{label}</Eyebrow>
      <div className="text-ink">{children}</div>
    </div>
  );
}
