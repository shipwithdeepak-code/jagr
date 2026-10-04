import { ManualCheckStatus } from '@/components/executionStatus';
import { executionStatusText } from '@/product/view/executionStatus';
import { signalMeta } from '@/product/catalog';
import { nativeMetricSignal } from '@/product/integrations/bridge';
import { ArrowRight, Plus, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useProduct } from '@/state/productContext';
import { FREQUENCY_LABEL } from '@/product/scheduler';
import { fmtDateTime, fmtTime } from '@/lib/time';
import { PROVIDERS } from '@/product/integrations/adapters';
import { pendingApprovals } from '@/product/agent/decisions';
import { Button, cx } from '@/components/ui';
import { EmptyPanel, LinkArrow, LoadingState, MetricValue, SectionHeader, StatusBadge } from '@/components/primitives';
import { readingOf } from '@/product/presentation';
import { findingState, investigationTitle, labelledTime } from '@/product/view/investigation';
import { watchCardStatus } from '@/product/view/watchCard';
import { hasRunnableConnectedWatch, hasRunnableProductWatch, runHasEvidenceGap } from '@/product/view/quickStart';
import { ConnectedWorkspaceFirstRun, GettingStarted, TryYourOwnData, WorkspaceDataBadge } from '@/components/onboarding';
import type { ProviderId, WatchInvestigation } from '@/product/types';

/**
 * The Overview answers one question — what needs my attention? — then, in order: how the watches
 * are doing, what closed recently, and whether the sources are healthy. Quiet is a result, stated
 * plainly with when Jagr last checked.
 */
