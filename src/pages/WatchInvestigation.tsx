import { ArrowLeft, ChevronDown, CircleAlert, Lock } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { WatchInvestigation } from '@/product/types';
import { useProduct } from '@/state/productContext';
import { useWorkspace } from '@/state/workspace';
import { fmtTime } from '@/lib/time';
import { attentionRoute, EmailPreview, ProviderName, SourceLinkButton } from '@/components/product';
import { ActionRow, AgentApprovalCard, AgentTraceTimeline, HypothesisList, PlannerModeLine } from '@/components/agent';
import { AttentionBanner, EvidenceItem, LoadingState, MetricValue, SectionHeader, StatusBadge } from '@/components/primitives';
import { effectiveActions, traceWithDecisions } from '@/product/agent/decisions';
import { confidenceBand } from '@/product/engine/monitor';
import { EmptyState, Mono } from '@/components/ui';
import type { TaskDraft } from '@/domain/types';
import { headlineOf, readingOf } from '@/product/presentation';
import { buildEvidenceChain } from '@/product/view/evidenceChain';
import { EvidenceChain } from '@/components/evidenceChain';
import { InvestigationReplay } from '@/components/replay';
import { BUILTIN_SOURCE_ROLES } from '@/product/catalog';
import { isSourceId } from '@/product/roles/types';

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
      sources: [
        ...new Set(
          inv.correlatedProviders.flatMap((p): TaskDraft['description']['sources'] => {
            const roles = isSourceId(p) ? BUILTIN_SOURCE_ROLES[p] : [];
            return roles.includes('feedback') ? ['support'] : roles.includes('work_items') ? ['issue_tracker'] : roles.includes('metrics') ? ['analytics'] : [];
          }),
        ),
      ],
    },
  };
}

export function WatchInvestigationPage() {
  const { id } = useParams();
  const { state, running } = useProduct();
  const inv = state.result?.investigations.find((i) => i.id === id);

  if (!inv && running) return <LoadingState label="Jagr is investigating…" />;
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

function Details({ summary, children, defaultOpen = false }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="group rounded-xl border border-line bg-surface">
      <summary className="interactive flex cursor-pointer list-none items-center gap-2 rounded-xl px-4 py-3 text-[13px] font-medium hover:bg-subtle/60 [&::-webkit-details-marker]:hidden">
        <ChevronDown size={14} className="text-ink-3 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
        {summary}
      </summary>
      <div className="border-t border-line p-4">{children}</div>
    </details>
  );
}

