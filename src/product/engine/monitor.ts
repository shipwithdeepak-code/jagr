import { addMinutes, addSeconds, fmtTime, minutesBetween } from '@/lib/time';
import type {
  AgentHypothesis,
  Area,
  AttentionLevel,
  ProposedAction,
  TraceStep,
  BriefSchedule,
  DetectedSignal,
  EmailNotification,
  InvestigationState,
  MonitoringResult,
  MorningBriefDoc,
  ProviderId,
  SchedulerLogEntry,
  SourceConnection,
  Watch,
  WatchInvestigation,
} from '../types';
import { AREA_LABEL, DEMO_RECIPIENT, SIGNALS } from '../catalog';
import { createAdapters, labelOf, labelsFrom, type AdapterRegistry, type ProviderLabel } from '../integrations/adapters';
import { ProviderUnavailableError } from '../integrations/types';
import type { World } from '../integrations/world';
import { planJobs } from '../scheduler';
import { ATTENTION_RANK, assessAttention } from './attention';
import { composeBrief } from './brief';
import { areasPresent, fmtMagnitude, readIssues, readMetric, readReviews, withWatchThreshold, type DetectionStatus } from './detect';
import { reason } from './investigate';
import { createToolbox } from '../agent/tools';
import { checkRolloutBeforeAction, runInvestigation } from '../agent/investigator';
import type { InvestigationPlanner } from '../agent/planner';
import { proposeActions } from '../agent/actions';
import { composeAlert, decideNotification } from './notify';

/**
 * The monitoring loop:
 *   OBSERVE → DETECT → INVESTIGATE → CORRELATE → ASSESS ATTENTION → DEDUPLICATE → NOTIFY → (BRIEF)
 * driven by the deterministic scheduler over a window of simulated time.
 */