export function ProductOverviewPage() {
  const { state, runMonitoring, running, mode, storageError, clearWorkspace, importedWorld, location, server } = useProduct();
  const r = state.result;
  const activeWatches = state.watches.filter((w) => w.status === 'active');
  const canRun = location === 'server' && mode === 'connected' && server
    ? !server.loading && hasRunnableConnectedWatch({ connections: server.connections, watches: state.watches })
    : hasRunnableProductWatch({ productConnections: state.connections, watches: state.watches });
  const open = (r?.investigations ?? []).filter((i) => i.status !== 'DISMISSED' && i.status !== 'RESOLVED' && i.attention !== 'LOW');
  const attention = [...open].sort((a, b) => ATTENTION_ORDER.indexOf(a.attention) - ATTENTION_ORDER.indexOf(b.attention));
  const closed = [...(r?.investigations ?? [])].filter((i) => !open.includes(i)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const waiting = pendingApprovals(r?.investigations ?? [], state.decisions);
  // Signals Jagr actually evaluates: releases are context, and imported data may lack some metrics.
  const importedMetrics = mode === 'imported' ? new Set<string>(importedWorld?.world?.metrics.map(nativeMetricSignal) ?? []) : undefined;
  const signals = new Set(
    activeWatches.flatMap((w) => w.signals.filter((s) => s.key !== 'changes' && (!importedMetrics || signalMeta(s.key).kind !== 'metric' || importedMetrics.has(s.key))).map((s) => s.key)),
  ).size;
  const cards = state.watches.map((w) => ({ w, card: watchCardStatus(w, { location, result: r, clock: state.clock, snapshotAt: server?.snapshotAt }) }));
  // When Jagr last looked: the latest recorded run (server), or the end of the replayed window (browser).
  const lastChecked = location === 'server' ? cards.flatMap((c) => c.card.runs.map((l) => l.scheduledAt)).sort().at(-1) : r?.window.end;
  const healthy = cards.filter(({ w }) => w.status === 'active' && !open.some((i) => i.watchIds.includes(w.id))).length;
  const latestRun = cards.flatMap(({ card }) => card.runs).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).at(-1);
  const nextRun = cards.flatMap(({ card }) => card.nextRun ?? []).sort()[0];
  const latestWatch = latestRun ? state.watches.find((w) => w.id === latestRun.watchId) : undefined;

  // The workspace gate (App) covers restoring and choosing; this shows only if a server workspace's data is unavailable.
  if (!mode) return <LoadingState label={server ? `Loading ${server.name}…` : 'Loading…'} />;

  const headline = running ? (location === 'server' ? 'Requesting checks…' : 'Jagr is checking your watches…') : !r ? (mode === 'imported' && !state.watches.length ? 'Create a watch to start monitoring' : 'Jagr is ready') : attention.length ? `${attention.length} ${attention.length === 1 ? 'investigation needs' : 'investigations need'} your attention` : location === 'server' ? 'No investigations currently need your attention' : 'Nothing needs your attention';

  return (
    <div className="animate-fade-up">
      {storageError && <div className="mb-4 rounded-lg border border-crit/40 bg-crit-soft/60 px-4 py-3 text-[13px] text-ink">{storageError}</div>}
      {mode === 'imported' && <GettingStarted />}
      {mode === 'connected' && location === 'server' && <ConnectedWorkspaceFirstRun />}

      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[28px] font-semibold tracking-[-0.02em] text-balance">{headline}</h1>
          <p className="num mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-2">
            {lastChecked && <span>Last checked {fmtDateTime(lastChecked)} UTC</span>}
            {lastChecked && <span aria-hidden className="text-ink-3">·</span>}
            <span>
              {activeWatches.length} active watch{activeWatches.length === 1 ? '' : 'es'} · {signals} signal{signals === 1 ? '' : 's'}
            </span>
            <WorkspaceDataBadge />
            {location === 'browser' && (
              <button
                className="interactive rounded text-ink-3 underline-offset-2 hover:text-ink hover:underline"
                onClick={() => {
                  if (window.confirm('Start over? This deletes this browser’s workspace, including any imported data.')) clearWorkspace();
                }}
              >
                Start over
              </button>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button icon={RefreshCw} onClick={() => void runMonitoring().catch(() => undefined)} disabled={running || !canRun}>
            {running ? 'Running…' : 'Run now'}
          </Button>
          <Link to="/watches?new=1" className="interactive inline-flex h-8.5 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium hover:bg-subtle">
            <Plus size={14} aria-hidden /> Create watch
          </Link>
          {mode === 'sample' && <TryYourOwnData />}
        </div>
      </header>

      <ManualCheckStatus />
      {state.stale && r && (
        <p className="mb-6 flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
          <span className="size-1.5 rounded-full bg-high" aria-hidden />
          Watches or sources changed since the last run — results below reflect the previous configuration.
          <button className="interactive font-medium text-accent hover:underline" onClick={() => void runMonitoring().catch(() => undefined)} disabled={running}>
            Re-run
          </button>
        </p>
      )}

      {/* 1 · What needs my attention — and what to do next */}
      <section className="mb-10" aria-labelledby="attention-h">
        <SectionHeader title={<span id="attention-h">Needs your attention</span>} count={r ? attention.length : undefined} />
        {!r ? (
          <EmptyPanel title="No investigations yet" why={mode === 'imported' ? 'Jagr needs a watch and product evidence before it can investigate changes.' : location === 'server' ? 'Watches run on their schedule. Run now to request a check for every active watch.' : 'Run monitoring to see what changed.'} action={mode === 'imported' && !state.watches.length ? <Link to="/watches?new=1"><LinkArrow>Create your first watch</LinkArrow></Link> : undefined} />
        ) : attention.length === 0 ? (
          <div className="rounded-lg border border-line bg-surface px-4 py-4">
            <p className="text-[14px] text-ink">{location === 'server' ? 'No investigations currently need your attention.' : 'Nothing needs your attention.'}</p>
            <p className="num mt-0.5 text-[13px] text-ink-2">
              {lastChecked ? `Last checked ${fmtTime(lastChecked)} UTC · ` : ''}
              {location === 'server' ? 'Check results appear in requested checks and investigations' : `${healthy} of ${activeWatches.length} watches healthy`}
            </p>
            {location === 'server' && latestRun && !(r?.investigations.length) && (
              <p className="mt-2 text-[13px] text-ink-2">
                {runHasEvidenceGap(latestRun.outcome) ? `Recorded watch outcome with an evidence gap: ${latestRun.outcome}. No conclusion was drawn from the unavailable source.` : `Recorded watch outcome: ${latestRun.outcome}. Use requested check status for its execution result.`}
                {nextRun ? ` Next scheduled check: ${fmtDateTime(nextRun)} UTC.` : ''}
                {latestWatch ? ` ${latestWatch.name} will interrupt at ${latestWatch.notificationPolicy.interruptAt} and above; CRITICAL is immediate and other qualifying findings wait for confirmation.` : ''}
              </p>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {attention.map((inv) => (
              <AttentionRow key={inv.id} inv={inv} approval={inv.actions.some((a) => waiting.some((w) => w.id === a.id))} />
            ))}
          </ul>
        )}
      </section>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-2">
        {/* 2 · How the watches are doing */}
        <section aria-labelledby="watches-h">
          <SectionHeader title={<span id="watches-h">Watches</span>} action={<Link to="/watches" className="text-[13px] font-medium text-accent hover:underline">All watches</Link>} />
          {state.watches.length === 0 ? (
            <EmptyPanel title="No active watches yet" why="Tell Jagr what matters to your product. Connect your product sources and create your first watch. Jagr will check for meaningful changes and investigate when something needs attention." action={<div className="flex flex-wrap gap-4"><Link to="/watches?new=1"><LinkArrow>Set up my first watch</LinkArrow></Link><Link to="/demo"><LinkArrow>See how Jagr works</LinkArrow></Link></div>} />
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
              {cards.map(({ w, card }) => {
                const top = open.find((i) => i.watchIds.includes(w.id));
                const ran = location === 'server' ? !!card.lastRun : !!r;
                const execution = Object.values(server?.executionStatuses ?? {}).find((entry) => entry?.watchId === w.id);
                const health = location === 'server' && execution ? { label: executionStatusText(execution), cls: execution.publicStatus === 'quiet' ? 'bg-ok' : 'bg-line-strong' } : w.status === 'paused' ? { label: 'Paused', cls: 'bg-line-strong' } : top ? { label: 'Needs attention', cls: top.attention === 'HIGH' || top.attention === 'CRITICAL' ? 'bg-high' : 'bg-med' } : ran ? { label: location === 'server' ? 'Check result unavailable' : 'Healthy', cls: location === 'server' ? 'bg-line-strong' : 'bg-ok' } : { label: 'Not run yet', cls: 'bg-line-strong' };
                return (
                  <li key={w.id} className="flex items-center gap-3 px-4 py-3">
                    <span aria-hidden className={cx('size-2 shrink-0 rounded-full', health.cls)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium">{w.name}</span>
                      <span className="block text-[13px] text-ink-2">
                        {health.label} · {FREQUENCY_LABEL[w.schedule.frequency].toLowerCase()}
                      </span>
                    </span>
                    {card.nextRun && <span className="num shrink-0 text-right text-[13px] text-ink-3">Next {fmtTime(card.nextRun)} UTC</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* 3 · What closed, 4 · whether the sources are healthy */}
        <div className="space-y-10">
          {closed.length > 0 && (
            <section aria-labelledby="closed-h">
              <SectionHeader title={<span id="closed-h">Recently closed</span>} action={<Link to="/investigations?status=all" className="text-[13px] font-medium text-accent hover:underline">All investigations</Link>} />
              <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
                {closed.slice(0, 5).map((inv) => (
                  <li key={inv.id}>
                    <Link to={inv.jagrPath} className="interactive flex items-center gap-3 px-4 py-3 hover:bg-subtle/60">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-medium">{investigationTitle(inv)}</span>
                        <span className="num block text-[13px] text-ink-2">
                          {findingState(inv).signal} · {labelledTime('updated', inv.updatedAt)}
                        </span>
                      </span>
                      <StatusBadge kind="attention" value={inv.attention} />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section aria-labelledby="sources-h">
            <SectionHeader title={<span id="sources-h">Sources</span>} action={<Link to="/sources" className="text-[13px] font-medium text-accent hover:underline">Manage</Link>} />
            <SourceHealth />
          </section>
        </div>
      </div>
    </div>
  );
}

function AttentionRow({ inv, approval }: { inv: WatchInvestigation; approval: boolean }) {
  const reading = readingOf(inv);
  const status = findingState(inv);
  const detected = inv.statusHistory.find((h) => h.state === 'DETECTED')?.at ?? inv.startedAt;
  const sources = [...new Set(inv.correlatedProviders.length ? inv.correlatedProviders : [inv.signals[0].provider])];
  return (
    <li>
      <Link to={inv.jagrPath} className="interactive group grid gap-x-4 gap-y-1 px-4 py-4 hover:bg-subtle/60 sm:grid-cols-[88px_1fr_auto] sm:px-5">
        <span className="pt-0.5">
          <StatusBadge kind="attention" value={inv.attention} />
        </span>
        <span className="min-w-0">
          <span className="block text-[16px] font-semibold tracking-tight">{investigationTitle(inv)}</span>
          {reading && (
            <span className="mt-0.5 block">
              <MetricValue baseline={reading.baseline} current={reading.current} />
            </span>
          )}
          <span className="num mt-1 block text-[13px] text-ink-2">
            {labelledTime('Detected', detected)} · {sources.map((p) => PROVIDERS[p as ProviderId]?.short ?? p).join(' + ')} · {status.cause}
          </span>
          <span className="mt-1 block text-[13px] text-ink-2">
            <span className="text-ink-3">Next:</span> {inv.recommendedNextStep}
          </span>
        </span>
        <span className="flex items-center gap-2 self-center text-[13px] text-ink-3">
          {approval && <span className="font-medium text-ink">Approval waiting</span>}
          <ArrowRight size={14} aria-hidden className="transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
        </span>
      </Link>
    </li>
  );
}

/** One line per source with one state. Sample and imported data are said once, not per source. */
function SourceHealth() {
  const { state, mode, location, server } = useProduct();
  if (location === 'server') {
    const sources = (server?.connections ?? []).filter((c) => c.kind === 'source');
    if (!sources.length) return <EmptyPanel title="No sources connected" why="Connect GitHub, Jira, analytics or feedback so Jagr has something to watch." action={<Link to="/sources"><LinkArrow>Connect a source</LinkArrow></Link>} />;
    return (
      <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
        {sources.map((c) => (
          <li key={c.id} className="flex items-center gap-3 px-4 py-2.5 text-[14px]">
            <span className="min-w-0 flex-1 truncate font-medium">{c.displayName}</span>
            <span className="text-[13px] text-ink-2">{c.health === 'healthy' ? 'Healthy' : c.health.replace('_', ' ').replace(/^./, (x) => x.toUpperCase())}</span>
          </li>
        ))}
      </ul>
    );
  }
  const used = state.connections.filter((c) => c.provider !== 'email' && !(mode === 'imported' && c.state === 'not_configured' && !c.label));
  const readable = used.filter((c) => c.state === 'simulated' || c.state === 'imported' || c.state === 'connected');
  const down = used.filter((c) => !readable.includes(c));
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3 text-[14px]">
      <p>
        {readable.map((c) => c.label?.short ?? PROVIDERS[c.provider].short).join(', ')}
        <span className="text-ink-2"> — {mode === 'imported' ? 'your imported data' : 'sample data (simulated)'}</span>
      </p>
      {down.length > 0 && <p className="mt-1 text-[13px] text-ink-2">Not available: {down.map((c) => c.label?.short ?? PROVIDERS[c.provider].short).join(', ')} — recorded as gaps in investigations.</p>}
    </div>
  );
}
const ATTENTION_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
