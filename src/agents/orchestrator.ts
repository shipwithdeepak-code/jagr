import type { AdapterSet, IssueTrackerAdapter } from '@/adapters/types';
import type {
  Action,
  ApprovalRequest,
  ConfidenceBand,
  Hypothesis,
  Investigation,
  InvestigationStatus,
  MetricBaseline,
  MetricDefinition,
  OvernightRun,
  RunStats,
  Signal,
  Task,
  TaskDraft,
  Team,
  WorkspaceSettings,
} from '@/domain/types';
import { fmtConfidence, fmtPct, fmtMetric, plural } from '@/lib/format';
import { addMinutes, BUCKET_MINUTES, fmtTime, minutesBetween } from '@/lib/time';
import { buildTaskDraft, determineAndExecute, planActions, refreshApproval, type ActionOutcome, type DecideOptions } from './actions';
import { generateMorningBrief } from './brief';
import { callTool, createRunContext, type RunContext } from './context';
import { clusterAnomalies, evaluateSignal, isWatched, signalsRelated, type AnomalyCluster } from './detection';
import { gatherEvidence, makeEvidence, type InvestigationScope } from './evidence';
import { applyStances, evaluateConfidence, scoreHypotheses, unexplainedMass } from './hypotheses';
import type { ReasoningEngine } from './reasoning';

/**
 * The overnight orchestrator.
 *
 *   collectSignals → detectAnomalies → prioritizeSignals → investigateSignal
 *     → gatherEvidence → generateHypotheses → evaluateConfidence → assessRisk
 *     → determineAction → createTask / createIncident / requestApproval → generateMorningBrief
 *
 * Runs a sweep every 30 minutes of simulated time from the start of the watch to the brief.
 */

export interface RunOptions {
  runId: string;
  scenario: { id: string; name: string };
  nightStart: string;
  buckets: number;
  settings: WorkspaceSettings;
  teams: Team[];
  adapters: AdapterSet;
  reasoner: ReasoningEngine;
  decide?: DecideOptions;
}

interface RunState {
  defs: MetricDefinition[];
  baselines: Map<string, MetricBaseline>;
  investigations: Investigation[];
  actions: Action[];
  approvals: ApprovalRequest[];
  tasks: Task[];
  drafts: TaskDraft[];
  watching: Map<string, Signal>;
  everAnomalous: Set<string>;
  latest: Signal[];
}

// ─────────────────────────────────────────────────────────────
// Stage functions
// ─────────────────────────────────────────────────────────────

export async function collectSignals(ctx: RunContext, st: RunState, asOf: string): Promise<Signal[] | null> {
  const res = await callTool(
    ctx,
    { tool: 'analytics.getSeries', source: 'analytics', stage: 'collect', action: `Collected signals`, input: `${st.defs.length} metrics · ${fmtTime(ctx.nightStart)}–${fmtTime(asOf)}`, routine: true },
    async () =>
      Promise.all(
        st.defs.map(async (d) => {
          const series = await ctx.adapters.analytics.getSeries(d.id, { start: ctx.nightStart, end: asOf });
          const watched = isWatched(d, ctx.settings);
          const s = evaluateSignal(d, series, st.baselines.get(d.id)!, ctx.settings.thresholds[d.category], asOf, watched);
          return watched ? s : { ...s, status: 'normal' as const, severity: 'normal' as const, note: 'Not watched' };
        }),
      ),
    (v) => `${v.filter((s) => s.watched).length} signals collected`,
  );
  return res.ok ? res.value : null;
}

export interface Detection {
  newAnomalies: Signal[];
  attach: { signal: Signal; investigation: Investigation }[];
  newWatches: Signal[];
  recovered: Signal[];
}

