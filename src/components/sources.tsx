import { useId, type ReactNode } from 'react';
import { fmtDate, fmtTime } from '@/lib/time';
import { fmtBehind, groupSources, ROLE_LABEL, SOURCE_GROUP_LABEL, type SourceActionId, type SourceGroup, type SourceView } from '@/product/view/sources';
import { PROVIDER_ICON } from './product';
import { StatusBadge } from './primitives';
import { Button, cx } from './ui';

/** One line per group: what the state means, shown once above its sources. */
const GROUP_HINT: Record<SourceGroup, string> = {
  connected: 'Read on every scheduled check.',
  stale: 'Readable, but the data stops before the monitoring window ends. Missing records are not treated as “nothing happened”.',
  needs_reconnect: 'Configured, but without credentials. Recorded as a gap until reconnected.',
  unavailable: 'Cannot be reached. Investigations record a gap — never a clean result.',
  error: 'Answered with an error. Investigations record a gap until it is resolved.',
  not_configured: 'Not part of this workspace yet.',
  imported: 'Files you uploaded. Nothing is fetched from the source itself.',
  simulated: 'Deterministic fixture data, clearly labelled. Never presented as live.',
};

/** Health in the connections domain's vocabulary (connections/model.ts), in words a PM can act on. */
function healthText(v: SourceView): { text: string; tone: string } {
  switch (v.health) {
    case 'healthy':
      return { text: 'Healthy — credential verified', tone: 'text-ok' };
    case 'unverified':
      return { text: 'Unverified — not checked yet', tone: 'text-ink-2' };
    case 'stale':
      return { text: v.behindMinutes !== undefined ? `Stale · ${fmtBehind(v.behindMinutes)} behind` : 'Stale', tone: 'text-med' };
    case 'degraded':
      return { text: 'Degraded — gap recorded', tone: 'text-high' };
    case 'needs_reconnect':
      return { text: 'Needs reconnect — gap recorded', tone: 'text-high' };
    case 'error':
      return { text: 'Error — gap recorded', tone: 'text-crit' };
    case 'not_configured':
      return { text: 'Not in use', tone: 'text-ink-3' };
    case 'not_applicable':
      return { text: v.state === 'imported' ? 'Not applicable — imported data' : 'Not applicable — simulated data', tone: 'text-ink-2' };
  }
}

function when(iso: string) {
  return `${fmtDate(iso)} · ${fmtTime(iso)} UTC`;
}

