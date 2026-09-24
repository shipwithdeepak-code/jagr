import { ArrowLeft, ArrowRight, ChevronRight, CircleAlert, GitPullRequest, Telescope } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Action, Evidence, Investigation, OvernightRun, TimelineEntry } from '@/domain/types';
import { SOURCE_LABELS } from '@/domain/defaults';
import { ACTION_CATALOG, GATE_LABELS } from '@/agents/policy';
import { decisionLabel, ownerFor } from '@/agents/actions';
import { fmtConfidence } from '@/lib/format';
import { fmtDuration, fmtTime } from '@/lib/time';
import { allEvents, teamName, useWorkspace } from '@/state/workspace';
import { SeriesChart, type ChartMarker } from '@/components/charts';
import { EvidenceGraph } from '@/components/EvidenceGraph';
import {
  Badge,
  Card,
  ConfidenceMeter,
  cx,
  Drawer,
  EmptyState,
  Eyebrow,
  InvestigationStatusBadge,
  KeyValue,
  Mono,
  PageHeader,
  RiskBadge,
  SectionTitle,
  SeverityBadge,
  SourceChip,
  Tabs,
} from '@/components/ui';
import { CreatedByBadge, PriorityBadge, TaskDraftCard, TaskDrawer, TaskStatusBadge } from '@/components/work';
import { RunButtons } from './Overview';
import { AuditTable } from './Trace';