export function detectAnomalies(signals: Signal[], st: RunState): Detection {
  const covered = new Set(st.investigations.filter((i) => i.status !== 'dismissed').flatMap((i) => i.signalIds));
  const watched = signals.filter((s) => s.watched);
  const anomalous = watched.filter((s) => s.status === 'anomalous' && !covered.has(s.id));
  const attach: Detection['attach'] = [];
  const newAnomalies: Signal[] = [];
  for (const s of anomalous) {
    const inv = st.investigations.find(
      (i) => i.status !== 'dismissed' && i.signalIds.some((id) => {
        const other = signals.find((x) => x.id === id);
        return other ? signalsRelated(other, s, st.defs) : false;
      }),
    );
    if (inv) attach.push({ signal: s, investigation: inv });
    else newAnomalies.push(s);
  }
  const newWatches = watched.filter((s) => s.status === 'watching' && !covered.has(s.id) && !st.watching.has(s.metricId));
  const recovered = [...st.watching.values()]
    .map((w) => signals.find((s) => s.metricId === w.metricId)!)
    .filter((s) => s && s.status === 'normal');
  return { newAnomalies, attach, newWatches, recovered };
}

export function prioritizeSignals(anomalies: Signal[], defs: MetricDefinition[]): AnomalyCluster[] {
  return clusterAnomalies(anomalies, defs);
}

function surfaces(scope: InvestigationScope) {
  return [...new Set(scope.members.map((m) => scope.defs.find((d) => d.id === m.metricId)?.surface).filter((s): s is NonNullable<typeof s> => !!s))];
}

function statusFor(band: ConfidenceBand): InvestigationStatus {
  return band === 'insufficient' ? 'insufficient_evidence' : band === 'low' ? 'low_confidence' : 'concluded';
}

function buildReasoning(inv: Investigation, leading: Hypothesis | undefined, assessmentReason: string, primary: Signal): string[] {
  const out: string[] = [];
  out.push(
    `${primary.name} moved ${fmtPct(primary.changePct)} (${fmtMetric(primary.current, primary.unit)} vs ${fmtMetric(primary.baseline.mean, primary.unit)}) and held for at least three consecutive 30-minute buckets — past the ${primary.thresholdPct}% threshold and ${Math.abs(primary.zScore).toFixed(1)}σ from normal nights.`,
  );
  if (inv.status === 'insufficient_evidence' || !leading) {
    out.push(...inv.evidence.filter((e) => e.kind !== 'anomaly').map((e) => e.detail));
    const best = inv.hypotheses[0];
    out.push(
      best
        ? `No explanation cleared the bar. The best candidate — "${best.statement}" — reaches ${fmtConfidence(best.confidence)}. ${assessmentReason}`
        : `No candidate explanations could be formed. ${assessmentReason}`,
    );
    out.push('Nightwatch will not assert a cause without evidence. It will keep monitoring and include this in the digest.');
    return out;
  }
  const weighted = [...leading.weights].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  const seen = new Set<string>();
  for (const w of weighted) {
    if (Math.abs(w.weight) < 0.15) continue;
    const e = inv.evidence.find((x) => x.id === w.evidenceId);
    if (!e || seen.has(e.id) || e.kind === 'anomaly') continue;
    seen.add(e.id);
    out.push(w.weight < 0 ? `Against: ${e.detail}` : e.detail);
    if (seen.size >= 6) break;
  }
  const alts = inv.hypotheses.filter((h) => h.id !== leading.id).slice(0, 3);
  if (alts.length) out.push(`Alternatives considered: ${alts.map((h) => `${h.statement} (${fmtConfidence(h.confidence)})`).join('; ')}.`);
  out.push(
    `Confidence ${fmtConfidence(inv.confidence)} (${inv.confidenceBand}): ${assessmentReason} ${fmtConfidence(unexplainedMass(inv.hypotheses))} is reserved for causes Nightwatch cannot observe.`,
  );
  return out;
}

