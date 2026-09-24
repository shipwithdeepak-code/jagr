import { ArrowRight, Check, CircleSlash, Moon, Play, Radar, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ApprovalRequest, BriefNotDone, OvernightRun } from '@/domain/types';
import { HISTORICAL_STATS, INTEGRATIONS } from '@/domain/defaults';
import { useWorkspace } from '@/state/workspace';
import { fmtConfidence, fmtPct } from '@/lib/format';
import { fmtDate, fmtDuration, fmtTime } from '@/lib/time';
import { Badge, Card, ConfidenceMeter, cx, Eyebrow, SectionTitle, SeverityBadge, SourceChip, Stat } from '@/components/ui';
import { GATE_LABELS } from '@/agents/policy';
import { useShellActions } from '@/components/shell';
import { TryYourOwnData } from '@/components/onboarding';

export function OverviewPage() {
  const { state } = useWorkspace();
  return state.run ? <Brief run={state.run} approvals={state.approvals} /> : <BeforeTheNight />;
}

// ─────────────────────────────────────────────────────────────
// Before the first run
// ─────────────────────────────────────────────────────────────

function BeforeTheNight() {
  const { state } = useWorkspace();
  const { settings } = state;
  const watched = Object.entries(settings.watch).filter(([, v]) => v).map(([k]) => k.replace('_', ' '));
  return (
    <div className="animate-fade-up">
      <div className="mb-8">
        <Eyebrow>Wed Sep 23 · 6:00 PM</Eyebrow>
        <h1 className="mt-2 text-[30px] font-semibold tracking-[-0.025em] sm:text-[34px]">JAGR is ready for tonight.</h1>
        <p className="mt-2 max-w-2xl text-[15px] text-ink-2">
          When the team logs off, JAGR monitors product signals, investigates anything that moves, files the work, and has a brief waiting at {settings.schedule.briefAt}. Consequential actions wait for you.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <RunButtons />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <Eyebrow>Watch window</Eyebrow>
          <div className="tabular mt-2 text-[24px] font-semibold tracking-tight">
            {settings.schedule.start} → {settings.schedule.end}
          </div>
          <p className="mt-1 text-[13px] text-ink-2">Sweeps every 30 minutes. Morning brief at {settings.schedule.briefAt}. Critical findings escalate {settings.criticalEscalation ? 'immediately' : 'in the brief'}.</p>
        </Card>
        <Card>
          <Eyebrow>Watching</Eyebrow>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {watched.map((w) => (
              <Badge key={w} className="capitalize">
                {w}
              </Badge>
            ))}
          </div>
          <Link to="/settings" className="mt-3 inline-flex items-center gap-1 text-[12.5px] font-medium text-ink-2 hover:text-ink">
            Configure <ArrowRight size={12} />
          </Link>
        </Card>
        <Card>
          <Eyebrow>Autonomy</Eyebrow>
          <ul className="mt-2 space-y-1 text-[13px]">
            <li className="flex items-center gap-2"><Check size={13} className="text-ok" /> Observe, investigate, recommend</li>
            <li className="flex items-center gap-2"><Check size={13} className="text-ok" /> Create tasks &amp; incident drafts</li>
            <li className="flex items-center gap-2"><ShieldCheck size={13} className="text-high" /> Production, payments, customers → your approval</li>
          </ul>
        </Card>
      </div>

      <Card className="mt-4">
        <SectionTitle hint="All connectors in Demo night are simulation adapters.">Sources</SectionTitle>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {INTEGRATIONS.map((i) => (
            <span key={i.kind} className="inline-flex items-center gap-1.5 text-[13px]">
              <span className={cx('size-1.5 rounded-full', settings.integrations[i.kind] === 'connected' ? 'bg-ok' : 'bg-crit')} />
              <SourceChip source={i.kind} className="text-ink-2" />
              <span className="text-[11.5px] text-ink-3">{settings.integrations[i.kind] === 'connected' ? 'Simulation connected' : 'Unavailable'}</span>
            </span>
          ))}
        </div>
      </Card>

      <ProductMetrics />
    </div>
  );
}

