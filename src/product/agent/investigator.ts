import { addMinutes, addSeconds, fmtTime, minutesBetween } from '@/lib/time';
import type {
  AgentHypothesis,
  Area,
  DetectedSignal,
  EvidenceItem,
  EvidenceStrength,
  HypothesisKind,
  ProviderId,
  SourceRef,
  PlannerDecision,
  ToolName,
  TraceStep,
  Watch,
} from '../types';
import { AREA_LABEL, AREA_METRICS, SIGNALS } from '../catalog';
import { labelOf, makeLink, type ProviderLabels } from '../integrations/adapters';
import type { IssueRecord, ReleaseRecord, ReviewRecord } from '../integrations/types';
import { metricEvidence, type Gathered } from '../engine/investigate';
import type { MetricResult, ToolOutcome, Toolbox } from './tools';
import { FAILURE_LABEL, HYPOTHESIS_ID, validatePlan, type InvestigationPlanner, type PlannerInput, type PlannerOption } from './planner';
import type { PlannerOutcome, PlannerProposal } from './plannerSchema';

/**
 * The investigation loop:
 *   SIGNAL → PLAN → [PLANNER → POLICY VALIDATOR → TOOL CALL → EVIDENCE → HYPOTHESES]* → STOP
 *
 * Tool selection is proposed by the model planner when one is configured, and by the deterministic
 * planner otherwise (or whenever the model fails or is rejected). Either way the proposal passes the
 * same policy validator before anything runs. Stopping, the budget, scoping and actions stay
 * deterministic policy: the model can suggest where to look, never whether to keep going or what to do.
 * Every decision is traced.
 */

type Tag =
  | 'primary'
  | 'release'
  | 'no_release'
  | 'issues'
  | 'no_issues'
  | 'external_issue'
  | 'crash_degraded'
  | 'crash_stable'
  | 'reviews'
  | 'no_reviews'
  | 'traffic_stable'
  | 'traffic_drop'
  | 'revenue_stable'
  | 'revenue_drop'
  | 'area_metric_degraded'
  | 'area_metric_stable'
  | 'unavailable';

interface Candidate {
  key: string;
  tool: ToolName;
  source: Exclude<ProviderId, 'email'>;
  input: string;
  tests: HypothesisKind[];
  why: string;
  exec: () => Promise<{ ok: boolean; state?: string; result: string; refs: SourceRef[] }>;
}

export interface InvestigationOutput {
  gathered: Gathered;
  hypotheses: AgentHypothesis[];
  trace: TraceStep[];
  toolCalls: number;
  stopReason: string;
  signalPersisted: boolean;
  revenueStable: boolean;
  externalIssue?: IssueRecord;
}

export const BUDGET = 9;
const STALE_LIMIT = 3;
const TOOL_NOUN: Record<ToolName, string> = {
  getAnalyticsMetric: 'metric',
  getAnalyticsTraffic: 'traffic',
  getJiraRelease: 'releases',
  getRecentJiraIssues: 'issues',
  getStoreReleases: 'releases',
  getStoreCrashRate: 'crash rate',
  getAppStoreReviews: 'reviews',
  getPlayStoreReviews: 'reviews',
};

/**
 * Pre-action check: before recommending a rollout change, confirm the release is still rolling out.
 * Evidence the investigation didn't need can be exactly what an action needs.
 */
export async function checkRolloutBeforeAction(args: {
  labels?: ProviderLabels;
  toolbox: Toolbox;
  watch: Watch;
  version: string;
  since: string;
  until: string;
  at: string;
  pass: number;
}): Promise<{ releases: ReleaseRecord[]; steps: TraceStep[] }> {
  const P = labelOf(args.labels);
  const steps: TraceStep[] = [];
  const releases: ReleaseRecord[] = [];
  let tick = 0;
  const step = (s: Omit<TraceStep, 'id' | 'at' | 'pass'>) => {
    steps.push({ id: `${args.at}-${args.pass}-rollout-${steps.length}`, at: addSeconds(args.at, tick++), pass: args.pass, ...s });
  };
  for (const store of ['google_play', 'app_store'] as const) {
    if (!args.watch.sources.includes(store)) continue;
    const input = `${store === 'app_store' ? 'iOS' : 'Android'} releases ${fmtTime(args.since)}–${fmtTime(args.until)}`;
    step({ kind: 'tool_call', title: `${P(store).short} → ${input}`, tool: 'getStoreReleases', source: store, input, why: `Before recommending an action on ${args.version}, check whether it is still rolling out on ${store === 'app_store' ? 'iOS' : 'Android'}.` });
    const o = await args.toolbox.getStoreReleases({ since: args.since, until: args.until, store });
    if (!o.ok) {
      step({ kind: 'result', title: `${P(store).name} ${o.state === 'not_in_watch' ? 'is not part of this watch' : `is ${o.state}`} — rollout state unknown`, tool: 'getStoreReleases', source: store, status: o.state === 'error' ? 'error' : 'unavailable' });
      continue;
    }
    const r = o.data.find((x) => x.version === args.version);
    if (r) releases.push(r);
    step({ kind: 'result', title: r ? `${args.version}: ${r.rollout ?? 'full release'} since ${fmtTime(r.releasedAt)}` : `No ${args.version} release on this store`, tool: 'getStoreReleases', source: store, status: 'ok', refs: r ? [{ provider: store, kind: 'release', id: r.id }] : [] });
  }
  return { releases, steps };
}
const EXTERNAL_LABELS = ['payment-provider', 'third-party', 'vendor', 'external'];
const HYP_LABEL: Record<HypothesisKind, string> = {
  release_related: 'Release-related',
  shared_product_issue: 'Real product issue',
  demand_shift: 'Demand shift',
  measurement_artifact: 'Measurement artifact',
  external_or_unobserved: 'Outside connected sources',
  customer_only: 'Customer-reported only',
};

