import type { Area, AttentionLevel, MonitoringResult, ProviderId, SourceConnection, Watch, WatchTemplateId } from '../types.js';
import { defaultBriefSchedule, watchFromTemplate } from '../catalog.js';
import { defaultConnections, resolveRef } from '../integrations/adapters.js';
import { buildWorld, CHECKOUT_ISSUES, CHECKOUT_REVIEWS, RELEASES_481, t, type World, type WorldSpec } from '../integrations/world.js';
import type { IssueRecord, ReviewRecord } from '../integrations/types.js';
import { runMonitoring } from '../engine/monitor.js';
import { atLeast } from '../engine/attention.js';
import { hasCausalOverclaim } from '../engine/language.js';
import { dailyOccurrences, planJobs, watchRunTimes } from '../scheduler.js';

/**
 * Golden evaluation set. Each case is a night of raw fixture data plus the ground truth a PM
 * would agree with. Cases check behaviour; the suite also computes product-level metrics —
 * the most important being the false interruption rate.
 */

export interface Check {
  label: string;
  passed: boolean;
  detail: string;
}

interface Truth {
  area: Area;
  attention: AttentionLevel;
}

export interface GoldenCase {
  id: string;
  title: string;
  scenario: string;
  expected: string;
  world: () => World;
  watches: () => Watch[];
  connections?: (c: SourceConnection[]) => SourceConnection[];
  truth: Truth[];
  expectedProviders?: ProviderId[];
  check: (r: MonitoringResult) => Check[];
}

const c = (label: string, passed: boolean, detail: string): Check => ({ label, passed, detail });
const w = (tpl: WatchTemplateId, freq: Watch['schedule']['frequency'] = '30m', id: string = tpl) => watchFromTemplate(id, tpl, { schedule: { frequency: freq, dailyAt: '07:00' } });
const open = (r: MonitoringResult) => r.investigations.filter((i) => i.status !== 'DISMISSED' && atLeast(i.attention, 'MEDIUM'));
const byArea = (r: MonitoringResult, area: Area) => r.investigations.filter((i) => i.area === area && i.status !== 'DISMISSED');
const alerts = (r: MonitoringResult) => r.emails.filter((e) => e.kind === 'alert');

const fullCheckout: WorldSpec = {
  id: 'full-checkout',
  name: 'Checkout degradation across sources',
  seed: 481,
  effects: {
    'ga4.checkout_conversion': [{ from: '19:00', change: -18 }],
    'ga4.purchase_revenue': [{ from: '19:00', change: -16 }],
    'app_store.crash_free_sessions': [{ from: '19:00', change: -0.67 }],
    'google_play.crash_free_sessions': [{ from: '19:15', change: -0.35 }],
  },
  releases: RELEASES_481,
  issues: CHECKOUT_ISSUES,
  reviews: CHECKOUT_REVIEWS,
};

const CRASH_ISSUES: IssueRecord[] = [
  { id: 'MOB-201', provider: 'jira', title: 'App crashes on launch after 4.8.1', type: 'Bug', priority: 'High', component: 'Mobile', area: 'stability', labels: ['crash', '4.8.1'], affectsVersion: '4.8.1', reporter: 'QA', createdAt: t('19:25') },
  { id: 'MOB-202', provider: 'jira', title: 'Crash when opening settings on Android', type: 'Bug', priority: 'High', component: 'Mobile', area: 'stability', labels: ['crash'], reporter: 'Support', createdAt: t('20:10') },
];

