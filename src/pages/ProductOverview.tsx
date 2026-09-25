import { signalMeta } from '@/product/catalog';
import { nativeMetricSignal } from '@/product/integrations/bridge';
import { ArrowRight, Plus, Radar, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useProduct } from '@/state/productContext';
import { useShellActions } from '@/components/shell';
import { FREQUENCY_LABEL, nextRunAt } from '@/product/scheduler';
import { fmtDate, fmtRelativeMinutes, fmtTime, minutesBetween } from '@/lib/time';
import { PROVIDERS } from '@/product/integrations/adapters';
import { pendingApprovals } from '@/product/agent/decisions';
import { Button, cx } from '@/components/ui';
import { EmptyPanel, LinkArrow, MetricValue, SectionHeader, StatusBadge } from '@/components/primitives';
import { headlineOf, readingOf } from '@/product/presentation';
import { GettingStarted, TryYourOwnData, Welcome, WorkspaceDataBadge } from '@/components/onboarding';

export function ProductOverviewPage() {
  const { state, runMonitoring, running, mode, storageError, clearWorkspace, importedWorld } = useProduct();
  const { requestDemo } = useShellActions();
  const r = state.result;
  const activeWatches = state.watches.filter((w) => w.status === 'active');
  const next = activeWatches
    .map((w) => ({ w, at: nextRunAt(w, state.clock, r?.window.start ?? '2026-09-23T18:00:00.000Z') }))
    .filter((x): x is { w: (typeof activeWatches)[number]; at: string } => !!x.at)
    .sort((a, b) => a.at.localeCompare(b.at));
  const open = (r?.investigations ?? []).filter((i) => i.status !== 'DISMISSED' && i.attention !== 'LOW');
  const attention = [...open].sort((a, b) => ATTENTION_ORDER.indexOf(a.attention) - ATTENTION_ORDER.indexOf(b.attention));
  const recent = [...(r?.investigations ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const waiting = pendingApprovals(r?.investigations ?? [], state.decisions);
  // Signals Jagr actually evaluates: releases are context, and imported data may lack some metrics.
  const importedMetrics = mode === 'imported' ? new Set<string>(importedWorld?.world?.metrics.map(nativeMetricSignal) ?? []) : undefined;
  const signals = new Set(
    activeWatches.flatMap((w) => w.signals.filter((s) => s.key !== 'changes' && (!importedMetrics || signalMeta(s.key).kind !== 'metric' || importedMetrics.has(s.key))).map((s) => s.key)),
  ).size;
  const hour = new Date(state.clock).getUTCHours();
  const greeting = hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';

  if (!mode) return <Welcome />;

  return (
    <div className="animate-fade-up">
      {storageError && <div className="mb-4 rounded-xl border border-crit/40 bg-crit-soft/60 px-4 py-3 text-[13px] text-ink">{storageError}</div>}
      {mode === 'imported' && <GettingStarted />}

      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
            <span className="num">
              {fmtDate(state.clock)} · {fmtTime(state.clock)} UTC
            </span>
            <WorkspaceDataBadge />
            <button
              className="interactive rounded text-ink-3 underline-offset-2 hover:text-ink hover:underline"
              onClick={() => {
                if (window.confirm('Start over? This deletes this browser’s workspace, including any imported data.')) clearWorkspace();
              }}
            >
              Start over
            </button>
          </div>
          <h1 className="mt-2 text-[28px] font-semibold tracking-[-0.025em] sm:text-[32px]">{greeting}</h1>
          <p className="mt-1 text-[14.5px] text-ink-2">
            {running
              ? 'Jagr is investigating…'
              : !r
                ? mode === 'imported'
                  ? 'Jagr needs a watch and product evidence before it can investigate changes.'
                  : 'Jagr is ready.'
                : attention.length
                  ? `${attention.length} ${attention.length === 1 ? 'thing needs' : 'things need'} your attention.`
                  : 'Nothing needs your attention.'}{' '}
            {activeWatches.length > 0 && (
              <span className="text-ink-3">
                Watching {signals} signal{signals === 1 ? '' : 's'} across {activeWatches.length} watch{activeWatches.length === 1 ? '' : 'es'}.
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" icon={RefreshCw} onClick={() => void runMonitoring().catch(() => undefined)} disabled={running || (mode === 'imported' && !state.watches.length)}>
            {running ? 'Running…' : 'Run monitoring'}
          </Button>
          <Link to="/watches?new=1" className="interactive inline-flex h-8.5 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium hover:bg-subtle">
            <Plus size={14} /> Create watch
          </Link>
          {mode === 'sample' && <TryYourOwnData />}
        </div>
      </header>

      {state.stale && r && (
        <p className="mb-6 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
          <span className="size-1.5 rounded-full bg-high" aria-hidden />
          Watches or sources changed since the last run — results below reflect the previous configuration.
          <button className="interactive font-medium text-accent hover:underline" onClick={() => void runMonitoring().catch(() => undefined)} disabled={running}>
            Re-run
          </button>
        </p>
      )}

      {/* 1 · What needs my attention — and what to do next */}
      <section className="mb-10">
        <SectionHeader title="Needs your attention" count={attention.length} hint="Investigations, not raw metrics — each one correlates every source Jagr could check." />
        {!r ? (
          <EmptyPanel title="No investigations yet" why={mode === 'imported' ? 'Jagr needs a watch and product evidence before it can investigate changes.' : 'Run monitoring to see what changed.'} action={mode === 'imported' && !state.watches.length ? <Link to="/watches?new=1"><LinkArrow>Create your first watch</LinkArrow></Link> : undefined} />
        ) : attention.length === 0 ? (
          <p className="rounded-xl border border-line bg-surface px-4 py-5 text-[13.5px] text-ink-2">Nothing needs your attention. Jagr checked {activeWatches.length} watch{activeWatches.length === 1 ? '' : 'es'} and found no meaningful change that persisted.</p>
        ) : (
          <ul className="stagger divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {attention.map((inv, i) => {
              const reading = readingOf(inv);
              return (
                <li key={inv.id} style={{ ['--i' as string]: i }}>
                  <Link to={inv.jagrPath} className="interactive group grid gap-x-4 gap-y-1 px-4 py-4 hover:bg-subtle/60 sm:grid-cols-[88px_1fr_auto] sm:px-5">
                    <span className="pt-0.5">
                      <StatusBadge kind="attention" value={inv.attention} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[15px] font-semibold tracking-tight">{headlineOf(inv)}</span>
                      {reading && (
                        <span className="mt-0.5 block">
                          <MetricValue baseline={reading.baseline} current={reading.current} />
                        </span>
                      )}
                      <span className="mt-1 block text-[12.5px] text-ink-2">
                        <span className="text-ink-3">Next:</span> {inv.recommendedNextStep}
                      </span>
                    </span>
                    <span className="flex items-center gap-2 self-center text-[12px] text-ink-3">
                      {inv.actions.some((a) => waiting.some((w) => w.id === a.id)) && <span className="font-medium text-high">Approval waiting</span>}
                      <span className="num">{fmtTime(inv.signals[0].onsetAt)}</span>
                      <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-2">
        {/* 2 · What is Jagr watching */}
        <section>
          <SectionHeader title="Watch health" action={<Link to="/watches" className="text-[12.5px] font-medium text-accent hover:underline">All watches</Link>} />
          {state.watches.length === 0 ? (
            <EmptyPanel title="Create your first watch" why="A watch is a standing question — “Is checkout healthy?” — that Jagr answers over your data." action={<Link to="/watches?new=1"><LinkArrow>Create watch</LinkArrow></Link>} />
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {state.watches.map((w) => {
                const top = open.find((i) => i.watchIds.includes(w.id));
                const health = w.status === 'paused' ? { label: 'Paused', cls: 'bg-line-strong' } : top ? { label: 'Needs attention', cls: top.attention === 'HIGH' || top.attention === 'CRITICAL' ? 'bg-high' : 'bg-med' } : r ? { label: 'Healthy', cls: 'bg-ok' } : { label: 'Not run yet', cls: 'bg-line-strong' };
                const n = next.find((x) => x.w.id === w.id);
                return (
                  <li key={w.id} className="flex items-center gap-3 px-4 py-3">
                    <span aria-hidden className={cx('size-2 shrink-0 rounded-full', health.cls)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium">{w.name}</span>
                      <span className="block text-[12px] text-ink-3">
                        {health.label} · {FREQUENCY_LABEL[w.schedule.frequency].toLowerCase()} · interrupts at {w.notificationPolicy.interruptAt}
                      </span>
                    </span>
                    {n && (
                      <span className="num shrink-0 text-right text-[12px] text-ink-3">
                        next {fmtTime(n.at)}
                        <span className="block">in {fmtRelativeMinutes(minutesBetween(state.clock, n.at))}</span>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
            {state.connections
              // With imported data, channels the upload model has no slot for (e.g. Play Store) aren't the user's concern.
              .filter((c) => c.provider !== 'email' && !(mode === 'imported' && c.state === 'not_configured' && !c.label))
              .map((c) => (
                <span key={c.provider} className="inline-flex items-center gap-1.5">
                  {c.label?.short ?? PROVIDERS[c.provider].short} <StatusBadge kind="source" value={c.state} />
                </span>
              ))}
            <Link to="/sources" className="ml-auto font-medium text-accent hover:underline">
              Sources
            </Link>
          </div>
        </section>

        {/* 3 · What changed recently */}
        <section>
          <SectionHeader title="Recent investigations" action={<Link to="/investigations" className="text-[12.5px] font-medium text-accent hover:underline">All</Link>} />
          {recent.length === 0 ? (
            <EmptyPanel title="Nothing investigated yet" why="When a watch sees a meaningful change, Jagr opens an investigation here." />
          ) : (
            <ol className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {recent.slice(0, 6).map((inv) => (
                <li key={inv.id}>
                  <Link to={inv.jagrPath} className="interactive flex items-center gap-3 px-4 py-3 hover:bg-subtle/60">
                    <span className="num w-11 shrink-0 font-mono text-[12px] text-ink-3">{fmtTime(inv.startedAt)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium">{headlineOf(inv)}</span>
                      <span className="block text-[12px] text-ink-3">{inv.status.charAt(0) + inv.status.slice(1).toLowerCase()}</span>
                    </span>
                    <StatusBadge kind="attention" value={inv.attention} />
                  </Link>
                </li>
              ))}
            </ol>
          )}
          {r && (
            <p className="num mt-3 text-[12px] text-ink-3">
              {fmtTime(r.window.start)} → {fmtTime(r.window.end)} · {r.log.filter((l) => l.type === 'watch_run').length} watch runs · {r.emails.length} email{r.emails.length === 1 ? '' : 's'} ·{' '}
              <Link to="/briefs" className="font-medium text-accent hover:underline">
                Brief
              </Link>
            </p>
          )}
        </section>
      </div>

      <p className="mt-12 flex flex-wrap items-center gap-2 border-t border-line pt-4 text-[12.5px] text-ink-3">
        <Radar size={13} /> New to Jagr? <Link to="/demo" className="font-medium text-ink-2 hover:text-ink hover:underline">Watch Demo night</Link> — a 30-second scripted replay, separate from your workspace.
        <button className="interactive font-medium text-ink-2 hover:text-ink hover:underline" onClick={requestDemo}>
          Reset &amp; replay
        </button>
      </p>
    </div>
  );
}

const ATTENTION_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