/** Copy who planned it into the trace. Opaque strings — the engine does not interpret providers. */
function provenance(o: PlannerOutcome, label: string): Pick<PlannerDecision, 'plannerLabel' | 'provider' | 'model' | 'latencyMs' | 'providerFallback'> {
  const s = o.source;
  return {
    plannerLabel: s?.displayName ?? label,
    provider: s?.provider,
    model: s?.model,
    latencyMs: s?.latencyMs,
    providerFallback: s?.fallbackFrom ? { from: s.fallbackFrom.displayName, reason: s.fallbackFrom.reason } : undefined,
  };
}

function plannerTitle(d: PlannerDecision): string {
  const who = d.plannerLabel;
  const via = d.providerFallback ? ` — primary planner unavailable, fallback provider used` : '';
  if (d.type === 'LLM' && d.failure) return `${FAILURE_LABEL[d.failure.code as keyof typeof FAILURE_LABEL] ?? 'LLM planner failed'} (${who}) — deterministic planner used`;
  if (d.type === 'LLM' && d.validator === 'REJECTED') return `${who} proposed ${d.proposedTool} — rejected by policy (${d.rejection?.code})${via}`;
  if (d.type === 'LLM') return `${who} proposed ${d.proposedTool} — approved${via}`;
  if (d.type === 'DETERMINISTIC') return `Deterministic planner chose ${d.executedTool}`;
  return `Deterministic planner chose ${d.executedTool} (fallback)`;
}

export function hypothesisLabel(k: HypothesisKind) {
  return HYP_LABEL[k];
}

const RANK: Record<EvidenceStrength, number> = { none: 0, weak: 1, moderate: 2, strong: 3 };

/** The most evidence can ever say about each explanation with the connected sources. */
const CEILING: Record<HypothesisKind, EvidenceStrength> = {
  release_related: 'moderate', // timing is correlation — never strong
  measurement_artifact: 'moderate', // no server-side data to confirm it
  external_or_unobserved: 'moderate', // the third party itself is not connected
  customer_only: 'moderate',
  demand_shift: 'strong',
  shared_product_issue: 'strong',
};