const REVIEW_SPIKE: ReviewRecord[] = [
  { id: 'as-r-9101', provider: 'app_store', rating: 1, title: 'Checkout confusing', body: 'The new checkout asks for my address twice.', version: '4.8.0', createdAt: t('21:05') },
  { id: 'as-r-9102', provider: 'app_store', rating: 2, title: 'Payment page slow', body: 'Payment takes forever to load at checkout.', version: '4.8.0', createdAt: t('21:40') },
  { id: 'as-r-9103', provider: 'app_store', rating: 1, title: 'Checkout error', body: 'Got an error at checkout, worked on retry.', version: '4.8.0', createdAt: t('22:15') },
  { id: 'as-r-9104', provider: 'app_store', rating: 2, title: 'Upgrade flow', body: 'Upgrade button at checkout did nothing once.', version: '4.8.0', createdAt: t('23:10') },
  { id: 'gp-r-7101', provider: 'google_play', rating: 1, title: 'Checkout', body: 'Checkout page keeps reloading.', version: '4.8.0', createdAt: t('22:30') },
];

const BLOCKERS: IssueRecord[] = [
  { id: 'PAY-601', provider: 'jira', title: 'Checkout returns 500 for all card payments', type: 'Incident', priority: 'Highest', component: 'Checkout', area: 'checkout', labels: ['incident'], reporter: 'On-call', createdAt: t('23:05') },
  { id: 'PAY-602', provider: 'jira', title: 'Subscriptions failing to activate after payment', type: 'Bug', priority: 'Highest', component: 'Checkout', area: 'checkout', labels: ['incident'], reporter: 'Support', createdAt: t('23:20') },
  { id: 'PAY-603', provider: 'jira', title: 'Checkout crash on iOS payment sheet', type: 'Bug', priority: 'Highest', component: 'Checkout', area: 'checkout', labels: ['crash'], reporter: 'QA', createdAt: t('23:30') },
];

