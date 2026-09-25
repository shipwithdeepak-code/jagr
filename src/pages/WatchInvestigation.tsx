import { ArrowLeft, ChevronRight, CircleAlert, Lock } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { WatchInvestigation } from '@/product/types';
import { useProduct } from '@/state/productContext';
import { useWorkspace } from '@/state/workspace';
import { fmtTime } from '@/lib/time';
import { attentionRoute, EmailPreview, ProviderName } from '@/components/product';
import { ActionRow, AgentApprovalCard, AgentTraceTimeline, HypothesisList, PlannerModeLine } from '@/components/agent';
import { AttentionBanner, LoadingState, MetricValue, StatusBadge } from '@/components/primitives';
import { effectiveActions, traceWithDecisions } from '@/product/agent/decisions';
import { confidenceBand } from '@/product/engine/monitor';
import { EmptyState, Mono } from '@/components/ui';
import type { TaskDraft } from '@/domain/types';
import { buildEvidenceChain } from '@/product/view/evidenceChain';
import { canonicalReading, findingState, investigationTitle, investigationWatches } from '@/product/view/investigation';
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
        {running ? 'Jagr is running monitoring.' : 'It may belong to an earlier monitoring run, or to another workspace. Open Investigations to see this workspace’s current ones.'}
      </EmptyState>
    );
  }
  return <Detail inv={inv} />;
}

