import { ArrowLeft, Check, CircleAlert, HelpCircle, Lock, Search, Eye } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { InvestigationState, WatchInvestigation } from '@/product/types';
import { PROVIDERS } from '@/product/integrations/adapters';
import { AREA_LABEL } from '@/product/catalog';
import { useProduct } from '@/state/productContext';
import { useWorkspace } from '@/state/workspace';
import { fmtTime } from '@/lib/time';
import { AttentionBadge, EmailPreview, InvestigationStateBadge, ProviderName, SourceLinkButton } from '@/components/product';
import { ActionRow, AgentApprovalCard, AgentTraceTimeline, AgentWorkingLine, AttentionDecision, HypothesisCards, PlannerModeLine } from '@/components/agent';
import { effectiveActions, traceWithDecisions } from '@/product/agent/decisions';
import { confidenceBand } from '@/product/engine/monitor';
import { Card, cx, EmptyState, Eyebrow, Mono, PageHeader, SectionTitle } from '@/components/ui';
import type { TaskDraft } from '@/domain/types';

const LIFECYCLE: InvestigationState[] = ['DETECTED', 'INVESTIGATING', 'CONFIRMED'];

const OWNER_TEAM: Record<string, string> = { checkout: 'payments-eng', signup: 'growth', search: 'product', stability: 'platform', general: 'product' };

function taskDraftFor(inv: WatchInvestigation): TaskDraft {
  return {
    investigationId: inv.id,
    kind: 'task',
    title: `Investigate: ${inv.title.toLowerCase().replace(/^./, (c) => c.toUpperCase())}`,
    priority: inv.attention === 'CRITICAL' ? 'P0' : inv.attention === 'HIGH' ? 'P1' : 'P2',
    ownerTeamId: OWNER_TEAM[inv.area] ?? 'product',
    evidenceSourceCount: inv.correlatedProviders.length,
    fingerprint: `watch:${inv.dedupeKey}`,
    description: {
      problem: inv.observed[0] ?? inv.title,
      impact: inv.summary,
      evidence: inv.observed,
      hypothesis: inv.likelyExplanation,
      confidence: `Investigation confidence ${confidenceBand(inv.confidence)} that the problem is real — cause not established`,
      nextStep: inv.recommendedNextStep,
      // The shared tracker uses the demo's source vocabulary; map what has an equivalent.
      sources: [...new Set(inv.correlatedProviders.flatMap((p): TaskDraft['description']['sources'] => (p === 'ga4' ? ['analytics'] : p === 'jira' ? ['issue_tracker'] : p === 'app_store' || p === 'google_play' ? ['support'] : [])))],
    },
  };
}

export function WatchInvestigationPage() {
  const { id } = useParams();
  const { state, running } = useProduct();
  const inv = state.result?.investigations.find((i) => i.id === id);

  if (!inv) {
    return (
      <EmptyState
        icon={CircleAlert}
        title={running ? 'Loading…' : 'Investigation not found'}
        action={<Link to="/investigations" className="text-[13px] font-medium text-accent">Back to investigations</Link>}
      >
        {running ? 'Jagr is running monitoring.' : 'It may belong to a different monitoring run, or to a workspace in another browser. Monitoring results are stored per browser in this demo.'}
      </EmptyState>
    );
  }
  return <Detail inv={inv} />;
}