export const GOLDEN_CASES: GoldenCase[] = [
  {
    id: 'EVAL-001',
    title: 'Conversion drops 18% after release',
    scenario: 'GA4 checkout conversion −18% from 19:00. Release 4.8.1 shipped 18:30–18:45. No other source moves.',
    expected: 'Investigate and correlate the release — without claiming it caused the drop.',
    world: () => buildWorld({ id: 'e001', name: 'EVAL-001', seed: 1001, effects: { 'ga4.checkout_conversion': [{ from: '19:00', change: -18 }] }, releases: RELEASES_481 }),
    watches: () => [w('checkout_health')],
    truth: [{ area: 'checkout', attention: 'HIGH' }],
    check: (r) => {
      const inv = byArea(r, 'checkout')[0];
      return [
        c('Investigation opened', !!inv, inv ? `${inv.title} (${inv.status})` : 'None'),
        c('Release correlated', inv?.releaseAssociation?.version === '4.8.1', inv?.releaseAssociation ? `4.8.1, ${inv.releaseAssociation.minutesBeforeOnset} min before onset` : 'No release association'),
        c('States correlation, not causation', !!inv && inv.likelyExplanation.includes('does not establish causation'), inv?.likelyExplanation ?? ''),
        c('PM notified once', alerts(r).length === 1, `${alerts(r).length} email(s)`),
      ];
    },
  },
  {
    id: 'EVAL-002',
    title: 'Conversion drops 2%',
    scenario: 'GA4 checkout conversion −2% all night. Nothing else changes.',
    expected: 'No interruption.',
    world: () => buildWorld({ id: 'e002', name: 'EVAL-002', seed: 1002, effects: { 'ga4.checkout_conversion': [{ from: '19:00', change: -2 }] } }),
    watches: () => [w('checkout_health')],
    truth: [],
    check: (r) => [
      c('No investigation needing attention', open(r).length === 0, `${open(r).length} open`),
      c('No email', alerts(r).length === 0, `${alerts(r).length} email(s)`),
    ],
  },
  {
    id: 'EVAL-003',
    title: 'Crash spike + Jira release',
    scenario: 'iOS crash-free −0.8 pts, Android −0.45 pts, 2 crash bugs in Jira, Jira release 4.8.1 at 18:30.',
    expected: 'One cross-source investigation (App Store, Google Play, Jira).',
    world: () =>
      buildWorld({
        id: 'e003',
        name: 'EVAL-003',
        seed: 1003,
        effects: { 'app_store.crash_free_sessions': [{ from: '19:00', change: -0.8 }], 'google_play.crash_free_sessions': [{ from: '19:15', change: -0.45 }] },
        releases: [RELEASES_481[0]],
        issues: CRASH_ISSUES,
      }),
    watches: () => [w('app_stability')],
    truth: [{ area: 'stability', attention: 'HIGH' }],
    expectedProviders: ['app_store', 'google_play', 'jira'],
    check: (r) => {
      const invs = byArea(r, 'stability');
      const inv = invs[0];
      return [
        c('Single investigation', invs.length === 1, `${invs.length} investigation(s)`),
        c('Correlates App Store, Google Play and Jira', !!inv && ['app_store', 'google_play', 'jira'].every((p) => inv.correlatedProviders.includes(p as ProviderId)), inv?.correlatedProviders.join(', ') ?? ''),
        // Jira's release date is bookkeeping, not when 4.8.1 reached users: it is evidence, but never a timing association.
        c('Jira release in the evidence, as a planned date', !!inv?.evidence.some((e) => e.provider === 'jira' && e.timing === 'planned'), inv?.evidence.find((e) => e.timing === 'planned')?.statement ?? 'none'),
        c('No timing claimed from a planned date', !!inv && !inv.releaseAssociation && !/minutes? after release/i.test(inv.likelyExplanation + inv.inferred.join(' ')), inv?.releaseAssociation ? `associated with ${inv.releaseAssociation.version}` : 'no association'),
      ];
    },
  },
  {
    id: 'EVAL-004',
    title: 'Reviews spike, analytics stable',
    scenario: '5 negative reviews about checkout in 2 hours. GA4 conversion is normal.',
    expected: 'Investigate the customer signal; brief, not an interruption.',
    world: () => buildWorld({ id: 'e004', name: 'EVAL-004', seed: 1004, reviews: REVIEW_SPIKE }),
    watches: () => [w('checkout_health')],
    truth: [{ area: 'checkout', attention: 'MEDIUM' }],
    check: (r) => {
      const inv = byArea(r, 'checkout')[0];
      return [
        c('Customer signal investigated', !!inv && inv.signals[0].key === 'feedback', inv ? inv.signals[0].label : 'None'),
        c('Analytics checked and stable', !!inv && inv.evidence.some((e) => e.provider === 'ga4' && e.direction === 'stable'), 'GA4 evidence present'),
        c('Morning brief, not an email', alerts(r).length === 0 && inv?.attention === 'MEDIUM', `${inv?.attention ?? '—'} · ${alerts(r).length} email(s)`),
      ];
    },
  },
  {
    id: 'EVAL-005',
    title: 'Analytics anomaly, no supporting source',
    scenario: 'GA4 signup conversion −12% from 22:00. No bugs, reviews or releases.',
    expected: 'Lower confidence; brief only.',
    world: () => buildWorld({ id: 'e005', name: 'EVAL-005', seed: 1005, effects: { 'ga4.signup_conversion': [{ from: '22:00', change: -12 }] } }),
    watches: () => [w('signup_funnel', '1h')],
    truth: [{ area: 'signup', attention: 'MEDIUM' }],
    check: (r) => {
      const inv = byArea(r, 'signup')[0];
      return [
        c('Investigated', !!inv, inv?.title ?? 'None'),
        c('Confidence below 60%', !!inv && inv.confidence < 0.6, inv ? `${Math.round(inv.confidence * 100)}%` : '—'),
        c('Says it is single-source', !!inv && inv.inferred.some((x) => x.includes('Only one source')), inv?.inferred.join(' ') ?? ''),
        c('No email', alerts(r).length === 0, `${alerts(r).length} email(s)`),
      ];
    },
  },
  {
    id: 'EVAL-006',
    title: 'Three sources show the same degradation',
    scenario: 'Conversion −18%, crashes up on iOS and Android, 4 checkout bugs, negative reviews, release 4.8.1.',
    expected: 'Higher confidence than a single-source anomaly.',
    world: () => buildWorld(fullCheckout),
    watches: () => [w('checkout_health')],
    truth: [{ area: 'checkout', attention: 'HIGH' }],
    expectedProviders: ['ga4', 'jira', 'app_store', 'google_play'],
    check: (r) => {
      const inv = byArea(r, 'checkout')[0];
      return [
        c('Three or more sources correlated', !!inv && inv.correlatedProviders.length >= 3, inv?.correlatedProviders.join(', ') ?? ''),
        c('Confidence ≥ 85%', !!inv && inv.confidence >= 0.85, inv ? `${Math.round(inv.confidence * 100)}%` : '—'),
      ];
    },
  },
  {
    id: 'EVAL-007',
    title: 'Same signal appears twice',
    scenario: 'The checkout degradation persists for 12 hours and is seen by two overlapping watches checking every 15 minutes.',
    expected: 'One investigation, one email.',
    world: () => buildWorld(fullCheckout),
    watches: () => [w('checkout_health', '15m', 'w-checkout'), w('customer_issues', '15m', 'w-customer')],
    truth: [{ area: 'checkout', attention: 'HIGH' }],
    check: (r) => {
      const invs = byArea(r, 'checkout');
      const inv = invs[0];
      return [
        c('One investigation', invs.length === 1, `${invs.length} investigation(s)`),
        c('Both watches linked', !!inv && inv.watchIds.length === 2, inv?.watchIds.join(', ') ?? ''),
        c('Seen many times', !!inv && inv.runs.length > 20, `${inv?.runs.length ?? 0} runs merged`),
        c('One email', alerts(r).length === 1, `${alerts(r).length} email(s)`),
      ];
    },
  },
  {
    id: 'EVAL-008',
    title: 'Provider unavailable',
    scenario: 'The EVAL-006 night, but App Store Connect is unavailable and Google Play returns an error.',
    expected: 'Explicit unavailable state; nothing fabricated for those sources.',
    world: () => buildWorld(fullCheckout),
    watches: () => [w('checkout_health')],
    connections: (cs) =>
      cs.map((x) =>
        x.provider === 'app_store' ? { ...x, state: 'unavailable', detail: 'Connection timed out (simulated outage)' } : x.provider === 'google_play' ? { ...x, state: 'error', detail: '401 — service-account token expired (simulated)' } : x,
      ),
    truth: [{ area: 'checkout', attention: 'HIGH' }],
    expectedProviders: ['ga4', 'jira'],
    check: (r) => {
      const inv = byArea(r, 'checkout')[0];
      const fabricated = inv?.evidence.filter((e) => (e.provider === 'app_store' || e.provider === 'google_play') && e.direction !== 'gap') ?? [];
      return [
        c('No evidence from unavailable sources', !!inv && fabricated.length === 0, `${fabricated.length} fabricated item(s)`),
        c('Gaps stated as unknowns', !!inv && inv.unknowns.some((u) => u.includes('App Store Connect is unavailable')) && inv.unknowns.some((u) => u.includes('Google Play Console is returning an error')), 'Both gaps listed'),
        c('Connection states preserved', r.connections.find((x) => x.provider === 'app_store')?.state === 'unavailable' && r.connections.find((x) => x.provider === 'google_play')?.state === 'error', 'unavailable / error'),
        c('Confidence reduced', !!inv && inv.confidence < 0.85, inv ? `${Math.round(inv.confidence * 100)}%` : '—'),
      ];
    },
  },
  {
    id: 'EVAL-009',
    title: 'No meaningful overnight changes',
    scenario: 'Ordinary noise across every source. Background bugs and reviews only.',
    expected: 'No alert; quiet morning brief.',
    world: () => buildWorld({ id: 'e009', name: 'EVAL-009', seed: 1009 }),
    watches: () => [w('checkout_health'), w('signup_funnel', '1h'), w('search_discovery', '4h')],
    truth: [],
    check: (r) => {
      const brief = r.briefs[0];
      return [
        c('No alert', alerts(r).length === 0, `${alerts(r).length} email(s)`),
        c('Quiet brief', brief?.headline === 'Nothing needs your attention.' && brief.quiet.watchCount === 3, brief ? `${brief.headline} ${brief.quiet.note}` : 'No brief'),
      ];
    },
  },
  {
    id: 'EVAL-010',
    title: 'Critical issue',
    scenario: 'At 23:00 checkout conversion falls 60%, iOS crash-free −2.5 pts, 3 highest-priority checkout bugs.',
    expected: 'Immediate notification — without waiting for confirmation.',
    world: () =>
      buildWorld({
        id: 'e010',
        name: 'EVAL-010',
        seed: 1010,
        effects: { 'ga4.checkout_conversion': [{ from: '23:00', change: -60 }], 'app_store.crash_free_sessions': [{ from: '23:00', change: -2.5 }] },
        issues: BLOCKERS,
      }),
    watches: () => [w('checkout_health', '15m')],
    truth: [{ area: 'checkout', attention: 'CRITICAL' }],
    check: (r) => {
      const inv = byArea(r, 'checkout')[0];
      const mail = alerts(r)[0];
      const firstInvestigating = inv?.statusHistory.find((h) => h.state === 'INVESTIGATING')?.at;
      return [
        c('Rated CRITICAL', inv?.attention === 'CRITICAL', inv?.attention ?? '—'),
        c('Immediate email', mail?.trigger === 'immediate', mail ? `${mail.trigger} at ${mail.sentAt.slice(11, 16)}` : 'No email'),
        c('Sent on first detection, before confirmation', !!mail && mail.sentAt === firstInvestigating, `detected ${firstInvestigating?.slice(11, 16)} · emailed ${mail?.sentAt.slice(11, 16)}`),
        c('Exactly one email', alerts(r).length === 1, `${alerts(r).length} email(s)`),
      ];
    },
  },
];