export function RunButtons() {
  const { startRun, requestDemo, running } = useShellActions();
  return (
    <>
      <button
        onClick={startRun}
        disabled={running}
        className="inline-flex h-9 items-center gap-2 rounded-lg bg-ink px-4 text-[13.5px] font-medium text-canvas shadow-card hover:opacity-90 disabled:opacity-60"
      >
        <Play size={14} /> Run Overnight
      </button>
      <button
        onClick={requestDemo}
        className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-surface px-4 text-[13.5px] font-medium shadow-card hover:bg-subtle"
      >
        <Radar size={14} /> Reset &amp; replay Demo night
      </button>
      <TryYourOwnData />
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// The morning brief
// ─────────────────────────────────────────────────────────────

function Brief({ run, approvals }: { run: OvernightRun; approvals: ApprovalRequest[] }) {
  const { brief } = run;
  const h = brief.headline;
  const inv = h ? run.investigations.find((i) => i.id === h.investigationId) : undefined;
  const headTasks = inv ? run.tasks.filter((t) => inv.taskIds.includes(t.id)) : [];
  const pending = approvals.filter((a) => a.status === 'pending' || a.status === 'more_evidence_requested');
  const others = brief.findings.filter((f) => f.investigationId !== h?.investigationId);
  const dismissed = run.investigations.filter((i) => i.status === 'dismissed');

  return (
    <div className="animate-fade-up">
      <div className="mb-7">
        <Eyebrow>
          {fmtDate(brief.generatedAt)} · Brief generated {fmtTime(brief.generatedAt)}
        </Eyebrow>
        <h1 className="mt-2 text-[32px] font-semibold tracking-[-0.025em] sm:text-[38px]">Good morning.</h1>
        <p className="mt-1 text-[15px] text-ink-2">JAGR monitored your product overnight.</p>
        <p className="mt-1 text-[12.5px] text-ink-3">
          {fmtTime(brief.window.start)} → {fmtTime(brief.window.end)} · {brief.counts.signals} signals · {run.events.filter((e) => e.stage === 'detect').length} sweeps · {run.investigations.length} investigations · {run.reasoningEngine}
        </p>
      </div>

      {/* Counts */}
      <div className="grid grid-cols-3 overflow-hidden rounded-xl border border-line bg-line shadow-card [&>*]:bg-surface" style={{ gap: 1 }}>
        <CountCell label="Critical" value={brief.counts.critical} tone="crit" />
        <CountCell label="Needs attention" value={brief.counts.attention} tone="high" />
        <CountCell label="Normal" value={brief.counts.normal} tone="ok" hint={brief.counts.dismissed ? `${brief.counts.dismissed} transient dip dismissed` : undefined} />
      </div>

      {brief.quiet && (
        <Card className="mt-5">
          <div className="flex items-start gap-3">
            <Moon size={18} className="mt-0.5 text-ok" />
            <div>
              <div className="text-[15px] font-semibold">A quiet night.</div>
              <p className="mt-1 text-[13.5px] text-ink-2">No signal crossed its threshold long enough to investigate. Nothing was filed and no one was paged.</p>
            </div>
          </div>
        </Card>
      )}

      {h && inv && (
        <section className="mt-5 overflow-hidden rounded-xl border border-line bg-surface shadow-card">
          <div className={cx('h-1', h.severity === 'critical' ? 'bg-crit' : h.severity === 'high' ? 'bg-high' : 'bg-med')} />
          <div className="p-5 sm:p-6">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={h.severity === 'critical' ? 'crit' : 'high'} className="font-semibold tracking-wide">
                {h.severity === 'critical' ? 'RED ALERT' : h.severity.toUpperCase()}
              </Badge>
              <SeverityBadge severity={h.severity} />
              {brief.escalations.map((e) => (
                <Badge key={e} tone="neutral">{e}</Badge>
              ))}
            </div>
            <h2 className="mt-3 text-[24px] font-semibold tracking-[-0.02em] sm:text-[28px]">
              {h.metricName} {h.changePct < 0 ? 'dropped' : 'rose'} {fmtPct(Math.abs(h.changePct)).replace('+', '')}.
            </h2>
            <p className="mt-2 max-w-3xl text-[15px] text-ink-2">“{h.statement}”</p>
            <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
              <div className="flex items-center gap-2 text-[13px] text-ink-3">
                Confidence <ConfidenceMeter value={h.confidence} band={inv.confidenceBand} />
              </div>
              <div className="text-[13px] text-ink-3">Onset {fmtTime(inv.onsetAt!)} · investigated in {fmtDuration(inv.durationSeconds ?? 0)}</div>
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              <Link to={`/investigations/${inv.id}`} className="inline-flex h-8.5 items-center gap-1.5 rounded-lg bg-ink px-3 text-[13px] font-medium text-canvas hover:opacity-90">
                Open investigation <ArrowRight size={14} />
              </Link>
              {headTasks.map((t) => (
                <Link key={t.id} to={`/tasks?open=${t.id}`} className="inline-flex h-8.5 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium hover:bg-subtle">
                  {t.kind === 'incident' ? 'Incident draft' : 'Task'} <span className="font-mono text-[12px]">{t.id}</span>
                </Link>
              ))}
              {pending.length > 0 && (
                <Link to="/approvals" className="inline-flex h-8.5 items-center gap-1.5 rounded-lg border border-high/30 bg-high-soft px-3 text-[13px] font-medium text-high hover:opacity-90">
                  <ShieldCheck size={14} /> {pending.length} awaiting your approval
                </Link>
              )}
            </div>
          </div>

          {brief.evidence.length > 0 && (
            <div className="border-t border-line px-5 py-5 sm:px-6">
              <Eyebrow className="mb-3">Evidence</Eyebrow>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                {brief.evidence.map((e) => (
                  <div key={e.label} className="rounded-lg border border-line bg-canvas/60 p-3">
                    <div className="truncate text-[12px] text-ink-3">{e.label}</div>
                    <div className={cx('tabular mt-1 text-[18px] font-semibold tracking-tight', e.tone === 'bad' ? 'text-crit' : 'text-ink')}>{e.value}</div>
                    <SourceChip source={e.source} className="mt-1.5" />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid border-t border-line md:grid-cols-2">
            <div className="p-5 sm:p-6 md:border-r md:border-line">
              <Eyebrow className="mb-3">What JAGR did</Eyebrow>
              <ul className="space-y-2">
                {brief.did.map((d) => (
                  <li key={d} className="flex items-start gap-2.5 text-[13.5px]">
                    <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-ok-soft text-ok">
                      <Check size={11} strokeWidth={3} />
                    </span>
                    {d}
                  </li>
                ))}
              </ul>
            </div>
            <div className="border-t border-line p-5 sm:p-6 md:border-t-0">
              <Eyebrow className="mb-3">What JAGR did not do</Eyebrow>
              {brief.didNot.length === 0 ? (
                <p className="text-[13px] text-ink-3">No consequential actions were recommended.</p>
              ) : (
                <ul className="space-y-3">
                  {brief.didNot.map((d) => (
                    <NotDoneRow key={d.label} item={d} approval={approvals.find((a) => a.id === d.approvalId)} />
                  ))}
                </ul>
              )}
              {brief.didNot.length > 0 && (
                <p className="mt-4 rounded-lg bg-subtle px-3 py-2 text-[12.5px] text-ink-2">
                  <span className="font-medium text-ink">Reason:</span> these actions require human approval. JAGR never changes production, payments or customer communication on its own.
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      {others.length > 0 && (
        <section className="mt-6">
          <SectionTitle hint="Routed by your escalation policy.">Also needs attention</SectionTitle>
          <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
            {others.map((f) => (
              <Link key={f.investigationId} to={`/investigations/${f.investigationId}`} className="flex flex-col gap-2 border-b border-line px-4 py-3.5 last:border-b-0 hover:bg-subtle sm:flex-row sm:items-center sm:gap-4 sm:px-5">
                <span className="w-20 shrink-0"><SeverityBadge severity={f.severity} /></span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium">{f.title}</div>
                  <div className="text-[12.5px] text-ink-2">{f.summary}</div>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-[12px] text-ink-3">
                  {f.confidence !== undefined && <span className="tabular">{fmtConfidence(f.confidence)} confidence</span>}
                  <Badge>{f.route === 'morning_brief' ? 'Morning brief' : f.route === 'daily_digest' ? 'Daily digest' : f.route === 'immediate' ? 'Escalated' : 'No interruption'}</Badge>
                  <ArrowRight size={14} />
                </div>
              </Link>
            ))}
          </div>
          {dismissed.length > 0 && (
            <p className="mt-2 text-[12.5px] text-ink-3">
              Also looked at and dismissed: {dismissed.map((d) => d.title.toLowerCase()).join(', ')} — recovered on its own with nothing to corroborate it.
            </p>
          )}
        </section>
      )}

      <ProductMetrics run={run} />
    </div>
  );
}

function CountCell({ label, value, tone, hint }: { label: string; value: number; tone: 'crit' | 'high' | 'ok'; hint?: string }) {
  return (
    <div className="px-4 py-4 sm:px-5">
      <div className="flex items-center gap-1.5 text-[12.5px] text-ink-3">
        <span className={cx('size-2 rounded-full', tone === 'crit' ? 'bg-crit' : tone === 'high' ? 'bg-high' : 'bg-ok')} />
        {label}
      </div>
      <div className="tabular mt-1 text-[28px] font-semibold tracking-tight sm:text-[32px]">{value}</div>
      {hint && <div className="hidden text-[11.5px] text-ink-3 sm:block">{hint}</div>}
    </div>
  );
}

function NotDoneRow({ item, approval }: { item: BriefNotDone; approval?: ApprovalRequest }) {
  const status = approval?.status;
  const label =
    status === 'approved' ? 'Approved by you — executed in simulation' : status === 'rejected' ? 'Rejected by you' : status === 'more_evidence_requested' ? 'Not performed — more evidence attached' : item.status;
  return (
    <li className="flex items-start gap-2.5">
      <span className={cx('mt-0.5 grid size-4 shrink-0 place-items-center rounded-full', status === 'approved' ? 'bg-ok-soft text-ok' : 'bg-subtle text-ink-3')}>
        {status === 'approved' ? <Check size={11} strokeWidth={3} /> : <CircleSlash size={11} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium">{item.label}</div>
        <div className="text-[12.5px] text-ink-3">
          {label}
          {approval && ` · ${GATE_LABELS[approval.gatedBy]}`}
        </div>
      </div>
      {approval && (status === 'pending' || status === 'more_evidence_requested') && (
        <Link to={`/approvals#${approval.id}`} className="shrink-0 text-[12.5px] font-medium text-accent hover:underline">
          Review
        </Link>
      )}
    </li>
  );
}

function ProductMetrics({ run }: { run?: OvernightRun }) {
  const { state } = useWorkspace();
  const H = HISTORICAL_STATS;
  const s = run?.stats;
  const runs = H.runs + state.runCount;
  const investigations = H.investigationsCompleted + (s?.investigationsCompleted ?? 0);
  const avg = (H.totalInvestigationSeconds + (s ? s.avgInvestigationSeconds * s.investigationsCompleted : 0)) / Math.max(1, investigations);
  const items = [
    { label: 'Overnight runs', value: runs },
    { label: 'Signals monitored', value: (H.signalsMonitored + (s?.signalsMonitored ?? 0)).toLocaleString('en-US'), hint: `${s?.signalsMonitored ?? 42} per night` },
    { label: 'Anomalies detected', value: H.anomaliesDetected + (s?.anomaliesDetected ?? 0) },
    { label: 'Investigations', value: investigations },
    { label: 'Tasks created', value: H.tasksCreated + (s?.tasksCreated ?? 0) },
    { label: 'Recommendations', value: H.recommendations + (s?.recommendations ?? 0) },
    { label: 'Actions executed', value: H.actionsExecuted + (s?.actionsExecuted ?? 0), hint: 'Low-risk only' },
    { label: 'Approvals requested', value: H.approvalsRequested + (s?.approvalsRequested ?? 0) },
    { label: 'False alerts', value: H.falseAlerts, hint: 'Marked by the team' },
    { label: 'Avg. investigation', value: fmtDuration(avg), hint: 'Detection → conclusion' },
  ];
  return (
    <section className="mt-10">
      <SectionTitle hint={`Demo workspace history · last ${runs} nights${run ? ', including tonight' : ''}.`}>JAGR activity</SectionTitle>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line shadow-card sm:grid-cols-5">
        {items.map((it) => (
          <div key={it.label} className="bg-surface px-4 py-3.5">
            <Stat label={it.label} value={it.value} hint={it.hint} />
          </div>
        ))}
      </div>
    </section>
  );
}
