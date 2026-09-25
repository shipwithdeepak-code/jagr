import { addMinutes, addSeconds, fmtTime, minutesBetween } from '../lib/time.js';
import type {
  AgentHypothesis,
  Area,
  ProposedAction,
  TraceStep,
  BriefSchedule,
  DetectedSignal,
  EmailNotification,
  InvestigationState,
  MonitoringResult,
  MorningBriefDoc,
  ProviderId,
  ScheduledJob,
  SchedulerLogEntry,
  SourceConnection,
  Watch,
  WatchInvestigation,
} from '../types.js';
import { AREA_LABEL, DEMO_RECIPIENT, metricKeyOf, signalMeta } from '../catalog.js';
import { createRegistry, labelOf, labelsFrom, makeLink, SimulatedEmailChannel, type ProviderLabel } from '../integrations/adapters.js';
import { ProviderUnavailableError } from '../integrations/types.js';
import type { SourceRegistry } from '../roles/registry.js';
import type { ChangeRecord, SourceId } from '../roles/types.js';
import { isSourceId } from '../roles/types.js';
import { assumptionsOf } from '../evidence/assumptions.js';
import type { World } from '../integrations/world.js';
import { planJobs } from '../scheduler.js';
import { ATTENTION_RANK, assessAttention } from './attention.js';
import { composeBrief } from './brief.js';
import { areasPresent, feedbackNoun, fmtMagnitude, readIssues, readMetric, readReviews, withWatchThreshold, type DetectionStatus } from './detect.js';
import { changePhrase, reason } from './investigate.js';
import { createToolbox } from '../agent/tools.js';
import { checkRolloutBeforeAction, runInvestigation, sourceDirectory } from '../agent/investigator.js';
import type { InvestigationPlanner } from '../agent/planner.js';
import { proposeActions } from '../agent/actions.js';
import { composeAlert, decideNotification } from './notify.js';

/**
 * The monitoring loop:
 *   OBSERVE → DETECT → INVESTIGATE → CORRELATE → ASSESS ATTENTION → DEDUPLICATE → NOTIFY → (BRIEF)
 * driven by the deterministic scheduler over a window of simulated time.
 */

export interface MonitorOptions {
  /** Model planner for tool selection. Absent → deterministic planner (labelled in the trace). */
  planner?: InvestigationPlanner;
  /** The night's fixture world — the simulated or imported data, and the run's time window. */
  world: World;
  /**
   * The workspace's sources by role. Absent → built from `world` and `connections` (simulated or
   * imported). A real connector registers here; the engine cannot tell the difference.
   */
  registry?: SourceRegistry;
  watches: Watch[];
  connections: SourceConnection[];
  brief: BriefSchedule;
  window?: { start: string; end: string };
  /**
   * Run exactly these scheduled jobs instead of planning every job in the window — how a server
   * runs one due watch (from its job queue) rather than replaying a whole night.
   */
  jobs?: ScheduledJob[];
  /**
   * Investigations from earlier runs, to continue rather than start fresh (deduplication, lifecycle,
   * notified levels all carry on). They are copied, never mutated in place.
   */
  investigations?: WatchInvestigation[];
  appBaseUrl?: string;
  recipient?: string;
  /**
   * Live progress for the UI: what the run is actually doing, as it happens. Every `step` is the
   * same TraceStep that lands in the investigation's trace — nothing is emitted that did not run.
   * A throwing listener never affects the run.
   */
  onEvent?: (e: RunEvent) => void;
}

export type RunEvent =
  | { type: 'job'; index: number; total: number; watchName: string; at: string }
  | { type: 'investigation'; id: string; title: string; firstPass: boolean }
  | { type: 'step'; investigationId: string; step: TraceStep };

interface Finding {
  signal: DetectedSignal;
  status: Exclude<DetectionStatus, 'normal'>;
  blockers: number;
}

const OPEN: InvestigationState[] = ['DETECTED', 'INVESTIGATING', 'CONFIRMED'];

function nightOf(iso: string) {
  return new Date(Date.parse(iso) - 12 * 3_600_000).toISOString().slice(0, 10);
}

function hhmm(iso: string) {
  return fmtTime(iso).replace(':', '');
}

/** A signal's identity within a run: the same key from two sources is two signals. */
const signalId = (s: { key: string; provider: string }) => `${s.key}@${s.provider}`;

/** A change a watch's change source reported: a failed deployment is a finding; the rest is context. */
interface ObservedChange {
  source: SourceId;
  record: ChangeRecord;
}

/** How far back each run reads changes (as for feedback); deployment ids deduplicate repeat sightings. */
const CHANGE_LOOKBACK_MIN = 360;

/** What one change source returned on a run (a source that could not be read is a gap instead). */
interface ChangeRead {
  source: SourceId;
  deployments: number;
  releases: number;
}

/**
 * A changes-only watch inspects no signal, so "within normal range" would claim a check that never
 * happened: say what was read instead.
 */
function changeReadSummary(reads: ChangeRead[], P: (p: ProviderId) => ProviderLabel): string {
  const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  return reads.map((r) => `${P(r.source).name}: ${plural(r.deployments, 'deployment')}, ${plural(r.releases, 'release')} in the last ${CHANGE_LOOKBACK_MIN / 60}h`).join(' · ');
}