export function InvestigationsPage() {
  const { state } = useWorkspace();
  const [tab, setTab] = useState<'open' | 'dismissed' | 'all'>('open');
  const run = state.run;
  if (!run) {
    return (
      <>
        <PageHeader title="Investigations" description="Every anomaly Nightwatch looks into, with the evidence, hypotheses and work it produced." />
        <EmptyState icon={Telescope} title="No investigations yet" action={<div className="flex gap-2"><RunButtons /></div>}>
          Investigations open automatically when a signal crosses its threshold and persists. Run the overnight watch to see one.
        </EmptyState>
      </>
    );
  }
  const list = run.investigations.filter((i) => (tab === 'open' ? i.status !== 'dismissed' : tab === 'dismissed' ? i.status === 'dismissed' : true));
  return (
    <>
      <PageHeader
        title="Investigations"
        description="Every anomaly Nightwatch looked into overnight, with the evidence, hypotheses and work it produced."
        actions={<Tabs value={tab} onChange={setTab} items={[{ value: 'open', label: 'Open' }, { value: 'dismissed', label: 'Dismissed' }, { value: 'all', label: 'All' }]} />}
      />
      <Card padded={false} className="overflow-hidden">
        <div className="hidden grid-cols-[110px_1fr_160px_150px_110px_24px] gap-4 border-b border-line bg-subtle/60 px-5 py-2 text-[11.5px] font-medium text-ink-3 md:grid">
          <span>Severity</span>
          <span>Finding</span>
          <span>Confidence</span>
          <span>Owner</span>
          <span>Opened</span>
          <span />
        </div>
        {list.length === 0 && <div className="px-5 py-10 text-center text-[13px] text-ink-3">Nothing here.</div>}
        {list.map((inv) => {
          const leading = inv.hypotheses.find((h) => h.id === inv.leadingHypothesisId);
          return (
            <Link key={inv.id} to={`/investigations/${inv.id}`} className="grid grid-cols-1 gap-2 border-b border-line px-5 py-3.5 last:border-b-0 hover:bg-subtle md:grid-cols-[110px_1fr_160px_150px_110px_24px] md:items-center md:gap-4">
              <span>
                <SeverityBadge severity={inv.severity} />
              </span>
              <span className="min-w-0">
                <span className="block text-[13.5px] font-medium">{inv.title}</span>
                <span className="block truncate text-[12.5px] text-ink-2">{leading ? leading.statement : inv.conclusion}</span>
              </span>
              <span>{inv.status === 'dismissed' ? <InvestigationStatusBadge status={inv.status} /> : <ConfidenceMeter value={inv.confidence} band={inv.confidenceBand} size="sm" />}</span>
              <span className="text-[12.5px] text-ink-2">{leading ? teamName(ownerFor(leading.area, state.settings)) : '—'}</span>
              <span className="tabular text-[12.5px] text-ink-3">{fmtTime(inv.startedAt)}</span>
              <ChevronRight size={14} className="hidden text-ink-3 md:block" />
            </Link>
          );
        })}
      </Card>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Detail
// ─────────────────────────────────────────────────────────────

const SECTIONS = [
  ['problem', 'Problem'],
  ['impact', 'Impact'],
  ['timeline', 'Timeline'],
  ['evidence', 'Evidence'],
  ['hypotheses', 'Hypotheses'],
  ['confidence', 'Confidence'],
  ['releases', 'Related releases'],
  ['support', 'Related support issues'],
  ['reasoning', 'Agent reasoning'],
  ['actions', 'Recommended actions'],
  ['tasks', 'Created tasks'],
  ['approvals', 'Approval requirements'],
  ['audit', 'Audit trail'],
] as const;

export function InvestigationDetailPage() {
  const { id } = useParams();
  const { state } = useWorkspace();
  const run = state.run;
  const inv = run?.investigations.find((i) => i.id === id);
  const [selected, setSelected] = useState<Evidence | null>(null);
  const [openTask, setOpenTask] = useState<string | null>(null);

  if (!run || !inv) {
    return (
      <EmptyState icon={CircleAlert} title="Investigation not found" action={<Link to="/investigations" className="text-[13px] font-medium text-accent">Back to investigations</Link>}>
        It may belong to an earlier run. Investigations are replaced when a new overnight run completes.
      </EmptyState>
    );
  }
  const leading = inv.hypotheses.find((h) => h.id === inv.leadingHypothesisId);
  const primary = run.signals.find((s) => s.id === inv.primarySignalId);
  const actions = run.actions.filter((a) => a.investigationId === inv.id);
  const tasks = state.tasks.filter((t) => t.investigationId === inv.id);
  const drafts = state.drafts.filter((d) => d.investigationId === inv.id);
  const approvals = state.approvals.filter((a) => a.investigationId === inv.id);
  const events = allEvents(state).filter((e) => e.investigationId === inv.id);

  const markers: ChartMarker[] = [
    ...inv.releases.map((r) => ({ at: r.deployedAt, label: r.version, tone: 'release' as const })),
    ...inv.timeline.filter((t) => t.kind === 'experiment').map((t) => ({ at: t.at, label: t.label.split(':')[0], tone: 'experiment' as const })),
    { at: inv.startedAt, label: 'Detected', tone: 'agent' as const },
  ];

  return (
    <div className="animate-fade-up">
      <Link to="/investigations" className="mb-4 inline-flex items-center gap-1 text-[12.5px] text-ink-3 hover:text-ink">
        <ArrowLeft size={13} /> Investigations
      </Link>
      <PageHeader
        eyebrow={
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={inv.severity} />
            <InvestigationStatusBadge status={inv.status} />
            <Mono className="text-ink-3">{inv.id}</Mono>
          </div>
        }
        title={inv.title}
        description={leading ? `${leading.statement}.` : inv.conclusion}
        actions={
          inv.status !== 'dismissed' && (
            <div className="rounded-lg border border-line bg-surface px-3 py-2 shadow-card">
              <div className="text-[11px] text-ink-3">Confidence</div>
              <ConfidenceMeter value={inv.confidence} band={inv.confidenceBand} />
            </div>
          )
        }
      />

      <div className="grid gap-8 xl:grid-cols-[172px_1fr]">
        <nav className="hidden xl:block" aria-label="Sections">
          <ol className="sticky top-20 space-y-0.5 text-[12.5px]">
            {SECTIONS.map(([sid, label], i) => (
              <li key={sid}>
                <a href={`#${sid}`} onClick={(e) => { e.preventDefault(); document.getElementById(sid)?.scrollIntoView({ behavior: 'smooth' }); }} className="flex gap-2 rounded-md px-2 py-1 text-ink-2 hover:bg-subtle hover:text-ink">
                  <span className="tabular w-4 text-ink-3">{i + 1}</span>
                  {label}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="min-w-0 space-y-8">
          {/* 1 Problem */}
          <section>
            <SectionTitle id="problem">1 · Problem</SectionTitle>
            <Card>
              <p className="text-[14.5px] leading-relaxed">{inv.problem}</p>
              <KeyValue
                className="mt-4"
                items={[
                  { k: 'Detected', v: `${fmtTime(inv.startedAt)} (onset ${fmtTime(inv.onsetAt ?? inv.startedAt)})` },
                  { k: 'Playbook', v: { purchase_funnel: 'Purchase funnel', activation: 'Activation', generic: 'General', transient_check: 'Transient re-check' }[inv.playbook] },
                  { k: 'Investigation time', v: inv.durationSeconds !== undefined ? fmtDuration(inv.durationSeconds) : '—' },
                  { k: 'Sources queried', v: <span className="flex flex-wrap gap-3">{inv.sourcesQueried.map((s) => <SourceChip key={s} source={s} className="text-ink-2" />)}</span> },
                  ...(inv.sourcesUnavailable.length ? [{ k: 'Unavailable', v: <span className="text-high">{inv.sourcesUnavailable.map((s) => SOURCE_LABELS[s]).join(', ')} — not guessed</span> }] : []),
                  { k: 'Escalation', v: { immediate: 'Immediate (on-call notified)', morning_brief: 'Morning brief', daily_digest: 'Daily digest', none: 'No interruption' }[inv.escalation] },
                ]}
              />
            </Card>
          </section>

          {/* 2 Impact */}
          <section>
            <SectionTitle id="impact">2 · Impact</SectionTitle>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              {inv.impact.map((m) => (
                <Card key={m.label}>
                  <div className="truncate text-[12px] text-ink-3">{m.label}</div>
                  <div className="tabular mt-1 text-[20px] font-semibold tracking-tight">{m.value}</div>
                  {m.detail && <div className="mt-0.5 text-[12px] text-ink-3">{m.detail}</div>}
                </Card>
              ))}
            </div>
          </section>

          {/* 3 Timeline */}
          <section>
            <SectionTitle id="timeline" hint="30-minute buckets against the same hours on the previous 28 nights.">3 · Timeline</SectionTitle>
            <Card>
              {primary && (
                <SeriesChart points={primary.series} baseline={primary.baseline.mean} stdDev={primary.baseline.stdDev} thresholdPct={primary.thresholdPct} badDirection={primary.badDirection} unit={primary.unit} markers={markers} label={primary.name} />
              )}
              <Timeline entries={mergeTimeline(inv, run)} />
            </Card>
          </section>

          {/* 4 Evidence */}
          <section>
            <SectionTitle id="evidence" hint={`${inv.evidence.length} observations from ${new Set(inv.evidence.map((e) => e.source)).size} sources. Every hypothesis weight points at one of these.`}>4 · Evidence</SectionTitle>
            <Card>
              <EvidenceGraph inv={inv} onSelect={setSelected} selectedId={selected?.id} />
            </Card>
            <div className="mt-3 overflow-hidden rounded-xl border border-line bg-surface shadow-card">
              {inv.evidence.map((e) => (
                <button key={e.id} onClick={() => setSelected(e)} className="flex w-full items-start gap-3 border-b border-line px-4 py-3 text-left last:border-b-0 hover:bg-subtle">
                  <StanceDot stance={e.stance} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium">{e.title}</span>
                    <span className="block text-[12.5px] text-ink-2">{e.detail}</span>
                  </span>
                  <SourceChip source={e.source} className="shrink-0" />
                </button>
              ))}
            </div>
          </section>

          {/* 5 Hypotheses */}
          <section>
            <SectionTitle id="hypotheses" hint="Candidates are generated from the evidence, then scored. The model can propose; it never grades itself.">5 · Hypotheses</SectionTitle>
            {inv.hypotheses.length === 0 ? (
              <Card><p className="text-[13px] text-ink-2">No hypotheses — this was a transient check.</p></Card>
            ) : (
              <div className="space-y-2">
                {inv.hypotheses.map((h) => (
                  <details key={h.id} className="group rounded-xl border border-line bg-surface shadow-card" open={h.id === inv.leadingHypothesisId}>
                    <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
                      <ChevronRight size={14} className="shrink-0 text-ink-3 transition-transform group-open:rotate-90" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13.5px] font-medium">{h.statement}</span>
                        <span className="text-[12px] text-ink-3">
                          {h.id === inv.leadingHypothesisId ? 'Leading' : h.status === 'ruled_out' ? 'Ruled out' : 'Alternative'} · {h.weights.filter((w) => w.weight > 0).length} for, {h.weights.filter((w) => w.weight < 0).length} against · proposed by {h.proposedBy}
                        </span>
                      </span>
                      <span className="w-28 shrink-0">
                        <span className="block h-1.5 overflow-hidden rounded-full bg-muted">
                          <span className={cx('block h-full rounded-full', h.id === inv.leadingHypothesisId ? 'bg-ink' : 'bg-ink-3')} style={{ width: `${Math.max(1, h.confidence * 100)}%` }} />
                        </span>
                      </span>
                      <span className="tabular w-10 shrink-0 text-right text-[13px] font-semibold">{fmtConfidence(h.confidence)}</span>
                    </summary>
                    <div className="border-t border-line px-4 py-3">
                      <div className="mb-2 text-[12px] text-ink-3">Prior {h.prior.toFixed(2)} · score {h.score.toFixed(2)} (log-odds)</div>
                      <ul className="space-y-1.5">
                        {[...h.weights].sort((a, b) => b.weight - a.weight).map((w) => {
                          const e = inv.evidence.find((x) => x.id === w.evidenceId);
                          return (
                            <li key={w.evidenceId} className="grid grid-cols-[52px_1fr] gap-3 text-[12.5px]">
                              <span className={cx('tabular font-mono font-medium', w.weight > 0 ? 'text-ok' : 'text-crit')}>{w.weight > 0 ? '+' : ''}{w.weight.toFixed(2)}</span>
                              <span>
                                <button className="font-medium hover:underline" onClick={() => e && setSelected(e)}>{e?.title}</button>
                                <span className="text-ink-3"> — {w.reason}</span>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  </details>
                ))}
              </div>
            )}
          </section>

          {/* 6 Confidence */}
          <section>
            <SectionTitle id="confidence">6 · Confidence</SectionTitle>
            <ConfidenceCard inv={inv} />
          </section>

          {/* 7 Releases */}
          <section>
            <SectionTitle id="releases">7 · Related releases</SectionTitle>
            {inv.releases.length === 0 ? (
              <Card><p className="text-[13px] text-ink-2">{inv.sourcesUnavailable.includes('github') ? 'GitHub was unavailable during this investigation — releases were not checked.' : 'No production release in the window before onset.'}</p></Card>
            ) : (
              inv.releases.map((r) => (
                <Card key={r.version} padded={false} className="overflow-hidden">
                  <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
                    <Badge tone="accent">{r.version}</Badge>
                    <span className="text-[13px]">Deployed {fmtTime(r.deployedAt)}</span>
                    <span className="text-[12.5px] text-ink-3">{r.services.join(', ')}</span>
                    <SourceChip source="github" className="ml-auto" />
                  </div>
                  <ul>
                    {r.pullRequests.map((p) => (
                      <li key={p.number} className={cx('flex items-start gap-3 border-b border-line px-4 py-2.5 last:border-b-0', p.relevant && 'bg-crit-soft/40')}>
                        <GitPullRequest size={14} className={cx('mt-0.5 shrink-0', p.relevant ? 'text-crit' : 'text-ink-3')} />
                        <span className="min-w-0 flex-1">
                          <span className="text-[13px] font-medium">#{p.number} {p.title}</span>
                          <span className="block truncate font-mono text-[11.5px] text-ink-3">{p.files.join('  ')}</span>
                        </span>
                        <span className="shrink-0 text-right text-[12px] text-ink-3">
                          merged {fmtTime(p.mergedAt)}
                          <br />@{p.author}
                        </span>
                        {p.relevant && <Badge tone="crit">Touches affected area</Badge>}
                      </li>
                    ))}
                  </ul>
                </Card>
              ))
            )}
          </section>

          {/* 8 Support */}
          <section>
            <SectionTitle id="support">8 · Related support issues</SectionTitle>
            {inv.tickets.length === 0 ? (
              <Card><p className="text-[13px] text-ink-2">No related support tickets since onset.</p></Card>
            ) : (
              <Card padded={false} className="overflow-hidden">
                {inv.tickets.map((t) => (
                  <div key={t.id} className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
                    <Mono className="text-ink-3">{t.id}</Mono>
                    <span className="min-w-0 flex-1 text-[13px]">{t.subject}</span>
                    {t.mentions.map((m) => <Badge key={m} tone="crit">{m === 'klarna' ? 'Klarna' : m}</Badge>)}
                    <span className="text-[12px] text-ink-3">{t.channel} · {t.plan} · {fmtTime(t.createdAt)}</span>
                  </div>
                ))}
              </Card>
            )}
          </section>

          {/* 9 Reasoning */}
          <section>
            <SectionTitle id="reasoning" hint={`Generated by ${run.reasoningEngine}. Each line restates an observation that moved the score.`}>9 · Agent reasoning summary</SectionTitle>
            <Card>
              <ol className="space-y-2.5">
                {inv.reasoning.map((r, i) => (
                  <li key={i} className="grid grid-cols-[20px_1fr] gap-2 text-[13.5px] leading-relaxed">
                    <span className="tabular text-ink-3">{i + 1}.</span>
                    <span className={r.startsWith('Against:') ? 'text-crit' : ''}>{r}</span>
                  </li>
                ))}
              </ol>
            </Card>
          </section>

          {/* 10 Actions */}
          <section>
            <SectionTitle id="actions" hint="Every candidate action is risk-classified, then checked against the autonomy policy.">10 · Recommended actions</SectionTitle>
            {actions.length === 0 ? (
              <Card><p className="text-[13px] text-ink-2">No actions — {inv.status === 'dismissed' ? 'the fluctuation recovered on its own.' : 'nothing to do.'}</p></Card>
            ) : (
              <Card padded={false} className="overflow-hidden">
                {actions.map((a) => <ActionRow key={a.id} a={a} />)}
              </Card>
            )}
          </section>

          {/* 11 Tasks */}
          <section>
            <SectionTitle id="tasks">11 · Created tasks</SectionTitle>
            <div className="space-y-3">
              {tasks.map((t) => (
                <button key={t.id} onClick={() => setOpenTask(t.id)} className="flex w-full flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left shadow-card hover:border-line-strong">
                  <Mono className="text-ink-3">{t.id}</Mono>
                  <span className="min-w-0 flex-1 text-[13.5px] font-medium">{t.title}</span>
                  <PriorityBadge p={t.priority} />
                  <TaskStatusBadge status={t.status} />
                  <CreatedByBadge by={t.createdBy} />
                  {t.kind === 'incident' && <Badge tone="crit">Incident draft</Badge>}
                  <ArrowRight size={14} className="text-ink-3" />
                </button>
              ))}
              {drafts.map((d) => <TaskDraftCard key={d.fingerprint} draft={d} />)}
              {tasks.length === 0 && drafts.length === 0 && (
                <Card><p className="text-[13px] text-ink-2">{inv.status === 'dismissed' ? 'No task — a recovered fluctuation is not work.' : 'No task created.'}</p></Card>
              )}
            </div>
          </section>

          {/* 12 Approvals */}
          <section>
            <SectionTitle id="approvals">12 · Approval requirements</SectionTitle>
            {approvals.length === 0 ? (
              <Card><p className="text-[13px] text-ink-2">No consequential actions were requested for this finding.</p></Card>
            ) : (
              <Card padded={false} className="overflow-hidden">
                {approvals.map((a) => (
                  <Link key={a.id} to={`/approvals#${a.id}`} className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-b-0 hover:bg-subtle">
                    <span className="min-w-0 flex-1 text-[13.5px] font-medium">{a.title}</span>
                    <RiskBadge risk={a.risk} />
                    <Badge>{GATE_LABELS[a.gatedBy]}</Badge>
                    <Badge tone={a.status === 'approved' ? 'ok' : a.status === 'rejected' ? 'neutral' : 'high'}>
                      {a.status === 'pending' ? 'HUMAN APPROVAL REQUIRED' : a.status === 'more_evidence_requested' ? 'More evidence attached' : a.status === 'approved' ? 'Approved' : 'Rejected'}
                    </Badge>
                    <ArrowRight size={14} className="text-ink-3" />
                  </Link>
                ))}
              </Card>
            )}
          </section>

          {/* 13 Audit */}
          <section>
            <SectionTitle id="audit" hint="Every tool call, decision and human response for this finding.">13 · Audit trail</SectionTitle>
            <AuditTable events={events} />
          </section>
        </div>
      </div>

      <EvidenceDrawer evidence={selected} inv={inv} run={run} onClose={() => setSelected(null)} />
      <TaskDrawer task={state.tasks.find((t) => t.id === openTask) ?? null} onClose={() => setOpenTask(null)} />
    </div>
  );
}

function StanceDot({ stance }: { stance: Evidence['stance'] }) {
  return <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', stance === 'supports' ? 'bg-ok' : stance === 'contradicts' ? 'bg-crit' : stance === 'gap' ? 'bg-high' : 'bg-line-strong')} title={stance} />;
}

function mergeTimeline(inv: Investigation, run: OvernightRun): TimelineEntry[] {
  const agent: TimelineEntry[] = run.events
    .filter((e) => e.investigationId === inv.id && (e.stage === 'investigate' || (e.stage === 'act' && e.status === 'ok' && !e.routine) || e.stage === 'approval' || e.stage === 'confidence'))
    .map((e) => ({ at: e.at, label: `${e.action}${e.stage === 'confidence' ? ` — ${e.result}` : ''}`, kind: 'agent', source: 'nightwatch' }));
  return [...inv.timeline, ...agent].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function Timeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <ol className="mt-5 border-l border-line pl-4">
      {entries.map((t, i) => (
        <li key={i} className="relative pb-2.5 text-[13px] last:pb-0">
          <span className={cx('absolute top-1.5 -left-[20.5px] size-2 rounded-full ring-2 ring-surface', t.kind === 'release' || t.kind === 'pr' ? 'bg-accent' : t.kind === 'agent' ? 'bg-ink' : t.kind === 'metric' ? 'bg-crit' : t.kind === 'experiment' ? 'bg-high' : 'bg-ink-3')} />
          <span className="tabular mr-2 font-mono text-[12px] text-ink-3">{fmtTime(t.at)}</span>
          <span className={t.kind === 'agent' ? 'text-ink-2' : ''}>{t.label}</span>
          <span className="ml-2 text-[11.5px] text-ink-3">{t.source === 'nightwatch' ? 'Nightwatch' : SOURCE_LABELS[t.source]}</span>
        </li>
      ))}
    </ol>
  );
}

function ConfidenceCard({ inv }: { inv: Investigation }) {
  if (inv.status === 'dismissed') {
    return <Card><p className="text-[13px] text-ink-2">Not scored. The metric recovered before the persistence rule was met, so Nightwatch recorded a re-check instead of a finding.</p></Card>;
  }
  const leading = inv.hypotheses.find((h) => h.id === inv.leadingHypothesisId) ?? inv.hypotheses[0];
  const alt = inv.hypotheses.filter((h) => h !== leading).reduce((a, h) => a + h.confidence, 0);
  const unexplained = 1 - inv.hypotheses.reduce((a, h) => a + h.confidence, 0);
  const supporting = leading?.weights.filter((w) => w.weight > 0.05) ?? [];
  const sources = new Set(supporting.map((w) => inv.evidence.find((e) => e.id === w.evidenceId)?.source));
  return (
    <Card>
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="tabular text-[32px] font-semibold tracking-tight">{inv.confidenceBand === 'insufficient' ? '—' : fmtConfidence(inv.confidence)}</span>
        <span className="text-[14px] capitalize text-ink-2">{inv.confidenceBand === 'insufficient' ? 'Insufficient evidence' : `${inv.confidenceBand} confidence`}</span>
      </div>
      <div className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-muted">
        <span className="bg-ink" style={{ width: `${(leading?.confidence ?? 0) * 100}%` }} title="Leading hypothesis" />
        <span className="bg-ink-3" style={{ width: `${alt * 100}%` }} title="Alternatives" />
        <span className="bg-[repeating-linear-gradient(45deg,var(--line-strong)_0_3px,transparent_3px_6px)]" style={{ width: `${unexplained * 100}%` }} title="Unexplained" />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-3">
        <span>■ Leading {fmtConfidence(leading?.confidence)}</span>
        <span>■ Alternatives {fmtConfidence(alt)}</span>
        <span>▨ Reserved for unobservable causes {fmtConfidence(unexplained)}</span>
      </div>
      <div className="mt-5 grid gap-4 text-[13px] sm:grid-cols-2">
        <div>
          <Eyebrow className="mb-1.5">How it’s computed</Eyebrow>
          <p className="text-ink-2">
            Each hypothesis starts from a prior, then every observation adds or subtracts log-odds according to an explicit likelihood table. Scores are normalised together with a fixed “unexplained” option, so certainty is never 100%.
          </p>
        </div>
        <div>
          <Eyebrow className="mb-1.5">Bands & rules</Eyebrow>
          <ul className="space-y-1 text-ink-2">
            <li>High ≥ 75% · Medium ≥ 55% · Low ≥ 35%</li>
            <li>Needs support from ≥ 2 independent sources ({sources.size} here)</li>
            <li>Below the bar → “Insufficient evidence”, no cause asserted</li>
            <li>Low confidence → task only, no production recommendations</li>
          </ul>
        </div>
      </div>
    </Card>
  );
}

function ActionRow({ a }: { a: Action }) {
  const spec = ACTION_CATALOG[a.type];
  const statusTone = a.status === 'executed' ? 'ok' : a.status === 'pending_approval' ? 'high' : a.status === 'failed' || a.status === 'blocked' ? 'crit' : 'neutral';
  const statusLabel: Record<Action['status'], string> = {
    executed: 'Executed',
    drafted: 'Drafted for you',
    pending_approval: 'Awaiting approval',
    approved: 'Approved',
    rejected: 'Rejected',
    recommended: 'Recommended',
    not_permitted: 'Not permitted',
    failed: 'Failed',
    blocked: 'Blocked by guardrail',
  };
  return (
    <div className="grid gap-2 border-b border-line px-4 py-3 last:border-b-0 md:grid-cols-[1fr_auto] md:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-medium">{a.title}</span>
          <RiskBadge risk={a.risk} />
          <Badge>Level {spec.level}{spec.gatedBy ? ` · ${GATE_LABELS[spec.gatedBy]}` : ''}</Badge>
        </div>
        <div className="mt-0.5 text-[12.5px] text-ink-2">{a.description}</div>
        <div className="mt-0.5 text-[12px] text-ink-3">
          Decision: {decisionLabel(a.decision)} — {a.decisionReason}
          {a.result ? ` · ${a.result}` : ''}
        </div>
      </div>
      <Badge tone={statusTone}>{statusLabel[a.status]}</Badge>
    </div>
  );
}

function EvidenceDrawer({ evidence, inv, run, onClose }: { evidence: Evidence | null; inv: Investigation; run: OvernightRun; onClose: () => void }) {
  const obs = useMemo(() => run.observations.filter((o) => evidence?.observationIds.includes(o.id)), [run, evidence]);
  if (!evidence) return null;
  const weights = inv.hypotheses
    .map((h) => ({ h, w: h.weights.find((w) => w.evidenceId === evidence.id) }))
    .filter((x): x is { h: typeof x.h; w: NonNullable<typeof x.w> } => !!x.w);
  return (
    <Drawer open onClose={onClose} title={evidence.title} subtitle={`${SOURCE_LABELS[evidence.source]} · ${evidence.kind.replace(/_/g, ' ')} · observed ${fmtTime(evidence.observedAt)}`}>
      <div className="flex flex-wrap gap-1.5">
        <Badge tone={evidence.stance === 'supports' ? 'ok' : evidence.stance === 'contradicts' ? 'crit' : evidence.stance === 'gap' ? 'high' : 'neutral'}>{evidence.stance === 'gap' ? 'Source unavailable' : evidence.stance}</Badge>
        <Badge>Strength {Math.round(evidence.strength * 100)}%</Badge>
        {evidence.value && <Badge tone="accent">{evidence.value}</Badge>}
      </div>
      <p className="mt-4 text-[14px] leading-relaxed">{evidence.detail}</p>

      <Eyebrow className="mt-6 mb-2">Effect on each hypothesis</Eyebrow>
      {weights.length === 0 ? (
        <p className="text-[13px] text-ink-3">Context only — no hypothesis weights this observation.</p>
      ) : (
        <ul className="space-y-2">
          {weights.map(({ h, w }) => (
            <li key={h.id} className="rounded-lg border border-line p-2.5 text-[12.5px]">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{h.statement}</span>
                <span className={cx('tabular font-mono font-semibold', w.weight > 0 ? 'text-ok' : 'text-crit')}>{w.weight > 0 ? '+' : ''}{w.weight.toFixed(2)}</span>
              </div>
              <div className="text-ink-3">{w.reason}</div>
            </li>
          ))}
        </ul>
      )}

      <Eyebrow className="mt-6 mb-2">Source data</Eyebrow>
      {obs.length === 0 ? (
        <p className="text-[13px] text-ink-3">{evidence.kind === 'anomaly' ? 'Derived from the analytics series shown in the timeline.' : 'Derived from the current sweep; no separate query.'}</p>
      ) : (
        obs.map((o) => (
          <div key={o.id} className="mb-3 overflow-hidden rounded-lg border border-line">
            <div className="flex items-center justify-between border-b border-line bg-subtle/60 px-3 py-1.5 text-[12px]">
              <Mono>{o.tool}</Mono>
              <span className="text-ink-3">{fmtTime(o.observedAt, true)} · simulation</span>
            </div>
            <dl className="divide-y divide-line">
              {Object.entries(o.data).map(([k, v]) => (
                <div key={k} className="grid grid-cols-[130px_1fr] gap-3 px-3 py-1.5 text-[12px]">
                  <dt className="font-mono text-ink-3">{k}</dt>
                  <dd className="font-mono break-words text-ink">{Array.isArray(v) ? v.join(', ') : String(v)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))
      )}
      <div className="mt-4 text-[12px] text-ink-3">Evidence id <Mono>{evidence.id}</Mono></div>
    </Drawer>
  );
}
