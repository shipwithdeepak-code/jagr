import { BarChart3, ExternalLink, Mail, Play, Smartphone, Ticket, type LucideIcon, GitBranch, Activity, MessageCircle, Hash, Bug } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { AttentionLevel, ConnectionState, EmailNotification, InvestigationState, ProviderId, SourceLink } from '@/product/types';
import { PROVIDERS } from '@/product/integrations/adapters';
import { fmtDate, fmtTime } from '@/lib/time';
import { Badge, cx, Eyebrow, type Tone } from './ui';
import { StatusBadge } from './primitives';
import { useContext, useEffect, useState } from 'react';
import { ProductContext } from '@/state/productContext';
import { useEnvironment, type EnvironmentScope } from '@/state/environment';

export const PROVIDER_ICON: Record<ProviderId, LucideIcon> = { jira: Ticket, ga4: BarChart3, app_store: Smartphone, google_play: Play, github: GitBranch, amplitude: Activity, intercom: MessageCircle, sentry: Bug, email: Mail, slack: Hash };

/** Localized Simple Icons vendor geometry with restrained brand colors; missing marks use the existing fallback. */
const PROVIDER_LOGO_PATH: Partial<Record<ProviderId, string>> = {
  github: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  jira: 'M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z',
  intercom: 'M21 0H3C1.343 0 0 1.343 0 3v18c0 1.658 1.343 3 3 3h18c1.658 0 3-1.342 3-3V3c0-1.657-1.342-3-3-3zm-5.801 4.399c0-.44.36-.8.802-.8.44 0 .8.36.8.8v10.688c0 .442-.36.801-.8.801-.443 0-.802-.359-.802-.801V4.399zM11.2 3.994c0-.44.357-.799.8-.799s.8.359.8.799v11.602c0 .44-.357.8-.8.8s-.8-.36-.8-.8V3.994zm-4 .405c0-.44.359-.8.799-.8.443 0 .802.36.802.8v10.688c0 .442-.36.801-.802.801-.44 0-.799-.359-.799-.801V4.399zM3.199 6c0-.442.36-.8.802-.8.44 0 .799.358.799.8v7.195c0 .441-.359.8-.799.8-.443 0-.802-.36-.802-.8V6zM20.52 18.202c-.123.105-3.086 2.593-8.52 2.593-5.433 0-8.397-2.486-8.521-2.593-.335-.288-.375-.792-.086-1.128.285-.334.79-.375 1.125-.09.047.041 2.693 2.211 7.481 2.211 4.848 0 7.456-2.186 7.479-2.207.334-.289.839-.25 1.128.086.289.336.25.84-.086 1.128zm.281-5.007c0 .441-.36.8-.801.8-.441 0-.801-.36-.801-.8V6c0-.442.361-.8.801-.8.441 0 .801.357.801.8v7.195z',
  sentry: 'M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z',
  slack: 'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z',
  ga4: 'M22.84 2.9982v17.9987c.0086 1.6473-1.3197 2.9897-2.967 2.9984a2.9808 2.9808 0 0 1-.3677-.0208c-1.528-.226-2.6477-1.5558-2.6105-3.1V3.1204c-.0369-1.5458 1.0856-2.8762 2.6157-3.1 1.6361-.1915 3.1178.9796 3.3093 2.6158.014.1201.0208.241.0202.3619zM4.1326 18.0548c-1.6417 0-2.9726 1.331-2.9726 2.9726C1.16 22.6691 2.4909 24 4.1326 24s2.9726-1.3309 2.9726-2.9726-1.331-2.9726-2.9726-2.9726zm7.8728-9.0098c-.0171 0-.0342 0-.0513.0003-1.6495.0904-2.9293 1.474-2.891 3.1256v7.9846c0 2.167.9535 3.4825 2.3505 3.763 1.6118.3266 3.1832-.7152 3.5098-2.327.04-.1974.06-.3983.0593-.5998v-8.9585c.003-1.6474-1.33-2.9852-2.9773-2.9882z',
  app_store: 'M8.8086 14.9194l6.1107-11.0368c.0837-.1513.1682-.302.2437-.4584.0685-.142.1267-.2854.1646-.4403.0803-.3259.0588-.6656-.066-.9767-.1238-.3095-.3417-.5678-.6201-.7355a1.4175 1.4175 0 0 0-.921-.1924c-.3207.043-.6135.1935-.8443.4288-.1094.1118-.1996.2361-.2832.369-.092.1463-.175.2979-.259.4492l-.3864.6979-.3865-.6979c-.0837-.1515-.1667-.303-.2587-.4492-.0837-.1329-.1739-.2572-.2835-.369-.2305-.2353-.5233-.3857-.844-.429a1.4181 1.4181 0 0 0-.921.1926c-.2784.1677-.4964.426-.6203.7355-.1246.311-.1461.6508-.066.9767.038.155.0962.2984.1648.4403.0753.1564.1598.307.2437.4584l1.248 2.2543-4.8625 8.7825H2.0295c-.1676 0-.3351-.0007-.5026.0092-.1522.009-.3004.0284-.448.0714-.3108.0906-.5822.2798-.7783.548-.195.2665-.3006.5929-.3006.9279 0 .3352.1057.6612.3006.9277.196.2683.4675.4575.7782.548.1477.043.296.0623.4481.0715.1675.01.335.009.5026.009h13.0974c.0171-.0357.059-.1294.1-.2697.415-1.4151-.6156-2.843-2.0347-2.843zM3.113 18.5418l-.7922 1.5008c-.0818.1553-.1644.31-.2384.4705-.067.1458-.124.293-.1611.452-.0785.3346-.0576.6834.0645 1.0029.1212.3175.3346.583.607.7549.2727.172.5891.2416.9013.1975.3139-.044.6005-.1986.8263-.4402.1072-.1148.1954-.2424.2772-.3787.0902-.1503.1714-.3059.2535-.4612L6 19.4636c-.0896-.149-.9473-1.4704-2.887-.9218m20.5861-3.0056a1.4707 1.4707 0 0 0-.779-.5407c-.1476-.0425-.2961-.0616-.4483-.0705-.1678-.0099-.3352-.0091-.503-.0091H18.648l-4.3891-7.817c-.6655.7005-.9632 1.485-1.0773 2.1976-.1655 1.0333.0367 2.0934.546 3.0004l5.2741 9.3933c.084.1494.167.299.2591.4435.0837.131.1739.2537.2836.364.231.2323.5238.3809.8449.4232.3192.0424.643-.0244.9217-.1899.2784-.1653.4968-.4204.621-.7257.1246-.3072.146-.6425.0658-.9641-.0381-.1529-.0962-.2945-.165-.4346-.0753-.1543-.1598-.303-.2438-.4524l-1.216-2.1662h1.596c.1677 0 .3351.0009.5029-.009.1522-.009.3007-.028.4483-.0705a1.4707 1.4707 0 0 0 .779-.5407A1.5386 1.5386 0 0 0 24 16.452a1.539 1.539 0 0 0-.3009-.9158Z',
  google_play: 'M22.018 13.298l-3.919 2.218-3.515-3.493 3.543-3.521 3.891 2.202a1.49 1.49 0 0 1 0 2.594zM1.337.924a1.486 1.486 0 0 0-.112.568v21.017c0 .217.045.419.124.6l11.155-11.087L1.337.924zm12.207 10.065 3.258-3.238L3.45.195a1.466 1.466 0 0 0-.946-.179l11.04 10.973zm0 2.067-11 10.933c.298.036.612-.016.906-.183l13.324-7.54-3.23-3.21z',
};