async function observe(
  reg: SourceRegistry,
  watch: Watch,
  at: string,
  worldStart: string,
  P: (p: ProviderId) => ProviderLabel,
): Promise<{ findings: Finding[]; gaps: ProviderId[]; failedDeployments: ObservedChange[]; shipped: ObservedChange[]; changeReads: ChangeRead[] }> {
  const findings: Finding[] = [];
  const failedDeployments: ObservedChange[] = [];
  const shipped: ObservedChange[] = [];
  const changeReads: ChangeRead[] = [];
  const gaps = new Set<ProviderId>();
  const among = watch.sources.filter((p): p is SourceId => p !== 'email');
  const read = async (source: SourceId, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof ProviderUnavailableError) gaps.add(source);
      else throw err;
    }
  };
  for (const sig of watch.signals) {
    const meta = signalMeta(sig.key);
    if (meta.kind === 'changes') {
      // Deployments and releases from the watch's change sources. Only a deployment the source reports
      // as failed is a finding; successful deployments and published releases are context. A source that
      // cannot be read is a gap, never "nothing changed".
      for (const s of reg.withRole('changes', among)) {
        await read(s.id, async () => {
          const records = await s.changes!.getChanges({ window: { start: addMinutes(at, -CHANGE_LOOKBACK_MIN), end: at } });
          changeReads.push({ source: s.id, deployments: records.filter((r) => r.kind === 'deploy').length, releases: records.filter((r) => r.kind === 'release').length });
          for (const record of records) {
            if (record.kind === 'deploy' && record.status === 'failed') failedDeployments.push({ source: s.id, record });
            else if ((record.kind === 'deploy' && record.status === 'success') || record.kind === 'release') shipped.push({ source: s.id, record });
          }
        });
      }
      continue;
    }
    if (meta.kind === 'metric') {
      const m = reg.metricSource(metricKeyOf(sig.key)!, among);
      if (!m) continue;
      const provider = m.source;
      await read(provider, async () => {
        const raw = await reg.get(provider)!.metrics!.getSeries({ metric: m.def.key, window: { start: worldStart, end: at } });
        if (!raw) return;
        const series = withWatchThreshold(raw, watch.thresholds);
        const r = readMetric(series);
        if (r.status === 'normal') return;
        findings.push({
          status: r.status,
          blockers: 0,
          signal: { key: sig.key, provider, area: series.area, label: series.name, magnitude: fmtMagnitude(series, r), ratio: r.ratio, onsetAt: r.onsetAt!, detectedAt: at, refs: [series.ref] },
        });
      });
    } else if (meta.kind === 'work_items') {
      for (const s of reg.withRole('work_items', among)) {
        await read(s.id, async () => {
          const items = await s.work_items!.getWorkItems({ window: { start: addMinutes(at, -180), end: at } });
          const areas: Area[] = sig.area === '*' ? areasPresent(items, []) : [(sig.area ?? watch.area) as Area];
          for (const area of areas) {
            const r = readIssues(items, area);
            if (r.status === 'normal') continue;
            const byId = new Map(items.map((i) => [i.id, i.ref]));
            findings.push({
              status: r.status,
              blockers: r.blockers,
              signal: { key: 'work_items', provider: s.id, area, label: `${AREA_LABEL[area]} issues in ${P(s.id).short}`, magnitude: `${r.count} new issues`, ratio: r.ratio, onsetAt: r.onsetAt!, detectedAt: at, refs: r.ids.map((id) => byId.get(id)!) },
            });
          }
        });
      }
    } else {
      for (const s of reg.withRole('feedback', among)) {
        await read(s.id, async () => {
          const items = await s.feedback!.getFeedback({ window: { start: addMinutes(at, -360), end: at } });
          const areas: Area[] = sig.area === '*' ? areasPresent([], items) : [(sig.area ?? watch.area) as Area];
          for (const area of areas) {
            const r = readReviews(items, area);
            if (r.status === 'normal') continue;
            const byId = new Map(items.map((i) => [i.id, i.ref]));
            const noun = feedbackNoun(items.filter((i) => r.ids.includes(i.id)), r.count);
            findings.push({
              status: r.status,
              blockers: 0,
              signal: { key: 'feedback', provider: s.id, area, label: `${P(s.id).short} ${noun.short.replace(/^negative /, '').replace(/ rated 1–2★$/, '')} about ${AREA_LABEL[area].toLowerCase()}`, magnitude: `${r.count} ${noun.short}`, ratio: r.ratio, onsetAt: r.onsetAt!, detectedAt: at, refs: r.ids.map((id) => byId.get(id)!) },
            });
          }
        });
      }
    }
  }
  return { findings, gaps: [...gaps], failedDeployments, shipped, changeReads };
}

/** Group findings that describe one problem: same area (or an area-specific watch) and onsets within 2 hours. */
function group(findings: Finding[], watch: Watch): Finding[][] {
  const sorted = [...findings].sort(
    (a, b) => (a.status === 'anomalous' ? 0 : 1) - (b.status === 'anomalous' ? 0 : 1) || signalMeta(a.signal.key).priority - signalMeta(b.signal.key).priority || b.signal.ratio - a.signal.ratio,
  );
  const groups: Finding[][] = [];
  for (const f of sorted) {
    const g = groups.find((grp) => {
      const p = grp[0].signal;
      const sameArea = watch.area !== '*' || p.area === f.signal.area || f.signal.area === 'stability' || p.area === 'stability';
      return sameArea && Math.abs(minutesBetween(p.onsetAt, f.signal.onsetAt)) <= 120;
    });
    if (g) g.push(f);
    else groups.push([f]);
  }
  return groups;
}

function summarise(inv: WatchInvestigation, P: (p: ProviderId) => ProviderLabel): string {
  const p = inv.signals[0];
  const others = inv.correlatedProviders.filter((x) => x !== p.provider).map((x) => P(x).short);
  const parts = [`${p.label} ${p.magnitude} since ${fmtTime(p.onsetAt)}`];
  if (others.length) parts.push(`corroborated by ${others.join(', ')}`);
  else parts.push(`only ${P(p.provider).short} shows it`);
  if (inv.releaseAssociation) parts.push(`began ${inv.releaseAssociation.minutesBeforeOnset} min after ${changePhrase(inv.releaseAssociation.kind, inv.releaseAssociation.version)}`);
  return `${parts.join('; ')}. Investigation confidence ${confidenceBand(inv.confidence)} that the ${AREA_LABEL[inv.area].toLowerCase()} problem is real; cause not established.`;
}