/** Evidence → hypotheses → confidence. Shared by first investigation and the pre-brief refresh. */
async function reason(ctx: RunContext, inv: Investigation, scope: InvestigationScope) {
  const bundle = await gatherEvidence(ctx, scope);

  const res = await callTool(
    ctx,
    { tool: 'reasoner.proposeHypotheses', source: 'analytics', stage: 'hypothesis', action: 'Generated hypotheses', input: `${bundle.evidence.length} evidence items`, investigationId: inv.id },
    () => ctx.reasoner.proposeHypotheses(bundle.evidence, { primaryName: scope.primary.name, primaryArea: scope.primary.area, surfaces: surfaces(scope) }),
    (v) => `${v.candidates.length} candidates (${v.engine})${v.notes.length ? ` · ${v.notes.join(' ')}` : ''}`,
  );
  const candidates = res.ok ? res.value.candidates : [];
  const hypotheses = scoreHypotheses(candidates, bundle.evidence);
  const leadingCandidate = hypotheses[0];
  const assessment = evaluateConfidence(leadingCandidate, bundle.evidence);
  const leading = assessment.band === 'insufficient' ? undefined : leadingCandidate;
  // With no qualifying hypothesis, nothing "supports" anything — evidence is context only.
  const evidence = applyStances(bundle.evidence, leading);

  return { bundle, hypotheses, assessment, leading, evidence };
}

export async function investigateSignal(ctx: RunContext, st: RunState, cluster: AnomalyCluster, opts: RunOptions): Promise<Investigation> {
  const { primary, members } = cluster;
  const onsetAt = members.map((m) => m.onsetAt!).filter(Boolean).sort()[0] ?? primary.observedAt;
  const inv: Investigation = {
    id: ctx.nextId('inv'),
    runId: ctx.runId,
    title: `${primary.name} ${fmtPct(primary.changePct)}`,
    primarySignalId: primary.id,
    signalIds: members.map((m) => m.id),
    severity: cluster.severity,
    status: 'investigating',
    playbook: 'generic',
    startedAt: ctx.clock.now(),
    onsetAt,
    problem: '',
    impact: [],
    evidence: [],
    hypotheses: [],
    confidenceBand: 'insufficient',
    conclusion: '',
    reasoning: [],
    timeline: [],
    actionIds: [],
    taskIds: [],
    approvalIds: [],
    relatedReleaseIds: [],
    relatedTicketIds: [],
    releases: [],
    tickets: [],
    sourcesQueried: [],
    sourcesUnavailable: [],
    escalation: ctx.settings.escalation[cluster.severity === 'normal' ? 'low' : cluster.severity],
    fingerprint: primary.metricId,
  };
  st.investigations.push(inv);

  ctx.clock.advance(2);
  ctx.log({
    stage: 'investigate',
    action: `Opened investigation: ${inv.title}`,
    result: `${cluster.severity.toUpperCase()} · ${plural(members.length, 'related signal')} · onset ${fmtTime(onsetAt)}`,
    status: cluster.severity === 'critical' ? 'warning' : 'info',
    investigationId: inv.id,
  });

  if (!ctx.settings.autonomy.investigate) {
    inv.status = 'insufficient_evidence';
    inv.conclusion = 'Investigation is turned off in the autonomy policy. Nightwatch reported the anomaly only.';
    inv.reasoning = [inv.conclusion];
    inv.problem = `${primary.name} moved ${fmtPct(primary.changePct)}.`;
    inv.impact = [{ label: primary.name, value: fmtPct(primary.changePct), detail: `${fmtMetric(primary.current, primary.unit)} vs ${fmtMetric(primary.baseline.mean, primary.unit)} baseline` }];
    inv.concludedAt = ctx.clock.now();
    return inv;
  }

  const scope: InvestigationScope = { investigation: inv, primary, members, defs: st.defs, allSignals: st.latest, onsetAt, asOf: ctx.clock.now() };
  await conclude(ctx, st, inv, scope, opts, false);
  return inv;
}