export async function runInvestigation(args: {
  toolbox: Toolbox;
  watch: Watch;
  primary: DetectedSignal;
  signals: DetectedSignal[];
  area: Area;
  onsetAt: string;
  at: string;
  pass: number;
  trigger: string;
  simulatedLinks: (p: ProviderId) => boolean;
  connectionState: (p: ProviderId) => string;
  connectionDetail?: (p: ProviderId) => string;
  /** The model planner. Absent → the deterministic planner, labelled as a fallback in the trace. */
  planner?: InvestigationPlanner;
  investigationId?: string;
  /** Source display names for this run (imported data renames channels). */
  labels?: ProviderLabels;
  /** Called with each trace step as it is recorded (live progress). */
  onStep?: (step: TraceStep) => void;
}): Promise<InvestigationOutput> {
  const P = labelOf(args.labels);
  const { toolbox: tb, watch, primary, area, onsetAt, at, pass } = args;
  const trace: TraceStep[] = [];
  let tick = 0;
  const step = (s: Omit<TraceStep, 'id' | 'at' | 'pass'>) => {
    const recorded: TraceStep = { id: `${at}-${pass}-${trace.length}`, at: addSeconds(at, tick), pass, ...s };
    trace.push(recorded);
    args.onStep?.(recorded);
    tick += s.kind === 'tool_call' ? 3 : 1;
  };

  const g: Gathered = { evidence: [], gaps: [], notInWatch: [], releases: [], issues: [], reviews: [] };
  const tags = new Map<string, Set<Tag>>();
  const add = (e: EvidenceItem, ...t: Tag[]) => {
    g.evidence.push(e);
    tags.set(e.id, new Set(t));
  };
  const has = (t: Tag) => [...tags.values()].some((s) => s.has(t));
  const withTag = (t: Tag) => g.evidence.filter((e) => tags.get(e.id)?.has(t));
  const link = (ref: SourceRef, label: string) => makeLink(ref, label, args.simulatedLinks(ref.provider));
  const areaLabel = AREA_LABEL[area].toLowerCase();
  const since = addMinutes(onsetAt, -60);
  const changeWindow = { since: addMinutes(onsetAt, -240), until: addMinutes(onsetAt, 30) };
  let revenueStable = false;
  let externalIssue: IssueRecord | undefined;
  let persisted = true;

  // ── Outcome helpers ─────────────────────────────────────────
  const gap = (source: Exclude<ProviderId, 'email'>, o: Extract<ToolOutcome<unknown>, { ok: false }>) => {
    if (o.state === 'not_in_watch') {
      if (!g.notInWatch.includes(source)) g.notInWatch.push(source);
      return `${P(source).name} is not part of this watch`;
    }
    if (o.state === 'no_data') {
      const detail = `${o.detail.charAt(0).toUpperCase()}${o.detail.slice(1)} in this workspace — not checked.`;
      if (!g.gaps.some((x) => x.detail === detail)) {
        g.gaps.push({ provider: source, detail, noData: true });
        add({ id: `${source}:nodata:${g.gaps.length}`, provider: source, direction: 'gap', statement: detail, refs: [] }, 'unavailable');
      }
      return detail;
    }
    const detail = `${P(source).name} is ${o.state === 'error' ? 'returning an error' : 'unavailable'} (${o.detail}) — its data was not checked.`;
    if (!g.gaps.some((x) => x.provider === source)) {
      g.gaps.push({ provider: source, detail });
      add({ id: `${source}:gap`, provider: source, direction: 'gap', statement: detail, refs: [] }, 'unavailable');
    }
    return detail;
  };

  const metricStep = (o: ToolOutcome<MetricResult>, source: Exclude<ProviderId, 'email'>, onData: (m: MetricResult) => Tag[]) => {
    if (!o.ok) return { ok: false, state: o.state, result: gap(source, o), refs: [] };
    const t = onData(o.data);
    if (o.data.series.id === areaMetric) g.areaMetric = o.data;
    const e = metricEvidence(o.data.series, o.data.reading, args.simulatedLinks(source), args.labels);
    add(e, ...t);
    return { ok: true, result: e.statement.replace(/^[^:]+: /, ''), refs: e.refs };
  };

  const releaseStep = (o: ToolOutcome<ReleaseRecord[]>, source: Exclude<ProviderId, 'email'>) => {
    if (!o.ok) return { ok: false, state: o.state, result: gap(source, o), refs: [] };
    if (!o.data.length) {
      add({ id: `${source}:no_release`, provider: source, direction: 'stable', statement: `${P(source).short}: no releases between ${fmtTime(changeWindow.since)} and ${fmtTime(changeWindow.until)}.`, refs: [], query: { tool: source === 'jira' ? 'getJiraRelease' : 'getStoreReleases', input: `${fmtTime(changeWindow.since)}–${fmtTime(changeWindow.until)}` } }, 'no_release');
      return { ok: true, result: `No releases between ${fmtTime(changeWindow.since)} and ${fmtTime(changeWindow.until)}`, refs: [] };
    }
    for (const r of o.data) {
      g.releases.push(r);
      const ref: SourceRef = { provider: source, kind: 'release', id: r.id };
      add(
        {
          id: `${source}:release:${r.id}`,
          provider: source,
          direction: 'change',
          statement: `${P(source).short}: release ${r.version}${r.platform !== 'all' ? ` (${r.platform === 'ios' ? 'iOS' : r.platform === 'android' ? 'Android' : 'web'})` : ''} at ${fmtTime(r.releasedAt)}${r.rollout ? ` — ${r.rollout.toLowerCase()}` : ''}.`,
          onsetAt: r.releasedAt,
          refs: [ref],
          link: link(ref, `Open ${P(source).short}`),
        },
        'release',
      );
    }
    const r = o.data[o.data.length - 1];
    return { ok: true, result: `Release ${r.version} at ${fmtTime(r.releasedAt)} — ${Math.round(minutesBetween(r.releasedAt, onsetAt))} min before the change began`, refs: o.data.map((x) => ({ provider: source, kind: 'release' as const, id: x.id })) };
  };

  const issuesStep = (o: ToolOutcome<IssueRecord[]>) => {
    if (!o.ok) return { ok: false, state: o.state, result: gap('jira', o), refs: [] };
    const issues = o.data;
    if (!issues.length) {
      add({ id: `jira:no_issues:${area}`, provider: 'jira', direction: 'stable', statement: `${P('jira').short}: no new ${areaLabel} issues since ${fmtTime(since)}.`, refs: [], query: { tool: 'getRecentJiraIssues', input: `${areaLabel} issues since ${fmtTime(since)}` } }, 'no_issues');
      return { ok: true, result: `No new ${areaLabel} issues`, refs: [] };
    }
    g.issues.push(...issues);
    const ext = issues.find((i) => i.labels.some((l) => EXTERNAL_LABELS.includes(l)));
    if (ext) externalIssue = ext;
    const product = issues.filter((i) => i !== ext);
    const refs = issues.map((i): SourceRef => ({ provider: 'jira', kind: 'issue', id: i.id }));
    if (product.length) {
      add(
        {
          id: `jira:issues:${area}`,
          provider: 'jira',
          direction: 'degraded',
          statement: `${P('jira').short}: ${product.length} new ${areaLabel} ${product.length === 1 ? 'issue' : 'issues'} since ${fmtTime(product[0].createdAt)} (${product.slice(0, 4).map((i) => i.id).join(', ')}${product.length > 4 ? ', …' : ''}).`,
          onsetAt: product[0].createdAt,
          refs: product.map((i) => ({ provider: 'jira', kind: 'issue', id: i.id })),
          link: link({ provider: 'jira', kind: 'issue', id: product[0].id }, `Open ${P('jira').short}`),
        },
        'issues',
      );
    }
    if (ext) {
      add(
        { id: `jira:external:${ext.id}`, provider: 'jira', direction: 'change', statement: `${P('jira').short}: ${ext.id} "${ext.title}" (labelled ${ext.labels.join(', ')}) at ${fmtTime(ext.createdAt)}.`, onsetAt: ext.createdAt, refs: [{ provider: 'jira', kind: 'issue', id: ext.id }], link: link({ provider: 'jira', kind: 'issue', id: ext.id }, `Open ${P('jira').short}`) },
        'external_issue',
      );
    }
    return { ok: true, result: `${issues.length} ${areaLabel} ${issues.length === 1 ? 'issue' : 'issues'}: ${issues.slice(0, 3).map((i) => i.id).join(', ')}${ext ? ` — ${ext.id} is a third-party report` : ''}`, refs };
  };

  const reviewsStep = (o: ToolOutcome<ReviewRecord[]>, source: 'app_store' | 'google_play') => {
    if (!o.ok) return { ok: false, state: o.state, result: gap(source, o), refs: [] };
    if (!o.data.length) {
      add({ id: `${source}:no_reviews:${area}`, provider: source, direction: 'stable', statement: `${P(source).short}: no 1–2★ reviews mention ${areaLabel} since ${fmtTime(since)}.`, refs: [], query: { tool: source === 'app_store' ? 'getAppStoreReviews' : 'getPlayStoreReviews', input: `${areaLabel} reviews since ${fmtTime(since)}` } }, 'no_reviews');
      return { ok: true, result: `No negative reviews about ${areaLabel}`, refs: [] };
    }
    g.reviews.push(...o.data);
    const refs = o.data.map((r): SourceRef => ({ provider: source, kind: 'review', id: r.id }));
    add(
      {
        id: `${source}:reviews:${area}`,
        provider: source,
        direction: 'degraded',
        statement: `${P(source).short}: ${o.data.length} ${o.data.length === 1 ? 'review rated 1–2★ mentions' : 'reviews rated 1–2★ mention'} ${areaLabel} since ${fmtTime(o.data[0].createdAt)}.`,
        onsetAt: o.data[0].createdAt,
        refs,
        link: link(refs[0], `Open ${P(source).short}`),
      },
      'reviews',
    );
    return { ok: true, result: `${o.data.length} negative ${o.data.length === 1 ? 'review' : 'reviews'}: “${o.data[0].title}”${o.data.length > 1 ? ' …' : ''}`, refs };
  };

  // ── Hypotheses to keep open, by kind of signal ─────────────
  const primaryMeta = SIGNALS[primary.key];
  const customerPrimary = primaryMeta.kind === 'issues' || primaryMeta.kind === 'reviews';
  const crashPrimary = primary.key.endsWith('crash_free_sessions');
  const kinds: HypothesisKind[] = customerPrimary
    ? ['customer_only', 'shared_product_issue', 'release_related', 'external_or_unobserved']
    : crashPrimary
      ? ['release_related', 'shared_product_issue', 'external_or_unobserved']
      : ['release_related', 'shared_product_issue', 'demand_shift', 'measurement_artifact', 'external_or_unobserved'];

  // ── Candidate tool calls (the agent's options) ─────────────
  const areaMetric = AREA_METRICS[area][0];
  const candidates: Candidate[] = [];
  const addCandidate = (c: Candidate) => {
    if (watch.sources.includes(c.source)) candidates.push(c);
  };
  addCandidate({ key: 'jira_release', tool: 'getJiraRelease', source: 'jira', input: `released ${fmtTime(changeWindow.since)}–${fmtTime(changeWindow.until)}`, tests: ['release_related'], why: 'Was anything released shortly before the change began?', exec: async () => releaseStep(await tb.getJiraRelease(changeWindow), 'jira') });
  for (const store of ['app_store', 'google_play'] as const) {
    addCandidate({ key: `${store}_release`, tool: 'getStoreReleases', source: store, input: `${store === 'app_store' ? 'iOS' : 'Android'} releases ${fmtTime(changeWindow.since)}–${fmtTime(changeWindow.until)}`, tests: ['release_related'], why: `Did ${store === 'app_store' ? 'an iOS' : 'an Android'} build ship shortly before the change?`, exec: async () => releaseStep(await tb.getStoreReleases({ ...changeWindow, store }), store) });
  }
  if (area !== 'general') {
    addCandidate({ key: 'jira_issues', tool: 'getRecentJiraIssues', source: 'jira', input: `${areaLabel} issues created since ${fmtTime(since)}`, tests: ['shared_product_issue', 'external_or_unobserved', 'customer_only'], why: `Are people reporting ${areaLabel} bugs — or a third-party problem?`, exec: async () => issuesStep(await tb.getRecentJiraIssues({ since, until: at, area })) });
  }
  if (!customerPrimary && !crashPrimary) {
    addCandidate({ key: 'traffic', tool: 'getAnalyticsTraffic', source: 'ga4', input: `ga4.sessions until ${fmtTime(at)}`, tests: ['demand_shift'], why: 'Did fewer people arrive, or did the same people convert less?', exec: async () => metricStep(await tb.getAnalyticsTraffic({ until: at }), 'ga4', (m) => [m.reading.status === 'normal' ? 'traffic_stable' : 'traffic_drop']) });
  }
  if (area === 'checkout' && primary.key !== 'ga4.purchase_revenue' && !customerPrimary && !crashPrimary) {
    addCandidate({ key: 'revenue', tool: 'getAnalyticsMetric', source: 'ga4', input: 'ga4.purchase_revenue', tests: ['measurement_artifact'], why: 'Does an independent money measure move too, or only the conversion metric?', exec: async () => metricStep(await tb.getAnalyticsMetric({ metricId: 'ga4.purchase_revenue', until: at }), 'ga4', (m) => { revenueStable = m.reading.status === 'normal'; return [revenueStable ? 'revenue_stable' : 'revenue_drop']; }) });
  }
  if ((customerPrimary || crashPrimary) && areaMetric && area !== 'stability') {
    addCandidate({ key: 'area_metric', tool: 'getAnalyticsMetric', source: 'ga4', input: areaMetric, tests: ['customer_only', 'shared_product_issue'], why: `Is the ${areaLabel} funnel actually affected in analytics?`, exec: async () => metricStep(await tb.getAnalyticsMetric({ metricId: areaMetric, until: at }), 'ga4', (m) => [m.reading.status === 'normal' ? 'area_metric_stable' : 'area_metric_degraded']) });
  }
  if (crashPrimary && watch.sources.includes('ga4')) {
    addCandidate({ key: 'area_metric', tool: 'getAnalyticsMetric', source: 'ga4', input: 'ga4.checkout_conversion', tests: ['shared_product_issue'], why: 'Are crashes hurting the core funnel?', exec: async () => metricStep(await tb.getAnalyticsMetric({ metricId: 'ga4.checkout_conversion', until: at }), 'ga4', (m) => [m.reading.status === 'normal' ? 'area_metric_stable' : 'area_metric_degraded']) });
  }
  if (area !== 'search' && area !== 'general') {
    for (const store of ['app_store', 'google_play'] as const) {
      if (primary.key === `${store}.crash_free_sessions`) continue;
      addCandidate({ key: `${store}_crash`, tool: 'getStoreCrashRate', source: store, input: `${store}.crash_free_sessions until ${fmtTime(at)}`, tests: ['shared_product_issue'], why: `Is the ${store === 'app_store' ? 'iOS' : 'Android'} app crashing more than normal?`, exec: async () => metricStep(await tb.getStoreCrashRate({ store, until: at }), store, (m) => [m.reading.status === 'normal' ? 'crash_stable' : 'crash_degraded']) });
    }
  }
  for (const store of ['app_store', 'google_play'] as const) {
    if (primary.key === `${store}.reviews`) continue;
    const tool: ToolName = store === 'app_store' ? 'getAppStoreReviews' : 'getPlayStoreReviews';
    addCandidate({ key: `${store}_reviews`, tool, source: store, input: `1–2★ reviews mentioning ${areaLabel} since ${fmtTime(since)}`, tests: ['shared_product_issue', 'customer_only'], why: `Are ${store === 'app_store' ? 'iOS' : 'Android'} customers complaining about ${areaLabel}?`, exec: async () => reviewsStep(store === 'app_store' ? await tb.getAppStoreReviews({ since, until: at, area }) : await tb.getPlayStoreReviews({ since, until: at, area }), store) });
  }

  // ── Hypothesis evaluation (recomputed from all evidence so far) ──
  const done = new Set<string>();
  const ran = (k: HypothesisKind) => candidates.some((c) => done.has(c.key) && c.tests.includes(k));
  const releaseVersion = () => g.releases.filter((r) => Date.parse(r.releasedAt) <= Date.parse(onsetAt) + 15 * 60_000).sort((a, b) => b.releasedAt.localeCompare(a.releasedAt))[0]?.version;

  function evaluate(): AgentHypothesis[] {
    const degradedProviders = new Set<ProviderId>();
    for (const e of g.evidence) {
      const t = tags.get(e.id);
      if (t && (t.has('primary') || t.has('issues') || t.has('crash_degraded') || t.has('reviews') || t.has('area_metric_degraded'))) degradedProviders.add(e.provider);
    }
    const nonAnalyticsDegraded = [...degradedProviders].some((p) => p !== 'ga4');
    const ids = (t: Tag) => withTag(t).map((e) => e.id);
    return kinds.map((kind): AgentHypothesis => {
      const tested = ran(kind) || (kind === 'measurement_artifact' && (ran('shared_product_issue') || has('revenue_stable') || has('revenue_drop')));
      let statusOverride: AgentHypothesis['status'] | undefined;
      let strength: EvidenceStrength = 'none';
      let forIds: string[] = [];
      let againstIds: string[] = [];
      const unknowns: string[] = [];
      let statement = '';
      switch (kind) {
        case 'release_related': {
          const v = releaseVersion();
          statement = v ? `The change is related to release ${v}` : 'A recent release is involved';
          forIds = ids('release');
          const tagged = v ? [...g.issues.filter((i) => i.affectsVersion === v || i.labels.includes(v)), ...g.reviews.filter((r) => r.version === v)] : [];
          if (tagged.length) forIds.push(...g.evidence.filter((e) => e.refs.some((r) => tagged.some((x) => x.id === r.id))).map((e) => e.id));
          againstIds = ids('no_release');
          const releaseSourceDown = g.gaps.some((x) => !x.noData && candidates.some((c) => c.source === x.provider && c.tests.includes('release_related')));
          // Timing is correlation. A release in the window is weak evidence; reports tagged with that
          // version make it moderate. It never becomes strong: that would be causation by timing.
          if (v) strength = tagged.length ? 'moderate' : 'weak';
          else if (againstIds.length && !releaseSourceDown) statusOverride = 'ruled_out';
          else if (releaseSourceDown) unknowns.push('Release history could not be fully checked — a source was unavailable.');
          unknowns.push(v ? `Whether release ${v} is responsible — timing is not causation.` : 'No release was found in the window.');
          break;
        }
        case 'shared_product_issue': {
          statement = `A real ${areaLabel} problem is affecting users (bug or crash)`;
          forIds = g.evidence.filter((e) => degradedProviders.has(e.provider) && e.direction === 'degraded').map((e) => e.id);
          againstIds = [...ids('crash_stable'), ...ids('no_issues'), ...ids('no_reviews')];
          const n = degradedProviders.size;
          strength = n >= 3 ? 'strong' : n === 2 ? 'moderate' : n === 1 ? 'weak' : 'none';
          const unchecked = candidates.filter((c) => c.tests.includes(kind) && !done.has(c.key)).map((c) => `${P(c.source).short} ${TOOL_NOUN[c.tool]}`);
          if (unchecked.length) unknowns.push(`Not checked: ${[...new Set(unchecked)].join(', ')}.`);
          break;
        }
        case 'demand_shift':
          statement = 'Fewer people reached the funnel (traffic or demand change)';
          forIds = ids('traffic_drop');
          againstIds = ids('traffic_stable');
          if (againstIds.length) statusOverride = 'ruled_out';
          else if (forIds.length) strength = 'strong';
          break;
        case 'measurement_artifact':
          statement = 'A tracking or measurement change, not a real change in behaviour';
          forIds = ids('revenue_stable');
          againstIds = [...ids('revenue_drop'), ...(nonAnalyticsDegraded ? g.evidence.filter((e) => e.direction === 'degraded' && e.provider !== 'ga4').map((e) => e.id) : [])];
          if (has('revenue_drop') || (nonAnalyticsDegraded && !forIds.length)) statusOverride = 'ruled_out';
          else if (forIds.length) strength = 'moderate';
          else if (tested) strength = 'weak';
          unknowns.push('No server-side data is connected to confirm what analytics reports.');
          break;
        case 'external_or_unobserved':
          statement = externalIssue ? `A third-party problem reported in ${P('jira').short} (${externalIssue.id})` : 'A cause outside the connected sources (payment provider, backend, marketing change)';
          forIds = ids('external_issue');
          strength = forIds.length ? 'moderate' : 'weak';
          unknowns.push(area === 'checkout' ? 'Payment-provider and backend status are not connected to Jagr.' : 'Backend and marketing data are not connected to Jagr.');
          break;
        case 'customer_only':
          statement = `Customers hit a ${areaLabel} problem that analytics does not show yet`;
          forIds = ids('area_metric_stable');
          againstIds = ids('area_metric_degraded');
          if (againstIds.length) statusOverride = 'ruled_out';
          else if (forIds.length) strength = 'moderate';
          unknowns.push('How many customers are affected.');
          break;
      }
      forIds = [...new Set(forIds)];
      againstIds = [...new Set(againstIds)];
      let status: AgentHypothesis['status'];
      if (statusOverride) status = statusOverride;
      else if (!tested && kind !== 'external_or_unobserved') status = 'untested';
      // Proportionate: evidence against is always recorded, but one quiet source does not contest
      // an explanation that three or more independent sources support.
      else if (forIds.length && againstIds.length && !(strength === 'strong' && againstIds.length < forIds.length)) status = 'contested';
      else if (RANK[strength] >= 2) status = 'supported';
      else status = 'open';
      if (status === 'ruled_out') strength = 'none';
      return { kind, statement, status, strength, evidenceFor: forIds, evidenceAgainst: againstIds, unknowns };
    });
  }

  const describe = (h: AgentHypothesis) => (h.status === 'ruled_out' ? 'ruled out' : h.status === 'untested' ? 'untested' : `${h.strength}${h.status === 'contested' ? ', contested' : ''}`);
  // Hypotheses keep a fixed order, so index i is the same explanation before and after.
  const diff = (a: AgentHypothesis[], b: AgentHypothesis[]) => b.flatMap((h, i) => (describe(h) !== describe(a[i]) ? [`${HYP_LABEL[h.kind]}: ${describe(a[i])} → ${describe(h)}`] : []));

  // ── Run ─────────────────────────────────────────────────────
  step({ kind: 'signal', title: `Signal: ${primary.label} ${primary.magnitude}`, detail: `${P(primary.provider).short} · began in the ${fmtTime(primary.onsetAt)} bucket · ${args.trigger}`, source: primary.provider, refs: primary.refs });
  step({
    kind: 'plan',
    title: 'Investigation plan',
    detail: `Keep ${kinds.length} explanations open and test each: ${kinds.map((k) => HYP_LABEL[k].toLowerCase()).join(', ')}. Sources in this watch: ${watch.sources.map((p) => `${P(p).short} (${args.connectionState(p)})`).join(', ')}.`,
  });
  // Sources known to be down are recorded as gaps now; the validator will not let anything call them.
  for (const p of watch.sources) {
    if (p === 'email' || p === primary.provider) continue;
    const st = args.connectionState(p);
    if (st !== 'unavailable' && st !== 'error') continue;
    const detail = gap(p, { ok: false, state: st, detail: args.connectionDetail?.(p) ?? `connection ${st}` });
    step({ kind: 'gap', title: `${P(p).short} unavailable — its tools will not be called`, detail, source: p, status: st as TraceStep['status'] });
  }

  // 1. Re-read the primary signal from its source rather than trusting the detector's cached value.
  let toolCalls = 0;
  const confirm = await (async () => {
    if (primaryMeta.kind === 'metric') {
      const p = primary.provider as Exclude<ProviderId, 'email'>;
      const o = p === 'ga4' ? await tb.getAnalyticsMetric({ metricId: primary.key, until: at }) : await tb.getStoreCrashRate({ store: p as 'app_store' | 'google_play', until: at });
      if (o.ok) persisted = o.data.reading.status !== 'normal';
      return { tool: (p === 'ga4' ? 'getAnalyticsMetric' : 'getStoreCrashRate') as ToolName, input: primary.key, out: metricStep(o, p, () => ['primary']) };
    }
    if (primaryMeta.kind === 'issues') {
      done.add('jira_issues');
      const out = issuesStep(await tb.getRecentJiraIssues({ since: addMinutes(at, -180), until: at, area }));
      for (const e of g.evidence) if (e.provider === 'jira' && e.direction === 'degraded') tags.get(e.id)?.add('primary');
      return { tool: 'getRecentJiraIssues' as ToolName, input: `${areaLabel} issues, last 3h`, out };
    }
    const store = primary.provider as 'app_store' | 'google_play';
    done.add(`${store}_reviews`);
    const o = store === 'app_store' ? await tb.getAppStoreReviews({ since: addMinutes(at, -360), until: at, area }) : await tb.getPlayStoreReviews({ since: addMinutes(at, -360), until: at, area });
    const out = reviewsStep(o, store);
    for (const e of g.evidence) if (e.provider === store && e.direction === 'degraded') tags.get(e.id)?.add('primary');
    return { tool: (store === 'app_store' ? 'getAppStoreReviews' : 'getPlayStoreReviews') as ToolName, input: `${areaLabel} reviews, last 6h`, out };
  })();
  toolCalls++;
  step({ kind: 'tool_call', title: `${P(primary.provider).short} → ${confirm.input}`, tool: confirm.tool, source: primary.provider, input: confirm.input, why: 'Re-read the signal from its source before investigating — do not trust a cached reading.' });
  step({ kind: 'result', title: confirm.out.result, tool: confirm.tool, source: primary.provider, status: confirm.out.ok ? 'ok' : (confirm.out.state as TraceStep['status']), refs: confirm.out.refs });

  let hyps = evaluate();
  step({ kind: 'hypothesis', title: 'Competing explanations', detail: hyps.map((h) => `${HYP_LABEL[h.kind]} — ${describe(h)}`).join(' · ') });

  let stopReason = '';
  if (!persisted) {
    stopReason = 'The signal is no longer present in the source. Stopping: nothing to investigate.';
  }

  // ── Planning helpers ───────────────────────────────────────
  const failedSources = new Set<ProviderId>();
  const attempts: Partial<Record<HypothesisKind, number>> = {};
  const qualified = (c: Candidate) => (candidates.filter((x) => x.tool === c.tool).length > 1 ? `${c.tool}(${c.tool === 'getAnalyticsMetric' ? c.input : c.source})` : c.tool);
  const hypIds = (ks: HypothesisKind[]) => ks.filter((k) => kinds.includes(k)).map((k) => HYPOTHESIS_ID[k]);
  const kindOf = new Map(kinds.map((k) => [HYPOTHESIS_ID[k], k]));
  const statement = (id: string) => g.evidence.find((e) => e.id === id)?.statement ?? id;

  // Tunnel-vision guard: after two probes of an explanation that changed nothing, it waits until every
  // other open explanation has had at least one test.
  const noChange: Partial<Record<HypothesisKind, number>> = {};
  const tunnel = (k: HypothesisKind, hs: AgentHypothesis[], useful: (h: AgentHypothesis) => boolean) =>
    (noChange[k] ?? 0) >= 2 && hs.some((h) => h.kind !== k && useful(h) && !(attempts[h.kind] ?? 0) && candidates.some((c) => !done.has(c.key) && c.tests.includes(h.kind) && !failedSources.has(c.source) && !['unavailable', 'error'].includes(args.connectionState(c.source))));

  /** Deterministic ranking: untested explanations first, then the least-probed useful ones. */
  const ranking = (untested: AgentHypothesis[], useful: AgentHypothesis[], remaining: Candidate[]) => {
    const out: { c: Candidate; target: HypothesisKind }[] = [];
    for (const t of [...untested, ...useful]) for (const c of remaining) if (c.tests.includes(t.kind) && !out.some((x) => x.c === c)) out.push({ c, target: t.kind });
    return out;
  };

  const plannerInput = (hs: AgentHypothesis[], useful: (h: AgentHypothesis) => boolean, used: number): PlannerInput => ({
    investigationId: args.investigationId ?? '',
    pass,
    signal: { key: primary.key, label: primary.label, magnitude: primary.magnitude },
    area: areaLabel,
    budget: { used, max: BUDGET },
    hypotheses: hs.map((h) => ({ id: HYPOTHESIS_ID[h.kind], kind: h.kind, label: HYP_LABEL[h.kind], status: h.status, strength: h.strength, ceiling: CEILING[h.kind], evidenceFor: h.evidenceFor.map(statement), evidenceAgainst: h.evidenceAgainst.map(statement), unknowns: h.unknowns })),
    evidence: g.evidence.map((e) => ({ source: P(e.provider).short, direction: e.direction, statement: e.statement })),
    options: candidates.map(
      (c): PlannerOption => ({
        id: qualified(c),
        tool: c.tool,
        source: c.source,
        sourceState: args.connectionState(c.source),
        tests: hypIds(c.tests),
        question: c.why,
        alreadyQueried: done.has(c.key),
        sourceFailed: failedSources.has(c.source),
        informative: !done.has(c.key) && c.tests.some((k) => { const h = hs.find((x) => x.kind === k); return !!h && useful(h) && !tunnel(k, hs, useful); }),
        probeLimited: !done.has(c.key) && c.tests.some((k) => { const h = hs.find((x) => x.kind === k); return !!h && useful(h) && tunnel(k, hs, useful); }),
      }),
    ),
  });

  const plannerStep = (d: PlannerDecision) => {
    step({ kind: 'planner', title: plannerTitle(d), planner: d });
    return trace[trace.length - 1].planner!;
  };

  /** Model proposes → validator decides. On any failure or rejection, the deterministic planner proposes → validator decides. */
  const choose = async (
    ranked: { c: Candidate; target: HypothesisKind }[],
    hs: AgentHypothesis[],
    useful: (h: AgentHypothesis) => boolean,
    remaining: Candidate[],
    used: number,
  ): Promise<{ candidate: Candidate; targets: HypothesisKind[]; decision: PlannerDecision } | null> => {
    const input = plannerInput(hs, useful, used);
    const byId = (id: string) => remaining.find((c) => qualified(c) === id)!;
    let failure: PlannerDecision['failure'];
    if (args.planner) {
      const p = await args.planner.plan(input);
      const who = provenance(p, args.planner.label);
      if (p.status === 'ok') {
        const v = validatePlan(p.proposal, input);
        const withheld = !v.ok && v.code === 'CAUSAL_CLAIM';
        const base: PlannerDecision = {
          type: 'LLM',
          investigationId: args.investigationId,
          ...who,
          proposedTool: p.proposal.nextTool,
          evidenceGap: withheld ? undefined : p.proposal.evidenceGap,
          reason: withheld ? undefined : p.proposal.reason,
          hypothesesAffected: p.proposal.hypothesesAffected,
          expectedEvidence: withheld ? undefined : p.proposal.expectedEvidence,
          validator: v.ok ? 'APPROVED' : 'REJECTED',
          cached: p.cached || undefined,
        };
        if (v.ok) {
          const candidate = byId(v.option.id);
          const targets = p.proposal.hypothesesAffected.map((id) => kindOf.get(id)).filter((k): k is HypothesisKind => !!k && candidate.tests.includes(k));
          const decision = plannerStep({ ...base, executedTool: v.option.id });
          return { candidate, targets, decision };
        }
        plannerStep({ ...base, rejection: { code: v.code, reason: v.reason } });
        failure = { code: 'REJECTED', detail: `Policy rejected the ${who.plannerLabel} plan (${v.code}).` };
      } else {
        plannerStep({ type: 'LLM', investigationId: args.investigationId, ...who, validator: 'NOT_RUN', failure: { code: p.code, detail: p.detail } });
        failure = { code: p.code, detail: p.detail };
      }
    }
    // Deterministic fallback — validated exactly like a model plan.
    for (const { c, target } of ranked) {
      const h = hs.find((x) => x.kind === target)!;
      const plan: PlannerProposal = {
        nextTool: qualified(c),
        reason: c.why,
        evidenceGap: `${HYP_LABEL[target]} is ${h.status === 'untested' ? 'untested' : h.strength === 'none' ? 'still without evidence' : `only ${h.strength}`}`,
        hypothesesAffected: hypIds(c.tests).length ? hypIds(c.tests) : [HYPOTHESIS_ID[target]],
        expectedEvidence: `Evidence that could strengthen or weaken ${c.tests.filter((k) => kinds.includes(k)).map((k) => HYP_LABEL[k].toLowerCase()).join(', ')}.`,
      };
      const v = validatePlan(plan, input);
      if (!v.ok) continue;
      const decision = plannerStep({
        // No LLM planner configured → the deterministic planner is simply the planner. Otherwise it is a fallback.
        type: args.planner ? 'DETERMINISTIC_FALLBACK' : 'DETERMINISTIC',
        investigationId: args.investigationId,
        plannerLabel: 'Deterministic planner',
        proposedTool: plan.nextTool,
        evidenceGap: plan.evidenceGap,
        reason: plan.reason,
        hypothesesAffected: plan.hypothesesAffected,
        expectedEvidence: plan.expectedEvidence,
        validator: 'APPROVED',
        executedTool: plan.nextTool,
        failure,
      });
      return { candidate: byId(v.option.id), targets: [target], decision };
    }
    return null;
  };

  // Breadth before depth: prefer the open explanation that has had the fewest calls aimed at it,
  // so one familiar story (usually the release) cannot soak up the budget.
  let unchangedRun = 0;
  while (!stopReason) {
    // Diminishing returns means repeated probing of the same questions — not "an explanation nobody has
    // tested yet". Whatever order a planner prefers, every open explanation gets at least one direct test.
    const unprobed = hyps.filter((h) => (h.status === 'untested' || (h.status !== 'ruled_out' && !(attempts[h.kind] ?? 0) && RANK[h.strength] < RANK[CEILING[h.kind]])) && candidates.some((c) => !done.has(c.key) && c.tests.includes(h.kind) && !failedSources.has(c.source) && !['unavailable', 'error'].includes(args.connectionState(c.source))));
    if (unchangedRun >= STALE_LIMIT && !unprobed.length) {
      stopReason = `Diminishing returns: the last ${STALE_LIMIT} calls did not change any explanation. Stopping rather than spending more calls on the same question.`;
      break;
    }
    if (toolCalls >= BUDGET) {
      stopReason = `Investigation stopped because the maximum tool-call budget was reached (${BUDGET} calls). Stopping with the evidence gathered so far.`;
      break;
    }
    const remaining = candidates.filter((c) => !done.has(c.key));
    // A call is only worth making if it can still move an explanation below its ceiling.
    const useful = (h: AgentHypothesis) => h.status !== 'ruled_out' && RANK[h.strength] < RANK[CEILING[h.kind]] && remaining.some((c) => c.tests.includes(h.kind));
    const untested = hyps.filter((h) => h.status === 'untested' && remaining.some((c) => c.tests.includes(h.kind)));
    const leading = [...hyps].filter((h) => h.status !== 'ruled_out' && h.kind !== 'external_or_unobserved').sort((a, b) => RANK[b.strength] - RANK[a.strength])[0];
    // Stop early only when the impact question is settled — is the problem real, and how broad? —
    // not when a convenient explanation looks good. Release timing alone never ends an investigation.
    const impact = hyps.find((h) => h.kind === 'shared_product_issue');
    const impactSettled = !!impact && (impact.strength === 'strong' || impact.status === 'ruled_out');

    // Scoping, not diagnosis: once impact is confirmed, check once whether customers are noticing.
    // It cannot change the cause question, but it informs the attention and customer-communication decisions.
    // Business impact (revenue) is scoped the same way: it rarely changes an explanation once
    // measurement is ruled out, but a PM needs the money number.
    const feedbackChecked = candidates.some((c) => c.key.endsWith('_reviews') && done.has(c.key)) || primaryMeta.kind === 'reviews';
    const scope = [
      { c: remaining.find((c) => c.key === 'revenue'), title: 'Scope gap: how much revenue is affected?', why: 'Size the business impact before deciding who to tell and what to prepare.' },
      { c: feedbackChecked ? undefined : remaining.find((c) => c.key.endsWith('_reviews')), title: 'Scope gap: are customers noticing?', why: 'Scope customer-visible impact before deciding who to tell and what to prepare.' },
    ].find((x) => x.c);
    const feedback = scope?.c;
    if (!untested.length && impactSettled && impact!.status !== 'ruled_out' && feedback && toolCalls < BUDGET) {
      step({ kind: 'gap', title: scope!.title, detail: `Impact is confirmed; the cause question is not what this answers. Next: ${P(feedback.source).short} — ${scope!.why}` });
      done.add(feedback.key);
      toolCalls++;
      const out = await feedback.exec();
      step({ kind: 'tool_call', title: `${P(feedback.source).short} → ${feedback.input}`, tool: feedback.tool, source: feedback.source, input: feedback.input, why: scope!.why });
      const before = hyps;
      hyps = evaluate();
      const changed = diff(before, hyps);
      step({ kind: 'result', title: out.result, tool: feedback.tool, source: feedback.source, status: out.ok ? 'ok' : (out.state as TraceStep['status']), refs: out.refs, changed: changed.length ? changed : ['No change to any explanation — scoping only'] });
      continue;
    }
    if (!untested.length && impactSettled) {
      const skipped = remaining.map((c) => `${P(c.source).short} (${c.tool})`);
      stopReason = `Enough evidence: the ${areaLabel} problem is ${impact!.status === 'ruled_out' ? 'not confirmed by any other source' : 'confirmed by three or more independent sources'} and every competing explanation has been tested.${skipped.length ? ` Skipped ${skipped.join(', ')} — they could not change the attention decision.` : ''}`;
      break;
    }
    // ── Choose the next tool: model proposes (if configured) → policy validates → else fallback ──
    const ranked = ranking(untested, hyps.filter(useful).sort((a, b) => (attempts[a.kind] ?? 0) - (attempts[b.kind] ?? 0)), remaining);
    const chosen = ranked.length ? await choose(ranked, hyps, useful, remaining, toolCalls) : null;
    if (!chosen) {
      const best = leading;
      stopReason =
        best && RANK[best.strength] >= 2
          ? `No remaining source in this watch can change the picture. Best-supported explanation: ${HYP_LABEL[best.kind].toLowerCase()} (${best.strength}).`
          : 'Evidence is insufficient and no remaining source in this watch can add more. Jagr will not guess a cause.';
      break;
    }
    const next = chosen.candidate;
    done.add(next.key);
    for (const k of chosen.targets) attempts[k] = (attempts[k] ?? 0) + 1;
    toolCalls++;
    const out = await next.exec();
    // Only an unreachable source is skipped for the rest of the pass — a metric with no data is not an outage.
    if (!out.ok && out.state !== 'no_data') failedSources.add(next.source);
    step({ kind: 'tool_call', title: `${P(next.source).short} → ${next.input}`, tool: next.tool, source: next.source, input: next.input, why: next.why });
    chosen.decision.resultSummary = out.result;
    const before = hyps;
    hyps = evaluate();
    const changed = diff(before, hyps);
    // An unavailable source is not a sign of diminishing returns — it is a reason to try the alternative.
    if (out.ok) unchangedRun = changed.length ? 0 : unchangedRun + 1;
    if (out.ok) for (const k of chosen.targets) noChange[k] = changed.some((c) => c.startsWith(`${HYP_LABEL[k]}:`)) ? 0 : (noChange[k] ?? 0) + 1;
    step({
      kind: 'result',
      title: out.result,
      tool: next.tool,
      source: next.source,
      status: out.ok ? 'ok' : (out.state as TraceStep['status']),
      refs: out.refs,
      changed: changed.length ? changed : ['No change to any explanation'],
    });
  }

  step({ kind: 'stop', title: 'Stopped investigating', detail: stopReason });
  g.trafficStable = has('traffic_stable') ? true : has('traffic_drop') ? false : undefined;
  return { gathered: g, hypotheses: hyps, trace, toolCalls, stopReason, signalPersisted: persisted, revenueStable, externalIssue };
}