export interface MonitorOptions {
  /** Model planner for tool selection. Absent → deterministic planner (labelled in the trace). */
  planner?: InvestigationPlanner;
  world: World;
  watches: Watch[];
  connections: SourceConnection[];
  brief: BriefSchedule;
  window?: { start: string; end: string };
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

async function observe(reg: AdapterRegistry, watch: Watch, at: string, worldStart: string, P: (p: ProviderId) => ProviderLabel): Promise<{ findings: Finding[]; gaps: ProviderId[] }> {
  const findings: Finding[] = [];
  const gaps = new Set<ProviderId>();
  for (const sig of watch.signals) {
    const meta = SIGNALS[sig.key];
    if (meta.kind === 'releases' || meta.provider === 'multi') continue;
    const provider = meta.provider;
    if (!watch.sources.includes(provider) || provider === 'email') continue;
    const adapter = reg.sources[provider];
    try {
      if (meta.kind === 'metric') {
        const [raw] = await adapter.getMetrics([sig.key], { start: worldStart, end: at });
        if (!raw) continue;
        const series = withWatchThreshold(raw, watch.thresholds);
        const r = readMetric(series);
        if (r.status === 'normal') continue;
        findings.push({
          status: r.status,
          blockers: 0,
          signal: { key: sig.key, provider, area: series.area, label: series.name, magnitude: fmtMagnitude(series, r), ratio: r.ratio, onsetAt: r.onsetAt!, detectedAt: at, refs: [{ provider, kind: 'metric', id: series.id }] },
        });
      } else if (meta.kind === 'issues') {
        const issues = await adapter.getIssues({ start: addMinutes(at, -180), end: at });
        const areas: Area[] = sig.area === '*' ? areasPresent(issues, []) : [(sig.area ?? watch.area) as Area];
        for (const area of areas) {
          const r = readIssues(issues, area);
          if (r.status === 'normal') continue;
          findings.push({
            status: r.status,
            blockers: r.blockers,
            signal: { key: 'jira.issues', provider: 'jira', area, label: `${AREA_LABEL[area]} issues in ${P('jira').short}`, magnitude: `${r.count} new issues`, ratio: r.ratio, onsetAt: r.onsetAt!, detectedAt: at, refs: r.ids.map((id) => ({ provider: 'jira', kind: 'issue', id })) },
          });
        }
      } else if (meta.kind === 'reviews') {
        const reviews = await adapter.getReviews({ start: addMinutes(at, -360), end: at });
        const areas: Area[] = sig.area === '*' ? areasPresent([], reviews) : [(sig.area ?? watch.area) as Area];
        for (const area of areas) {
          const r = readReviews(reviews, area);
          if (r.status === 'normal') continue;
          findings.push({
            status: r.status,
            blockers: 0,
            signal: { key: sig.key, provider, area, label: `${P(provider).short} reviews about ${AREA_LABEL[area].toLowerCase()}`, magnitude: `${r.count} negative reviews`, ratio: r.ratio, onsetAt: r.onsetAt!, detectedAt: at, refs: r.ids.map((id) => ({ provider, kind: 'review', id })) },
          });
        }
      }
    } catch (err) {
      if (err instanceof ProviderUnavailableError) gaps.add(provider);
      else throw err;
    }
  }
  return { findings, gaps: [...gaps] };
}

/** Group findings that describe one problem: same area (or an area-specific watch) and onsets within 2 hours. */
function group(findings: Finding[], watch: Watch): Finding[][] {
  const sorted = [...findings].sort(
    (a, b) => (a.status === 'anomalous' ? 0 : 1) - (b.status === 'anomalous' ? 0 : 1) || SIGNALS[a.signal.key].priority - SIGNALS[b.signal.key].priority || b.signal.ratio - a.signal.ratio,
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
  if (inv.releaseAssociation) parts.push(`began ${inv.releaseAssociation.minutesBeforeOnset} min after release ${inv.releaseAssociation.version}`);
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
  const reg = createAdapters(o.world, o.connections);
  const labels = labelsFrom(o.connections);
  const P = labelOf(labels);
  const base = o.appBaseUrl ?? 'https://jagr.vercel.app';
  const recipient = o.recipient ?? DEMO_RECIPIENT;
  const investigations: WatchInvestigation[] = [];
  const emails: EmailNotification[] = [];
  const briefs: MorningBriefDoc[] = [];
  const log: SchedulerLogEntry[] = [];
  let lastBrief = window.start;

  const emit = (e: RunEvent) => {
    try {
      o.onEvent?.(e);
    } catch {
      /* progress is best-effort */
    }
  };
  const jobs = planJobs(o.watches, window, o.brief);
  for (const [index, job] of jobs.entries()) {
    if (job.type !== 'morning_brief') emit({ type: 'job', index, total: jobs.length, watchName: o.watches.find((w) => w.id === job.watchId)?.name ?? '', at: job.at });
    if (job.type === 'morning_brief') {
      const brief = composeBrief({ at: job.at, since: lastBrief, watches: o.watches, investigations, emails, log });
      briefs.push(brief);
      lastBrief = job.at;
      log.push({ jobId: job.id, type: job.type, scheduledAt: job.at, outcome: `Morning brief — ${brief.headline}`, investigationIds: brief.items.map((i) => i.investigationId), emailIds: [] });
      continue;
    }

    const watch = o.watches.find((w) => w.id === job.watchId)!;
    const at = job.at;
    const { findings, gaps } = await observe(reg, watch, at, o.world.start, P);
    const touched = new Set<string>();
    const sent: string[] = [];

    for (const grp of group(findings, watch)) {
      const primary = grp[0].signal;
      const area = primary.area;
      const anomalous = new Set(grp.filter((f) => f.status === 'anomalous').map((f) => f.signal.key));
      const dedupeKey = `${area}:${nightOf(primary.onsetAt)}`;
      // Deduplicate: same area on the same night, or an open investigation already tracking any of
      // these exact signals (e.g. crash-free sessions seen by both Checkout health and App stability).
      const sameSignal = (i: WatchInvestigation) =>
        grp.some((f) =>
          i.signals.some(
            (s) => s.key === f.signal.key && (SIGNALS[s.key].kind === 'metric' || s.area === f.signal.area) && Math.abs(minutesBetween(s.onsetAt, f.signal.onsetAt)) <= 120,
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
      const prevKeys = new Set(inv.signals.map((s) => `${s.key}:${s.area}`));
      const newWatch = !inv.watchIds.includes(watch.id);
      if (newWatch) inv.watchIds.push(watch.id);
      for (const f of grp) {
        const i = inv.signals.findIndex((s) => s.key === f.signal.key && s.area === f.signal.area);
        if (i >= 0) inv.signals[i] = { ...f.signal, onsetAt: inv.signals[i].onsetAt < f.signal.onsetAt ? inv.signals[i].onsetAt : f.signal.onsetAt };
        else inv.signals.push(f.signal);
      }
      inv.signals.sort((a, b) => SIGNALS[a.key].priority - SIGNALS[b.key].priority || b.ratio - a.ratio);
      inv.updatedAt = at;

      if (!isOwner) {
        const note = `${watch.name} saw ${grp.map((f) => `${f.signal.label} (${f.signal.magnitude})`).join(', ')} — linked to this investigation instead of opening a duplicate.`;
        inv.runs.push({ at, watchId: watch.id, anomalous: anomalous.size > 0, note });
        if (newWatch || grp.some((f) => !prevKeys.has(`${f.signal.key}:${f.signal.area}`))) {
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
      const out = await runInvestigation({
        onStep: (step) => emit({ type: 'step', investigationId: invId, step }),
        toolbox: createToolbox(reg, watch, o.world.start),
        watch,
        primary: lead,
        signals: inv.signals,
        area: inv.area,
        onsetAt: onset,
        at,
        pass: maxPass(inv) + 1,
        trigger,
        simulatedLinks: (p) => (p === 'email' ? true : reg.sources[p].connection().state !== 'connected'),
        connectionState: (p) => (p === 'email' ? reg.email.connection().state : reg.sources[p].connection().state),
        connectionDetail: (p) => (p === 'email' ? reg.email.connection().detail : reg.sources[p].connection().detail),
        planner: o.planner,
        investigationId: inv.id,
        labels,
      });
      const r = reason(lead, inv.signals, out.gathered, inv.area, onset, false, persistent, labels);
      const attention = assessAttention({ signals: inv.signals, anomalous, corroborating: r.corroborating, releaseAssociated: !!r.releaseAssociation, blockerIssues: grp.reduce((a, f) => a + f.blockers, 0) });
      const critical = attention.level === 'CRITICAL';
      const final = critical ? reason(lead, inv.signals, out.gathered, inv.area, onset, true, persistent, labels) : r;

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
      const releases = [...out.gathered.releases];
      if (ATTENTION_RANK[inv.attention] >= ATTENTION_RANK.HIGH && releaseLive && inv.releaseAssociation && !inv.actions.some((a) => a.kind === 'pause_rollout') && !releases.some((r) => r.rollout)) {
        const check = await checkRolloutBeforeAction({
          labels,
          toolbox: createToolbox(reg, watch, o.world.start),
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
      const proposed = proposeActions({ inv, hypotheses: out.hypotheses, attention: inv.attention, issues: out.gathered.issues, releases, at, issueSource: o.connections.find((c) => c.provider === 'jira')?.state === 'imported' ? 'imported' : undefined });
      const newActions = proposed.filter((p) => !inv.actions.some((a) => a.id === p.id));
      inv.actions.push(...newActions);

      // TRACE — keep a full pass when something material changed; otherwise one re-check line.
      const after = snapshot(inv);
      const newSignal = grp.some((f) => !prevKeys.has(`${f.signal.key}:${f.signal.area}`));
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
          await reg.email.send(mail);
          emails.push(mail);
          inv.notifiedLevels.push(inv.attention);
          sent.push(mail.id);
          inv.trace.push({ id: `${inv.id}-notify-${at}`, at: lastAt(inv, at), pass: maxPass(inv), kind: 'notify', title: `Emailed the PM: “${mail.subject}”`, detail: decision.reason });
        } catch {
          inv.runs.push({ at, watchId: watch.id, anomalous: true, note: 'Email channel unavailable — notification not delivered; it will appear in the morning brief.' });
        }
      }
    }

    // Owner investigations this run did not see again.
    for (const inv of investigations.filter((i) => i.watchId === watch.id && OPEN.includes(i.status) && !touched.has(i.id))) {
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
        findings.length ? `${findings.length} signal${findings.length === 1 ? '' : 's'} outside normal range` : 'All signals within normal range',
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

export function highestAttention(invs: WatchInvestigation[]): AttentionLevel | undefined {
  return invs.reduce<AttentionLevel | undefined>((m, i) => (!m || ATTENTION_RANK[i.attention] > ATTENTION_RANK[m] ? i.attention : m), undefined);
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
  push({ kind: 'uncertainty', title: inv.releaseAssociation ? `Release ${inv.releaseAssociation.version} is not proven causal` : 'Cause not established', detail: inv.uncertainty });
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
    const timing = rel ? ` It began ${rel.minutesBeforeOnset} min after release ${rel.version} — a temporal correlation that does not establish causation, and a release can also change tracking.` : '';
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
