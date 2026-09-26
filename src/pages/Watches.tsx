import { ArrowLeft, ArrowRight, Check, Pause, Play, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { AttentionLevel, MonitoringFrequency, NotificationPolicy, ProviderId, Watch, WatchTemplateId } from '@/product/types';
import { metricKeyOf, signalMeta, WATCH_TEMPLATES, WIZARD_TEMPLATES, watchFromTemplate } from '@/product/catalog';
import { metricKeyOf as nativeMetricKey, nativeMetricSignal } from '@/product/integrations/bridge';
import type { SignalKey } from '@/product/types';
import { PROVIDERS } from '@/product/integrations/adapters';
import { METRIC_DEFS } from '@/product/integrations/world';
import { canLeaveSourceStep, connectionsPending, initialWizardSources, sourceStepBlocker, templateAvailability, wizardSourceRows } from '@/product/view/watchWizard';
import { FREQUENCY_LABEL, toCron } from '@/product/scheduler';
import { watchCardStatus } from '@/product/view/watchCard';
import { createWatchWithState, initialWatchCreationState } from '@/product/view/watchCreation';
import { useProduct } from '@/state/productContext';
import { fmtDateTime, fmtTime } from '@/lib/time';
import { AttentionBadge, ConnectionBadge, ProviderName } from '@/components/product';
import { Button, cx, Drawer, EmptyState, Mono, PageHeader, Toggle, useDialogFocus } from '@/components/ui';
import { investigationTitle } from '@/product/view/investigation';
import { useToast } from '@/components/toast';
import { isQuickStartOrigin } from '@/state/firstRun';

export function WatchesPage() {
  const { state, setWatchStatus, mode, importedWorld, location, server } = useProduct();
  // Imported data renames channels ("Feedback", not "App Store reviews") and may lack some metrics.
  const importedMetrics = mode === 'imported' ? new Set<string>(importedWorld?.world?.metrics.map(nativeMetricSignal) ?? []) : undefined;
  const signalLabel = (key: SignalKey) => signalMeta(key).label;
  const [params, setParams] = useSearchParams();
  const quickStartOrigin = isQuickStartOrigin(`?${params.toString()}`);
  const [logFor, setLogFor] = useState<Watch | null>(null);
  const wizardOpen = params.get('new') === '1';
  const r = state.result;
  const sourceName = (p: ProviderId) => state.connections.find((c) => c.provider === p)?.label?.short ?? PROVIDERS[p].short;

  return (
    <>
      <PageHeader
        title="Watches"
        description="A watch is a standing question Jagr answers on a schedule: which signals matter, where to look, how often to check, and when it’s worth interrupting you."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setParams({ new: '1' })}>
            Create watch
          </Button>
        }
      />
      {state.watches.length === 0 && (
        <EmptyState icon={Plus} title="Create your first watch" action={<Button variant="primary" icon={Plus} onClick={() => setParams({ new: '1' })}>Create watch</Button>}>
          A watch is a standing question — e.g. “Is checkout healthy?” Jagr answers it over your data and opens an investigation when something meaningful changes.
        </EmptyState>
      )}
      {state.watches.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {state.watches.map((w) => {
            const invs = r?.investigations.filter((i) => i.watchIds.includes(w.id) && i.status !== 'DISMISSED' && i.status !== 'RESOLVED') ?? [];
            const status = watchCardStatus(w, { location, result: r, clock: state.clock, snapshotAt: server?.snapshotAt });
            const ran = location === 'server' ? !!status.lastRun : !!r;
            const top = invs[0];
            const health =
              w.status === 'paused'
                ? { label: 'Paused', dot: 'bg-line-strong' }
                : top
                  ? { label: 'Needs attention', dot: top.attention === 'HIGH' || top.attention === 'CRITICAL' ? 'bg-high' : 'bg-med' }
                  : ran
                    ? { label: 'Healthy', dot: 'bg-ok' }
                    : { label: 'Not run yet', dot: 'bg-line-strong' };
            const signals = w.signals
              .filter((sg) => sg.key !== 'changes')
              // One line per channel: with imported data both store review signals read "Customer feedback".
              .filter((sg, i, all) => mode !== 'imported' || all.findIndex((x) => signalLabel(x.key) === signalLabel(sg.key) && x.area === sg.area) === i);
            return (
              <li key={w.id} className={cx('px-4 py-4 sm:px-5', w.status === 'paused' && 'opacity-75')}>
                <div className="grid gap-x-6 gap-y-3 md:grid-cols-[minmax(0,1fr)_240px]">
                  <div className="min-w-0">
                    <h2 className="text-[16px] font-semibold tracking-tight">{w.name}</h2>
                    <p className="text-[13px] text-ink-2">{w.description}</p>
                    <p className="mt-1.5 text-[13px] text-ink-2">
                      {w.sources.map(sourceName).join(', ')}
                      <span className="text-ink-3"> · </span>
                      {FREQUENCY_LABEL[w.schedule.frequency]}
                      {w.schedule.frequency === 'daily' ? ` at ${w.schedule.dailyAt}` : ''} ({w.timezone})
                      <span className="text-ink-3"> · </span>
                      {w.notificationPolicy.interruptAt === 'CRITICAL' ? 'Interrupts for CRITICAL only' : `Interrupts at ${w.notificationPolicy.interruptAt} and above`}
                    </p>
                    {invs.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {invs.map((i) => (
                          <li key={i.id}>
                            <Link to={i.jagrPath} className="inline-flex items-center gap-2 text-[13px] hover:underline">
                              <AttentionBadge level={i.attention} /> {investigationTitle(i)}
                              {i.watchId !== w.id && <span className="text-ink-3">(shared with {state.watches.find((x) => x.id === i.watchId)?.name ?? 'another watch'})</span>}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <dl className="grid grid-cols-[auto_1fr] content-start gap-x-3 gap-y-1 text-[13px]">
                    <dt className="text-ink-3">State</dt>
                    <dd className="flex items-center gap-1.5">
                      <span aria-hidden className={cx('size-2 rounded-full', health.dot)} /> {health.label}
                    </dd>
                    <dt className="text-ink-3">Last run</dt>
                    <dd className="num">
                      {location === 'server' ? (status.lastRun ? `${fmtDateTime(status.lastRun.scheduledAt)} UTC` : 'Not run yet') : r ? `${status.runs.length} checks in the last window` : 'Not run yet'}
                    </dd>
                    <dt className="text-ink-3">Next run</dt>
                    <dd className="num">{status.nextRun ? `${fmtTime(status.nextRun)} UTC` : '—'}</dd>
                  </dl>
                </div>
                {location === 'server' && status.lastRun && <p className="mt-2 text-[13px] text-ink-2">{status.lastRun.outcome}</p>}
                {!invs.length && ran && location !== 'server' && <p className="mt-2 text-[13px] text-ink-3">{status.quiet}</p>}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <details className="group min-w-0 flex-1">
                    <summary className="interactive inline-flex cursor-pointer list-none items-center gap-1 rounded text-[13px] font-medium text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
                      <ArrowRight size={12} aria-hidden className="transition-transform group-open:rotate-90 motion-reduce:transition-none" /> What it checks
                    </summary>
                    <ul className="mt-2 space-y-0.5 border-l border-line pl-3 text-[13px]">
                      {signals.map((sg) => {
                        const missing = importedMetrics && signalMeta(sg.key).kind === 'metric' && !importedMetrics.has(sg.key);
                        if (missing) return <li key={sg.key + (sg.area ?? '')} className="text-ink-3">{signalMeta(sg.key).label} — not in your imported data, skipped</li>;
                        const metric = metricKeyOf(sg.key);
                        const rule = metric ? ruleText(metric, w.thresholds) : null;
                        const custom = !!metric && w.thresholds?.[metric] !== undefined;
                        return (
                          <li key={sg.key + (sg.area ?? '')}>
                            {signalLabel(sg.key)}
                            {sg.area && signalMeta(sg.key).kind !== 'metric' ? (sg.area === '*' ? ' · every area' : ` · ${sg.area}`) : ''}
                            {rule && <span className="text-ink-2"> — {rule}{custom && ' (custom)'}</span>}
                          </li>
                        );
                      })}
                      {w.signals.some((sg) => sg.key === 'changes') && <li className="text-ink-2">{w.signals.every((sg) => sg.key === 'changes') ? 'Failed deployments; successful deployments and releases as brief context' : 'Recent releases, as context'}</li>}
                      <li className="text-ink-3">
                        Morning brief: {w.notificationPolicy.morningBrief ? `includes ${w.notificationPolicy.briefMin} and above` : 'off'} · schedule <Mono className="text-ink-3">{toCron(w)}</Mono>
                      </li>
                    </ul>
                  </details>
                  <Button size="sm" variant="ghost" onClick={() => setLogFor(w)}>
                    Run log <span className="num text-ink-3">{status.runs.length}</span>
                  </Button>
                  <Button size="sm" variant="ghost" icon={w.status === 'active' ? Pause : Play} onClick={() => setWatchStatus(w.id, w.status === 'active' ? 'paused' : 'active')}>
                    {w.status === 'active' ? 'Pause' : 'Resume'}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Drawer open={!!logFor} onClose={() => setLogFor(null)} title={logFor ? `${logFor.name} — run log` : ''} subtitle={location === 'server' ? 'Recent monitoring runs of this watch' : 'Every scheduled check from the last monitoring window'}>
        {logFor && (
          <ul className="divide-y divide-line text-[13px]">
            {watchCardStatus(logFor, { location, result: r, clock: state.clock, snapshotAt: server?.snapshotAt }).runs.map((l) => (
              <li key={l.jobId} className={cx('grid gap-3 py-2', location === 'server' ? 'grid-cols-[120px_1fr]' : 'grid-cols-[72px_1fr]')}>
                <span className="num text-ink-3">{location === 'server' ? `${fmtDateTime(l.scheduledAt)}` : `${fmtTime(l.scheduledAt)} UTC`}</span>
                <span className={l.emailIds.length ? 'font-medium text-ink' : l.investigationIds.length ? '' : 'text-ink-2'}>
                  {l.outcome}
                  {l.investigationIds.map((id) => (
                    <Link key={id} to={`/investigations/w/${id}`} className="ml-2 text-accent hover:underline">
                      Open
                    </Link>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Drawer>

      {wizardOpen && <CreateWatchWizard initialTemplate={params.get('template')} quickStartOrigin={quickStartOrigin} onClose={() => setParams({})} />}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Create Watch
// ─────────────────────────────────────────────────────────────

const STEPS = ['What should I watch?', 'What counts as a change?', 'Where should I look?', 'How often should I check?', 'When should I interrupt you?', 'Morning brief?'];
/** A metric's default detection rule, and how a watch may override it (see Watch.thresholds). */
const METRIC_RULE = new Map(METRIC_DEFS.map((d) => [nativeMetricKey(d.id, d.provider, d.platform), d]));
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
  { value: 'MEDIUM', label: 'Any persistent change', hint: 'Also single-source changes. Expect more alerts.' },
];

export async function runCreatedWatch(runMonitoring: () => Promise<unknown>, onSuccess: () => void): Promise<void> {
  await runMonitoring();
  onSuccess();
}

function CreateWatchWizard({ onClose, initialTemplate, quickStartOrigin }: { onClose: () => void; initialTemplate: string | null; quickStartOrigin: boolean }) {
  const { state, createWatch, runMonitoring, running, mode, importedWorld, location } = useProduct();
  const toast = useToast();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const requestedTemplate = WIZARD_TEMPLATES.includes(initialTemplate as WatchTemplateId) ? (initialTemplate as WatchTemplateId) : 'checkout_health';
  const [template, setTemplate] = useState<WatchTemplateId>(requestedTemplate);
  const tpl = WATCH_TEMPLATES.find((t) => t.id === template)!;
  const [name, setName] = useState(tpl.name);
  // In a "my data" workspace, only sources that have data start ticked; in a server workspace, only
  // sources it has connected (its connection list is empty until the snapshot arrives).
  const usable = (list: ProviderId[]) => initialWizardSources(list, state.connections, { location, mode });
  const pending = connectionsPending(state.connections, { location });
  const [sources, setSources] = useState<ProviderId[]>(() => usable(tpl.sources));
  const [frequency, setFrequency] = useState<MonitoringFrequency>('30m');
  const [dailyAt, setDailyAt] = useState('07:00');
  const [interruptAt, setInterruptAt] = useState<NotificationPolicy['interruptAt']>('HIGH');
  const [brief, setBrief] = useState(true);
  const [briefMin, setBriefMin] = useState<NotificationPolicy['briefMin']>('MEDIUM');
  const [creation, setCreation] = useState(initialWatchCreationState);
  const { creating, created, error: creationError, warning: creationWarning } = creation;
  // With imported data, only metrics that are actually in the upload can be tuned.
  const importedMetrics = mode === 'imported' ? new Set<string>(importedWorld?.world?.metrics.map(nativeMetricSignal) ?? []) : undefined;
  const metrics = tpl.signals.filter((s) => { const m = metricKeyOf(s.key); return !!m && METRIC_RULE.has(m) && (!importedMetrics || importedMetrics.has(s.key)); }).map((s) => metricKeyOf(s.key)!);
  const [thresholds, setThresholds] = useState<Record<string, string>>({});

  useEffect(() => {
    setName(tpl.name);
    setSources(usable(tpl.sources));
    setThresholds({});
  }, [tpl]);

  // A server workspace's connections can arrive after the wizard opens: pick sources once they do.
  useEffect(() => {
    if (!pending) setSources(usable(tpl.sources));
  }, [pending]);

  const dialog = useRef<HTMLDivElement>(null);
  const close = () => {
    if (!creating) onClose();
  };
  useDialogFocus(true, close, dialog);

  const rows = wizardSourceRows(tpl.sources, state.connections, { location });
  const availability = templateAvailability(tpl.sources, state.connections, { location });
  const invalidThreshold = metrics.some((id) => thresholds[id] !== undefined && thresholds[id] !== '' && !(Number(thresholds[id]) > 0));
  // Every disabled Next says why, next to the button.
  const blocker =
    step === 0 && availability.status === 'unavailable'
      ? `${tpl.name} needs a source this workspace does not have.`
      : step === 0 && availability.status === 'loading'
        ? 'Waiting for this workspace’s connections to load.'
        : step === 1 && invalidThreshold
          ? 'Fix the highlighted threshold.'
          : step === 2
            ? sourceStepBlocker(sources, rows)
            : undefined;
  const canNext = !blocker && (step !== 2 || canLeaveSourceStep(sources, rows));
  const duplicateName = state.watches.some((w) => w.name.trim().toLowerCase() === name.trim().toLowerCase());

  const finish = async () => {
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
    await createWatchWithState(watch, createWatch, setCreation);
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-3 sm:p-6" role="dialog" aria-modal="true" aria-labelledby="create-watch-title" aria-busy={creating}>
      <div ref={dialog} tabIndex={-1} className="animate-fade-up flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-pop outline-none">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div id="create-watch-title" className="text-[14px] font-semibold">{created ? 'Watch created' : 'Create watch'}</div>
          <button onClick={close} disabled={creating} className="rounded p-1 text-ink-3 hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50" aria-label="Close">
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
          {creationError && <p role="alert" className="mb-4 rounded-lg border border-crit/40 bg-crit-soft px-3 py-2 text-[13px] text-crit">Watch creation failed: {creationError}</p>}
          {creationWarning && <p role="alert" className="mb-4 rounded-lg border border-high/40 bg-high-soft px-3 py-2 text-[13px] text-ink">{creationWarning}</p>}
          {creating && <p role="status" className="sr-only">Creating and saving the watch.</p>}
          {created ? (
            <div className="text-center">
              <div className="mx-auto grid size-10 place-items-center rounded-full bg-ok-soft text-ok">
                <Check size={18} />
              </div>
              <div className="mt-3 text-[20px] font-semibold">Watch created.</div>
              <p className="mt-1 text-[14px] text-ink-2">
                <span className="font-medium text-ink">{created.name}</span> checks {created.sources.map((p) => state.connections.find((c) => c.provider === p)?.label?.short ?? PROVIDERS[p].short).join(', ')} {FREQUENCY_LABEL[created.schedule.frequency].toLowerCase()}, interrupts you at {created.notificationPolicy.interruptAt === 'CRITICAL' ? 'CRITICAL only' : `${created.notificationPolicy.interruptAt}+`}, and {created.notificationPolicy.morningBrief ? 'reports in the morning brief' : 'stays out of the brief'}.
              </p>
              <p className="mt-2 text-[13px] text-ink-3">Cron equivalent: <Mono>{toCron(created)}</Mono> ({created.timezone})</p>
              {created.thresholds && Object.keys(created.thresholds).length > 0 && (
                <p className="mt-1 text-[13px] text-ink-2">
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
              <h2 className="text-[20px] font-semibold tracking-tight">{STEPS[step]}</h2>
              {step === 0 && (
                <div className="mt-4">
                  <div className="grid gap-2 sm:grid-cols-2">
                    {WIZARD_TEMPLATES.map((id) => {
                      const t = WATCH_TEMPLATES.find((x) => x.id === id)!;
                      const a = templateAvailability(t.sources, state.connections, { location });
                      return (
                        <button key={id} type="button" aria-pressed={template === id} onClick={() => setTemplate(id)} className={cx('rounded-lg border p-3 text-left transition-colors', template === id ? 'border-ink bg-subtle' : 'border-line hover:border-line-strong')}>
                          <div className="text-[14px] font-semibold">{t.name}</div>
                          <div className="mt-0.5 text-[13px] text-ink-3">{t.example}</div>
                          {a.status === 'unavailable' && <div className="mt-1 text-[12px] font-medium text-ink-2">Needs {a.missing.map((p) => PROVIDERS[p].short).join(' or ')}</div>}
                        </button>
                      );
                    })}
                  </div>
                  {availability.status === 'unavailable' && (
                    <div role="status" className="mt-4 rounded-lg border border-line bg-canvas p-4">
                      <p className="text-[14px] font-medium">{availability.missing.map((p) => PROVIDERS[p].name).join(' or ')} required</p>
                      <p className="mt-0.5 text-[13px] text-ink-2">
                        This watch needs a {availability.missing.map((p) => PROVIDERS[p].short).join(' or ')} connection.
                        {location === 'server' ? '' : ' Live connections belong to server workspaces.'}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Link to={location === 'server' ? '/sources' : '/settings#account'} onClick={onClose} className="interactive inline-flex h-8 items-center rounded-lg bg-ink px-3 text-[13px] font-medium text-canvas hover:opacity-90">
                          {location === 'server' ? `Connect ${PROVIDERS[availability.missing[0]].short}` : 'Sign in to a server workspace'}
                        </Link>
                        <Button size="sm" onClick={() => setTemplate(WIZARD_TEMPLATES.find((id) => templateAvailability(WATCH_TEMPLATES.find((x) => x.id === id)!.sources, state.connections, { location }).status === 'ready') ?? 'checkout_health')}>
                          Choose another watch
                        </Button>
                      </div>
                    </div>
                  )}
                  <label className="mt-4 block text-[13px] text-ink-3">
                    Name
                    <input value={name} onChange={(e) => setName(e.target.value)} aria-describedby={duplicateName ? 'watch-name-dup' : undefined} className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 text-[14px] text-ink" />
                  </label>
                  {duplicateName && (
                    <p id="watch-name-dup" className="mt-1 text-[13px] text-ink-2">
                      A watch called “{name.trim()}” already exists. A different name keeps them apart in alerts and the brief.
                    </p>
                  )}
                </div>
              )}
              {step === 1 && (
                <div className="mt-4 space-y-2">
                  {metrics.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-line-strong p-4 text-[13px] text-ink-2">
                      {tpl.signals.every((s) => s.key === 'changes')
                        ? `${tpl.name} reports a deployment the source marks as failed. Successful deployments and releases are listed as context in the morning brief — never as findings. There are no thresholds to set.`
                        : mode === 'imported' && tpl.signals.some((s) => signalMeta(s.key).kind === 'metric')
                        ? `None of ${tpl.name}’s metrics are in your imported data, so there are no thresholds to set. Issues and feedback are judged against their usual volume.`
                        : `${tpl.name} counts new issues and negative reviews against their usual volume — there are no metric thresholds to set. Jagr opens an investigation when volume is clearly unusual.`}
                    </p>
                  ) : (
                    metrics.map((id) => {
                      const def = METRIC_RULE.get(id)!;
                      const v = thresholds[id] ?? '';
                      const bad = v !== '' && !(Number(v) > 0);
                      return (
                        <div key={id} className={cx('rounded-lg border p-3', bad ? 'border-crit' : 'border-line')}>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[14px]">
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
                  {metrics.length > 0 && (
                    <p className="pt-1 text-[13px] text-ink-3">A change must also hold for most of an hour and sit well outside normal variation before Jagr investigates. “Usual level” is the metric’s baseline from previous nights (or, for imported data, the earliest part of your upload). Who gets interrupted is set two steps from now.</p>
                  )}
                </div>
              )}
              {step === 2 && (
                <div className="mt-4 space-y-2">
                  {rows.map((r) => {
                    const p = r.provider;
                    const on = sources.includes(p);
                    const ready = r.status === 'ready';
                    return (
                      <label key={p} className={cx('flex items-center gap-3 rounded-lg border p-3', ready ? 'cursor-pointer' : 'cursor-not-allowed opacity-70', on ? 'border-ink' : 'border-line')}>
                        <input type="checkbox" checked={on} disabled={!ready} onChange={(e) => setSources(e.target.checked ? [...sources, p] : sources.filter((x) => x !== p))} className="size-4 accent-[var(--ink)]" />
                        <ProviderName provider={p} className="text-[14px] font-medium" />
                        <span className="ml-auto flex items-center gap-2 text-[12px] text-ink-3">
                          {r.status === 'loading' ? (
                            'Loading connection…'
                          ) : r.status === 'missing' ? (
                            <>
                              Not connected — left out
                              <ConnectionBadge state="not_configured" />
                            </>
                          ) : (
                            <>
                              {r.state === 'not_configured' ? 'Nothing imported — left out' : r.state !== 'simulated' && r.state !== 'connected' && r.state !== 'imported' && 'Will be recorded as a gap'}
                              <ConnectionBadge state={r.state} />
                            </>
                          )}
                        </span>
                      </label>
                    );
                  })}
                  {pending && <p role="status" className="pt-1 text-[12px] text-ink-3">Loading this workspace’s connections…</p>}
                  {!pending && location === 'server' && !rows.some((r) => r.status === 'ready') && (
                    <p role="status" className="pt-1 text-[12px] text-high">
                      None of this template’s sources is connected to this workspace yet. Connect one in <Link to="/sources" className="underline">Sources</Link>, or choose another template.
                    </p>
                  )}
                  <p className="pt-1 text-[12px] text-ink-3">
                    Sources come from <Link to="/sources" className="text-accent hover:underline">Sources</Link>.{' '}
                    {mode === 'imported'
                      ? 'Sources you have not imported are left out of the run — never reported as “nothing found”.'
                      : location === 'server'
                        ? 'Only sources connected to this workspace can be watched; they are read live on every check.'
                        : 'In the sample workspace every source is simulated — Jagr never presents fixture data as live.'}
                  </p>
                </div>
              )}
              {step === 3 && (
                <div className="mt-4 space-y-2">
                  {FREQS.map((f) => (
                    <label key={f} className={cx('flex cursor-pointer items-center gap-3 rounded-lg border p-3', frequency === f ? 'border-ink' : 'border-line')}>
                      <input type="radio" checked={frequency === f} onChange={() => setFrequency(f)} className="accent-[var(--ink)]" />
                      <span className="text-[14px] font-medium">{FREQUENCY_LABEL[f]}</span>
                      {f === 'daily' && frequency === 'daily' && <input type="time" value={dailyAt} onChange={(e) => setDailyAt(e.target.value || '07:00')} className="ml-auto h-8 rounded-lg border border-line bg-surface px-2 text-[13px]" />}
                      {f === '30m' && <span className="ml-auto text-[12px] text-ink-3">Recommended for funnels</span>}
                    </label>
                  ))}
                  <p className="pt-1 text-[13px] text-ink-3">This is the monitoring schedule. The morning brief runs on its own schedule ({state.brief.time} {state.brief.timezone}); critical findings alert you immediately from whichever run finds them.</p>
                </div>
              )}
              {step === 4 && (
                <div className="mt-4 space-y-2">
                  {INTERRUPT.map((o) => (
                    <label key={o.value} className={cx('flex cursor-pointer items-start gap-3 rounded-lg border p-3', interruptAt === o.value ? 'border-ink' : 'border-line')}>
                      <input type="radio" checked={interruptAt === o.value} onChange={() => setInterruptAt(o.value)} className="mt-1 accent-[var(--ink)]" />
                      <span>
                        <span className="block text-[14px] font-medium">{o.label}</span>
                        <span className="block text-[12px] text-ink-3">{o.hint}</span>
                      </span>
                    </label>
                  ))}
                  <div className="flex flex-wrap items-center gap-2 pt-2 text-[12px] text-ink-3">
                    {(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as AttentionLevel[]).map((l) => (
                      <span key={l} className="inline-flex items-center gap-1">
                        <AttentionBadge level={l} />
                        {l === 'LOW' ? 'never alerts' : l === 'MEDIUM' ? 'morning brief' : l === 'HIGH' ? 'alert once confirmed' : 'alert immediately'}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {step === 5 && (
                <div className="mt-4 space-y-3">
                  <div className="flex items-center justify-between rounded-lg border border-line p-3">
                    <div>
                      <div className="text-[14px] font-medium">Include this watch in the morning brief</div>
                      <div className="text-[12px] text-ink-3">
                        Every day at {state.brief.time} ({state.brief.timezone}) — findings that didn’t warrant an alert, and quiet watches.
                      </div>
                    </div>
                    <Toggle checked={brief} onChange={setBrief} label="Morning brief" />
                  </div>
                  {brief && (
                    <label className="flex items-center justify-between rounded-lg border border-line p-3 text-[14px]">
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
              <Button variant="ghost" onClick={close}>
                Done
              </Button>
              <Button
                variant="primary"
                disabled={running}
                onClick={async () => {
                  try {
                    await runCreatedWatch(runMonitoring, () => {
                      toast({ tone: 'success', title: 'Monitoring re-run', body: `${created.name} is now part of the overnight schedule.` });
                      onClose();
                      if (quickStartOrigin) navigate('/');
                    });
                  } catch (error) {
                    toast({ tone: 'warning', title: 'The run did not complete', body: (error as Error).message });
                  }
                }}
              >
                {running ? 'Running…' : 'Run monitoring now'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" icon={ArrowLeft} disabled={creating} onClick={() => (step === 0 ? close() : setStep(step - 1))}>
                {step === 0 ? 'Cancel' : 'Back'}
              </Button>
              <div className="flex min-w-0 items-center gap-3">
                {blocker ? (
                  <span role="status" className="min-w-0 text-right text-[13px] text-ink-2">
                    {blocker}
                  </span>
                ) : (
                  <span className="text-[13px] text-ink-3">
                    Step {step + 1} of {STEPS.length}
                  </span>
                )}
                {step < STEPS.length - 1 ? (
                  <Button variant="primary" onClick={() => setStep(step + 1)} disabled={!canNext}>
                    Next <ArrowRight size={14} />
                  </Button>
                ) : (
                  <Button variant="primary" icon={Check} onClick={() => void finish()} disabled={creating}>
                    {creating ? 'Creating…' : 'Create watch'}
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