// ─────────────────────────────────────────────────────────────
// Running the suite and computing metrics
// ─────────────────────────────────────────────────────────────

export interface CaseResult {
  id: string;
  title: string;
  passed: boolean;
  checks: Check[];
  result: MonitoringResult;
  world: World;
}

export interface Metric {
  key: string;
  label: string;
  value: number;
  /** true when higher is better. */
  higherIsBetter: boolean;
  target: number;
  detail: string;
}

export interface GoldenReport {
  cases: CaseResult[];
  metrics: Metric[];
  passed: number;
  failed: number;
}

export async function runCase(gc: GoldenCase): Promise<CaseResult> {
  const world = gc.world();
  const connections = gc.connections ? gc.connections(defaultConnections()) : defaultConnections();
  const result = await runMonitoring({ world, watches: gc.watches(), connections, brief: defaultBriefSchedule() });
  const checks = gc.check(result);
  return { id: gc.id, title: gc.title, passed: checks.every((x) => x.passed), checks, result, world };
}

function ratio(num: number, den: number, empty = 1) {
  return den === 0 ? empty : num / den;
}

export function generatedTexts(r: MonitoringResult): string[] {
  const out: string[] = [];
  for (const i of r.investigations) out.push(i.title, i.summary, i.likelyExplanation, i.uncertainty, i.recommendedNextStep, i.attentionReason, i.confidenceReason, ...i.inferred, ...i.unknowns, ...i.hypotheses.map((h) => h.statement));
  for (const e of r.emails) out.push(e.subject, e.sections.whatChanged, e.sections.likelyExplanation, e.sections.uncertainty, e.sections.recommendedNextStep);
  for (const b of r.briefs) out.push(b.headline, b.quiet.note, ...b.items.map((i) => i.summary));
  return out.filter(Boolean);
}