const PROVIDER_LOGO_COLOR: Partial<Record<ProviderId, string>> = {
  github: '#181717',
  jira: '#1868DB',
  intercom: '#286EFA',
  sentry: '#362D59',
  app_store: '#0D96F6',
};

const SLACK_LOGO = [
  { fill: '#E01E5A', d: 'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z' },
  { fill: '#36C5F0', d: 'M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z' },
  { fill: '#2EB67D', d: 'M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z' },
  { fill: '#ECB22E', d: 'M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z' },
];

const GOOGLE_PLAY_LOGO = [
  { fill: '#FFCC00', d: 'M22.018 13.298l-3.919 2.218-3.515-3.493 3.543-3.521 3.891 2.202a1.49 1.49 0 0 1 0 2.594z' },
  { fill: '#00A173', d: 'M1.337.924a1.486 1.486 0 0 0-.112.568v21.017c0 .217.045.419.124.6l11.155-11.087L1.337.924z' },
  { fill: '#00A6ED', d: 'M13.544 10.989l3.258-3.238L3.45.195a1.466 1.466 0 0 0-.946-.179l11.04 10.973z' },
  { fill: '#F34A46', d: 'M13.544 13.056l-11 10.933c.298.036.612-.016.906-.183l13.324-7.54-3.23-3.21z' },
];

const GOOGLE_ANALYTICS_LOGO = [
  { fill: '#E37400', d: 'M22.84 2.9982v17.9987c.0086 1.6473-1.3197 2.9897-2.967 2.9984a2.9808 2.9808 0 0 1-.3677-.0208c-1.528-.226-2.6477-1.5558-2.6105-3.1V3.1204c-.0369-1.5458 1.0856-2.8762 2.6157-3.1 1.6361-.1915 3.1178.9796 3.3093 2.6158.014.1201.0208.241.0202.3619z' },
  { fill: '#F9AB00', d: 'M4.1326 18.0548c-1.6417 0-2.9726 1.331-2.9726 2.9726C1.16 22.6691 2.4909 24 4.1326 24s2.9726-1.3309 2.9726-2.9726-1.331-2.9726-2.9726-2.9726zM12.0054 9.045c-.0171 0-.0342 0-.0513.0003-1.6495.0904-2.9293 1.474-2.891 3.1256v7.9846c0 2.167.9535 3.4825 2.3505 3.763 1.6118.3266 3.1832-.7152 3.5098-2.327.04-.1974.06-.3983.0593-.5998v-8.9585c.003-1.6474-1.33-2.9852-2.9773-2.9882z' },
];

