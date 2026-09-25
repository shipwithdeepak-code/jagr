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
  simulated: 'Sample data from fixtures — labelled simulated wherever it appears, never presented as live.',
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
    <section aria-label="Signal coverage" className="mb-8 rounded-lg border border-line bg-surface px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[16px] font-semibold tracking-tight">Signal coverage</h2>
        <p className="num text-[13px] text-ink-2">
          {feeding} of {views.length} evidence sources fully feeding investigations
          {partial > 0 && <span className="text-med"> · {partial} stale</span>}
          {gaps > 0 && <span className="text-high"> · {gaps} recorded as gaps</span>}
        </p>
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        {groups.map((g) => (
          <li key={g.group}>
            <a href={`#sources-${g.group}`} className="interactive inline-flex items-center gap-2 rounded text-[13px] text-ink-2 hover:text-ink">
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
 * The state is said once, in the group heading — never repeated on every row.
 */
export function SourceGroups({ views, extra, onAction }: { views: SourceView[]; extra?: (v: SourceView) => ReactNode; onAction?: (source: SourceView, action: SourceActionId) => void }) {
  return (
    <div className="space-y-8">
      {groupSources(views).map((g) => (
        <section key={g.group} id={`sources-${g.group}`} aria-labelledby={`sources-${g.group}-h`} className="scroll-mt-20">
          <div className="mb-3">
            <h2 id={`sources-${g.group}-h`} className="flex flex-wrap items-center gap-2 text-[16px] font-semibold tracking-tight">
              {SOURCE_GROUP_LABEL[g.group]} <span className="num text-[13px] font-normal text-ink-3">{g.sources.length}</span>
            </h2>
            <p className="mt-0.5 text-[13px] text-ink-2">{GROUP_HINT[g.group]}</p>
          </div>
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {g.sources.map((v) => (
              <SourceCard key={v.id} view={v} extra={extra?.(v)} onAction={onAction} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function SourceCard({ view: v, extra, onAction }: { view: SourceView; extra?: ReactNode; onAction?: (source: SourceView, action: SourceActionId) => void }) {
  const Icon = PROVIDER_ICON[v.id];
  const health = healthText(v);
  const reasonsId = useId();
  const enabled = (a: SourceView['actions'][number]) => a.available && !!onAction;
  const unavailable = v.actions.filter((a) => !enabled(a));
  const reasons = [...new Set(unavailable.map((a) => a.reason))];
  // Fixture and uploaded data have no live health to report — the group heading already says what they are.
  const live = v.group !== 'simulated' && v.group !== 'imported';
  return (
    <li className="grid min-w-0 gap-x-6 gap-y-3 px-4 py-4 sm:px-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]" aria-label={`${v.name} — ${SOURCE_GROUP_LABEL[v.group]}`}>
      <div className="flex min-w-0 items-start gap-3">
        <Icon size={16} aria-hidden className="mt-0.5 shrink-0 text-ink-3" />
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold tracking-tight">{v.name}</h3>
          <p className="text-[13px] text-ink-2">{v.roles.length ? `Provides ${v.roles.map((r) => ROLE_LABEL[r].toLowerCase()).join(', ')}` : 'Provides no evidence roles'}</p>
          {v.account && <p className="mt-0.5 text-[13px] break-words text-ink">{v.account}</p>}
        </div>
      </div>
      <div className="min-w-0">
        {live && (
          <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
            <dt className="text-ink-3">Health</dt>
            <dd className={cx('font-medium', health.tone)}>{health.text}</dd>
            {v.group === 'stale' && v.freshAsOf && (
              <>
                <dt className="text-ink-3">Data up to</dt>
                <dd className="num">{when(v.freshAsOf)}</dd>
              </>
            )}
            {v.lastCheck && (
              <>
                <dt className="text-ink-3">{v.lastCheckLabel}</dt>
                <dd className="num">{when(v.lastCheck)}</dd>
              </>
            )}
          </dl>
        )}
        {live && v.group !== 'connected' && <p className="mt-2 text-[13px] leading-snug text-ink-2">{v.impact}</p>}
        {live && v.detail && (
          <p className={cx('mt-1 text-[13px] break-words', /no deployments found|check the environment/i.test(v.detail) ? 'font-medium text-ink' : 'text-ink-3')}>
            {/no deployments found|check the environment/i.test(v.detail) && <span className="text-high">Check configuration: </span>}
            {v.detail}
          </p>
        )}
        {extra}
        {v.actions.length > 0 && (
          <div className="mt-3">
            <div className="flex flex-wrap gap-2">
              {v.actions.map((a) => (
                <Button key={a.id} size="sm" variant={a.id === 'reconnect' || a.id === 'connect' ? 'primary' : 'secondary'} disabled={!enabled(a)} aria-describedby={!enabled(a) ? reasonsId : undefined} onClick={enabled(a) ? () => onAction!(v, a.id) : undefined}>
                  {a.label}
                </Button>
              ))}
            </div>
            {reasons.length > 0 && (
              <p id={reasonsId} className="mt-2 text-[13px] leading-snug text-ink-3">
                {reasons.join(' ')}
              </p>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