async function conclude(ctx: RunContext, st: RunState, inv: Investigation, scope: InvestigationScope, opts: RunOptions, refresh: boolean) {
  const before = { confidence: inv.confidence, evidence: inv.evidence.length, tickets: inv.relatedTicketIds.length, leading: inv.leadingHypothesisId };
  const { bundle, hypotheses, assessment, leading, evidence } = await reason(ctx, inv, scope);

  inv.playbook = bundle.playbook;
  inv.evidence = evidence;
  inv.hypotheses = hypotheses;
  inv.leadingHypothesisId = leading?.id;
  inv.confidence = hypotheses[0]?.confidence;
  inv.confidenceBand = assessment.band;
  inv.status = statusFor(assessment.band);
  inv.severity = scope.members.reduce((m, s) => (rank(s.severity) > rank(m) ? s.severity : m), inv.severity);
  inv.impact = bundle.impact;
  inv.timeline = bundle.timeline;
  inv.relatedReleaseIds = bundle.relatedReleaseIds;
  inv.relatedTicketIds = bundle.relatedTicketIds;
  inv.releases = bundle.releases;
  inv.tickets = bundle.tickets;
  inv.sourcesQueried = [...bundle.sourcesQueried];
  inv.sourcesUnavailable = [...bundle.sourcesUnavailable];
  inv.fingerprint = `${scope.primary.metricId}:${leading?.id ?? 'unexplained'}`;
  inv.problem = `${scope.primary.name} fell from ${fmtMetric(scope.primary.baseline.mean, scope.primary.unit)} to ${fmtMetric(scope.primary.current, scope.primary.unit)} (${fmtPct(scope.primary.changePct)}), starting in the ${fmtTime(inv.onsetAt!)} bucket, and has not recovered.`
    .replace('fell from', scope.primary.badDirection === 'up' ? 'rose from' : 'fell from');
  inv.conclusion = leading
    ? `${leading.statement}. Confidence ${fmtConfidence(inv.confidence)} (${assessment.band}).`
    : 'Insufficient evidence.';
  inv.reasoning = buildReasoning(inv, leading, assessment.reason, scope.primary);
  inv.concludedAt = ctx.clock.now();
  if (!refresh) inv.durationSeconds = minutesBetween(inv.startedAt, inv.concludedAt) * 60;

  ctx.clock.advance(3);
  ctx.log({
    stage: 'hypothesis',
    action: leading ? 'Correlated evidence and ranked hypotheses' : 'Correlated evidence — no hypothesis cleared the bar',
    result: leading ? `Leading: ${leading.statement}` : `Insufficient evidence (best candidate ${fmtConfidence(hypotheses[0]?.confidence)})`,
    status: leading ? 'ok' : 'warning',
    investigationId: inv.id,
  });
  ctx.log({
    stage: 'confidence',
    action: refresh ? 'Re-evaluated confidence' : 'Evaluated confidence',
    result: leading
      ? `Confidence: ${fmtConfidence(inv.confidence)} (${assessment.band})${refresh && before.confidence !== undefined && Math.round(before.confidence * 100) !== Math.round((inv.confidence ?? 0) * 100) ? ` — was ${fmtConfidence(before.confidence)}` : ''}`
      : 'Insufficient evidence — no conclusion asserted',
    status: leading ? 'ok' : 'warning',
    input: assessment.reason,
    investigationId: inv.id,
  });

  // Actions: first pass plans everything; refresh only adds what's new and updates filed issues.
  const existingKeys = new Set(st.actions.filter((a) => a.investigationId === inv.id).map((a) => `${a.type}:${a.target ?? ''}`));
  const candidates = planActions(inv, leading);
  const outcome: ActionOutcome = await determineAndExecute(ctx, inv, leading, candidates, ctx.teams, { ...opts.decide, skipTypes: existingKeys });
  record(st, inv, outcome);

  // Unexplained findings are never auto-filed, but the PM gets a ready-made draft to pick up.
  if (inv.status === 'insufficient_evidence' && ctx.settings.autonomy.recommend) {
    const draft = buildTaskDraft(inv, undefined, ctx.settings);
    if (!st.drafts.some((d) => d.fingerprint === draft.fingerprint)) st.drafts.push(draft);
  }

  if (refresh) {
    // Drafts waiting for the PM should reflect the latest evidence too.
    st.drafts = st.drafts.map((d) => (d.investigationId === inv.id ? buildTaskDraft(inv, leading, ctx.settings, d.kind) : d));
    for (let i = 0; i < st.approvals.length; i++) {
      if (st.approvals[i].investigationId === inv.id) st.approvals[i] = refreshApproval(inv, st.approvals[i]);
    }
    const newEvidence = inv.evidence.length - before.evidence;
    const newTickets = inv.relatedTicketIds.length - before.tickets;
    const filed = st.tasks.filter((t) => t.investigationId === inv.id);
    if (filed.length && (newEvidence > 0 || newTickets > 0 || before.confidence !== inv.confidence)) {
      await addEvidenceToIssues(ctx, st, inv, leading, filed, { newTickets, before: before.confidence });
    }
  }
}