/** One part of the incident document: a heading that says what the part answers, then its content. */
function Part({ id, title, hint, children }: { id: string; title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-20 border-t border-line pt-6 first:border-t-0 first:pt-0">
      <h2 id={`${id}-h`} className="text-[16px] font-semibold tracking-tight">
        {title}
      </h2>
      {hint && <p className="mt-0.5 max-w-2xl text-[13px] text-ink-2">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * The investigation as an incident document, in the order a PM needs it:
 *   what happened → why it matters → evidence → what Jagr infers → what is not known → what to do.
 * Each fact, the recommendation and each approval appear once. How Jagr worked (replay, full trace,
 * run history) is available but collapsed — nobody should have to read it to understand the incident.
 */
function Detail({ inv }: { inv: WatchInvestigation }) {
  const { state, runMonitoring, running, location } = useProduct();
  const { createTaskFromDraft, state: ws } = useWorkspace();
  const [filed, setFiled] = useState<string | null>(ws.tasks.find((t) => t.fingerprint === `watch:${inv.dedupeKey}`)?.id ?? null);
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

  const title = investigationTitle(inv);
  const status = findingState(inv);
  const reading = canonicalReading(inv);
  const chain = buildEvidenceChain(inv, state.decisions);
  const at = (s: string) => inv.statusHistory.find((h) => h.state === s)?.at;
  const calls = inv.trace.filter((s) => s.kind === 'tool_call');
  const checked = [...new Set(calls.flatMap((s) => s.sources ?? [s.source]).filter((p): p is NonNullable<typeof p> => !!p))];
  const gaps = inv.evidence.filter((e) => e.direction === 'gap');
  const lead = inv.signals[0];
  const related = inv.signals.slice(1);
  const times: [string, string | undefined][] = [
    ['Began', lead.onsetAt],
    ['Detected', at('DETECTED') ?? inv.startedAt],
    ['Updated', inv.updatedAt],
    [inv.status === 'RESOLVED' ? 'Resolved' : inv.status === 'DISMISSED' ? 'Dismissed' : '', inv.completedAt],
  ];
  const hypotheses = inv.agentHypotheses.filter((h) => h.status !== 'ruled_out');

  return (
    <div className="animate-fade-up space-y-6">
      <Link to="/investigations" className="interactive inline-flex items-center gap-1 text-[13px] text-ink-3 hover:text-ink">
        <ArrowLeft size={13} aria-hidden /> Investigations
      </Link>

      <AttentionBanner level={inv.attention}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px]">
          <StatusBadge kind="attention" value={inv.attention} size="md" />
          <span className="font-medium text-ink">{status.signal}</span>
          <span className="text-ink-2">{status.cause}</span>
        </div>
        <h1 className="mt-3 text-[28px] leading-tight font-semibold tracking-[-0.02em] text-balance">{title}</h1>
        <p className="mt-1 text-[13px] text-ink-3">{investigationWatches(inv, state.watches)}</p>
        {reading && (
          <div className="mt-3">
            <MetricValue baseline={reading.baseline} current={reading.current} change={`${reading.change} vs baseline`} size="lg" />
          </div>
        )}
        <dl className="num mt-4 flex flex-wrap gap-x-6 gap-y-1.5 text-[13px]">
          {times
            .filter(([k, v]) => k && v)
            .map(([k, v]) => (
              <div key={k} className="flex items-baseline gap-1.5">
                <dt className="text-ink-3">{k}</dt>
                <dd className="font-medium text-ink">{fmtTime(v!)} UTC</dd>
              </div>
            ))}
        </dl>
      </AttentionBanner>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 space-y-8">
          <Part id="what-happened" title="What happened">
            {reading ? (
              <>
                <p className="text-[16px] text-ink">
                  {reading.metric} {reading.change.startsWith('+') ? 'rose' : 'fell'} from <span className="num font-medium">{reading.baseline}</span> to <span className="num font-medium">{reading.current}</span> ({reading.change}).
                </p>
                <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-[auto_1fr]">
                  <dt className="text-ink-3">Observed</dt>
                  <dd className="num">
                    {reading.current}
                    {reading.asOf && <span className="text-ink-3"> · as of {fmtTime(reading.asOf)} UTC</span>}
                  </dd>
                  <dt className="text-ink-3">Baseline</dt>
                  <dd className="num">
                    {reading.baseline}
                    {reading.baselineWindow && <span className="text-ink-3"> · {reading.baselineWindow.charAt(0).toLowerCase() + reading.baselineWindow.slice(1)}</span>}
                  </dd>
                  <dt className="text-ink-3">Period</dt>
                  <dd className="num">Since {fmtTime(reading.since)} UTC</dd>
                </dl>
              </>
            ) : (
              <p className="text-[16px] text-ink">
                {lead.label} {lead.magnitude} <span className="text-ink-3">· since {fmtTime(lead.onsetAt)} UTC</span>
              </p>
            )}
            {related.length > 0 && (
              <div className="mt-4">
                <h3 className="text-[13px] font-medium text-ink-2">Related signals</h3>
                <ul className="mt-1 space-y-0.5 text-[14px]">
                  {related.map((sig) => (
                    <li key={`${sig.key}:${sig.provider}:${sig.area}`}>
                      {sig.label} {sig.magnitude} <span className="text-ink-3">· <ProviderName provider={sig.provider} short /> · since {fmtTime(sig.onsetAt)} UTC</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Part>

          <Part id="why" title="Why it matters">
            <p className="text-[14px] text-ink">{inv.attentionReason}</p>
            <p className="mt-1 text-[13px] text-ink-2">{attentionRoute(inv.attention, owner?.notificationPolicy.interruptAt)}.</p>
          </Part>

          <Part id="evidence" title="Evidence" hint="What the sources show. Every fact names its source and links to the record.">
            <EvidenceChain chain={chain} stateOf={stateOf} stages={['observed', 'correlated']} label="Evidence" />
          </Part>

          <Part id="inferred" title="What Jagr infers" hint="Jagr’s reading of the facts above — not established fact.">
            <EvidenceChain chain={chain} stateOf={stateOf} stages={['inferred', 'assumed']} label="Inferences and assumptions" />
          </Part>

          <Part id="unknown" title="What is not known" hint="What the evidence does not establish, and what could not be checked.">
            <EvidenceChain chain={chain} stateOf={stateOf} stages={['unknown']} label="Unknowns" />
            {hypotheses.length > 0 && (
              <div className="mt-5">
                <h3 className="text-[13px] font-medium text-ink-2">Possible explanations</h3>
                <p className="mb-2 text-[13px] text-ink-3">Strength is how much independent evidence lines up — not the probability it is the cause.</p>
                <HypothesisList hypotheses={inv.agentHypotheses} evidence={inv.evidence} />
              </div>
            )}
          </Part>

          <Part id="what-to-do" title="What to do">
            <p className="text-[16px] font-medium text-ink">{inv.recommendedNextStep}</p>
            {actions.length > 0 && (
              <div className="mt-4 overflow-hidden rounded-lg border border-line bg-surface">
                {actions.map((a) => (
                  <ActionRow key={a.id} action={a} onDo={a.kind === 'create_work_item' || a.kind === 'create_incident' ? fileTask : undefined} />
                ))}
              </div>
            )}
            {filed && (
              <Link to={`/tasks?open=${filed}`} className="mt-2 inline-block text-[13px] font-medium text-accent hover:underline">
                Task {filed} filed{location === 'browser' ? ' in the simulated tracker' : ''} — view in Tasks
              </Link>
            )}
            {approvals.length > 0 && (
              <div className="mt-4 space-y-4">
                {approvals.map((a) => (
                  <AgentApprovalCard key={a.id} action={a} />
                ))}
              </div>
            )}
            <p className="mt-3 flex items-start gap-1.5 text-[13px] text-ink-3">
              <Lock size={12} aria-hidden className="mt-0.5 shrink-0" /> Rollbacks, pricing, refunds and customer messages always need a person’s approval.
            </p>
          </Part>

          <details className="group border-t border-line pt-6">
            <summary className="interactive flex cursor-pointer list-none items-center gap-2 rounded text-[16px] font-semibold tracking-tight hover:text-ink [&::-webkit-details-marker]:hidden">
              <ChevronRight size={16} aria-hidden className="text-ink-3 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
              How Jagr investigated
              <span className="text-[13px] font-normal text-ink-3">
                {calls.length} tool calls · {inv.runs.length} checks
              </span>
            </summary>
            <div className="mt-5 space-y-8">
              <section aria-label="Replay">
                <h3 className="mb-2 text-[14px] font-semibold">Replay</h3>
                <InvestigationReplay inv={inv} decisions={state.decisions} onRunAgain={() => void runMonitoring()} running={running} />
              </section>
              <section aria-label="Agent trace">
                <h3 className="text-[14px] font-semibold">Agent trace</h3>
                <p className="mb-2 text-[13px] text-ink-2">Every planner decision, validator verdict, tool call and result, as recorded.</p>
                <div className="mb-3">
                  <PlannerModeLine info={state.result?.planner} />
                </div>
                <AgentTraceTimeline steps={trace} connections={connections} />
              </section>
              <section aria-label="Run history">
                <h3 className="text-[14px] font-semibold">Run history</h3>
                <p className="mb-2 text-[13px] text-ink-2">{inv.runs.length} scheduled checks were merged into this investigation instead of opening duplicates.</p>
                <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
                  {inv.runs.map((r, i) => (
                    <div key={i} className="grid grid-cols-[64px_1fr] gap-3 border-b border-line px-3 py-1.5 text-[13px] last:border-b-0">
                      <span className="num text-ink-3">{fmtTime(r.at)} UTC</span>
                      <span className={r.watchId !== inv.watchId ? 'text-accent' : r.anomalous ? 'text-ink-2' : 'text-ink-3'}>{r.note}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-[12px] text-ink-3">
                  Investigation <Mono>{inv.id}</Mono> · dedupe key <Mono>{inv.dedupeKey}</Mono>
                </p>
              </section>
              {emails.length > 0 && (
                <section aria-label="Alert">
                  <h3 className="mb-2 text-[14px] font-semibold">Alert</h3>
                  <div className="space-y-4">
                    {emails.map((e) => (
                      <EmailPreview key={e.id} email={e} />
                    ))}
                  </div>
                </section>
              )}
            </div>
          </details>
        </div>

        {/* The record: status and scope at a glance. Nothing here repeats the document. */}
        <aside aria-label="Investigation record" className="lg:order-none">
          <dl className="sticky top-20 space-y-3 rounded-lg border border-line bg-surface p-4 text-[13px]">
            <Fact k="Signal">{status.signal}</Fact>
            <Fact k="Cause">{status.cause}</Fact>
            <Fact k="Confidence" title="How sure Jagr is that the signal is real — not that any explanation is the cause.">
              {status.confidence}
              <span className="block text-[12px] text-ink-3">that the signal is real</span>
            </Fact>
            <Fact k="Checked">
              {checked.length} source{checked.length === 1 ? '' : 's'} · {calls.length} tool calls
              <span className="mt-0.5 flex flex-wrap gap-x-2 text-[12px] text-ink-2">
                {checked.map((p) => (
                  <ProviderName key={p} provider={p} short />
                ))}
              </span>
              {gaps.length > 0 && <span className="block text-[12px] text-ink-2">{gaps.length} could not be checked</span>}
            </Fact>
            {waiting.length > 0 && (
              <Fact k="Waiting for you">
                <a href={`#approve-${waiting[0].id}`} className="font-medium text-accent hover:underline">
                  {waiting.length} approval{waiting.length === 1 ? '' : 's'}
                </a>
              </Fact>
            )}
          </dl>
        </aside>
      </div>
    </div>
  );
}

function Fact({ k, title, children }: { k: string; title?: string; children: ReactNode }) {
  return (
    <div title={title}>
      <dt className="text-[12px] text-ink-3">{k}</dt>
      <dd className="mt-0.5 text-ink">{children}</dd>
    </div>
  );
}