/** Every link Jagr generated must open something real: an investigation, or a source record. */
export function linkValid(href: string, r: MonitoringResult, world: World): boolean {
  if (href.startsWith('/investigations/w/')) return r.investigations.some((i) => i.jagrPath === href);
  const m = href.match(/^\/sources\/([a-z_0-9]+)\/(metric|issue|release|review)\/(.+)$/);
  if (!m) return false;
  return !!resolveRef(world, { provider: m[1] as ProviderId, kind: m[2] as 'metric', id: decodeURIComponent(m[3]) });
}

export function schedulerChecks(): Check[] {
  const start = '2026-09-23T18:00:00.000Z';
  const end = '2026-09-24T08:00:00.000Z';
  const expected: Record<string, number> = { '15m': 57, '30m': 29, '1h': 15, '4h': 4, daily: 1 };
  const checks: Check[] = Object.entries(expected).map(([f, n]) => {
    const got = watchRunTimes(w('checkout_health', f as Watch['schedule']['frequency']), start, end).length;
    return c(`${f} watch runs ${n}× overnight`, got === n, `${got} runs`);
  });
  const jobs = planJobs([w('checkout_health')], { start, end }, defaultBriefSchedule());
  const briefs = jobs.filter((j) => j.type === 'morning_brief');
  checks.push(c('Brief runs once at 08:00, separate from monitoring', briefs.length === 1 && briefs[0].at === end, briefs.map((b) => b.at).join(', ')));
  const ny = dailyOccurrences('08:00', 'America/New_York', '2026-09-24T00:00:00.000Z', '2026-09-24T23:59:00.000Z');
  checks.push(c('Timezone-aware brief (08:00 New York = 12:00 UTC)', ny[0] === '2026-09-24T12:00:00.000Z', ny.join(', ')));
  const paused = { ...w('checkout_health'), status: 'paused' as const };
  checks.push(c('Paused watches are not scheduled', watchRunTimes(paused, start, end).length === 0, 'no runs'));
  return checks;
}