function rank(s: Signal['severity']) {
  return { critical: 4, high: 3, medium: 2, low: 1, normal: 0 }[s];
}

function record(st: RunState, inv: Investigation, outcome: ActionOutcome) {
  st.actions.push(...outcome.actions);
  st.approvals.push(...outcome.approvals);
  for (const t of outcome.tasks) {
    const idx = st.tasks.findIndex((x) => x.id === t.id);
    if (idx >= 0) st.tasks[idx] = t;
    else st.tasks.push(t);
  }
  for (const d of outcome.drafts) {
    if (!st.drafts.some((x) => x.fingerprint === d.fingerprint)) st.drafts.push(d);
  }
  inv.actionIds.push(...outcome.actions.map((a) => a.id));
  inv.approvalIds.push(...outcome.approvals.map((a) => a.id));
  inv.taskIds = [...new Set([...inv.taskIds, ...outcome.actions.map((a) => a.taskId).filter((x): x is string => !!x)])];
}

async function addEvidenceToIssues(
  ctx: RunContext,
  st: RunState,
  inv: Investigation,
  leading: Hypothesis | undefined,
  filed: Task[],
  delta: { newTickets: number; before?: number },
) {
  const tracker: IssueTrackerAdapter = ctx.adapters.issueTracker;
  for (const t of filed) {
    const draft = buildTaskDraft(inv, leading, ctx.settings, t.kind);
    const parts: string[] = [];
    if (delta.newTickets > 0) parts.push(`support complaints ${inv.relatedTicketIds.length - delta.newTickets} → ${inv.relatedTicketIds.length}`);
    if (delta.before !== undefined && inv.confidence !== undefined && Math.round(delta.before * 100) !== Math.round(inv.confidence * 100)) {
      parts.push(`confidence ${fmtConfidence(delta.before)} → ${fmtConfidence(inv.confidence)}`);
    }
    const body = `Evidence refreshed before the morning brief: ${parts.length ? parts.join('; ') : 'no material change'}.`;
    const action: Action = {
      id: ctx.nextId('act'),
      investigationId: inv.id,
      type: 'add_evidence_to_issue',
      title: `Add evidence to ${t.id}`,
      description: body,
      risk: 'low',
      requiredLevel: 3,
      decision: ctx.settings.autonomy.createTasks ? 'execute' : 'recommend_only',
      decisionReason: 'Updating issues is permitted (level 3)',
      status: 'recommended',
      target: t.id,
      createdAt: ctx.clock.now(),
      taskId: t.id,
    };
    if (action.decision === 'execute') {
      const res = await callTool(
        ctx,
        { tool: 'issueTracker.addComment', source: 'issue_tracker', stage: 'act', action: `Added evidence to ${t.id}`, input: body, investigationId: inv.id },
        async () => {
          await tracker.updateDescription(t.id, draft.description, draft.evidenceSourceCount);
          return tracker.addComment(t.id, { at: ctx.clock.now(), author: 'nightwatch', body });
        },
        (v) => `${v.id} updated`,
      );
      action.status = res.ok ? 'executed' : 'failed';
      action.result = res.ok ? body : res.error;
      if (res.ok) {
        const idx = st.tasks.findIndex((x) => x.id === t.id);
        st.tasks[idx] = res.value;
      }
    }
    st.actions.push(action);
    inv.actionIds.push(action.id);
  }
}

