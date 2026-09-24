import { ArrowLeft, ArrowRight, Check, Pause, Play, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import type { AttentionLevel, MonitoringFrequency, NotificationPolicy, ProviderId, Watch, WatchTemplateId } from '@/product/types';
import { SIGNALS, WATCH_TEMPLATES, WIZARD_TEMPLATES, watchFromTemplate } from '@/product/catalog';
import { PROVIDERS } from '@/product/integrations/adapters';
import { METRIC_DEFS } from '@/product/integrations/world';
import { FREQUENCY_LABEL, nextRunAt, toCron } from '@/product/scheduler';
import { useProduct } from '@/state/productContext';
import { fmtTime } from '@/lib/time';
import { AttentionBadge, ConnectionBadge, ProviderName } from '@/components/product';
import { Badge, Button, Card, cx, Drawer, Eyebrow, Mono, PageHeader, Toggle , EmptyState } from '@/components/ui';
import { useToast } from '@/components/toast';

export function WatchesPage() {
  const { state, setWatchStatus, mode, importedWorld } = useProduct();
  // Imported data renames channels ("Feedback", not "App Store reviews") and may lack some metrics.
  const importedMetrics = mode === 'imported' ? new Set(importedWorld?.world?.metrics.map((m) => m.id) ?? []) : undefined;
  const signalLabel = (key: keyof typeof SIGNALS) => {
    const meta = SIGNALS[key];
    if (mode !== 'imported') return meta.label;
    if (meta.kind === 'issues') return 'Issues';
    if (meta.kind === 'reviews') return 'Customer feedback';
    return meta.label;
  };
  const [params, setParams] = useSearchParams();
  const [logFor, setLogFor] = useState<Watch | null>(null);
  const wizardOpen = params.get('new') === '1';
  const r = state.result;

  return (
    <>
      <PageHeader
        title="Watches"
        description="A watch is a standing question Jagr answers on a schedule: which signals matter, where to look, how often to check, and when it's worth interrupting you."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setParams({ new: '1' })}>
            Create Watch
          </Button>
        }
      />
      {state.watches.length === 0 && (
        <EmptyState icon={Plus} title="Create your first watch." action={<Button variant="primary" icon={Plus} onClick={() => setParams({ new: '1' })}>Create watch</Button>}>
          A watch is a standing question — e.g. “Is checkout healthy?” Jagr answers it over your data and opens an investigation when something meaningful changes.
        </EmptyState>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {state.watches.map((w) => {
          const invs = r?.investigations.filter((i) => i.watchIds.includes(w.id) && i.status !== 'DISMISSED') ?? [];
          const runs = r?.log.filter((l) => l.watchId === w.id).length ?? 0;
          const next = nextRunAt(w, state.clock, r?.window.start ?? '2026-09-23T18:00:00.000Z');
          return (
            <Card key={w.id} className={w.status === 'paused' ? 'opacity-70' : ''}>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[15px] font-semibold tracking-tight">{w.name}</span>
                    <Badge tone={w.status === 'active' ? 'ok' : 'neutral'} dot>
                      {w.status === 'active' ? 'Active' : 'Paused'}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-[12.5px] text-ink-2">{w.description}</p>
                </div>
                <Button size="sm" variant="ghost" icon={w.status === 'active' ? Pause : Play} onClick={() => setWatchStatus(w.id, w.status === 'active' ? 'paused' : 'active')}>
                  {w.status === 'active' ? 'Pause' : 'Resume'}
                </Button>
              </div>
              <dl className="mt-3 grid grid-cols-[90px_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
                <dt className="text-ink-3">Sources</dt>
                <dd className="flex flex-wrap gap-x-3 gap-y-1">
                  {w.sources.map((p) => (
                    <ProviderName key={p} provider={p} short />
                  ))}
                </dd>
                <dt className="text-ink-3">Signals</dt>
                <dd>
                  <ul className="space-y-0.5">
                    {w.signals
                      .filter((s) => s.key !== 'releases')
                      // One line per channel: with imported data both store review signals read "Customer feedback".
                      .filter((s, i, all) => mode !== 'imported' || all.findIndex((x) => signalLabel(x.key) === signalLabel(s.key) && x.area === s.area) === i)
                      .map((s) => {
                        const missing = importedMetrics && SIGNALS[s.key].kind === 'metric' && !importedMetrics.has(s.key);
                        if (missing) {
                          return (
                            <li key={s.key + (s.area ?? '')} className="text-ink-3">
                              {SIGNALS[s.key].label} — not in your imported data, skipped
                            </li>
                          );
                        }
                        const rule = ruleText(s.key, w.thresholds);
                        const custom = w.thresholds?.[s.key] !== undefined;
                        return (
                          <li key={s.key + (s.area ?? '')}>
                            {signalLabel(s.key)}
                            {s.area && SIGNALS[s.key].kind !== 'metric' ? (s.area === '*' ? ' · every area' : ` · ${s.area}`) : ''}
                            {rule && (
                              <span className="text-ink-3">
                                {' '}
                                — {rule}
                                {custom && <span className="ml-1 rounded bg-accent-soft px-1 text-[11px] font-medium text-accent">custom</span>}
                              </span>
                            )}
                          </li>
                        );
                      })}
                    {w.signals.some((s) => s.key === 'releases') && <li className="text-ink-3">Recent releases, as context</li>}
                  </ul>
                </dd>
                <dt className="text-ink-3">Schedule</dt>
                <dd>
                  {FREQUENCY_LABEL[w.schedule.frequency]}
                  {w.schedule.frequency === 'daily' ? ` at ${w.schedule.dailyAt}` : ''} · {w.timezone} · <Mono className="text-ink-3">{toCron(w)}</Mono>
                </dd>
                <dt className="text-ink-3">Interrupt</dt>
                <dd>
                  {w.notificationPolicy.interruptAt === 'CRITICAL' ? 'CRITICAL only' : `${w.notificationPolicy.interruptAt} and above`} · brief {w.notificationPolicy.morningBrief ? `includes ${w.notificationPolicy.briefMin}+` : 'off'}
                </dd>
                <dt className="text-ink-3">Next check</dt>
                <dd>{next ? fmtTime(next) : '—'}</dd>
              </dl>
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-[12.5px]">
                {invs.length ? (
                  invs.map((i) => (
                    <Link key={i.id} to={i.jagrPath} className="inline-flex items-center gap-1.5 hover:underline">
                      <AttentionBadge level={i.attention} /> {i.title}
                      {i.watchId !== w.id && <span className="text-ink-3">(linked)</span>}
                    </Link>
                  ))
                ) : (
                  <span className="text-ink-3">{r ? 'No meaningful changes last night' : 'Not run yet'}</span>
                )}
                <button onClick={() => setLogFor(w)} className="ml-auto text-[12px] font-medium text-accent hover:underline">
                  {runs} runs · log
                </button>
              </div>
            </Card>
          );
        })}
      </div>

      <Drawer open={!!logFor} onClose={() => setLogFor(null)} title={logFor ? `${logFor.name} — run log` : ''} subtitle="Every scheduled check from the last monitoring window">
        {logFor && (
          <ul className="divide-y divide-line text-[12.5px]">
            {(r?.log.filter((l) => l.watchId === logFor.id) ?? []).map((l) => (
              <li key={l.jobId} className="grid grid-cols-[52px_1fr] gap-3 py-2">
                <span className="tabular font-mono text-ink-3">{fmtTime(l.scheduledAt)}</span>
                <span className={l.emailIds.length ? 'font-medium text-high' : l.investigationIds.length ? '' : 'text-ink-3'}>
                  {l.outcome}
                  {l.investigationIds.map((id) => (
                    <Link key={id} to={`/investigations/w/${id}`} className="ml-2 text-accent hover:underline">
                      {id}
                    </Link>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Drawer>

      {wizardOpen && <CreateWatchWizard onClose={() => setParams({})} />}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Create Watch
// ─────────────────────────────────────────────────────────────

const STEPS = ['What should I watch?', 'What counts as a change?', 'Where should I look?', 'How often should I check?', 'When should I interrupt you?', 'Morning brief?'];
/** A metric's default detection rule, and how a watch may override it (see Watch.thresholds). */
const METRIC_RULE = new Map(METRIC_DEFS.map((d) => [d.id, d]));
const unitOf = (id: string) => (METRIC_RULE.get(id)?.mode === 'absolute' ? 'pts' : '%');
const verbOf = (id: string) => (METRIC_RULE.get(id)?.badDirection === 'up' ? 'rises' : 'drops');
/** Human rule for a watch card, e.g. "drops more than 3% vs baseline". */
export function ruleText(id: string, thresholds?: Watch['thresholds']) {
  const def = METRIC_RULE.get(id);
  if (!def) return null;
  const th = thresholds?.[id] ?? def.threshold;
  return `${verbOf(id)} more than ${th}${unitOf(id) === '%' ? '%' : ' pts'} vs baseline`;
}

const FREQS: MonitoringFrequency[] = ['15m', '30m', '1h', '4h', 'daily'];
const INTERRUPT: { value: NotificationPolicy['interruptAt']; label: string; hint: string }[] = [
  { value: 'CRITICAL', label: 'Only when it’s critical', hint: 'Severe customer or production impact. Everything else waits for the brief.' },
  { value: 'HIGH', label: 'When it matters (recommended)', hint: 'Cross-source degradation of a core funnel, once confirmed — plus anything critical.' },
  { value: 'MEDIUM', label: 'Any persistent change', hint: 'Also single-source changes. Expect more emails.' },
];

function CreateWatchWizard({ onClose }: { onClose: () => void }) {
  const { state, createWatch, runMonitoring, running, mode, importedWorld } = useProduct();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [template, setTemplate] = useState<WatchTemplateId>('checkout_health');
  const tpl = WATCH_TEMPLATES.find((t) => t.id === template)!;
  const [name, setName] = useState(tpl.name);
  // In a "my data" workspace, only sources that have data start ticked.
  const usable = (list: ProviderId[]) => (mode === 'imported' ? list.filter((p) => state.connections.find((c) => c.provider === p)?.state !== 'not_configured') : list);
  const [sources, setSources] = useState<ProviderId[]>(() => usable(tpl.sources));
  const [frequency, setFrequency] = useState<MonitoringFrequency>('30m');
  const [dailyAt, setDailyAt] = useState('07:00');
  const [interruptAt, setInterruptAt] = useState<NotificationPolicy['interruptAt']>('HIGH');
  const [brief, setBrief] = useState(true);
  const [briefMin, setBriefMin] = useState<NotificationPolicy['briefMin']>('MEDIUM');
  const [created, setCreated] = useState<Watch | null>(null);
  // With imported data, only metrics that are actually in the upload can be tuned.
  const importedMetrics = mode === 'imported' ? new Set(importedWorld?.world?.metrics.map((m) => m.id) ?? []) : undefined;
  const metrics = tpl.signals.filter((s) => SIGNALS[s.key].kind === 'metric' && METRIC_RULE.has(s.key) && (!importedMetrics || importedMetrics.has(s.key))).map((s) => s.key);
  const [thresholds, setThresholds] = useState<Record<string, string>>({});

  useEffect(() => {
    setName(tpl.name);
    setSources(usable(tpl.sources));
    setThresholds({});
  }, [tpl]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const conn = (p: ProviderId) => state.connections.find((c) => c.provider === p)!;
  const invalidThreshold = metrics.some((id) => thresholds[id] !== undefined && thresholds[id] !== '' && !(Number(thresholds[id]) > 0));
  const canNext = (step !== 2 || sources.length > 0) && (step !== 1 || !invalidThreshold);

  const finish = () => {
    const id = `w-${template}-${Date.now().toString(36)}`;
    const watch = watchFromTemplate(id, template, {
      name: name.trim() || tpl.name,
      sources,
      schedule: { frequency, dailyAt },
      notificationPolicy: { interruptAt, briefMin, morningBrief: brief },
      // Only thresholds that differ from the metric's default are stored.
      thresholds: Object.fromEntries(
        metrics.flatMap((id) => {
          const v = Number(thresholds[id]);
          return thresholds[id] && v > 0 && v !== METRIC_RULE.get(id)!.threshold ? [[id, v]] : [];
        }),
      ),
    }, state.clock);
    createWatch(watch);
    setCreated(watch);
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-3 sm:p-6" role="dialog" aria-modal="true" aria-label="Create watch">
      <div className="animate-fade-up flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="text-[14px] font-semibold">{created ? 'Watch created' : 'Create Watch'}</div>
          <button onClick={onClose} className="rounded-md p-1 text-ink-3 hover:bg-subtle" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {!created && (
          <div className="flex gap-1 px-5 pt-4">
            {STEPS.map((s, i) => (
              <span key={s} className={cx('h-1 flex-1 rounded-full', i <= step ? 'bg-ink' : 'bg-muted')} />
            ))}
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-5 py-5">
          {created ? (
            <div className="text-center">
              <div className="mx-auto grid size-10 place-items-center rounded-full bg-ok-soft text-ok">
                <Check size={18} />
              </div>
              <div className="mt-3 text-[18px] font-semibold">Watch created.</div>
              <p className="mt-1 text-[13.5px] text-ink-2">
                <span className="font-medium text-ink">{created.name}</span> checks {created.sources.map((p) => state.connections.find((c) => c.provider === p)?.label?.short ?? PROVIDERS[p].short).join(', ')} {FREQUENCY_LABEL[created.schedule.frequency].toLowerCase()}, interrupts you at {created.notificationPolicy.interruptAt === 'CRITICAL' ? 'CRITICAL only' : `${created.notificationPolicy.interruptAt}+`}, and {created.notificationPolicy.morningBrief ? 'reports in the morning brief' : 'stays out of the brief'}.
              </p>
              <p className="mt-2 text-[12.5px] text-ink-3">Cron equivalent: <Mono>{toCron(created)}</Mono> ({created.timezone})</p>
              {created.thresholds && Object.keys(created.thresholds).length > 0 && (
                <p className="mt-1 text-[12.5px] text-ink-2">
                  Custom thresholds:{' '}
                  {Object.keys(created.thresholds)
                    .map((id) => `${METRIC_RULE.get(id)?.name ?? id} ${ruleText(id, created.thresholds)}`)
                    .join('; ')}
                  .
                </p>
              )}
            </div>
          ) : (
            <>
              <h2 className="text-[18px] font-semibold tracking-tight">{STEPS[step]}</h2>
              {step === 0 && (
                <div className="mt-4">
                  <div className="grid gap-2 sm:grid-cols-2">
                    {WIZARD_TEMPLATES.map((id) => {
                      const t = WATCH_TEMPLATES.find((x) => x.id === id)!;
                      return (
                        <button key={id} onClick={() => setTemplate(id)} className={cx('rounded-xl border p-3 text-left transition-colors', template === id ? 'border-ink bg-subtle' : 'border-line hover:border-line-strong')}>
                          <div className="text-[13.5px] font-semibold">{t.name}</div>
                          <div className="mt-0.5 text-[12px] text-ink-3">{t.example}</div>
                        </button>
                      );
                    })}
                  </div>
                  <label className="mt-4 block text-[12.5px] text-ink-3">
                    Name
                    <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 text-[14px] text-ink" />
                  </label>
                </div>
              )}
              {step === 1 && (
                <div className="mt-4 space-y-2">
                  {metrics.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-line-strong p-4 text-[13px] text-ink-2">
                      {mode === 'imported' && tpl.signals.some((s) => SIGNALS[s.key].kind === 'metric')
                        ? `None of ${tpl.name}’s metrics are in your imported data, so there are no thresholds to set. Issues and feedback are judged against their usual volume.`
                        : `${tpl.name} counts new issues and negative reviews against their usual volume — there are no metric thresholds to set. Jagr opens an investigation when volume is clearly unusual.`}
                    </p>
                  ) : (
                    metrics.map((id) => {
                      const def = METRIC_RULE.get(id)!;
                      const v = thresholds[id] ?? '';
                      const bad = v !== '' && !(Number(v) > 0);
                      return (
                        <div key={id} className={cx('rounded-xl border p-3', bad ? 'border-crit' : 'border-line')}>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[13.5px]">
                            <span className="font-medium">{def.name}</span>
                            <span className="text-ink-2">{verbOf(id)} more than</span>
                            <label className="inline-flex items-center gap-1">
                              <span className="sr-only">Threshold for {def.name} ({unitOf(id)})</span>
                              <input
                                type="number"
                                inputMode="decimal"
                                min={0}
                                step={unitOf(id) === '%' ? 1 : 0.1}
                                value={v}
                                placeholder={String(def.threshold)}
                                onChange={(e) => setThresholds({ ...thresholds, [id]: e.target.value })}
                                aria-invalid={bad}
                                className="num h-8 w-20 rounded-lg border border-line bg-surface px-2 text-right text-[13px]"
                              />
                              <span className="text-ink-2">{unitOf(id)}</span>
                            </label>
                            <span className="text-ink-2">vs its usual level</span>
                          </div>
                          <div className="mt-1 text-[12px] text-ink-3">
                            {bad ? 'Enter a number above 0.' : `Default ${def.threshold}${unitOf(id) === '%' ? '%' : ' pts'}`}
                          </div>
                        </div>
                      );
                    })
                  )}
                  <p className="pt-1 text-[12px] text-ink-3">A change must also hold for most of an hour and sit well outside normal variation before Jagr investigates. “Usual level” is the metric’s baseline from previous nights (or, for imported data, the earliest part of your upload). Who gets interrupted is set two steps from now.</p>
                </div>
              )}
              {step === 2 && (
                <div className="mt-4 space-y-2">
                  {tpl.sources.map((p) => {
                    const c = conn(p);
                    const on = sources.includes(p);
                    return (
                      <label key={p} className={cx('flex cursor-pointer items-center gap-3 rounded-xl border p-3', on ? 'border-ink' : 'border-line')}>
                        <input type="checkbox" checked={on} onChange={(e) => setSources(e.target.checked ? [...sources, p] : sources.filter((x) => x !== p))} className="size-4 accent-[var(--ink)]" />
                        <ProviderName provider={p} className="text-[13.5px] font-medium" />
                        <span className="ml-auto flex items-center gap-2 text-[12px] text-ink-3">
                          {c.state === 'not_configured' ? 'Nothing imported — left out' : c.state !== 'simulated' && c.state !== 'connected' && c.state !== 'imported' && 'Will be recorded as a gap'}
                          <ConnectionBadge state={c.state} />
                        </span>
                      </label>
                    );
                  })}
                  <p className="pt-1 text-[12px] text-ink-3">
                    Sources come from <Link to="/sources" className="text-accent hover:underline">Sources</Link>. {mode === 'imported' ? 'Sources you have not imported are left out of the run — never reported as “nothing found”.' : 'In the sample workspace every source is simulated — Jagr never presents fixture data as live.'}
                  </p>
                </div>
              )}
              {step === 3 && (
                <div className="mt-4 space-y-2">
                  {FREQS.map((f) => (
                    <label key={f} className={cx('flex cursor-pointer items-center gap-3 rounded-xl border p-3', frequency === f ? 'border-ink' : 'border-line')}>
                      <input type="radio" checked={frequency === f} onChange={() => setFrequency(f)} className="accent-[var(--ink)]" />
                      <span className="text-[13.5px] font-medium">{FREQUENCY_LABEL[f]}</span>
                      {f === 'daily' && frequency === 'daily' && <input type="time" value={dailyAt} onChange={(e) => setDailyAt(e.target.value || '07:00')} className="ml-auto h-8 rounded-lg border border-line bg-surface px-2 text-[13px]" />}
                      {f === '30m' && <span className="ml-auto text-[12px] text-ink-3">Recommended for funnels</span>}
                    </label>
                  ))}
                  <p className="pt-1 text-[12px] text-ink-3">This is the monitoring schedule. The morning brief runs on its own schedule ({state.brief.time} {state.brief.timezone}); critical findings email immediately from whichever run finds them.</p>
                </div>
              )}
              {step === 4 && (
                <div className="mt-4 space-y-2">
                  {INTERRUPT.map((o) => (
                    <label key={o.value} className={cx('flex cursor-pointer items-start gap-3 rounded-xl border p-3', interruptAt === o.value ? 'border-ink' : 'border-line')}>
                      <input type="radio" checked={interruptAt === o.value} onChange={() => setInterruptAt(o.value)} className="mt-1 accent-[var(--ink)]" />
                      <span>
                        <span className="block text-[13.5px] font-medium">{o.label}</span>
                        <span className="block text-[12px] text-ink-3">{o.hint}</span>
                      </span>
                    </label>
                  ))}
                  <div className="flex flex-wrap items-center gap-2 pt-2 text-[12px] text-ink-3">
                    {(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as AttentionLevel[]).map((l) => (
                      <span key={l} className="inline-flex items-center gap-1">
                        <AttentionBadge level={l} />
                        {l === 'LOW' ? 'never emails' : l === 'MEDIUM' ? 'brief' : l === 'HIGH' ? 'email when confirmed' : 'email immediately'}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {step === 5 && (
                <div className="mt-4 space-y-3">
                  <div className="flex items-center justify-between rounded-xl border border-line p-3">
                    <div>
                      <div className="text-[13.5px] font-medium">Include this watch in the morning brief</div>
                      <div className="text-[12px] text-ink-3">
                        Every day at {state.brief.time} ({state.brief.timezone}) — findings that didn’t warrant an email, and quiet watches.
                      </div>
                    </div>
                    <Toggle checked={brief} onChange={setBrief} label="Morning brief" />
                  </div>
                  {brief && (
                    <label className="flex items-center justify-between rounded-xl border border-line p-3 text-[13.5px]">
                      Include findings from
                      <select value={briefMin} onChange={(e) => setBriefMin(e.target.value as NotificationPolicy['briefMin'])} className="h-8 rounded-lg border border-line bg-surface px-2 text-[13px]">
                        <option value="MEDIUM">MEDIUM and above</option>
                        <option value="HIGH">HIGH and above</option>
                      </select>
                    </label>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-line px-5 py-3">
          {created ? (
            <>
              <Button variant="ghost" onClick={onClose}>
                Done
              </Button>
              <Button
                variant="primary"
                disabled={running}
                onClick={async () => {
                  await runMonitoring();
                  toast({ tone: 'success', title: 'Monitoring re-run', body: `${created.name} is now part of the overnight schedule.` });
                  onClose();
                }}
              >
                {running ? 'Running…' : 'Run monitoring now'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" icon={ArrowLeft} onClick={() => (step === 0 ? onClose() : setStep(step - 1))}>
                {step === 0 ? 'Cancel' : 'Back'}
              </Button>
              <div className="flex items-center gap-3">
                <Eyebrow>
                  Step {step + 1} of {STEPS.length}
                </Eyebrow>
                {step < STEPS.length - 1 ? (
                  <Button variant="primary" onClick={() => setStep(step + 1)} disabled={!canNext}>
                    Next <ArrowRight size={14} />
                  </Button>
                ) : (
                  <Button variant="primary" icon={Check} onClick={finish}>
                    Create watch
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