/** At-a-glance coverage: how many sources feed investigations, and where the gaps are. */
export function SourcesOverview({ views }: { views: SourceView[] }) {
  const groups = groupSources(views);
  const feeding = views.filter((v) => v.group === 'connected' || v.group === 'imported' || v.group === 'simulated').length;
  const partial = views.filter((v) => v.group === 'stale').length;
  const gaps = views.filter((v) => v.group === 'unavailable' || v.group === 'error' || v.group === 'needs_reconnect').length;
  return (
    <section aria-label="Signal coverage" className="mb-8 rounded-xl border border-line bg-surface px-4 py-4 shadow-card sm:px-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[15px] font-semibold tracking-tight">Signal coverage</h2>
        <p className="num text-[13px] text-ink-2">
          {feeding} of {views.length} evidence sources fully feeding investigations
          {partial > 0 && <span className="text-med"> · {partial} stale</span>}
          {gaps > 0 && <span className="text-high"> · {gaps} recorded as gaps</span>}
        </p>
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        {groups.map((g) => (
          <li key={g.group}>
            <a href={`#sources-${g.group}`} className="interactive inline-flex items-center gap-2 rounded text-[12.5px] text-ink-2 hover:text-ink">
              <StatusBadge kind="source" value={g.group} />
              <span className="num font-medium text-ink">{g.sources.length}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Sources grouped by state, most actionable first. `extra` adds per-source content (e.g. simulation controls). */
/**
 * `onAction` is the seam for server workspaces (connect / test / reconnect / disconnect via the
 * connection lifecycle API). Without it every action renders disabled, with its reason.
 */
export function SourceGroups({ views, extra, onAction }: { views: SourceView[]; extra?: (v: SourceView) => ReactNode; onAction?: (source: SourceView, action: SourceActionId) => void }) {
  return (
    <div className="space-y-8">
      {groupSources(views).map((g) => (
        <section key={g.group} id={`sources-${g.group}`} aria-labelledby={`sources-${g.group}-h`} className="scroll-mt-20">
          <div className="mb-3">
            <h2 id={`sources-${g.group}-h`} className="flex items-baseline gap-2 text-[13px] font-semibold tracking-tight">
              {SOURCE_GROUP_LABEL[g.group]} <span className="num font-normal text-ink-3">{g.sources.length}</span>
            </h2>
            <p className="mt-0.5 text-[12.5px] text-ink-3">{GROUP_HINT[g.group]}</p>
          </div>
          <div className="stagger grid gap-3 md:grid-cols-2">
            {g.sources.map((v, i) => (
              <SourceCard key={v.id} view={v} index={i} extra={extra?.(v)} onAction={onAction} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function SourceCard({ view: v, extra, index = 0, onAction }: { view: SourceView; extra?: ReactNode; index?: number; onAction?: (source: SourceView, action: SourceActionId) => void }) {
  const Icon = PROVIDER_ICON[v.id];
  const health = healthText(v);
  const reasonsId = useId();
  const enabled = (a: SourceView['actions'][number]) => a.available && !!onAction;
  const unavailable = v.actions.filter((a) => !enabled(a));
  const reasons = [...new Set(unavailable.map((a) => a.reason))];
  return (
    <article className="flex min-w-0 flex-col rounded-xl border border-line bg-surface p-4 shadow-card" style={{ ['--i' as string]: index }} aria-label={`${v.name} — ${SOURCE_GROUP_LABEL[v.group]}`}>
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-subtle text-ink-2">
          <Icon size={16} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-[14px] font-semibold tracking-tight">{v.name}</h3>
            <StatusBadge kind="source" value={v.group} />
          </div>
          <p className="mt-0.5 text-[12px] text-ink-3">{v.roles.length ? `Provides ${v.roles.map((r) => ROLE_LABEL[r].toLowerCase()).join(', ')}` : 'Provides no evidence roles'}</p>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[12.5px]">
        <dt className="text-ink-3">Account</dt>
        <dd className="min-w-0 break-words text-ink">{v.account ?? (v.state === 'imported' ? 'Your uploaded files' : v.state === 'simulated' ? 'None — fixture data' : 'Not reported in this build')}</dd>
        <dt className="text-ink-3">Health</dt>
        <dd className={cx('font-medium', health.tone)}>{health.text}</dd>
        <dt className="text-ink-3">Freshness</dt>
        <dd className="num text-ink">{v.group === 'stale' && v.freshAsOf ? `Complete up to ${when(v.freshAsOf)}` : v.group === 'connected' || v.group === 'imported' || v.group === 'simulated' ? 'Current for the monitoring window' : '—'}</dd>
        {v.lastCheck && (
          <>
            <dt className="text-ink-3">{v.lastCheckLabel}</dt>
            <dd className="num text-ink">{when(v.lastCheck)}</dd>
          </>
        )}
      </dl>

      <p className={cx('mt-3 text-[12.5px] leading-snug', v.group === 'stale' ? 'text-ink' : 'text-ink-2')}>{v.impact}</p>
      {v.detail && v.group !== 'simulated' && <p className="mt-1 text-[12px] break-words text-ink-3">{v.detail}</p>}

      {extra}

      {v.actions.length > 0 && (
        <div className="mt-auto pt-3">
          <div className="flex flex-wrap gap-2 border-t border-line pt-3">
            {v.actions.map((a) => (
              <Button key={a.id} size="sm" variant={a.id === 'reconnect' || a.id === 'connect' ? 'primary' : 'secondary'} disabled={!enabled(a)} aria-describedby={!enabled(a) ? reasonsId : undefined} onClick={enabled(a) ? () => onAction!(v, a.id) : undefined}>
                {a.label}
              </Button>
            ))}
          </div>
          {reasons.length > 0 && (
            <p id={reasonsId} className="mt-2 text-[11.5px] leading-snug text-ink-3">
              {reasons.join(' ')}
            </p>
          )}
        </div>
      )}
    </article>
  );
}