/** A dip that recovered: re-check quickly, record why no action was taken. */
async function checkTransient(ctx: RunContext, st: RunState, recovered: Signal[], watchedFrom: Signal[]) {
  const primary = recovered.sort((a, b) => a.tier - b.tier)[0];
  const since = watchedFrom.map((w) => w.onsetAt!).filter(Boolean).sort()[0] ?? primary.observedAt;
  const inv: Investigation = {
    id: ctx.nextId('inv'),
    runId: ctx.runId,
    title: `${primary.name} dip at ${fmtTime(since)}`,
    primarySignalId: primary.id,
    signalIds: recovered.map((s) => s.id),
    severity: 'low',
    status: 'investigating',
    playbook: 'transient_check',
    startedAt: ctx.clock.now(),
    onsetAt: since,
    problem: '',
    impact: [],
    evidence: [],
    hypotheses: [],
    confidenceBand: 'insufficient',
    conclusion: '',
    reasoning: [],
    timeline: [],
    actionIds: [],
    taskIds: [],
    approvalIds: [],
    relatedReleaseIds: [],
    relatedTicketIds: [],
    releases: [],
    tickets: [],
    sourcesQueried: [],
    sourcesUnavailable: [],
    escalation: 'none',
    fingerprint: `${primary.metricId}:transient`,
  };
  st.investigations.push(inv);
  ctx.log({ stage: 'investigate', action: `Re-checked ${primary.name}`, result: 'Recovered by the next sweep — checking for corroboration before dismissing', status: 'info', investigationId: inv.id });

  const scope: InvestigationScope = { investigation: inv, primary, members: recovered, defs: st.defs, allSignals: st.latest, onsetAt: since, asOf: ctx.clock.now(), transient: true };
  const bundle = await gatherEvidence(ctx, scope);
  const worst = watchedFrom.find((w) => w.metricId === primary.metricId);
  const dipPct = worst ? ((worst.series.at(-1)!.value - worst.baseline.mean) / worst.baseline.mean) * 100 : primary.changePct;
  const recoveredEv = makeEvidence(scope, 'recovered', {
    kind: 'recovered',
    source: 'analytics',
    title: `Back within ${Math.abs(((primary.series.at(-1)!.value - primary.baseline.mean) / primary.baseline.mean) * 100).toFixed(1)}% of baseline`,
    detail: `${primary.name} dropped ${fmtPct(dipPct)} in one 30-minute bucket, then returned to its normal range in the next. A single-bucket move does not meet the persistence rule.`,
    value: 'Recovered',
    strength: 1,
    entities: [primary.metricId],
    observationIds: [],
  });
  const corroborating = bundle.evidence.filter((e) => e.kind === 'deployment' || e.kind === 'support_cluster');
  inv.evidence = [recoveredEv, ...bundle.evidence.filter((e) => e.kind !== 'anomaly')];
  inv.status = 'dismissed';
  inv.sourcesQueried = [...bundle.sourcesQueried];
  inv.sourcesUnavailable = [...bundle.sourcesUnavailable];
  inv.timeline = bundle.timeline;
  inv.impact = [{ label: primary.name, value: fmtPct(dipPct), detail: 'one bucket, then recovered' }];
  inv.problem = `${primary.name} dipped ${fmtPct(dipPct)} in the ${fmtTime(since)} bucket and recovered by the next sweep.`;
  inv.conclusion = corroborating.length
    ? 'Recovered, but corroborating signals exist — logged for the digest.'
    : 'Transient fluctuation. Recovered with no corroborating release, experiment or support signal. No incident, no task.';
  inv.reasoning = [inv.problem, ...inv.evidence.map((e) => e.detail), inv.conclusion];
  inv.concludedAt = ctx.clock.now();
  ctx.log({ stage: 'decide', action: `Dismissed transient: ${primary.name}`, result: 'No incident created — recovered with no corroborating evidence', decision: 'continue_monitoring', status: 'ok', investigationId: inv.id });
}

// ─────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────