function Detail({ inv }: { inv: WatchInvestigation }) {
  const { state } = useProduct();
  const { createTaskFromDraft, state: ws } = useWorkspace();
  const [filed, setFiled] = useState<string | null>(ws.tasks.find((t) => t.fingerprint === `watch:${inv.dedupeKey}`)?.id ?? null);
  const watches = inv.watchIds.map((id) => state.watches.find((w) => w.id === id)).filter(Boolean);
  const owner = state.watches.find((w) => w.id === inv.watchId);
  const emails = state.result?.emails.filter((e) => e.investigationId === inv.id) ?? [];
  const reached = new Set(inv.statusHistory.map((h) => h.state));
  const ended = inv.status === 'DISMISSED' || inv.status === 'RESOLVED';

  const actions = effectiveActions(inv, state.decisions);
  const trace = traceWithDecisions(inv, state.decisions);
  const approvals = actions.filter((a) => a.risk === 'HIGH' || a.risk === 'CRITICAL');
  const fileTask = async () => {
    if (filed) return;
    const task = await createTaskFromDraft(taskDraftFor(inv));
    if (task) setFiled(task.id);
  };

  return (
    <div className="animate-fade-up">
      <Link to="/investigations" className="mb-4 inline-flex items-center gap-1 text-[12.5px] text-ink-3 hover:text-ink">
        <ArrowLeft size={13} /> Investigations
      </Link>
      <PageHeader
        eyebrow={
          <div className="flex flex-wrap items-center gap-2">
            <AttentionBadge level={inv.attention} />
            <InvestigationStateBadge state={inv.status} />
            <span className="text-[12px] text-ink-3">{watches.map((w) => w!.name).join(' + ')}</span>
            <Mono className="text-ink-3">{inv.id}</Mono>
          </div>
        }
        title={inv.title}
        description={inv.summary}
        actions={
          <div className="rounded-lg border border-line bg-surface px-3 py-2 shadow-card" title="Confidence that the problem is real — not that any explanation is the cause.">
            <div className="text-[11px] text-ink-3">Investigation confidence</div>
            <div className="text-[18px] font-semibold capitalize">{confidenceBand(inv.confidence)}</div>
          </div>
        }
      />

      {/* Lifecycle */}
      <Card className="mb-6">
        <div className="flex flex-wrap items-center gap-2">
          {LIFECYCLE.map((s, i) => {
            const h = inv.statusHistory.find((x) => x.state === s);
            return (
              <div key={s} className="flex items-center gap-2">
                {i > 0 && <span className="h-px w-6 bg-line-strong" />}
                <span className={cx('inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium', reached.has(s) ? 'bg-accent-soft text-accent' : 'bg-subtle text-ink-3')}>
                  {reached.has(s) && <Check size={12} />}
                  {s}
                  {h && <span className="tabular font-mono text-[11px] opacity-80">{fmtTime(h.at)}</span>}
                </span>
              </div>
            );
          })}
          {ended && (
            <>
              <span className="h-px w-6 bg-line-strong" />
              <span className="rounded-md bg-ok-soft px-2 py-1 text-[12px] font-medium text-ok">
                {inv.status} {fmtTime(inv.completedAt!)}
              </span>
            </>
          )}
          <span className="ml-auto">
            <AgentWorkingLine inv={inv} />
          </span>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-6">
          {/* Observed / Inferred / Unknown */}
          <section>
            <SectionTitle hint="Jagr keeps what it saw, what it concluded from that, and what it doesn't know strictly apart.">Observed · Inferred · Unknown</SectionTitle>
            <div className="grid gap-3 md:grid-cols-3">
              <Column icon={Eye} title="Observed" tone="ink" items={inv.observed} hint="Facts from the sources" />
              <Column icon={Search} title="Inferred" tone="accent" items={inv.inferred} hint="Jagr's reading of the facts" />
              <Column icon={HelpCircle} title="Unknown" tone="high" items={inv.unknowns} hint="Not established or not checked" />
            </div>
          </section>

          <section>
            <SectionTitle>Likely explanation</SectionTitle>
            <Card>
              <p className="text-[14.5px] leading-relaxed">{inv.likelyExplanation}</p>
              <div className="mt-3 rounded-lg bg-subtle px-3 py-2 text-[13px] text-ink-2">
                <span className="font-medium text-ink">Uncertainty:</span> {inv.uncertainty}
              </div>
            </Card>
          </section>

          <section>
            <SectionTitle hint="Every explanation Jagr kept open, with the evidence for and against it. None is presented as the cause.">Hypotheses</SectionTitle>
            <HypothesisCards hypotheses={inv.agentHypotheses} evidence={inv.evidence} />
          </section>

          {actions.length > 0 && (
            <section id="actions">
              <SectionTitle hint="Risk decides autonomy: LOW Jagr does · MEDIUM Jagr recommends · HIGH prepared + notify · CRITICAL approval.">Actions</SectionTitle>
              <Card padded={false} className="overflow-hidden">
                {actions.map((a) => (
                  <ActionRow key={a.id} action={a} onDo={a.kind === 'create_jira_task' || a.kind === 'create_jira_incident' ? fileTask : undefined} />
                ))}
              </Card>
              {filed && (
                <Link to={`/tasks?open=${filed}`} className="mt-2 inline-block text-[12.5px] font-medium text-accent hover:underline">
                  Task {filed} filed in the simulated tracker — view in Tasks
                </Link>
              )}
              {approvals.length > 0 && (
                <div className="mt-4 space-y-4">
                  {approvals.map((a) => (
                    <AgentApprovalCard key={a.id} action={a} />
                  ))}
                </div>
              )}
            </section>
          )}

          <section id="trace">
            <SectionTitle hint="Signal → planner proposes → policy validates → tool call → evidence → hypotheses → stop → attention → action. Every pass, every call.">Agent trace</SectionTitle>
            <div className="mb-2">
              <PlannerModeLine info={state.result?.planner} />
            </div>
            <AgentTraceTimeline steps={trace} connections={state.result?.connections ?? state.connections} />
          </section>

          <section>
            <SectionTitle hint="Each item links to the record it came from.">Evidence across sources</SectionTitle>
            <Card padded={false} className="overflow-hidden">
              {inv.evidence.map((e) => (
                <div key={e.id} className="flex flex-wrap items-start gap-3 border-b border-line px-4 py-3 last:border-b-0">
                  <span
                    className={cx(
                      'mt-1.5 size-2 shrink-0 rounded-full',
                      e.direction === 'degraded' ? 'bg-crit' : e.direction === 'change' ? 'bg-accent' : e.direction === 'gap' ? 'bg-high' : 'bg-ok',
                    )}
                    title={e.direction}
                  />
                  <span className="min-w-0 flex-1 text-[13px]">
                    {e.statement}
                    <span className="ml-2 text-[11.5px] text-ink-3">{e.direction === 'gap' ? 'source gap' : e.direction === 'change' ? 'change' : e.direction}</span>
                  </span>
                  {e.link && <SourceLinkButton link={e.link} compact />}
                </div>
              ))}
            </Card>
          </section>

          <section>
            <SectionTitle hint={`${inv.runs.length} scheduled checks were merged into this one investigation instead of opening duplicates.`}>Run history &amp; deduplication</SectionTitle>
            <Card padded={false} className="max-h-72 overflow-y-auto">
              {inv.runs.map((r, i) => (
                <div key={i} className="grid grid-cols-[52px_1fr] gap-3 border-b border-line px-4 py-2 text-[12.5px] last:border-b-0">
                  <span className="tabular font-mono text-ink-3">{fmtTime(r.at)}</span>
                  <span className={r.watchId !== inv.watchId ? 'text-accent' : r.anomalous ? '' : 'text-ink-3'}>{r.note}</span>
                </div>
              ))}
            </Card>
          </section>
        </div>

        <aside className="space-y-6">
          <AttentionDecision inv={inv} interruptAt={owner?.notificationPolicy.interruptAt} />
          <Card>
            <Eyebrow className="mb-2">Recommended next step</Eyebrow>
            <p className="text-[14px] font-medium">{inv.recommendedNextStep}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {inv.sourceLinks.slice(0, 6).map((l) => (
                <SourceLinkButton key={l.href} link={l} compact />
              ))}
            </div>
            <div className="mt-3 flex items-center gap-1.5 border-t border-line pt-3 text-[12px] text-ink-3">
              <Lock size={11} /> Rollbacks, pricing, refunds and customer messages need human approval — Jagr won’t do them.
            </div>
          </Card>

          <Card>
            <Eyebrow className="mb-2">Correlated sources</Eyebrow>
            <ul className="space-y-1.5 text-[13px]">
              {Object.keys(PROVIDERS)
                .filter((p) => p !== 'email')
                .map((p) => {
                  const hit = inv.correlatedProviders.includes(p as never);
                  const gap = inv.evidence.some((e) => e.provider === p && e.direction === 'gap');
                  const out = !owner?.sources.includes(p as never);
                  return (
                    <li key={p} className="flex items-center justify-between gap-2">
                      <ProviderName provider={p as never} />
                      <span className={cx('text-[12px]', hit ? 'font-medium text-crit' : gap ? 'text-high' : 'text-ink-3')}>{hit ? 'Degraded' : gap ? 'Unavailable' : out ? 'Not in watch' : 'No change'}</span>
                    </li>
                  );
                })}
            </ul>
            {inv.releaseAssociation && (
              <p className="mt-3 border-t border-line pt-3 text-[12.5px] text-ink-2">
                Release <span className="font-medium text-ink">{inv.releaseAssociation.version}</span> shipped {inv.releaseAssociation.minutesBeforeOnset} min before onset — temporal association only.
              </p>
            )}
          </Card>

          <section>
            <Eyebrow className="mb-2">{emails.length ? 'Email sent' : 'Notification'}</Eyebrow>
            {emails.length ? (
              emails.map((e) => <EmailPreview key={e.id} email={e} />)
            ) : (
              <Card>
                <p className="text-[13px] text-ink-2">
                  No email — {inv.attention === 'LOW' ? 'a fluctuation is not worth an interruption.' : `${inv.attention} findings go to the morning brief (this watch interrupts at ${owner?.notificationPolicy.interruptAt}).`}
                </p>
              </Card>
            )}
          </section>
          <p className="text-[12px] text-ink-3">
            Area: {AREA_LABEL[inv.area]} · dedupe key <Mono>{inv.dedupeKey}</Mono>
          </p>
        </aside>
      </div>
    </div>
  );
}

function Column({ icon: Icon, title, items, hint, tone }: { icon: typeof Eye; title: string; items: string[]; hint: string; tone: 'ink' | 'accent' | 'high' }) {
  return (
    <Card>
      <div className={cx('flex items-center gap-1.5 text-[13px] font-semibold', tone === 'accent' ? 'text-accent' : tone === 'high' ? 'text-high' : 'text-ink')}>
        <Icon size={14} /> {title}
      </div>
      <div className="mb-2 text-[11.5px] text-ink-3">{hint}</div>
      <ul className="space-y-2 text-[12.5px] leading-snug">
        {items.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </Card>
  );
}