function Detail({ inv }: { inv: WatchInvestigation }) {
  const { state, runMonitoring, running } = useProduct();
  const { createTaskFromDraft, state: ws } = useWorkspace();
  const [filed, setFiled] = useState<string | null>(ws.tasks.find((t) => t.fingerprint === `watch:${inv.dedupeKey}`)?.id ?? null);
  const watches = inv.watchIds.map((id) => state.watches.find((w) => w.id === id)).filter(Boolean);
  const owner = state.watches.find((w) => w.id === inv.watchId);
  const emails = state.result?.emails.filter((e) => e.investigationId === inv.id) ?? [];
  const connections = state.result?.connections ?? state.connections;
  const stateOf = (p: string) => connections.find((c) => c.provider === p)?.state;

  const actions = effectiveActions(inv, state.decisions);
  const trace = traceWithDecisions(inv, state.decisions);
  const approvals = actions.filter((a) => a.risk === 'HIGH' || a.risk === 'CRITICAL');
  const waiting = approvals.filter((a) => a.effective === 'awaiting_approval');
  const fileTask = async () => {
    if (filed) return;
    const task = await createTaskFromDraft(taskDraftFor(inv));
    if (task) setFiled(task.id);
  };

  const reading = readingOf(inv);
  const at = (s: string) => inv.statusHistory.find((h) => h.state === s)?.at;
  const calls = inv.trace.filter((s) => s.kind === 'tool_call');
  const checked = [...new Set(calls.flatMap((s) => s.sources ?? [s.source]).filter((p): p is NonNullable<typeof p> => !!p))];
  const gaps = inv.evidence.filter((e) => e.direction === 'gap');
  const band = confidenceBand(inv.confidence);

  const decision = (
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">Likely explanation</div>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink">{inv.likelyExplanation}</p>
        <p className="mt-2 text-[12.5px] text-ink-2">
          <span className="font-medium text-ink">Uncertainty.</span> {inv.uncertainty}
        </p>
      </div>
      <div className="rounded-xl border border-ink/15 bg-surface p-4">
        <div className="text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">Recommended next step</div>
        <p className="mt-1.5 text-[14px] font-medium text-ink">{inv.recommendedNextStep}</p>
        {waiting.length > 0 && (
          <a href={`#approve-${waiting[0].id}`} className="interactive mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg bg-ink px-3 text-[12.5px] font-medium text-canvas hover:opacity-90">
            Review {waiting.length} approval{waiting.length === 1 ? '' : 's'}
          </a>
        )}
        <p className="mt-3 flex items-start gap-1.5 text-[11.5px] text-ink-3">
          <Lock size={11} className="mt-0.5 shrink-0" /> Rollbacks, pricing, refunds and customer messages always need a human.
        </p>
      </div>
    </div>
  );

  return (
    <div className="animate-fade-up space-y-6">
      <Link to="/investigations" className="interactive inline-flex items-center gap-1 text-[12.5px] text-ink-3 hover:text-ink">
        <ArrowLeft size={13} /> Investigations
      </Link>

      <AttentionBanner level={inv.attention}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-ink-3">
          <StatusBadge kind="attention" value={inv.attention} size="md" />
          <span className="font-medium text-ink-2">{inv.status.charAt(0) + inv.status.slice(1).toLowerCase()}</span>
          <span>{watches.map((w) => w!.name).join(' + ')}</span>
          <Mono className="text-ink-3">{inv.id}</Mono>
        </div>
        <h1 className="mt-3 text-[26px] leading-tight font-semibold tracking-[-0.02em] sm:text-[30px]">{headlineOf(inv)}</h1>
        {reading && (
          <div className="mt-2">
            <MetricValue baseline={reading.baseline} current={reading.current} change={`${reading.change} vs baseline`} size="lg" />
          </div>
        )}
        <dl className="num mt-4 flex flex-wrap gap-x-6 gap-y-2 text-[12px]">
          {[
            ['Began', inv.signals[0].onsetAt],
            ['Detected', at('DETECTED')],
            ['Investigated', at('INVESTIGATING')],
            ['Confirmed', at('CONFIRMED')],
            [inv.status === 'RESOLVED' ? 'Resolved' : inv.status === 'DISMISSED' ? 'Dismissed' : '', inv.completedAt],
          ]
            .filter(([k, v]) => k && v)
            .map(([k, v]) => (
              <div key={k} className="flex items-baseline gap-1.5">
                <dt className="text-ink-3">{k}</dt>
                <dd className="font-mono font-medium text-ink">{fmtTime(v!)} UTC</dd>
              </div>
            ))}
          <div className="flex items-baseline gap-1.5">
            <dt className="text-ink-3">Investigation confidence</dt>
            <dd className="font-medium text-ink capitalize" title="Confidence that the problem is real — not that any explanation is the cause.">
              {band}
            </dd>
          </div>
        </dl>
      </AttentionBanner>

      {/* The three questions a PM asks first. One surface, not three cards. */}
      <section aria-label="Summary" className="grid overflow-hidden rounded-xl border border-line bg-surface md:grid-cols-3 md:divide-x md:divide-line max-md:divide-y max-md:divide-line">
        <div className="p-4">
          <div className="text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">What changed</div>
          <p className="mt-1.5 text-[14px] font-semibold text-ink">
            {inv.signals[0].label} {inv.signals[0].magnitude}
          </p>
          <p className="mt-1 text-[12.5px] text-ink-2">
            since {fmtTime(inv.signals[0].onsetAt)} UTC{inv.signals.length > 1 ? ` · ${inv.signals.length - 1} related signal${inv.signals.length > 2 ? 's' : ''}` : ''}
          </p>
        </div>
        <div className="p-4">
          <div className="text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">Why it matters</div>
          <p className="mt-1.5 text-[13px] text-ink">{inv.attentionReason}</p>
          <p className="mt-1 text-[12.5px] text-ink-2">{attentionRoute(inv.attention, owner?.notificationPolicy.interruptAt)}</p>
        </div>
        <div className="p-4">
          <div className="text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">What Jagr checked</div>
          <p className="num mt-1.5 text-[14px] font-semibold text-ink">
            {calls.length} tool calls · {checked.length} source{checked.length === 1 ? '' : 's'}
          </p>
          <p className="mt-1 flex flex-wrap gap-x-2 text-[12.5px] text-ink-2">
            {checked.map((p) => (
              <ProviderName key={p} provider={p} short />
            ))}
            {gaps.length > 0 && <span className="text-high">· {gaps.length} not checked</span>}
          </p>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-8">
          <section aria-label="Evidence chain">
            <SectionHeader title="Evidence chain" hint="From the signal to the decision: what Jagr observed, what it could correlate, what it infers, what it doesn’t know — and what waits for you. Every item shows where it came from." />
            <EvidenceChain chain={buildEvidenceChain(inv, state.decisions)} stateOf={stateOf} />
          </section>

          <section aria-label="Investigation replay">
            <SectionHeader title="How Jagr investigated" hint="Step through the recorded investigation — each planner decision, tool call, piece of evidence and conclusion, exactly as it happened." />
            <InvestigationReplay inv={inv} decisions={state.decisions} onRunAgain={() => void runMonitoring()} running={running} />
          </section>

          <section>
            <SectionHeader title="Hypotheses" hint="Every explanation Jagr kept open. Strength is how much independent evidence lines up — not the probability it is the cause." />
            <HypothesisList hypotheses={inv.agentHypotheses} evidence={inv.evidence} />
          </section>

          <div className="lg:hidden">{decision}</div>

          <section>
            <SectionHeader title="All evidence" count={inv.evidence.length} hint="Every record Jagr gathered, including checks that came back normal and sources it could not read." />
            <div className="divide-y divide-line rounded-xl border border-line bg-surface px-4">
              {inv.evidence.map((e) => (
                <EvidenceItem key={e.id} evidence={e} source={<ProviderName provider={e.provider} short />} state={stateOf(e.provider)} action={e.link ? <SourceLinkButton link={e.link} compact /> : undefined} />
              ))}
            </div>
          </section>

          {actions.length > 0 && (
            <section id="actions">
              <SectionHeader title="Actions" hint="Risk decides autonomy — LOW: Jagr does it · MEDIUM: Jagr recommends · HIGH: prepared, waits for you · CRITICAL: approval required." />
              <div className="overflow-hidden rounded-xl border border-line bg-surface">
                {actions.map((a) => (
                  <ActionRow key={a.id} action={a} onDo={a.kind === 'create_work_item' || a.kind === 'create_incident' ? fileTask : undefined} />
                ))}
              </div>
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
            <SectionHeader title="Agent trace" hint="Every planner decision, validator verdict, tool call and result — recorded as Jagr worked." />
            <div className="mb-3">
              <PlannerModeLine info={state.result?.planner} />
            </div>
            <AgentTraceTimeline steps={trace} connections={connections} />
          </section>

          <Details summary={<span>Notification, run history &amp; deduplication <span className="font-normal text-ink-3">· {emails.length ? '1 email sent' : 'no email'} · {inv.runs.length} checks merged</span></span>}>
            <div className="space-y-5">
              {emails.length ? (
                emails.map((e) => <EmailPreview key={e.id} email={e} />)
              ) : (
                <p className="text-[13px] text-ink-2">No email — {inv.attention === 'LOW' ? 'a fluctuation is not worth an interruption.' : `${inv.attention} findings go to the morning brief (this watch interrupts at ${owner?.notificationPolicy.interruptAt}).`}</p>
              )}
              <div>
                <div className="mb-2 text-[12px] font-medium text-ink-2">{inv.runs.length} scheduled checks were merged into this one investigation instead of opening duplicates.</div>
                <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
                  {inv.runs.map((r, i) => (
                    <div key={i} className="grid grid-cols-[52px_1fr] gap-3 border-b border-line px-3 py-1.5 text-[12px] last:border-b-0">
                      <span className="num font-mono text-ink-3">{fmtTime(r.at)}</span>
                      <span className={r.watchId !== inv.watchId ? 'text-accent' : r.anomalous ? 'text-ink-2' : 'text-ink-3'}>{r.note}</span>
                    </div>
                  ))}
                </div>
              </div>
              <p className="text-[12px] text-ink-3">
                Dedupe key <Mono>{inv.dedupeKey}</Mono>
              </p>
            </div>
          </Details>
        </div>

        <aside className="hidden lg:block">
          <div className="sticky top-20">{decision}</div>
        </aside>
      </div>
    </div>
  );
}
