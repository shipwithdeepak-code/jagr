import { ArrowRight, Bell, Inbox, Moon, RefreshCw } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import type { MorningBriefDoc } from '@/product/types';
import { useProduct } from '@/state/productContext';
import { fmtDate, fmtTime } from '@/lib/time';
import { AttentionBadge, EmailPreview } from '@/components/product';
import { Button, Card, cx, EmptyState, PageHeader, Tabs } from '@/components/ui';
import { investigationTitle } from '@/product/view/investigation';
import { AttentionBanner, LoadingState, StatusBadge } from '@/components/primitives';
import { briefView } from '@/product/view/brief';
import { PROVIDERS } from '@/product/integrations/adapters';
import { nativeMetricSignal } from '@/product/integrations/bridge';

export function BriefsPage() {
  const { state, running, runMonitoring, mode } = useProduct();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as 'briefs' | 'alerts') ?? 'briefs';
  const r = state.result;
  const emails = r?.emails ?? [];
  const selected = emails.find((e) => e.id === params.get('alert')) ?? emails[0];
  const briefs = [...(r?.briefs ?? [])].reverse();
  const brief = briefs.find((b) => b.id === params.get('brief')) ?? briefs[0];

  return (
    <>
      <PageHeader
        title="Briefs"
        description="What Jagr found in each monitoring window — investigations, not metrics — and what stayed quiet. Alerts that could not wait are listed separately."
        actions={
          <Tabs
            value={tab}
            onChange={(v) => setParams(v === 'briefs' ? {} : { tab: v })}
            items={[
              { value: 'briefs', label: 'Briefs' },
              { value: 'alerts', label: `Alerts sent (${emails.length})` },
            ]}
          />
        }
      />

      {tab === 'briefs' ? (
        <div className="grid gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
          <nav aria-label="Brief history" className="lg:sticky lg:top-20 lg:self-start">
            {briefs.length > 0 && (
              <ol className="flex gap-1 overflow-x-auto lg:flex-col">
                {briefs.map((b) => (
                  <li key={b.id} className="shrink-0">
                    <button
                      onClick={() => setParams({ brief: b.id })}
                      aria-current={b.id === brief?.id ? 'true' : undefined}
                      className={cx('interactive w-full rounded-lg px-3 py-2 text-left text-[13px]', b.id === brief?.id ? 'bg-subtle font-medium text-ink' : 'text-ink-2 hover:bg-subtle')}
                    >
                      <span className="num block">{fmtDate(b.generatedAt)}</span>
                      <span className="num block text-[12px] text-ink-3">{fmtTime(b.generatedAt)} UTC</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-3 hidden text-[13px] text-ink-3 lg:block">
              {state.brief.enabled ? `Daily at ${state.brief.time} ${state.brief.timezone}.` : 'The morning brief is off.'}{' '}
              <Link to="/settings#monitoring" className="text-accent hover:underline">
                Change
              </Link>
            </p>
          </nav>
          <div className="min-w-0">
            {brief ? (
              <BriefDocument brief={brief} />
            ) : running ? (
              <LoadingState label="Jagr is monitoring — the brief is written when the run finishes." />
            ) : (
              <EmptyState
                icon={Moon}
                title="No brief yet"
                action={
                  mode && (mode !== 'imported' || state.watches.length > 0) ? (
                    <Button variant="primary" icon={RefreshCw} onClick={() => void runMonitoring()}>
                      Run monitoring
                    </Button>
                  ) : (
                    <Link to="/watches?new=1" className="inline-flex h-8.5 items-center rounded-lg bg-ink px-3 text-[13px] font-medium text-canvas">
                      Create a watch
                    </Link>
                  )
                }
              >
                The brief is written at {state.brief.time} {state.brief.timezone}, after monitoring runs. It lists what needs your attention — and what stayed quiet.
              </EmptyState>
            )}
          </div>
        </div>
      ) : emails.length === 0 ? (
        <EmptyState icon={Inbox} title="No alerts sent">
          Jagr only alerts you when something matters: HIGH findings once confirmed, CRITICAL immediately. Everything else waits for the brief.
        </EmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
          <Card padded={false} className="h-fit overflow-hidden">
            {emails.map((e) => (
              <button key={e.id} onClick={() => setParams({ tab: 'alerts', alert: e.id })} aria-current={selected?.id === e.id ? 'true' : undefined} className={cx('flex w-full flex-col gap-1 border-b border-line px-4 py-3 text-left last:border-b-0 hover:bg-subtle', selected?.id === e.id && 'bg-subtle')}>
                <span className="num flex items-center gap-2 text-[12px] text-ink-3">
                  <Bell size={12} aria-hidden /> {fmtDate(e.sentAt)} {fmtTime(e.sentAt)} UTC {e.attention && <AttentionBadge level={e.attention} className="ml-auto" />}
                </span>
                <span className="text-[13px] font-medium">{e.subject}</span>
              </button>
            ))}
          </Card>
          {selected && <EmailPreview email={selected} />}
        </div>
      )}
    </>
  );
}

/** The morning brief, as a PM reads it: what needs attention, then what stayed quiet. */
export function BriefDocument({ brief, compact = false }: { brief: MorningBriefDoc; compact?: boolean }) {
  const { state, mode, importedWorld } = useProduct();
  const importedMetrics = mode === 'imported' ? new Set<string>(importedWorld?.world?.metrics.map(nativeMetricSignal) ?? []) : undefined;
  const view = briefView(brief, {
    investigations: state.result?.investigations ?? [],
    watches: state.watches,
    decisions: state.decisions,
    evaluable: importedMetrics ? (key) => !key.startsWith('metric:') || importedMetrics.has(key) : undefined,
  });
  // The engine records links by its internal title; readers see the canonical one.
  const linkedTitle = (t: string) => {
    const inv = (state.result?.investigations ?? []).find((i) => i.title === t);
    return inv ? investigationTitle(inv) : t;
  };
  return (
    <article aria-label={`Morning brief, ${fmtDate(view.generatedAt)}`} className={cx('rounded-lg border border-line bg-surface', compact ? 'p-4' : 'px-5 py-6 sm:px-8 sm:py-8')}>
      <p className="num text-[13px] text-ink-3">
        {fmtDate(view.generatedAt)} · {fmtTime(view.generatedAt)} UTC · covers {fmtTime(view.window.start)}–{fmtTime(view.window.end)} UTC
      </p>
      {!compact && <h2 className="mt-3 text-[28px] leading-tight font-semibold tracking-[-0.02em]">Good morning.</h2>}
      <p className={cx('text-ink-2', compact ? 'mt-1 text-[16px] font-medium text-ink' : 'mt-1.5 text-[20px]')}>{view.headline}</p>

      {view.items.length > 0 && (
        <ol className={cx('stagger space-y-4', compact ? 'mt-4' : 'mt-7')}>
          {view.items.map((it, i) => (
            <li key={it.investigationId} style={{ ['--i' as string]: i }}>
              <AttentionBanner level={it.attention}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-ink-3">
                  <StatusBadge kind="attention" value={it.attention} size="md" />
                  <span>{it.watchNames.join(' + ')}</span>
                  <span>{it.emailedAt ? `Alert sent ${fmtTime(it.emailedAt)} UTC` : 'New in this brief'}</span>
                </div>
                <h3 className="mt-2.5 text-[20px] leading-snug font-semibold tracking-[-0.01em]">{it.headline}</h3>
                {!compact && (
                  <dl className="mt-4 grid gap-x-6 gap-y-3 text-[14px] sm:grid-cols-[130px_minmax(0,1fr)]">
                    <dt className="font-medium text-ink-3">What changed</dt>
                    <dd className="text-ink">{it.whatChanged}</dd>
                    <dt className="font-medium text-ink-3">What Jagr found</dt>
                    <dd>
                      {it.found.length ? (
                        <ul className="space-y-1 text-ink">
                          {it.found.map((f) => (
                            <li key={f}>{f}</li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-ink-2">Nothing in other sources corroborates it yet.</span>
                      )}
                    </dd>
                    <dt className="font-medium text-ink-3">Not known</dt>
                    <dd className="text-ink-2 italic">{it.uncertainty}</dd>
                    <dt className="font-medium text-ink-3">Next step</dt>
                    <dd className="font-medium text-ink">{it.next}</dd>
                  </dl>
                )}
                <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <Link to={`/investigations/w/${it.investigationId}`} className="interactive inline-flex items-center gap-1 text-[13px] font-medium text-ink hover:underline">
                    Open investigation <ArrowRight size={13} aria-hidden />
                  </Link>
                  {it.approvalsWaiting > 0 && (
                    <Link to={`/investigations/w/${it.investigationId}#what-to-do`} className="interactive text-[13px] font-medium text-ink hover:underline">
                      {it.approvalsWaiting} approval{it.approvalsWaiting === 1 ? '' : 's'} waiting
                    </Link>
                  )}
                </div>
              </AttentionBanner>
            </li>
          ))}
        </ol>
      )}

      {(view.shipped.length > 0 || view.shippedUnavailable.length > 0) && (
        <section aria-label="Changes shipped" className={cx('rounded-lg border border-line px-4 py-4', compact ? 'mt-4' : 'mt-6')}>
          <h3 className="text-[14px] font-semibold">Changes shipped</h3>
          <p className="text-[13px] text-ink-3">Context, not findings — a change listed here is not evidence that it caused anything.</p>
          {view.shipped.length > 0 && (
            <ul className="mt-2 space-y-1 text-[13px] text-ink">
              {view.shipped.map((c) => (
                <li key={`${c.source}|${c.title}|${c.at}`} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="num text-[13px] text-ink-3">{fmtTime(c.at)} UTC</span>
                  <span className="min-w-0 break-words">{c.title}</span>
                  <span className="text-[13px] text-ink-3">
                    {PROVIDERS[c.source as keyof typeof PROVIDERS]?.short ?? c.source} · {c.kind === 'release' ? 'release published' : 'deployment succeeded'}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {view.shippedUnavailable.length > 0 && <p className="mt-2 text-[13px] text-ink">Could not read changes from {view.shippedUnavailable.map((p) => PROVIDERS[p]?.name ?? p).join(', ')} — this list may be incomplete.</p>}
        </section>
      )}

      <section aria-label="Quiet" className={cx('rounded-lg border border-line px-4 py-4', compact ? 'mt-4' : 'mt-6')}>
        <h3 className="text-[14px] font-semibold">Quiet</h3>
        <p className="mt-1.5 text-[14px] text-ink">
          {view.quiet.signals > 0 ? (
            <>
              <span className="num font-semibold">{view.quiet.signals}</span> monitored signal{view.quiet.signals === 1 ? '' : 's'} showed no meaningful change.
            </>
          ) : view.items.length ? (
            'Every monitored signal is part of something reported above.'
          ) : (
            'Nothing was monitored in this window.'
          )}
        </p>
        {view.quiet.watches.length > 0 && <p className="mt-1 text-[13px] text-ink-2">Quiet watches: {view.quiet.watches.join(', ')}.</p>}
        {view.deduplicated.map((d) => (
          <p key={d.watchName} className="mt-1 text-[13px] text-ink-2">
            {d.watchName}: its findings were linked to “{linkedTitle(d.linkedTo)}” instead of being reported twice.
          </p>
        ))}
      </section>

      <p className="num mt-4 text-[13px] text-ink-3">
        {view.stats.watchRuns} watch runs · {view.stats.sourcesChecked} sources · {view.stats.emailsSent} alert{view.stats.emailsSent === 1 ? '' : 's'} sent · {view.stats.dismissed} fluctuation{view.stats.dismissed === 1 ? '' : 's'} dismissed without interrupting you
      </p>
    </article>
  );
}