function setStatus(inv: WatchInvestigation, state: InvestigationState, at: string) {
  if (inv.status === state) return;
  inv.status = state;
  inv.statusHistory.push({ state, at });
  if (state === 'DISMISSED' || state === 'RESOLVED') inv.completedAt = at;
}

export async function runMonitoring(o: MonitorOptions): Promise<MonitoringResult> {
  const window = o.window ?? { start: o.world.start, end: addMinutes(o.world.end, 5) };
  const built = o.registry ? undefined : createRegistry(o.world, o.connections);
  const reg = o.registry ?? built!.registry;
  const email = built?.email ?? new SimulatedEmailChannel(o.connections.find((c) => c.provider === 'email') ?? { provider: 'email', state: 'simulated', detail: 'Simulated outbox', updatedAt: window.start });
  const labels = labelsFrom(o.connections);
  const P = labelOf(labels);
  const base = o.appBaseUrl ?? 'https://jagr.vercel.app';
  const recipient = o.recipient ?? DEMO_RECIPIENT;
  const investigations: WatchInvestigation[] = o.investigations ? (JSON.parse(JSON.stringify(o.investigations)) as WatchInvestigation[]) : [];
  const emails: EmailNotification[] = [];
  const briefs: MorningBriefDoc[] = [];
  const log: SchedulerLogEntry[] = [];
  // Successful deployments and releases the watches saw — context for the brief, never findings.
  const shipped = new Map<string, ObservedChange>();
  let lastBrief = window.start;

  const emit = (e: RunEvent) => {
    try {
      o.onEvent?.(e);
    } catch {
      /* progress is best-effort */
    }
  };
  const jobs = o.jobs ?? planJobs(o.watches, window, o.brief);
  for (const [index, job] of jobs.entries()) {
    if (job.type !== 'morning_brief') emit({ type: 'job', index, total: jobs.length, watchName: o.watches.find((w) => w.id === job.watchId)?.name ?? '', at: job.at });
    if (job.type === 'morning_brief') {
      const brief = composeBrief({ at: job.at, since: lastBrief, watches: o.watches, investigations, emails, log, shipped: [...shipped.values()].map(shippedChange) });
      briefs.push(brief);
      lastBrief = job.at;
      log.push({ jobId: job.id, type: job.type, scheduledAt: job.at, outcome: `Morning brief — ${brief.headline}`, investigationIds: brief.items.map((i) => i.investigationId), emailIds: [] });
      continue;
    }

    const watch = o.watches.find((w) => w.id === job.watchId)!;
    const at = job.at;
    const { findings, gaps, failedDeployments, shipped: seen, changeReads } = await observe(reg, watch, at, o.world.start, P);
    const changesOnly = watch.signals.every((sig) => signalMeta(sig.key).kind === 'changes');
    for (const c of seen) shipped.set(c.record.id, c);
    const touched = new Set<string>();
    const sent: string[] = [];

    for (const grp of group(findings, watch)) {
      const primary = grp[0].signal;
      const area = primary.area;
      const anomalous = new Set(grp.filter((f) => f.status === 'anomalous').map((f) => signalId(f.signal)));
      const dedupeKey = `${area}:${nightOf(primary.onsetAt)}`;
      // Deduplicate: same area on the same night, or an open investigation already tracking any of
      // these exact signals (e.g. crash-free sessions seen by both Checkout health and App stability).
      const sameSignal = (i: WatchInvestigation) =>
        grp.some((f) =>
          i.signals.some(
            (s) => signalId(s) === signalId(f.signal) && (signalMeta(s.key).kind === 'metric' || s.area === f.signal.area) && Math.abs(minutesBetween(s.onsetAt, f.signal.onsetAt)) <= 120,
          ),
        );
      let inv = investigations.find((i) => OPEN.includes(i.status) && (i.dedupeKey === dedupeKey || sameSignal(i)));
      // Same underlying event seen again later the same night: reopen rather than open a second investigation.
      let reopened = false;
      if (!inv) {
        inv = investigations.find(
          (i) => (i.status === 'RESOLVED' || i.status === 'DISMISSED') && i.watchId === watch.id && i.dedupeKey === dedupeKey && !!i.completedAt && minutesBetween(i.completedAt, at) <= 360,
        );
        if (inv) {
          reopened = true;
          inv.completedAt = undefined;
          setStatus(inv, anomalous.size > 0 ? 'INVESTIGATING' : 'DETECTED', at);
        }
      }
      // An investigation must not be bounded by whichever watch saw it first: a watch that can see
      // sources the current owner cannot takes over, so the agent investigates with the widest view.
      if (inv && inv.watchId !== watch.id) {
        const owner = o.watches.find((x) => x.id === inv!.watchId);
        const extra = owner ? watch.sources.filter((s) => !owner.sources.includes(s)) : watch.sources;
        if (!owner || owner.status !== 'active' || (extra.length && watch.sources.length > owner.sources.length)) {
          inv.trace.push({ id: `${inv.id}-handover-${at}-${watch.id}`, at, pass: maxPass(inv), kind: 'signal', title: `Handed over to ${watch.name}`, detail: `${watch.name} can see ${extra.map((p) => P(p).short).join(', ') || 'the same sources'}${owner ? `, which ${owner.name} cannot` : ''}. It investigates from here so no source is left out.` });
          inv.watchId = watch.id;
        }
      }
      const isOwner = !inv || inv.watchId === watch.id;

      if (!inv) {
        const id = `wi-${area}-${hhmm(at)}`;
        const path = `/investigations/w/${id}`;
        inv = {
          id,
          watchId: watch.id,
          watchIds: [watch.id],
          area,
          title: '',
          summary: '',
          startedAt: at,
          updatedAt: at,
          status: 'DETECTED',
          statusHistory: [{ state: 'DETECTED', at }],
          attention: 'LOW',
          attentionReason: '',
          confidence: 0,
          confidenceReason: '',
          signals: [],
          evidence: [],
          observed: [],
          inferred: [],
          unknowns: [],
          hypotheses: [],
          likelyExplanation: '',
          uncertainty: '',
          recommendedNextStep: '',
          correlatedProviders: [],
          sourceLinks: [],
          jagrPath: path,
          jagrLink: `${base}${path}`,
          dedupeKey,
          runs: [],
          notifiedLevels: [],
          trace: [],
          agentHypotheses: [],
          actions: [],
          toolCalls: 0,
          stopReason: '',
        };
        investigations.push(inv);
      }
      touched.add(inv.id);
      const prevKeys = new Set(inv.signals.map((s) => `${signalId(s)}:${s.area}`));
      const newWatch = !inv.watchIds.includes(watch.id);
      if (newWatch) inv.watchIds.push(watch.id);
      for (const f of grp) {
        const i = inv.signals.findIndex((s) => signalId(s) === signalId(f.signal) && s.area === f.signal.area);
        if (i >= 0) inv.signals[i] = { ...f.signal, onsetAt: inv.signals[i].onsetAt < f.signal.onsetAt ? inv.signals[i].onsetAt : f.signal.onsetAt };
        else inv.signals.push(f.signal);
      }
      inv.signals.sort((a, b) => signalMeta(a.key).priority - signalMeta(b.key).priority || b.ratio - a.ratio);
      inv.updatedAt = at;

      if (!isOwner) {
        const note = `${watch.name} saw ${grp.map((f) => `${f.signal.label} (${f.signal.magnitude})`).join(', ')} — linked to this investigation instead of opening a duplicate.`;
        inv.runs.push({ at, watchId: watch.id, anomalous: anomalous.size > 0, note });
        if (newWatch || grp.some((f) => !prevKeys.has(`${signalId(f.signal)}:${f.signal.area}`))) {
          inv.trace.push({ id: `${inv.id}-dedupe-${at}-${watch.id}`, at, pass: maxPass(inv), kind: 'signal', title: `Also seen by ${watch.name}`, detail: note });
        }
        continue;
      }

      // INVESTIGATE — the agent loop (plan → tool → evidence → hypotheses → stop)
      const lead = inv.signals[0];
      const onset = inv.signals.map((s) => s.onsetAt).sort()[0];
      const persistent = anomalous.size > 0 || inv.runs.some((x) => x.anomalous);
      const before = snapshot(inv);
      const firstPass = inv.trace.filter((t) => t.kind === 'plan').length === 0;
      const trigger = firstPass
        ? `detected by the ${watch.name} watch`
        : reopened
          ? 'degraded again after recovering — reopened'
          : `scheduled re-check by ${watch.name}`;
      const invId = inv.id;
      // The investigation's title is written after this pass; name it by what was detected.
      emit({ type: 'investigation', id: invId, title: inv.title || `${lead.label} ${lead.magnitude}`, firstPass });
      const sources = sourceDirectory(reg, watch);
      const linkSimulated = (p: ProviderId) => !isSourceId(p) || reg.isSimulated(p);
      const out = await runInvestigation({
        onStep: (step) => emit({ type: 'step', investigationId: invId, step }),
        toolbox: createToolbox(reg, watch, o.world.start, labels),
        sources,
        watch,
        primary: lead,
        signals: inv.signals,
        area: inv.area,
        onsetAt: onset,
        at,
        pass: maxPass(inv) + 1,
        trigger,
        simulatedLinks: linkSimulated,
        connectionState: (p) => (p === 'email' ? email.connection().state : !isSourceId(p) ? 'not_configured' : (reg.connection(p)?.state ?? 'not_configured')),
        connectionDetail: (p) => (p === 'email' ? email.connection().detail : !isSourceId(p) ? 'A notification channel, not an evidence source' : (reg.connection(p)?.detail ?? 'Not part of this workspace')),
        freshAsOf: (p) => (isSourceId(p) ? reg.connection(p)?.freshAsOf : undefined),
        planner: o.planner,
        investigationId: inv.id,
        labels,
      });
      const r = reason(lead, inv.signals, out.gathered, inv.area, onset, false, persistent, labels, linkSimulated);
      const attention = assessAttention({ signals: inv.signals, anomalous, corroborating: r.corroborating, releaseAssociated: !!r.releaseAssociation, blockerIssues: grp.reduce((a, f) => a + f.blockers, 0) });
      const critical = attention.level === 'CRITICAL';
      const final = critical ? reason(lead, inv.signals, out.gathered, inv.area, onset, true, persistent, labels, linkSimulated) : r;

      const prevAttention = inv.attention;
      if (ATTENTION_RANK[attention.level] >= ATTENTION_RANK[prevAttention]) {
        inv.attention = attention.level;
        inv.attentionReason = attention.reason;
      }
      if (inv.statusHistory.length === 1 && ATTENTION_RANK[inv.attention] < ATTENTION_RANK[watch.severityThreshold]) {
        investigations.splice(investigations.indexOf(inv), 1);
        touched.delete(inv.id);
        continue;
      }

      Object.assign(inv, {
        title: final.title,
        confidence: final.confidence,
        confidenceReason: final.confidenceReason,
        evidence: out.gathered.evidence,
        observed: final.observed,
        inferred: final.inferred,
        // Add the agent's unknowns that the write-up doesn't already cover (release causality and
        // unconnected systems are stated once, by the write-up).
        unknowns: [
          ...new Set([
            ...final.unknowns,
            ...out.hypotheses.filter((h) => h.status !== 'ruled_out').flatMap((h) => h.unknowns).filter((u) => !/^Whether release|not connected to Jagr|^No release was found/.test(u)),
          ]),
        ],
        hypotheses: final.hypotheses,
        likelyExplanation: final.likelyExplanation,
        uncertainty: final.uncertainty,
        recommendedNextStep: final.recommendedNextStep,
        correlatedProviders: final.correlatedProviders,
        releaseAssociation: final.releaseAssociation,
        sourceLinks: final.sourceLinks,
        agentHypotheses: out.hypotheses,
      });
      applyCompetingExplanations(inv, out.hypotheses, out.externalIssue);
      inv.assumptions = assumptionsOf(inv);
      inv.summary = summarise(inv, P);
      // LIFECYCLE
      const lastOwnerRun = [...inv.runs].reverse().find((x) => x.watchId === watch.id);
      if (anomalous.size > 0) {
        if (inv.status === 'DETECTED') setStatus(inv, 'INVESTIGATING', at);
        else if (inv.status === 'INVESTIGATING' && lastOwnerRun?.anomalous) setStatus(inv, 'CONFIRMED', at);
      }
      inv.runs.push({
        at,
        watchId: watch.id,
        anomalous: anomalous.size > 0,
        note: `${anomalous.size ? 'Degraded' : 'Possible fluctuation'}: ${grp.map((f) => `${f.signal.label} ${f.signal.magnitude}`).join(', ')} · ${inv.attention} · ${confidenceBand(inv.confidence)} investigation confidence`,
      });

      // PRE-ACTION CHECK — a rollout action needs rollout facts the investigation may have skipped.
      const releaseLive = out.hypotheses.some((h) => h.kind === 'release_related' && h.status !== 'ruled_out' && (h.strength === 'moderate' || h.strength === 'strong'));
      const releases = [...out.gathered.changes];
      if (ATTENTION_RANK[inv.attention] >= ATTENTION_RANK.HIGH && releaseLive && inv.releaseAssociation && !inv.actions.some((a) => a.kind === 'pause_rollout') && !releases.some((r) => r.rollout)) {
        const check = await checkRolloutBeforeAction({
          labels,
          toolbox: createToolbox(reg, watch, o.world.start, labels),
          sources,
          watch,
          version: inv.releaseAssociation.version,
          since: addMinutes(onset, -240),
          until: addMinutes(onset, 30),
          at: addSeconds(out.trace.at(-1)?.at ?? at, 1),
          pass: out.trace[0]?.pass ?? maxPass(inv) + 1,
        });
        releases.push(...check.releases);
        out.trace.push(...check.steps);
        for (const step of check.steps) emit({ type: 'step', investigationId: invId, step });
        out.toolCalls += check.steps.filter((x) => x.kind === 'tool_call').length;
      }

      // ACT — propose actions by risk; only LOW-risk ones run on their own.
      // Where drafts and links would go: the watch's work-item source (if any), and whether it can take a write.
      const trackerId = sources.withRole('work_items')[0];
      const tracker = trackerId ? { label: P(trackerId).short, mode: reg.connection(trackerId)?.state === 'imported' ? ('imported' as const) : ('live' as const), down: out.gathered.evidence.some((e) => e.provider === trackerId && e.direction === 'gap') } : undefined;
      const proposed = proposeActions({ inv, hypotheses: out.hypotheses, attention: inv.attention, workItems: out.gathered.workItems, changes: releases, at, tracker });
      const newActions = proposed.filter((p) => !inv.actions.some((a) => a.id === p.id));
      inv.actions.push(...newActions);

      // TRACE — keep a full pass when something material changed; otherwise one re-check line.
      const after = snapshot(inv);
      const newSignal = grp.some((f) => !prevKeys.has(`${signalId(f.signal)}:${f.signal.area}`));
      if (firstPass || reopened || newSignal || newActions.length || before !== after) {
        inv.toolCalls += out.toolCalls;
        inv.stopReason = out.stopReason;
        const closing = closingSteps(inv, out.trace, newActions, prevAttention !== inv.attention || firstPass, P);
        inv.trace.push(...out.trace, ...closing);
        for (const step of closing) emit({ type: 'step', investigationId: invId, step });
      } else {
        const t0 = out.trace[0]?.at ?? at;
        inv.trace.push({ id: `${inv.id}-recheck-${at}`, at: t0, pass: maxPass(inv), kind: 'recheck', title: `Re-checked: ${lead.label} still ${lead.magnitude}`, detail: `${out.toolCalls} tool calls · no material change to evidence, explanations or attention.` });
      }

      // NOTIFY
      const decision = decideNotification(inv, watch);
      if (decision.send) {
        const mail = composeAlert(inv, decision.trigger!, at, recipient);
        try {
          await email.send(mail);
          emails.push(mail);
          inv.notifiedLevels.push(inv.attention);
          sent.push(mail.id);
          inv.trace.push({ id: `${inv.id}-notify-${at}`, at: lastAt(inv, at), pass: maxPass(inv), kind: 'notify', title: `Emailed the PM: “${mail.subject}”`, detail: decision.reason });
        } catch {
          inv.runs.push({ at, watchId: watch.id, anomalous: true, note: 'Email channel unavailable — notification not delivered; it will appear in the morning brief.' });
        }
      }
    }

    // DEPLOYMENT FAILURES — one investigation per failed deployment (deduplicated by its record id).
    for (const f of failedDeployments) {
      const existing = investigations.find((i) => i.dedupeKey === `${DEPLOY_KEY}${f.record.id}`);
      if (existing) continue; // the same failed deployment, seen again: never a second investigation
      const inv = deploymentFailureInvestigation(f, watch, at, { base, takenIds: new Set(investigations.map((i) => i.id)), label: P(f.source), simulated: reg.isSimulated(f.source) });
      investigations.push(inv);
      touched.add(inv.id);
      emit({ type: 'investigation', id: inv.id, title: inv.title, firstPass: true });
      for (const step of inv.trace) emit({ type: 'step', investigationId: inv.id, step });
    }
    for (const inv of investigations.filter((i) => i.watchId === watch.id && isDeploymentFailure(i) && OPEN.includes(i.status) && i.deployment)) {
      const d = inv.deployment!;
      // A later successful deployment on the same target closes the deployment failure (outcome only).
      const success = seen.find((c) => c.source === d.source && c.record.kind === 'deploy' && c.record.status === 'success' && sameTarget(c.record, d.target) && c.record.at > d.at);
      if (success) {
        closeDeploymentFailure(inv, success, at, P(success.source));
        continue;
      }
      // Existing cross-source correlation: another watched source degraded soon after the failure.
      if (ATTENTION_RANK[inv.attention] < ATTENTION_RANK.HIGH) {
        const onsetOf = (i: WatchInvestigation) => i.signals.map((x) => x.onsetAt).sort()[0];
        const related = investigations.find((i) => !isDeploymentFailure(i) && (i.status === 'INVESTIGATING' || i.status === 'CONFIRMED') && i.signals.length > 0 && minutesBetween(d.at, onsetOf(i)) >= 0 && minutesBetween(d.at, onsetOf(i)) <= 120);
        if (related) {
          const gap = Math.round(minutesBetween(d.at, onsetOf(related)));
          inv.attention = 'HIGH';
          inv.attentionReason = `${related.title} began ${gap} min after this failed deployment — a timing correlation in another watched source, not a cause.`;
          inv.correlatedProviders = [...new Set([...inv.correlatedProviders, ...related.correlatedProviders])];
          inv.unknowns = [...new Set([...inv.unknowns, 'Whether the failed deployment and the degradation are related — timing alone does not establish it.'])];
          inv.updatedAt = at;
          inv.trace.push({ id: `${inv.id}-attention-${at}`, at, pass: maxPass(inv), kind: 'attention', title: 'Attention: HIGH', detail: inv.attentionReason });
        }
      }
      const decision = decideNotification(inv, watch);
      if (decision.send) {
        const mail = composeAlert(inv, decision.trigger!, at, recipient);
        try {
          await email.send(mail);
          emails.push(mail);
          inv.notifiedLevels.push(inv.attention);
          sent.push(mail.id);
          inv.trace.push({ id: `${inv.id}-notify-${at}`, at: lastAt(inv, at), pass: maxPass(inv), kind: 'notify', title: `Emailed the PM: “${mail.subject}”`, detail: decision.reason });
        } catch {
          inv.runs.push({ at, watchId: watch.id, anomalous: true, note: 'Email channel unavailable — notification not delivered; it will appear in the morning brief.' });
        }
      }
    }

    // Owner investigations this run did not see again (deployment failures close only on a later success).
    for (const inv of investigations.filter((i) => i.watchId === watch.id && OPEN.includes(i.status) && !touched.has(i.id) && !isDeploymentFailure(i))) {
      const leadProvider = inv.signals[0]?.provider;
      if (leadProvider && gaps.includes(leadProvider)) {
        inv.runs.push({ at, watchId: watch.id, anomalous: false, note: `${P(leadProvider).name} unavailable — could not re-check; status unchanged.` });
        continue;
      }
      inv.runs.push({ at, watchId: watch.id, anomalous: false, note: 'Back within normal range.' });
      if (inv.status === 'CONFIRMED') {
        const ownerRuns = inv.runs.filter((x) => x.watchId === watch.id);
        if (ownerRuns.slice(-2).every((x) => !x.anomalous)) {
          setStatus(inv, 'RESOLVED', at);
          inv.trace.push({ id: `${inv.id}-resolved-${at}`, at, pass: maxPass(inv), kind: 'stop', title: 'Resolved: back within normal range for two checks', detail: 'Jagr will reopen this investigation if the same problem returns tonight.' });
        }
      } else {
        setStatus(inv, 'DISMISSED', at);
        inv.attentionReason = 'Did not persist into the next run — dismissed as a fluctuation, no one was interrupted.';
        inv.trace.push({ id: `${inv.id}-dismissed-${at}`, at, pass: maxPass(inv), kind: 'stop', title: 'Dismissed: did not persist', detail: 'Back within normal range on the next check. No one was interrupted.' });
      }
      inv.updatedAt = at;
    }

    const opened = [...touched];
    log.push({
      jobId: job.id,
      type: 'watch_run',
      watchId: watch.id,
      scheduledAt: at,
      outcome: [
        changesOnly ? changeReadSummary(changeReads, P) || (gaps.length ? '' : 'No change source to read') : findings.length ? `${findings.length} signal${findings.length === 1 ? '' : 's'} outside normal range` : 'All signals within normal range',
        failedDeployments.length ? `${failedDeployments.length} failed deployment${failedDeployments.length === 1 ? '' : 's'} reported` : '',
        gaps.length ? `${gaps.map((g) => P(g).name).join(', ')} unavailable` : '',
        sent.length ? `${sent.length} email sent` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      investigationIds: opened,
      emailIds: sent,
    });
  }

  return { window, investigations, emails, briefs, log, connections: o.connections, actions: investigations.flatMap((i) => i.actions) };
}

// ─────────────────────────────────────────────────────────────
// Deployment failures — a change source reports a deployment as failed
// ─────────────────────────────────────────────────────────────

const DEPLOY_KEY = 'deploy:';

/** A successful deployment or published release, as brief context. */
function shippedChange(c: ObservedChange): NonNullable<MorningBriefDoc['shipped']>[number] {
  return { title: c.record.title, at: c.record.at, source: c.source, kind: c.record.kind, timing: c.record.timing, version: c.record.version };
}

/** An investigation about a failed deployment (not a degrading signal). */
export const isDeploymentFailure = (inv: WatchInvestigation) => !!inv.deployment || inv.dedupeKey.startsWith(DEPLOY_KEY);

/**
 * The change stream a deployment belongs to (e.g. the same environment and repository): the target the
 * source reports, or, for a record without one, its title with the version removed.
 */
export function changeTarget(r: Pick<ChangeRecord, 'title' | 'version' | 'target'>): string {
  return r.target ?? legacyChangeTarget(r);
}

/** How targets were derived before sources reported them; still matches failures recorded that way. */
function legacyChangeTarget(r: Pick<ChangeRecord, 'title' | 'version'>): string {
  return r.version ? r.title.split(r.version).join('') : r.title;
}

/** Whether a change record continues the stream a deployment failure was recorded on. */
const sameTarget = (r: ChangeRecord, target: string) => changeTarget(r) === target || legacyChangeTarget(r) === target;

const DEPLOY_UNKNOWN_CAUSE = 'Why the deployment failed — the deployment record does not say (build, tests or infrastructure).';
const DEPLOY_UNKNOWN_IMPACT = 'Whether users or product metrics are affected — the deployment record does not show it.';

/** A new investigation from one failed-deployment record. Every statement is a fact from that record. */
function deploymentFailureInvestigation(
  f: ObservedChange,
  watch: Watch,
  at: string,
  opts: { base: string; takenIds: Set<string>; label: ProviderLabel; simulated: boolean },
): WatchInvestigation {
  const r = f.record;
  let id = `wi-deploy-${hhmm(r.at)}`;
  for (let n = 2; opts.takenIds.has(id); n++) id = `wi-deploy-${hhmm(r.at)}-${n}`;
  const path = `/investigations/w/${id}`;
  const when = fmtTime(r.at);
  const statement = `${opts.label.short}: ${r.title} — reported as failed at ${when}.`;
  const observed = [statement, ...(r.notes ? [`Deployment note from ${opts.label.short}: ${r.notes}`] : [])];
  const likely = `${opts.label.name} reports that ${r.title} failed at ${when}. The deployment record does not say why.`;
  const uncertainty = 'Cause not established: the deployment record reports the failure, not what caused it. Nothing here shows whether users or product metrics are affected.';
  const reason = 'A deployment to a watched environment failed. Morning brief — no interruption unless another watched source degrades in the same window.';
  const stop = 'The failure is reported directly by the change source; its cause is not in the record, so there is nothing further to test from here.';
  const link = makeLink(r.ref, `Open ${opts.label.short}`, opts.simulated, r.provenance.url);
  const pass = 1;
  const t = (n: number) => addSeconds(at, n);
  return {
    id,
    watchId: watch.id,
    watchIds: [watch.id],
    area: watch.area === '*' ? 'general' : watch.area,
    title: `Deployment failed: ${r.title}`,
    summary: `${r.title} failed at ${when}. Cause not established.`,
    startedAt: at,
    updatedAt: at,
    status: 'CONFIRMED',
    statusHistory: [
      { state: 'DETECTED', at },
      { state: 'CONFIRMED', at },
    ],
    attention: 'MEDIUM',
    attentionReason: reason,
    confidence: 0.9,
    confidenceReason: `Reported directly by ${opts.label.name}'s deployment status — the failure is a recorded fact; its cause is not.`,
    signals: [{ key: 'changes', provider: f.source, area: watch.area === '*' ? 'general' : watch.area, label: r.title, magnitude: 'failed', ratio: 1, onsetAt: r.at, detectedAt: at, refs: [r.ref] }],
    evidence: [{ id: `${r.id}:failed`, provider: f.source, direction: 'change', statement, onsetAt: r.at, refs: [r.ref], link, changeKind: r.kind, timing: r.timing }],
    observed,
    inferred: [],
    unknowns: [DEPLOY_UNKNOWN_CAUSE, DEPLOY_UNKNOWN_IMPACT],
    hypotheses: [],
    likelyExplanation: likely,
    uncertainty,
    recommendedNextStep: `Open the failed deployment in ${opts.label.short} and check its logs.`,
    correlatedProviders: [f.source],
    sourceLinks: [link],
    jagrPath: path,
    jagrLink: `${opts.base}${path}`,
    dedupeKey: `${DEPLOY_KEY}${r.id}`,
    runs: [{ at, watchId: watch.id, anomalous: true, note: `Deployment reported as failed: ${r.title}` }],
    notifiedLevels: [],
    trace: [
      { id: `${id}-${pass}-signal`, at: t(0), pass, kind: 'signal', title: `Signal: ${r.title} failed`, detail: `Reported by ${opts.label.name} at ${when} · detected by the ${watch.name} watch`, source: f.source, refs: [r.ref] },
      { id: `${id}-${pass}-assessment`, at: t(1), pass, kind: 'assessment', title: `Deployment failure reported by ${opts.label.short}`, detail: likely },
      { id: `${id}-${pass}-uncertainty`, at: t(2), pass, kind: 'uncertainty', title: 'Cause not established', detail: uncertainty },
      { id: `${id}-${pass}-attention`, at: t(3), pass, kind: 'attention', title: 'Attention: MEDIUM', detail: reason },
      { id: `${id}-${pass}-stop`, at: t(4), pass, kind: 'stop', title: 'Stopped investigating', detail: stop },
    ],
    agentHypotheses: [],
    actions: [],
    toolCalls: 0,
    stopReason: stop,
    deployment: { source: f.source, recordId: r.id, target: changeTarget(r), at: r.at, version: r.version },
  };
}

/**
 * Close a deployment-failure investigation after a later successful deployment on the same target.
 * This resolves the deployment outcome only: it is not evidence that any product or system impact is
 * resolved, and nothing here infers that the new deployment fixed the application or moved a metric.
 */
function closeDeploymentFailure(inv: WatchInvestigation, success: ObservedChange, at: string, label: ProviderLabel) {
  const r = success.record;
  setStatus(inv, 'RESOLVED', at);
  inv.updatedAt = at;
  inv.observed = [...inv.observed, `${label.short}: ${r.title} — reported as successful at ${fmtTime(r.at)}.`];
  inv.unknowns = [
    ...inv.unknowns.filter((u) => u !== DEPLOY_UNKNOWN_IMPACT),
    'Whether any product or system impact is resolved — a later successful deployment only shows that deployment succeeded. Jagr does not infer that it fixed the application or caused any metric recovery.',
  ];
  inv.summary = `${inv.summary} Deployment failure resolved by a later successful deployment at ${fmtTime(r.at)}; product impact not assessed.`;
  inv.runs.push({ at, watchId: inv.watchId, anomalous: false, note: `Deployment failure resolved by a subsequent successful deployment (${r.title}). Product impact not assessed.` });
  inv.trace.push({
    id: `${inv.id}-deploy-resolved-${at}`,
    at,
    pass: maxPass(inv),
    kind: 'stop',
    title: 'Deployment failure resolved by a subsequent successful deployment',
    detail: `${r.title} succeeded at ${fmtTime(r.at)} on the same target. This closes the deployment failure only — it is not evidence that product impact is resolved, and Jagr does not infer that this deployment fixed the application or caused any metric recovery.`,
    source: success.source,
    refs: [r.ref],
  });
}

// ─────────────────────────────────────────────────────────────
// Trace helpers
// ─────────────────────────────────────────────────────────────

function maxPass(inv: WatchInvestigation) {
  return inv.trace.reduce((m, t) => Math.max(m, t.pass), 0);
}

function lastAt(inv: WatchInvestigation, fallback: string) {
  const t = inv.trace.at(-1)?.at;
  return t && t > fallback ? addSeconds(t, 1) : fallback;
}

function describeHyp(h: AgentHypothesis) {
  return `${h.kind}:${h.status}:${h.strength}`;
}

/** What counts as a material change worth a full trace pass. */
function snapshot(inv: WatchInvestigation) {
  return [inv.status, inv.attention, [...inv.correlatedProviders].sort().join(','), inv.agentHypotheses.map(describeHyp).join('|'), inv.releaseAssociation?.version ?? ''].join('#');
}

const AUTONOMY_LABEL: Record<ProposedAction['autonomy'], string> = {
  autonomous: 'Done automatically (low risk, reversible)',
  recommend: 'Recommended — one click to do it',
  prepare_and_notify: 'Prepared — waiting for your approval',
  approval_required: 'Consequential — waiting for your approval',
};

function closingSteps(inv: WatchInvestigation, pass: TraceStep[], newActions: ProposedAction[], attentionChanged: boolean, P: (p: ProviderId) => ProviderLabel): TraceStep[] {
  const p = pass[0]?.pass ?? maxPass(inv);
  let t = pass.at(-1)?.at ?? inv.updatedAt;
  const out: TraceStep[] = [];
  const push = (s: Omit<TraceStep, 'id' | 'at' | 'pass'>) => {
    t = addSeconds(t, 1);
    out.push({ id: `${inv.id}-${p}-close-${out.length}`, at: t, pass: p, ...s });
  };
  const sources = inv.correlatedProviders.map((x) => P(x).short);
  push({
    kind: 'assessment',
    title: sources.length > 1 ? `Evidence lines up across ${sources.join(', ')}` : `Only ${sources[0] ?? 'one source'} shows the change`,
    detail: inv.likelyExplanation,
  });
  push({ kind: 'uncertainty', title: inv.releaseAssociation ? `${changePhrase(inv.releaseAssociation.kind, inv.releaseAssociation.version).replace(/^./, (c) => c.toUpperCase())} is not proven causal` : 'Cause not established', detail: inv.uncertainty });
  if (attentionChanged) {
    push({ kind: 'attention', title: `Attention: ${inv.attention}`, detail: `${inv.attentionReason} Investigation confidence: ${confidenceBand(inv.confidence)} — that a real ${AREA_LABEL[inv.area].toLowerCase()} problem exists, not that its cause is known.` });
  }
  for (const a of newActions) {
    push({ kind: a.risk === 'HIGH' || a.risk === 'CRITICAL' ? 'approval' : 'action', title: `${a.risk} risk · ${a.title}`, detail: `${AUTONOMY_LABEL[a.autonomy]}. ${a.status === 'executed' ? a.result ?? '' : a.why}` });
  }
  return out;
}

export function confidenceBand(c: number): 'high' | 'moderate' | 'low' {
  return c >= 0.8 ? 'high' : c >= 0.55 ? 'moderate' : 'low';
}

/**
 * When the agent keeps a competing explanation alive, the write-up must say so instead of
 * presenting one story: conflicting sources, or a third-party problem alongside a release.
 */
function applyCompetingExplanations(inv: WatchInvestigation, hyps: AgentHypothesis[], external?: { id: string; title: string; createdAt: string }) {
  const h = (k: AgentHypothesis['kind']) => hyps.find((x) => x.kind === k);
  const artifact = h('measurement_artifact');
  const shared = h('shared_product_issue');
  if (artifact && artifact.strength === 'moderate' && artifact.status !== 'ruled_out' && shared && shared.strength !== 'strong' && shared.strength !== 'moderate') {
    const lead = inv.signals[0];
    inv.title = `${lead.label} declined — sources conflict`;
    const rel = inv.releaseAssociation;
    const timing = rel ? ` It began ${rel.minutesBeforeOnset} min after ${changePhrase(rel.kind, rel.version)} — a temporal correlation that does not establish causation, and a change can also affect tracking.` : '';
    inv.likelyExplanation = `${lead.label} fell in Analytics, but purchase revenue is normal and no other source shows a problem. The sources conflict: a tracking or measurement change is as plausible as a real drop, and the evidence does not establish either.${timing}`;
    inv.recommendedNextStep = `Check whether the ${lead.label.toLowerCase()} event or its tracking changed before treating this as a real drop.`;
    inv.inferred = [...inv.inferred, 'An independent money measure (purchase revenue) did not move, which conflicts with a real conversion drop.'];
  }
  const ext = h('external_or_unobserved');
  const rel = h('release_related');
  if (external && ext && ext.strength === 'moderate' && rel && rel.status !== 'ruled_out' && (rel.strength === 'moderate' || rel.strength === 'strong')) {
    inv.likelyExplanation += ` ${external.id} reports a third-party problem at ${fmtTime(external.createdAt)}, which is an equally plausible explanation; the evidence does not separate the two.`;
    inv.unknowns = [...inv.unknowns, `Whether the release, the third-party problem (${external.id}) or both are involved.`];
    inv.recommendedNextStep = `Check the third-party status in ${external.id} and the release changes in parallel — the evidence does not favour either.`;
  }
}