export async function runOvernight(opts: RunOptions): Promise<OvernightRun> {
  const nightEnd = addMinutes(opts.nightStart, opts.buckets * BUCKET_MINUTES);
  const ctx = createRunContext({
    runId: opts.runId,
    settings: opts.settings,
    teams: opts.teams,
    adapters: opts.adapters,
    reasoner: opts.reasoner,
    nightStart: opts.nightStart,
    nightEnd,
  });
  const st: RunState = { defs: [], baselines: new Map(), investigations: [], actions: [], approvals: [], tasks: [], drafts: [], watching: new Map(), everAnomalous: new Set(), latest: [] };
  const { autonomy } = opts.settings;

  ctx.log({
    stage: 'start',
    action: 'Nightwatch started overnight run',
    result: `Watch ${opts.settings.schedule.start} → ${opts.settings.schedule.end} · reasoning: ${opts.reasoner.name}`,
    status: 'ok',
    input: `Autonomy: observe ${on(autonomy.observe)}, investigate ${on(autonomy.investigate)}, recommend ${on(autonomy.recommend)}, tasks ${on(autonomy.createTasks)}, incidents ${on(autonomy.createIncidents)}; production/payments/customer comms gated`,
  });

  const finish = (note?: string) => finalize(ctx, st, opts, nightEnd, note);

  if (!autonomy.observe) {
    ctx.log({ stage: 'start', action: 'Observation is turned off', result: 'Nightwatch did not monitor tonight', status: 'skipped' });
    return finish('Observation is turned off in the autonomy policy.');
  }

  const defsRes = await callTool(ctx, { tool: 'analytics.listMetrics', source: 'analytics', stage: 'collect', action: 'Loaded metric catalogue' }, () => opts.adapters.analytics.listMetrics(), (v) => `${v.length} metrics`);
  if (!defsRes.ok) return finish('Product analytics was unavailable, so Nightwatch could not monitor signals.');
  st.defs = defsRes.value;

  const baseRes = await callTool(
    ctx,
    { tool: 'analytics.getBaseline', source: 'analytics', stage: 'collect', action: 'Loaded historical baselines', input: 'Same hours, previous 28 nights' },
    async () => Promise.all(st.defs.map(async (d) => [d.id, await opts.adapters.analytics.getBaseline(d.id)] as const)),
    (v) => `${v.length} baselines`,
  );
  if (!baseRes.ok) return finish('Historical baselines were unavailable.');
  st.baselines = new Map(baseRes.value);

  for (let k = 1; k <= opts.buckets; k++) {
    const t = addMinutes(opts.nightStart, k * BUCKET_MINUTES);
    ctx.clock.set(t);
    const signals = await collectSignals(ctx, st, t);
    if (!signals) continue;
    st.latest = signals;
    const det = detectAnomalies(signals, st);
    for (const s of signals.filter((x) => x.status === 'anomalous' && x.watched)) st.everAnomalous.add(s.metricId);

    const anomalousNow = signals.filter((s) => s.watched && s.status === 'anomalous').length;
    const nothingNew = !det.newAnomalies.length && !det.newWatches.length && !det.recovered.length && !det.attach.length;
    ctx.log({
      stage: 'detect',
      action: `Sweep ${fmtTime(t)}`,
      result: nothingNew
        ? `${signals.filter((s) => s.watched).length} signals checked · ${anomalousNow ? `${anomalousNow} anomalous (already under investigation)` : 'all within normal range'}`
        : [
            det.newAnomalies.length ? `Detected ${plural(det.newAnomalies.length, 'anomaly', 'anomalies')}: ${det.newAnomalies.map((s) => `${s.name} ${fmtPct(s.changePct)}`).join(', ')}` : '',
            det.newWatches.length ? `Watching ${det.newWatches.map((s) => s.name).join(', ')} — waiting for persistence` : '',
            det.recovered.length ? `${det.recovered.map((s) => s.name).join(', ')} recovered` : '',
          ].filter(Boolean).join(' · ') || `${det.attach.length} related signal(s) attached`,
      status: det.newAnomalies.length ? 'warning' : 'ok',
      routine: nothingNew,
    });

    for (const w of det.newWatches) st.watching.set(w.metricId, w);
    for (const s of signals) if (s.status === 'anomalous') st.watching.delete(s.metricId);

    if (det.recovered.length) {
      const watchedFrom = det.recovered.map((r) => st.watching.get(r.metricId)!).filter(Boolean);
      for (const r of det.recovered) st.watching.delete(r.metricId);
      if (autonomy.investigate && det.recovered.some((r) => r.tier === 1)) await checkTransient(ctx, st, det.recovered.filter((r) => r.tier <= 2), watchedFrom);
    }

    for (const { signal, investigation } of det.attach) {
      investigation.signalIds.push(signal.id);
      ctx.log({ stage: 'prioritize', action: `Attached ${signal.name} to existing investigation`, result: investigation.title, status: 'info', investigationId: investigation.id });
    }

    if (det.newAnomalies.length) {
      const clusters = prioritizeSignals(det.newAnomalies, st.defs);
      ctx.clock.advance(2);
      ctx.log({
        stage: 'prioritize',
        action: `Prioritized ${plural(det.newAnomalies.length, 'anomaly', 'anomalies')} into ${plural(clusters.length, 'finding')}`,
        result: clusters.map((c) => `${c.primary.name} (${c.severity}${c.members.length > 1 ? `, +${c.members.length - 1} related` : ''})`).join(' · '),
        status: 'info',
      });
      for (const c of clusters) await investigateSignal(ctx, st, c, opts);
    }
  }

  // Pre-brief refresh: re-gather evidence for every open finding as of the end of the watch.
  ctx.clock.set(nightEnd);
  const open = st.investigations.filter((i) => i.status !== 'dismissed' && autonomy.investigate);
  if (open.length) {
    ctx.log({ stage: 'investigate', action: 'Pre-brief refresh', result: `Re-checking ${plural(open.length, 'open finding')} with the latest data`, status: 'info' });
  }
  for (const inv of open) {
    const members = inv.signalIds.map((id) => st.latest.find((s) => s.id === id)!).filter(Boolean);
    const primary = st.latest.find((s) => s.id === inv.primarySignalId)!;
    const scope: InvestigationScope = { investigation: inv, primary, members, defs: st.defs, allSignals: st.latest, onsetAt: inv.onsetAt!, asOf: ctx.clock.now() };
    inv.title = `${primary.name} ${fmtPct(primary.changePct)}`;
    await conclude(ctx, st, inv, scope, opts, true);
  }

  return finish();
}

