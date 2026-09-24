import { ArrowRight, Clock, Mail, Moon, Plus, Radar, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useProduct } from '@/state/productContext';
import { useShellActions } from '@/components/shell';
import { FREQUENCY_LABEL, nextBriefAt, nextRunAt } from '@/product/scheduler';
import { fmtDate, fmtRelativeMinutes, fmtTime, minutesBetween } from '@/lib/time';
import { AttentionBadge, attentionRoute, ConnectionBadge, PROVIDER_ICON } from '@/components/product';
import { PROVIDERS } from '@/product/integrations/adapters';
import { Button, Card, cx, Eyebrow, SectionTitle } from '@/components/ui';
import { GettingStarted, TryYourOwnData, Welcome, WorkspaceDataBadge } from '@/components/onboarding';

export function ProductOverviewPage() {
  const { state, runMonitoring, running, mode, storageError, clearWorkspace } = useProduct();
  const { requestDemo } = useShellActions();
  const r = state.result;
  const brief = r?.briefs.at(-1);
  const conn = (p: string) => state.connections.find((c) => c.provider === p)!;
  const activeWatches = state.watches.filter((w) => w.status === 'active');
  const next = activeWatches
    .map((w) => ({ w, at: nextRunAt(w, state.clock, r?.window.start ?? '2026-09-23T18:00:00.000Z') }))
    .filter((x): x is { w: (typeof activeWatches)[number]; at: string } => !!x.at)
    .sort((a, b) => a.at.localeCompare(b.at));
  const briefNext = nextBriefAt(state.brief, state.clock);
  const needs = r?.investigations.filter((i) => i.status !== 'DISMISSED' && i.attention !== 'LOW').length ?? 0;

  if (!mode) return <Welcome />;

  return (
    <div className="animate-fade-up">
      {storageError && <div className="mb-4 rounded-xl border border-crit/40 bg-crit-soft/60 px-4 py-3 text-[13px] text-ink">{storageError}</div>}
      {mode === 'imported' && <GettingStarted />}
      <div className="mb-6">
        <Eyebrow>
          <span className="inline-flex flex-wrap items-center gap-2">
            {fmtDate(state.clock)} · {fmtTime(state.clock)} <WorkspaceDataBadge />
            <button
              className="text-ink-3 underline-offset-2 hover:text-ink hover:underline"
              onClick={() => {
                if (window.confirm('Start over? This deletes this browser’s workspace, including any imported data.')) clearWorkspace();
              }}
            >
              Start over
            </button>
          </span>
        </Eyebrow>
        <h1 className="mt-2 text-[30px] font-semibold tracking-[-0.025em] sm:text-[34px]">
          {brief ? brief.headline : running ? 'Investigating…' : r ? (needs ? `${needs} ${needs === 1 ? 'thing needs' : 'things need'} your attention.` : 'Nothing needs your attention.') : mode === 'imported' ? 'Jagr needs evidence to investigate.' : 'Jagr is ready.'}
        </h1>
        <p className="mt-2 max-w-2xl text-[15px] text-ink-2">
          An investigator that connects product evidence before deciding whether to interrupt you — not another dashboard.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" icon={RefreshCw} onClick={() => void runMonitoring()} disabled={running || (mode === 'imported' && !state.watches.length)}>
            {running ? 'Running…' : 'Run monitoring'}
          </Button>
          <Link to="/watches?new=1" className="inline-flex h-8.5 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium shadow-card hover:bg-subtle">
            <Plus size={14} /> Create watch
          </Link>
          {mode === 'sample' && <TryYourOwnData />}
        </div>
      </div>

      {state.stale && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-high/30 bg-high-soft/60 px-4 py-3 text-[13px]">
          <span className="font-medium text-ink">Watches or sources changed since the last run.</span>
          <span className="text-ink-2">Findings below reflect the previous configuration.</span>
          <Button size="sm" className="ml-auto" onClick={() => void runMonitoring()} disabled={running}>
            Re-run monitoring
          </Button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* What needs my attention? */}
        <Card className="lg:col-span-2">
          <SectionTitle hint="Investigations, not raw metrics. Each one correlates every source it could check.">What needs my attention?</SectionTitle>
          {!brief || brief.items.length === 0 ? (
            <p className="text-[13.5px] text-ink-2">Nothing needs your attention. {brief?.quiet.note}</p>
          ) : (
            <div className="-mx-4 sm:-mx-5">
              {brief.items.map((it) => (
                <Link key={it.investigationId} to={`/investigations/w/${it.investigationId}`} className="flex flex-col gap-2 border-t border-line px-4 py-3.5 hover:bg-subtle sm:flex-row sm:items-center sm:gap-4 sm:px-5">
                  <span className="w-20 shrink-0">
                    <AttentionBadge level={it.attention} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-semibold">{it.title}</span>
                    <span className="block text-[12.5px] text-ink-2">{it.summary}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-[12px] text-ink-3">
                    {it.emailedAt ? (
                      <span className="inline-flex items-center gap-1">
                        <Mail size={12} /> Emailed {fmtTime(it.emailedAt)}
                      </span>
                    ) : (
                      <span>Morning brief</span>
                    )}
                    <ArrowRight size={14} />
                  </span>
                </Link>
              ))}
            </div>
          )}
        </Card>

        {/* What happened? */}
        <Card>
          <SectionTitle action={<Link to="/briefs" className="text-[12.5px] font-medium text-accent hover:underline">Morning brief</Link>}>What happened?</SectionTitle>
          {r ? (
            <>
              <p className="text-[13px] text-ink-2">
                {fmtTime(r.window.start)} → {fmtTime(r.window.end)}: {brief?.stats.watchRuns ?? 0} watch runs across {brief?.stats.sourcesChecked ?? 0} sources · {r.emails.length} {r.emails.length === 1 ? 'email' : 'emails'} sent ·{' '}
                {r.investigations.filter((i) => i.status === 'DISMISSED').length} fluctuations dismissed.
              </p>
              <ol className="mt-3 space-y-1.5 border-l border-line pl-3.5 text-[13px]">
                {keyMoments(r).map((m) => (
                  <li key={m.at + m.text} className="relative">
                    <span className={cx('absolute top-1.5 -left-[18px] size-2 rounded-full ring-2 ring-surface', m.tone === 'email' ? 'bg-high' : m.tone === 'brief' ? 'bg-ok' : 'bg-ink-3')} />
                    <span className="tabular mr-2 font-mono text-[12px] text-ink-3">{fmtTime(m.at)}</span>
                    {m.href ? (
                      <Link to={m.href} className="hover:underline">
                        {m.text}
                      </Link>
                    ) : (
                      m.text
                    )}
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className="text-[13px] text-ink-2">Monitoring hasn’t run yet.</p>
          )}
        </Card>

        {/* When will it check again? */}
        <Card>
          <SectionTitle hint="Monitoring and briefing run on separate schedules.">When will it check again?</SectionTitle>
          <ul className="space-y-2 text-[13px]">
            {next.map(({ w, at }) => (
              <li key={w.id} className="flex items-center gap-3">
                <Clock size={13} className="text-ink-3" />
                <span className="min-w-0 flex-1 truncate font-medium">{w.name}</span>
                <span className="text-[12px] text-ink-3">{FREQUENCY_LABEL[w.schedule.frequency].toLowerCase()}</span>
                <span className="tabular w-28 text-right">
                  {fmtTime(at)} <span className="text-ink-3">· in {fmtRelativeMinutes(minutesBetween(state.clock, at))}</span>
                </span>
              </li>
            ))}
            {briefNext && (
              <li className="flex items-center gap-3 border-t border-line pt-2">
                <Moon size={13} className="text-ink-3" />
                <span className="flex-1 font-medium">Morning brief</span>
                <span className="tabular w-28 text-right">
                  {fmtDate(briefNext)} {fmtTime(briefNext)}
                </span>
              </li>
            )}
          </ul>
        </Card>

        {/* What is Jagr watching? */}
        <Card className="lg:col-span-2">
          <SectionTitle action={<Link to="/watches" className="text-[12.5px] font-medium text-accent hover:underline">All watches</Link>}>What is Jagr watching?</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-2">
            {state.watches.map((w) => {
              const invs = r?.investigations.filter((i) => i.watchIds.includes(w.id) && i.status !== 'DISMISSED') ?? [];
              const top = invs.find((i) => i.watchId === w.id);
              return (
                <Link key={w.id} to="/watches" className="rounded-lg border border-line p-3 hover:border-line-strong">
                  <div className="flex items-center gap-2">
                    <span className={cx('size-2 rounded-full', w.status === 'paused' ? 'bg-line-strong' : top ? (top.attention === 'HIGH' || top.attention === 'CRITICAL' ? 'bg-high' : 'bg-med') : 'bg-ok')} />
                    <span className="text-[13.5px] font-semibold">{w.name}</span>
                    {w.status === 'paused' && <span className="text-[11.5px] text-ink-3">Paused</span>}
                    {top && <AttentionBadge level={top.attention} className="ml-auto" />}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {w.sources.map((p) => {
                      const Icon = PROVIDER_ICON[p];
                      const st = conn(p).state;
                      return (
                        <span key={p} className="inline-flex items-center gap-1 text-[11.5px] text-ink-2" title={`${conn(p).label?.short ?? PROVIDERS[p].short}: ${st.replace('_', ' ')}`}>
                          <Icon size={12} />
                          <span className={cx('size-1.5 rounded-full', st === 'simulated' ? 'bg-info' : st === 'connected' ? 'bg-ok' : st === 'imported' ? 'bg-accent' : st === 'not_configured' ? 'bg-line-strong' : st === 'error' ? 'bg-crit' : 'bg-high')} />
                        </span>
                      );
                    })}
                    <span className="ml-auto text-[11.5px] text-ink-3">{FREQUENCY_LABEL[w.schedule.frequency]} · interrupts at {w.notificationPolicy.interruptAt}</span>
                  </div>
                  <div className="mt-1.5 text-[12px] text-ink-3">{top ? `${top.title} — ${attentionRoute(top.attention, w.notificationPolicy.interruptAt).toLowerCase()}` : invs.length ? `Linked to ${invs[0].title.toLowerCase()} (deduplicated)` : 'No meaningful changes'}</div>
                </Link>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
            Sources: {state.connections.filter((c) => c.provider !== 'email').map((c) => (
              <span key={c.provider} className="inline-flex items-center gap-1">
                {c.label?.short ?? PROVIDERS[c.provider].short} <ConnectionBadge state={c.state} />
              </span>
            ))}
            <Link to="/sources" className="ml-auto font-medium text-accent hover:underline">Manage sources</Link>
          </div>
        </Card>
      </div>

      <Card className="mt-4">
        <div className="flex flex-wrap items-center gap-3">
          <Radar size={16} className="text-ink-2" />
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold">Demo night: the autonomous agent replay</div>
            <div className="text-[12.5px] text-ink-2">The original scripted night — a Klarna checkout regression with evidence graph, approvals and agent trace.</div>
          </div>
          <Link to="/demo" className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-[12.5px] font-medium hover:bg-subtle">
            Open demo night
          </Link>
          <Button size="sm" variant="secondary" icon={Radar} onClick={requestDemo}>
            Reset &amp; replay
          </Button>
        </div>
      </Card>
    </div>
  );
}

function keyMoments(r: NonNullable<ReturnType<typeof useProduct>['state']['result']>) {
  const out: { at: string; text: string; href?: string; tone: 'inv' | 'email' | 'brief' }[] = [];
  for (const i of r.investigations.filter((x) => x.status !== 'DISMISSED')) {
    const confirmed = i.statusHistory.find((h) => h.state === 'INVESTIGATING');
    out.push({ at: confirmed?.at ?? i.startedAt, text: `Investigation opened: ${i.title}`, href: i.jagrPath, tone: 'inv' });
  }
  for (const e of r.emails) out.push({ at: e.sentAt, text: `Emailed: “${e.subject}”`, href: `/briefs?tab=outbox&email=${e.id}`, tone: 'email' });
  for (const b of r.briefs) out.push({ at: b.generatedAt, text: `Morning brief: ${b.headline}`, href: '/briefs', tone: 'brief' });
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