export async function runGoldenSuite(): Promise<GoldenReport> {
  const cases: CaseResult[] = [];
  for (const gc of GOLDEN_CASES) cases.push(await runCase(gc));

  // Detection precision / recall over (case, area) pairs.
  let tp = 0, fp = 0, fn = 0;
  // Interruptions
  let emails = 0, falseInterruptions = 0;
  let corrCases = 0, corrOk = 0;
  let evidenceItems = 0, grounded = 0;
  let texts = 0, overclaims = 0;
  let truths = 0, severityOk = 0, dedupeOk = 0;
  let links = 0, validLinks = 0;
  let actionable = 0;

  for (const gc of GOLDEN_CASES) {
    const cr = cases.find((x) => x.id === gc.id)!;
    const r = cr.result;
    const predicted = open(r);
    for (const p of predicted) (gc.truth.some((t) => t.area === p.area) ? tp++ : fp++);
    for (const tr of gc.truth) {
      truths++;
      const invs = byArea(r, tr.area);
      if (!invs.length) fn++;
      if (invs[0]?.attention === tr.attention) severityOk++;
      const perLevel = new Map<string, number>();
      alerts(r).filter((e) => invs.some((i) => i.id === e.investigationId)).forEach((e) => perLevel.set(e.attention!, (perLevel.get(e.attention!) ?? 0) + 1));
      if (invs.length === 1 && [...perLevel.values()].every((n) => n <= 1)) dedupeOk++;
    }
    for (const e of alerts(r)) {
      emails++;
      const inv = r.investigations.find((i) => i.id === e.investigationId);
      const truth = gc.truth.find((t) => t.area === inv?.area);
      if (!truth || !atLeast(truth.attention, 'HIGH')) falseInterruptions++;
      const s = e.sections;
      if (s.whatChanged && s.whatJagrFound.length && s.likelyExplanation && s.uncertainty && s.recommendedNextStep && e.buttons.some((b) => b.kind === 'jagr') && e.buttons.some((b) => b.kind === 'source')) actionable++;
      for (const b of e.buttons) {
        links++;
        if (linkValid(b.href, r, cr.world)) validLinks++;
      }
    }
    if (gc.expectedProviders) {
      // Correct correlation = no source correlated that isn't really degraded, and enough
      // corroboration (3, or all of them if fewer exist). Since Phase 2 the agent stops once the
      // impact is settled, so it is not required to query every degraded source.
      corrCases++;
      const inv = byArea(r, gc.truth[0].area)[0];
      const got = inv?.correlatedProviders ?? [];
      if (inv && got.every((p) => gc.expectedProviders!.includes(p)) && got.length >= Math.min(3, gc.expectedProviders.length)) corrOk++;
    }
    for (const inv of r.investigations) {
      for (const ev of inv.evidence.filter((e) => e.direction !== 'gap')) {
        evidenceItems++;
        // Grounded = every cited record resolves, or (for a negative finding) the query that
        // returned nothing is in the agent trace.
        const recordsResolve = ev.refs.length > 0 && ev.refs.every((ref) => !!resolveRef(cr.world, ref));
        const queryTraced = ev.refs.length === 0 && !!ev.query && inv.trace.some((t) => t.kind === 'tool_call' && t.tool === ev.query!.tool);
        if (recordsResolve || queryTraced) grounded++;
      }
      for (const l of inv.sourceLinks) {
        links++;
        if (linkValid(l.href, r, cr.world)) validLinks++;
      }
      links++;
      if (linkValid(inv.jagrPath, r, cr.world)) validLinks++;
    }
    for (const text of generatedTexts(r)) {
      texts++;
      if (hasCausalOverclaim(text)) overclaims++;
    }
  }

  const sched = schedulerChecks();
  const metrics: Metric[] = [
    { key: 'false_interruption_rate', label: 'False interruption rate', value: ratio(falseInterruptions, emails, 0), higherIsBetter: false, target: 0, detail: `${falseInterruptions} of ${emails} emails were not warranted` },
    { key: 'precision', label: 'Detection precision', value: ratio(tp, tp + fp), higherIsBetter: true, target: 1, detail: `${tp} correct of ${tp + fp} raised` },
    { key: 'recall', label: 'Detection recall', value: ratio(tp, tp + fn), higherIsBetter: true, target: 1, detail: `${tp} of ${tp + fn} real issues found` },
    { key: 'correlation', label: 'Cross-source correlation accuracy', value: ratio(corrOk, corrCases), higherIsBetter: true, target: 1, detail: `${corrOk} of ${corrCases} cases correlated only truly degraded sources, with enough corroboration` },
    { key: 'grounding', label: 'Evidence grounding', value: ratio(grounded, evidenceItems), higherIsBetter: true, target: 1, detail: `${grounded} of ${evidenceItems} evidence items resolve to a source record or a traced query` },
    { key: 'overclaim', label: 'Causality overclaim rate', value: ratio(overclaims, texts, 0), higherIsBetter: false, target: 0, detail: `${overclaims} of ${texts} generated statements assert causation` },
    { key: 'severity', label: 'Severity accuracy', value: ratio(severityOk, truths), higherIsBetter: true, target: 1, detail: `${severityOk} of ${truths} rated at the expected attention level` },
    { key: 'dedupe', label: 'Deduplication accuracy', value: ratio(dedupeOk, truths), higherIsBetter: true, target: 1, detail: `${dedupeOk} of ${truths} issues produced exactly one investigation and ≤1 email per level` },
    { key: 'deep_links', label: 'Deep-link validity', value: ratio(validLinks, links), higherIsBetter: true, target: 1, detail: `${validLinks} of ${links} links open a real investigation or source record` },
    { key: 'actionability', label: 'Email actionability', value: ratio(actionable, emails), higherIsBetter: true, target: 1, detail: `${actionable} of ${emails} emails have all five sections, a Jagr link and a source link` },
    { key: 'scheduler', label: 'Scheduler correctness', value: ratio(sched.filter((x) => x.passed).length, sched.length), higherIsBetter: true, target: 1, detail: `${sched.filter((x) => x.passed).length} of ${sched.length} schedule checks` },
  ];

  return { cases, metrics, passed: cases.filter((x) => x.passed).length, failed: cases.filter((x) => !x.passed).length };
}

export function metricMeetsTarget(m: Metric) {
  return m.higherIsBetter ? m.value >= m.target : m.value <= m.target;
}