export function ProviderLogo({ provider, size = 20, className }: { provider: string; size?: number; className?: string }) {
  const knownProvider = provider as ProviderId;
  const path = PROVIDER_LOGO_PATH[knownProvider];
  if (!path) {
    const Icon = PROVIDER_ICON[knownProvider] ?? Activity;
    return <Icon size={size} aria-hidden className={cx(knownProvider === 'amplitude' && 'text-[#0052F2]', className)} />;
  }
  const layers = knownProvider === 'slack' ? SLACK_LOGO : knownProvider === 'google_play' ? GOOGLE_PLAY_LOGO : knownProvider === 'ga4' ? GOOGLE_ANALYTICS_LOGO : undefined;
  return (
    <svg aria-hidden focusable="false" viewBox="0 0 24 24" width={size} height={size} className={className} data-source-logo={provider}>
      {layers ? layers.map((layer) => <path key={layer.fill} fill={layer.fill} d={layer.d} />) : <path fill={PROVIDER_LOGO_COLOR[knownProvider] ?? 'currentColor'} d={path} />}
    </svg>
  );
}

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

export function ConnectionBadge({ state }: { state: ConnectionState }) {
  // One source-status vocabulary everywhere: USER IMPORT / CONNECTED / SIMULATED / NOT CONFIGURED / UNAVAILABLE / ERROR.
  return <StatusBadge kind="source" value={state} />;
}

/** Which environment a record belongs to — shown wherever records from both could appear. */
export function EnvironmentBadge({ env }: { env: 'workspace' | 'demo' }) {
  return env === 'workspace' ? (
    <Badge tone="info">Workspace</Badge>
  ) : (
    <span className="inline-flex items-center rounded border border-dashed border-high/50 px-1.5 py-px text-[12px] font-medium text-high">Demo night</span>
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
  if (level === 'CRITICAL') return 'Alert raised immediately';
  if (level === 'LOW') return 'No interruption';
  if ((interruptAt === 'MEDIUM' && level === 'MEDIUM') || level === 'HIGH') return 'Alert raised once confirmed';
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
      className={cx('inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface font-medium shadow-card hover:bg-subtle', compact ? 'h-7 px-2 text-[12px]' : 'h-8 px-2.5 text-[13px]')}
    >
      <ProviderName provider={link.provider} short />
      {tag && <span className={cx('rounded px-1 text-[12px] font-semibold', tag === 'IMPORT' ? 'bg-accent-soft text-accent' : 'bg-info-soft text-info')}>{tag}</span>}
      <ExternalLink size={11} className="text-ink-3" />
    </Link>
  );
}

/** The data status of an email's source link, as of the current workspace: IMPORT, SIM, or nothing for live. */
function EmailButtonTag({ provider, simulated }: { provider?: ProviderId; simulated: boolean }) {
  const ctx = useContext(ProductContext);
  const state = provider ? ctx?.state.connections.find((c) => c.provider === provider)?.state : undefined;
  if (state === 'imported') return <span className="rounded bg-accent-soft px-1 text-[12px] font-semibold text-accent">IMPORT</span>;
  return simulated ? <span className="rounded bg-info-soft px-1 text-[12px] font-semibold text-info">SIM</span> : null;
}

/** Renders an email the way the PM would receive it. */
export function EmailPreview({ email }: { email: EmailNotification }) {
  const s = email.sections;
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-subtle/60 px-4 py-2 text-[12px] text-ink-3">
        <Mail size={13} aria-hidden />
        {email.to ? (
          <span>
            <span className="font-medium text-ink-2">{email.from}</span> → {email.to}
          </span>
        ) : (
          <span className="font-medium text-ink-2">Alert</span>
        )}
        <span className="ml-auto">
          {fmtDate(email.sentAt)} {fmtTime(email.sentAt)} UTC · {email.trigger === 'immediate' ? 'raised immediately' : email.trigger === 'escalated' ? 'escalation' : 'raised once confirmed'}
        </span>
        {email.to && (
          <Badge tone="neutral" className="border border-dashed border-line-strong">
            Simulated · not delivered
          </Badge>
        )}
      </div>
      <div className="px-5 py-4">
        <div className="text-[16px] font-semibold tracking-tight">{email.subject}</div>
        <div className="mt-4 space-y-4 text-[14px]">
          <Section label="What changed">
            <div className="text-[16px] font-semibold">{s.whatChanged}</div>
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
                'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium',
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