function on(b: boolean) {
  return b ? 'on' : 'off';
}

function finalize(ctx: RunContext, st: RunState, opts: RunOptions, nightEnd: string, note?: string): OvernightRun {
  ctx.clock.advance(20);
  const signals = st.latest.map((s) => {
    const wasTransient = st.investigations.some((i) => i.status === 'dismissed' && i.signalIds.includes(s.id));
    return wasTransient && s.status === 'normal' ? { ...s, status: 'transient' as const, note: 'Dipped briefly overnight, then recovered' } : s;
  });
  const brief = generateMorningBrief({
    runId: ctx.runId,
    generatedAt: ctx.clock.now(),
    window: { start: ctx.nightStart, end: nightEnd },
    signals,
    investigations: st.investigations,
    actions: st.actions,
    approvals: st.approvals,
    tasks: st.tasks,
    events: ctx.events,
  });
  if (note) brief.escalations.unshift(note);
  ctx.log({
    stage: 'brief',
    action: 'Morning brief generated',
    result: note ?? `${brief.counts.critical} critical · ${brief.counts.attention} need attention · ${brief.counts.normal} normal`,
    status: note ? 'warning' : 'ok',
  });

  const durations = st.investigations.filter((i) => i.durationSeconds !== undefined).map((i) => i.durationSeconds!);
  const stats: RunStats = {
    signalsMonitored: signals.filter((s) => s.watched).length,
    anomaliesDetected: st.everAnomalous.size,
    investigationsCompleted: st.investigations.length,
    tasksCreated: st.actions.filter((a) => (a.type === 'create_task' || a.type === 'create_incident_draft') && a.status === 'executed').length,
    recommendations: st.actions.filter((a) => a.decision !== 'execute').length,
    actionsExecuted: st.actions.filter((a) => a.status === 'executed').length,
    approvalsRequested: st.approvals.length,
    avgInvestigationSeconds: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
  };

  return {
    id: ctx.runId,
    scenarioId: opts.scenario.id,
    scenarioName: opts.scenario.name,
    startedAt: ctx.nightStart,
    endedAt: ctx.clock.now(),
    reasoningEngine: opts.reasoner.name,
    signals,
    investigations: st.investigations,
    actions: st.actions,
    approvals: st.approvals,
    tasks: st.tasks,
    drafts: st.drafts,
    events: ctx.events,
    observations: ctx.observations,
    brief,
    stats,
  };
}
