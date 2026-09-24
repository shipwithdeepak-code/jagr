import type { PaymentProvider, ProviderStats, PullRequest, SupportTicket } from '@/adapters/types';
import type {
  Evidence,
  EvidenceKind,
  ImpactMetric,
  Investigation,
  MetricDefinition,
  ReleaseRef,
  Signal,
  SourceKind,
  TicketRef,
  TimelineEntry,
} from '@/domain/types';
import { fmtMetric, fmtPct, fmtPts, round } from '@/lib/format';
import { addMinutes, fmtTime, isBefore, minutesBetween } from '@/lib/time';
import { callTool, type RunContext } from './context';
import { badChangePct } from './detection';

/**
 * Evidence gathering. Each step queries one system through its adapter and turns raw observations
 * into typed Evidence. Nothing here knows the "answer" — steps only describe what the data shows.
 */

export interface InvestigationScope {
  investigation: Pick<Investigation, 'id'>;
  primary: Signal;
  members: Signal[];
  defs: MetricDefinition[];
  allSignals: Signal[];
  onsetAt: string;
  asOf: string;
  transient?: boolean;
}

export interface EvidenceBundle {
  evidence: Evidence[];
  entities: Set<string>;
  sourcesQueried: Set<SourceKind>;
  sourcesUnavailable: Set<SourceKind>;
  relatedReleaseIds: string[];
  relatedTicketIds: string[];
  releases: ReleaseRef[];
  tickets: TicketRef[];
  timeline: TimelineEntry[];
  impact: ImpactMetric[];
  playbook: Investigation['playbook'];
}

const SURFACE_KEYWORDS: Record<string, string[]> = {
  checkout: ['checkout', 'payment', 'pay later', 'klarna', 'paypal', 'purchase', 'subscribe', 'apple pay'],
  onboarding: ['onboarding', 'sign up', 'signup', 'getting started', 'tutorial'],
  reports: ['export', 'report', 'csv', 'pdf'],
  platform: ['server error', 'down', 'not load', 'sync', 'crash', 'error 500', 'nothing loads'],
  core: ['not load', 'crash', 'sync'],
  billing: ['invoice', 'charged', 'refund'],
};

const CODE_KEYWORDS: Record<string, string[]> = {
  checkout: ['checkout', 'payment', 'klarna', 'paypal', 'stripe', 'pricing'],
  onboarding: ['onboarding', 'signup'],
  reports: ['export', 'report'],
  platform: ['api', 'gateway', 'database', 'migration', 'pool'],
  core: ['core'],
  billing: ['billing', 'invoice'],
};

const PROVIDER_ALIASES: Record<PaymentProvider, string[]> = {
  klarna: ['klarna', 'pay later'],
  paypal: ['paypal'],
  card: ['credit card', 'debit card'],
  apple_pay: ['apple pay'],
};

/** How an error code should be read — used to separate "our request is broken" from "their service is down". */
export const ERROR_CODE_CLASS: Record<string, { cls: 'client' | 'server' | 'network' | 'customer'; label: string }> = {
  invalid_order_lines: { cls: 'client', label: 'request rejected as invalid (HTTP 400)' },
  upstream_5xx: { cls: 'server', label: 'server errors (HTTP 5xx)' },
  timeout: { cls: 'network', label: 'timeouts' },
  declined: { cls: 'customer', label: 'declines' },
  card_declined: { cls: 'customer', label: 'card declines' },
  insufficient_funds: { cls: 'customer', label: 'insufficient funds' },
  buyer_cancelled: { cls: 'customer', label: 'buyer cancelled' },
  auth_failed: { cls: 'customer', label: 'authentication failed' },
};

const INSTRUMENTATION_KEYWORDS = ['analytics', 'tracking', 'instrumentation', 'telemetry'];

function surfacesOf(scope: InvestigationScope): string[] {
  const s = new Set<string>();
  for (const m of scope.members) {
    const def = scope.defs.find((d) => d.id === m.metricId);
    if (def?.surface) s.add(def.surface);
  }
  return [...s];
}

function defOf(scope: InvestigationScope, metricId: string) {
  return scope.defs.find((d) => d.id === metricId);
}

export function makeEvidence(
  scope: InvestigationScope,
  key: string,
  e: Omit<Evidence, 'id' | 'stance' | 'observedAt'> & { observedAt?: string },
): Evidence {
  return {
    id: `${scope.investigation.id}:${key}`,
    stance: 'context',
    observedAt: e.observedAt ?? scope.asOf,
    ...e,
  };
}

function signalValueLabel(s: Signal): string {
  if (s.unit === 'percent' && Math.abs(s.current - s.baseline.mean) > 5 && s.baseline.mean > 1 && s.category === 'payments') {
    return fmtPts(s.current - s.baseline.mean, 1);
  }
  return fmtPct(s.changePct);
}

// ─────────────────────────────────────────────────────────────
// Step 1 — metric decomposition (analytics)
// ─────────────────────────────────────────────────────────────

async function decompose(ctx: RunContext, scope: InvestigationScope, b: EvidenceBundle) {
  const { primary, members, allSignals } = scope;
  const primaryDef = defOf(scope, primary.metricId);
  b.evidence.push(
    makeEvidence(scope, `anomaly:${primary.metricId}`, {
      kind: 'anomaly',
      source: 'analytics',
      title: `${primary.name} ${primary.changePct < 0 ? 'down' : 'up'} ${fmtPct(Math.abs(primary.changePct)).replace('+', '')}`,
      detail: `${primary.name} is ${fmtMetric(primary.current, primary.unit)} over the last 90 minutes versus a baseline of ${fmtMetric(primary.baseline.mean, primary.unit)} (${primary.baseline.window.toLowerCase()}; z = ${primary.zScore.toFixed(1)}).`,
      value: fmtPct(primary.changePct),
      strength: 1,
      entities: [primary.metricId, ...(primaryDef?.surface ? [primaryDef.surface] : [])],
      observationIds: [],
    }),
  );

  for (const m of members) {
    if (m === primary) continue;
    const isReliability = m.category === 'reliability';
    b.evidence.push(
      makeEvidence(scope, `member:${m.metricId}`, {
        kind: isReliability ? 'reliability_spike' : 'driver_moved',
        source: 'analytics',
        title: `${m.name} ${signalValueLabel(m)}`,
        detail: `${m.name} moved to ${fmtMetric(m.current, m.unit)} from ${fmtMetric(m.baseline.mean, m.unit)} in the same window${m.onsetAt ? `, starting in the ${fmtTime(m.onsetAt)} bucket` : ''}.`,
        value: signalValueLabel(m),
        strength: Math.min(1, Math.abs(m.changePct) / (2 * m.thresholdPct)),
        entities: [m.metricId, ...(defOf(scope, m.metricId)?.surface ? [defOf(scope, m.metricId)!.surface!] : [])],
        observationIds: [],
      }),
    );
  }

  // Drivers not already in the cluster: did they move?
  const memberIds = new Set(members.map((m) => m.metricId));
  const driverIds = new Set<string>();
  for (const m of members) for (const d of defOf(scope, m.metricId)?.drivers ?? []) if (!memberIds.has(d)) driverIds.add(d);

  // Segment siblings: metrics that share a parent with the primary and carry a platform.
  const parent = scope.defs.find((d) => d.drivers?.includes(primary.metricId));
  const siblings = primaryDef?.platform ? (parent?.drivers ?? []).filter((id) => id !== primary.metricId && defOf(scope, id)?.platform) : [];

  const queried = [...driverIds, ...siblings];
  if (queried.length === 0) return;

  const res = await callTool(
    ctx,
    { tool: 'analytics.decompose', source: 'analytics', stage: 'evidence', action: `Decomposed ${primary.name} into drivers`, input: queried.join(', '), investigationId: scope.investigation.id },
    async () => queried.map((id) => allSignals.find((s) => s.metricId === id)).filter((s): s is Signal => !!s),
    (v) => v.map((s) => `${s.name} ${fmtPct(s.changePct)}`).join(' · '),
  );
  if (!res.ok) return;
  b.sourcesQueried.add('analytics');
  const obs = ctx.observe({
    source: 'analytics',
    tool: 'analytics.decompose',
    summary: `Driver metrics for ${primary.name}`,
    data: Object.fromEntries(res.value.map((s) => [s.metricId, round(s.changePct, 2)])),
  });

  for (const s of res.value) {
    const def = defOf(scope, s.metricId);
    const bad = badChangePct(s.current, s.baseline.mean, s.badDirection);
    if (siblings.includes(s.metricId)) continue;
    if (def?.unit === 'count') {
      const drop = bad >= s.thresholdPct;
      b.evidence.push(
        makeEvidence(scope, `traffic:${s.metricId}`, {
          kind: drop ? 'traffic_drop' : 'traffic_stable',
          source: 'analytics',
          title: `${s.name} ${drop ? fmtPct(s.changePct) : 'normal'}`,
          detail: drop
            ? `${s.name} fell ${fmtPct(Math.abs(s.changePct)).replace('+', '')}, so fewer people reached this step.`
            : `${s.name} is ${fmtPct(s.changePct)} versus baseline — the same number of people are arriving, so demand did not change.`,
          value: drop ? fmtPct(s.changePct) : 'Normal',
          strength: drop ? Math.min(1, bad / (2 * s.thresholdPct)) : 1,
          entities: [s.metricId, 'traffic'],
          observationIds: [obs.id],
        }),
      );
    } else if (bad >= s.thresholdPct) {
      b.evidence.push(
        makeEvidence(scope, `driver:${s.metricId}`, {
          kind: s.category === 'reliability' ? 'reliability_spike' : 'driver_moved',
          source: 'analytics',
          title: `${s.name} ${signalValueLabel(s)}`,
          detail: `${s.name} moved to ${fmtMetric(s.current, s.unit)} from ${fmtMetric(s.baseline.mean, s.unit)}.`,
          value: signalValueLabel(s),
          strength: Math.min(1, bad / (2 * s.thresholdPct)),
          entities: [s.metricId],
          observationIds: [obs.id],
        }),
      );
    } else {
      b.evidence.push(
        makeEvidence(scope, `driver:${s.metricId}`, {
          kind: 'driver_stable',
          source: 'analytics',
          title: `${s.name} stable`,
          detail: `${s.name} is ${fmtPct(s.changePct)} versus baseline — not where the drop is.`,
          value: 'Stable',
          strength: 1,
          entities: [s.metricId],
          observationIds: [obs.id],
        }),
      );
    }
  }

  if (siblings.length && primaryDef?.platform) {
    const sib = res.value.filter((s) => siblings.includes(s.metricId));
    const allStable = sib.every((s) => badChangePct(s.current, s.baseline.mean, s.badDirection) < s.thresholdPct / 2);
    const platformName = { ios: 'iOS', android: 'Android', web: 'Web' }[primaryDef.platform];
    b.evidence.push(
      makeEvidence(scope, `segment:${primary.metricId}`, {
        kind: allStable ? 'segment_concentrated' : 'segment_spread',
        source: 'analytics',
        title: allStable ? `Isolated to ${platformName}` : 'Decline spread across platforms',
        detail: allStable
          ? `Only ${platformName} is affected: ${sib.map((s) => `${s.name.split('— ')[1] ?? s.name} ${fmtPct(s.changePct)}`).join(', ')}.`
          : `Other platforms moved too: ${sib.map((s) => `${s.name} ${fmtPct(s.changePct)}`).join(', ')}.`,
        value: allStable ? platformName : 'All platforms',
        strength: 1,
        entities: [primaryDef.platform],
        observationIds: [obs.id],
      }),
    );
    if (allStable) b.entities.add(primaryDef.platform);
  }
}

// ─────────────────────────────────────────────────────────────
// Step 2 — payment providers
// ─────────────────────────────────────────────────────────────

async function compareProviders(ctx: RunContext, scope: InvestigationScope, b: EvidenceBundle) {
  const window = { start: scope.onsetAt, end: scope.asOf };
  const res = await callTool(
    ctx,
    { tool: 'payments.getProviderBreakdown', source: 'payments', stage: 'evidence', action: 'Compared payment providers', input: `${fmtTime(window.start)}–${fmtTime(window.end)}`, investigationId: scope.investigation.id },
    () => ctx.adapters.payments.getProviderBreakdown(window),
    (v) => v.map((p) => `${p.label} ${p.errorRate.toFixed(1)}%`).join(' · '),
  );
  if (!res.ok) {
    if (res.unavailable) gap(scope, b, 'payments', 'Payments data unavailable — provider comparison skipped');
    return;
  }
  b.sourcesQueried.add('payments');
  const stats = res.value;
  const obs = ctx.observe({
    source: 'payments',
    tool: 'payments.getProviderBreakdown',
    summary: 'Error rate by payment provider since onset',
    data: Object.fromEntries(stats.map((p) => [p.provider, `${p.errorRate.toFixed(1)}% (baseline ${p.baselineErrorRate}%) · ${p.failures}/${p.attempts} failed`])),
  });

  const isOutlier = (p: ProviderStats) => {
    const delta = p.errorRate - p.baselineErrorRate;
    return delta >= 5 && delta / p.baselineStdDev >= 4;
  };
  const outliers = stats.filter(isOutlier);
  const normals = stats.filter((p) => !isOutlier(p));

  if (outliers.length >= 3) {
    b.entities.add('all_providers');
    b.evidence.push(
      makeEvidence(scope, 'provider:all', {
        kind: 'provider_outlier',
        source: 'payments',
        title: `${outliers.length} of ${stats.length} payment providers failing`,
        detail: `Error rates rose across ${outliers.map((p) => `${p.label} (${p.errorRate.toFixed(1)}%)`).join(', ')}. A failure this broad points upstream of any single provider.`,
        value: `${outliers.length}/${stats.length}`,
        strength: 1,
        entities: ['all_providers', ...outliers.map((p) => p.provider)],
        observationIds: [obs.id],
      }),
    );
    signature(scope, b, outliers[0], obs.id, true);
    return;
  }

  for (const p of outliers) {
    const delta = p.errorRate - p.baselineErrorRate;
    b.entities.add(p.provider);
    b.evidence.push(
      makeEvidence(scope, `provider:${p.provider}`, {
        kind: 'provider_outlier',
        source: 'payments',
        title: `${p.label} errors ${fmtPts(delta)}`,
        detail: `${p.label} error rate is ${p.errorRate.toFixed(1)}% since ${fmtTime(scope.onsetAt)} versus a ${p.baselineErrorRate}% baseline (${p.failures} of ${p.attempts} attempts failed).`,
        value: fmtPts(delta),
        strength: Math.min(1, delta / 20),
        entities: [p.provider, 'payments'],
        observationIds: [obs.id],
      }),
    );
    signature(scope, b, p, obs.id, false);
  }

  for (const p of normals) {
    b.evidence.push(
      makeEvidence(scope, `provider:${p.provider}`, {
        kind: 'provider_normal',
        source: 'payments',
        title: `${p.label} normal`,
        detail: `${p.label} error rate is ${p.errorRate.toFixed(1)}% versus a ${p.baselineErrorRate}% baseline — within normal range.`,
        value: 'Normal',
        strength: 1,
        entities: [p.provider, 'payments'],
        observationIds: [obs.id],
      }),
    );
  }

  for (const p of outliers.slice(0, 2)) {
    const st = await callTool(
      ctx,
      { tool: 'payments.getProviderStatus', source: 'payments', stage: 'evidence', action: `Checked ${p.label} status page`, input: p.provider, investigationId: scope.investigation.id },
      () => ctx.adapters.payments.getProviderStatus(p.provider, scope.asOf),
      (v) => `${v.status}: ${v.message}`,
    );
    if (!st.ok) continue;
    const o = ctx.observe({ source: 'payments', tool: 'payments.getProviderStatus', summary: `${p.label} status`, data: { status: st.value.status, message: st.value.message } });
    b.evidence.push(
      makeEvidence(scope, `status:${p.provider}`, {
        kind: 'provider_status',
        source: 'payments',
        title: `${p.label} status: ${st.value.status}`,
        detail:
          st.value.status === 'operational'
            ? `${p.label} reports all systems operational — no incident on their side.`
            : `${p.label} reports "${st.value.message}".`,
        value: st.value.status === 'operational' ? 'Operational' : 'Degraded',
        strength: 1,
        entities: [p.provider, st.value.status],
        observationIds: [o.id],
      }),
    );
  }
}

function signature(scope: InvestigationScope, b: EvidenceBundle, p: ProviderStats, obsId: string, aggregate: boolean) {
  let top: { code: string; increase: number; share: number } | undefined;
  for (const [code, share] of Object.entries(p.errorCodes)) {
    const increase = share - (p.baselineErrorCodes[code] ?? 0);
    if (!top || increase > top.increase) top = { code, increase, share };
  }
  if (!top || top.increase < 30) return;
  const cls = ERROR_CODE_CLASS[top.code] ?? { cls: 'server' as const, label: top.code };
  const reading =
    cls.cls === 'client'
      ? 'This is a request-validation error: the provider is up but rejecting what we send, which points at our integration.'
      : cls.cls === 'server'
        ? 'These are server-side failures rather than customer declines.'
        : 'These are network timeouts.';
  b.evidence.push(
    makeEvidence(scope, `signature:${aggregate ? 'all' : p.provider}`, {
      kind: 'provider_error_signature',
      source: 'payments',
      title: `${top.share}% of ${aggregate ? 'failures' : `${p.label} failures`}: ${top.code}`,
      detail: `${top.share}% of ${aggregate ? 'failed payments' : `${p.label} failures`} are ${top.code} — ${cls.label} (was ${p.baselineErrorCodes[top.code] ?? 0}% of failures before). ${reading}`,
      value: top.code,
      strength: Math.min(1, top.increase / 60),
      entities: [aggregate ? 'all_providers' : p.provider, `${cls.cls}_error`],
      observationIds: [obsId],
    }),
  );
}

// ─────────────────────────────────────────────────────────────
// Step 3 — releases & pull requests (GitHub)
// ─────────────────────────────────────────────────────────────

async function reviewReleases(ctx: RunContext, scope: InvestigationScope, b: EvidenceBundle) {
  const primaryDef = defOf(scope, scope.primary.metricId);
  const window = { start: addMinutes(scope.onsetAt, -180), end: addMinutes(scope.onsetAt, 30) };
  const res = await callTool(
    ctx,
    { tool: 'github.listDeployments', source: 'github', stage: 'evidence', action: 'Queried recent releases', input: `${fmtTime(window.start)}–${fmtTime(window.end)}`, investigationId: scope.investigation.id },
    () => ctx.adapters.github.listDeployments(window),
    (v) => (v.length ? v.map((d) => `${d.version} at ${fmtTime(d.deployedAt)}`).join(', ') : 'No deployments in window'),
  );
  if (!res.ok) {
    if (res.unavailable) gap(scope, b, 'github', 'GitHub unavailable — release correlation skipped');
    return;
  }
  b.sourcesQueried.add('github');
  const relevant = res.value.filter(
    (d) => !primaryDef?.platform || d.platform === primaryDef.platform || d.platform === 'backend',
  );

  if (relevant.length === 0) {
    const o = ctx.observe({ source: 'github', tool: 'github.listDeployments', summary: 'No relevant deployments', data: { window: `${fmtTime(window.start)}–${fmtTime(window.end)}`, deployments: res.value.map((d) => d.version) } });
    const platformName = primaryDef?.platform ? { ios: 'iOS', android: 'Android', web: 'web' }[primaryDef.platform] + ' ' : '';
    b.evidence.push(
      makeEvidence(scope, 'release:none', {
        kind: 'no_recent_deployment',
        source: 'github',
        title: `No ${platformName}release before onset`,
        detail: `No ${platformName}production deployment between ${fmtTime(window.start)} and ${fmtTime(window.end)}${res.value.length ? ` (${res.value.map((d) => d.version).join(', ')} shipped but does not touch this platform)` : ''}.`,
        value: 'None',
        strength: 1,
        entities: ['no_release'],
        observationIds: [o.id],
      }),
    );
    return;
  }

  const keywords = new Set<string>([...b.entities, ...surfacesOf(scope).flatMap((s) => CODE_KEYWORDS[s] ?? [])]);
  const providerEntities = [...b.entities].filter((e) => e in PROVIDER_ALIASES);

  for (const d of relevant) {
    const prs = await callTool(
      ctx,
      { tool: 'github.getPullRequests', source: 'github', stage: 'evidence', action: `Reviewed pull requests in ${d.version}`, input: d.pullRequests.map((n) => `#${n}`).join(', '), investigationId: scope.investigation.id },
      () => ctx.adapters.github.getPullRequests(d.pullRequests),
      (v) => v.map((p) => `#${p.number} ${p.title}`).join(' · '),
    );
    const pulls: PullRequest[] = prs.ok ? prs.value : [];
    const minutesBeforeBucketEnd = minutesBetween(d.deployedAt, addMinutes(scope.onsetAt, 30));
    const inOnsetBucket = !isBefore(d.deployedAt, scope.onsetAt);
    const proximity = inOnsetBucket ? 1 : Math.max(0.2, 1 - (minutesBeforeBucketEnd - 30) / 180);
    const o = ctx.observe({
      source: 'github',
      tool: 'github.listDeployments',
      summary: `${d.version} deployment`,
      data: { version: d.version, deployedAt: d.deployedAt, services: d.services, pullRequests: d.pullRequests.map((n) => `#${n}`) },
    });
    const matched: { pr: PullRequest; hits: string[]; provider: boolean; instrumentation: boolean }[] = [];
    for (const pr of pulls) {
      const text = `${pr.title} ${pr.files.join(' ')} ${pr.labels.join(' ')}`.toLowerCase();
      const hits = [...keywords].filter((k) => text.includes(k.replace('_', ' ')) || text.includes(k));
      const provider = providerEntities.some((p) => text.includes(p));
      const instrumentation = INSTRUMENTATION_KEYWORDS.some((k) => text.includes(k));
      if (hits.length || instrumentation) matched.push({ pr, hits, provider, instrumentation });
    }
    const linkedProviders = providerEntities.filter((p) => matched.some((m) => m.provider && `${m.pr.title} ${m.pr.files.join(' ')}`.toLowerCase().includes(p)));

    b.relatedReleaseIds.push(d.version);
    b.releases.push({
      version: d.version,
      deployedAt: d.deployedAt,
      services: d.services,
      pullRequests: pulls.map((p) => ({ number: p.number, title: p.title, author: p.author, mergedAt: p.mergedAt, files: p.files, relevant: matched.some((m) => m.pr.number === p.number && m.hits.length > 0) })),
    });
    b.timeline.push({ at: d.deployedAt, label: `Release ${d.version} deployed (${d.services.join(', ')})`, kind: 'release', source: 'github' });
    b.evidence.push(
      makeEvidence(scope, `release:${d.version}`, {
        kind: 'deployment',
        source: 'github',
        title: `Release ${d.version} at ${fmtTime(d.deployedAt)}`,
        detail: `${d.version} (${d.services.join(', ')}) was deployed at ${fmtTime(d.deployedAt)}, ${inOnsetBucket ? `inside the first degraded bucket (${fmtTime(scope.onsetAt)}–${fmtTime(addMinutes(scope.onsetAt, 30))})` : `${Math.round(minutesBetween(d.deployedAt, scope.onsetAt))} min before the degradation began`}. It contains ${d.pullRequests.length} pull requests${matched.length ? `, ${matched.filter((m) => m.hits.length).length} touching this area` : ''}.`,
        value: d.version,
        strength: proximity,
        entities: [d.version, ...d.services, d.platform, ...linkedProviders, ...(d.platform === 'backend' ? ['platform'] : [])],
        observationIds: [o.id],
        observedAt: d.deployedAt,
      }),
    );

    for (const m of matched) {
      const po = ctx.observe({ source: 'github', tool: 'github.getPullRequests', summary: `PR #${m.pr.number}`, data: { title: m.pr.title, mergedAt: m.pr.mergedAt, author: m.pr.author, files: m.pr.files, labels: m.pr.labels } });
      b.timeline.push({ at: m.pr.mergedAt, label: `PR #${m.pr.number} merged: ${m.pr.title}`, kind: 'pr', source: 'github' });
      const entities = [
        d.version,
        `pr#${m.pr.number}`,
        ...m.hits,
        ...(m.instrumentation ? ['instrumentation'] : []),
        ...providerEntities.filter((p) => `${m.pr.title} ${m.pr.files.join(' ')}`.toLowerCase().includes(p)),
      ];
      b.evidence.push(
        makeEvidence(scope, `pr:${m.pr.number}`, {
          kind: 'merged_pr',
          source: 'github',
          title: `PR #${m.pr.number}: ${m.pr.title}`,
          detail: `Merged at ${fmtTime(m.pr.mergedAt)} and shipped in ${d.version}. Changed ${m.pr.files.length} files (${m.pr.files.slice(0, 2).join(', ')}${m.pr.files.length > 2 ? ', …' : ''}).${m.instrumentation && !m.hits.length ? ' Touches analytics instrumentation — could change how the metric is measured.' : ''}`,
          value: `#${m.pr.number}`,
          strength: m.provider ? 1 : m.hits.length ? 0.6 : 0.5,
          entities: [...new Set(entities)],
          observationIds: [po.id],
          observedAt: m.pr.mergedAt,
        }),
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Step 4 — support tickets
// ─────────────────────────────────────────────────────────────

async function reviewSupport(ctx: RunContext, scope: InvestigationScope, b: EvidenceBundle, hasReliability: boolean) {
  const window = { start: scope.onsetAt, end: scope.asOf };
  const res = await callTool(
    ctx,
    { tool: 'support.searchTickets', source: 'support', stage: 'evidence', action: 'Queried support tickets', input: `${fmtTime(window.start)}–${fmtTime(window.end)}`, investigationId: scope.investigation.id },
    () => ctx.adapters.support.searchTickets(window),
    (v) => `${v.length} tickets in window`,
  );
  if (!res.ok) {
    if (res.unavailable) gap(scope, b, 'support', 'Support unavailable — customer impact not verified');
    return;
  }
  b.sourcesQueried.add('support');
  const surfaces = surfacesOf(scope);
  const keywords = [...new Set([...surfaces.flatMap((s) => SURFACE_KEYWORDS[s] ?? []), ...(hasReliability ? SURFACE_KEYWORDS.platform : [])])];
  const matches: SupportTicket[] = res.value.filter((t) => {
    const text = `${t.subject} ${t.body}`.toLowerCase();
    return keywords.some((k) => text.includes(k));
  });
  const mentions: Partial<Record<PaymentProvider, number>> = {};
  for (const t of matches) {
    const text = `${t.subject} ${t.body}`.toLowerCase();
    for (const [p, aliases] of Object.entries(PROVIDER_ALIASES) as [PaymentProvider, string[]][]) {
      if (aliases.some((a) => text.includes(a))) mentions[p] = (mentions[p] ?? 0) + 1;
    }
  }
  const o = ctx.observe({
    source: 'support',
    tool: 'support.searchTickets',
    summary: `${matches.length} related tickets`,
    data: { searched: res.value.length, matched: matches.length, ticketIds: matches.map((t) => t.id), keywords: keywords.slice(0, 8) },
  });
  const surfaceLabel = surfaces.includes('checkout') ? 'checkout' : surfaces[0] ?? 'this area';

  if (matches.length >= 2) {
    const mentioned = (Object.entries(mentions) as [PaymentProvider, number][]).filter(([, n]) => n >= 2);
    for (const [p] of mentioned) b.entities.add(p);
    b.relatedTicketIds = matches.map((t) => t.id);
    b.tickets = matches.map((t) => {
      const text = `${t.subject} ${t.body}`.toLowerCase();
      return {
        id: t.id,
        createdAt: t.createdAt,
        subject: t.subject,
        channel: t.channel,
        plan: t.plan,
        mentions: (Object.entries(PROVIDER_ALIASES) as [PaymentProvider, string[]][]).filter(([, a]) => a.some((x) => text.includes(x))).map(([p]) => p),
      };
    });
    b.timeline.push({ at: matches[0].createdAt, label: `First related support ticket (${matches[0].id})`, kind: 'support', source: 'support' });
    const labels: Record<PaymentProvider, string> = { klarna: 'Klarna', paypal: 'PayPal', card: 'cards', apple_pay: 'Apple Pay' };
    b.evidence.push(
      makeEvidence(scope, 'support:cluster', {
        kind: 'support_cluster',
        source: 'support',
        title: `${matches.length} ${surfaceLabel} complaints`,
        detail: `${matches.length} support tickets about ${surfaceLabel} since ${fmtTime(scope.onsetAt)}${mentioned.length ? `; ${mentioned.map(([p, n]) => `${n} mention ${labels[p]}`).join(', ')}` : ''}. Real customers are affected, so this is not a tracking artefact.`,
        value: String(matches.length),
        strength: Math.min(1, matches.length / 6),
        entities: [surfaceLabel, 'customers', ...mentioned.map(([p]) => p)],
        observationIds: [o.id],
        observedAt: matches[0].createdAt,
      }),
    );
  } else {
    b.evidence.push(
      makeEvidence(scope, 'support:none', {
        kind: 'no_support_signal',
        source: 'support',
        title: 'No related complaints',
        detail: `${res.value.length} tickets opened since ${fmtTime(scope.onsetAt)}; ${matches.length ? 'only one' : 'none'} relate to ${surfaceLabel}.`,
        value: String(matches.length),
        strength: 1,
        entities: ['no_tickets'],
        observationIds: [o.id],
      }),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Step 5 — experiments
// ─────────────────────────────────────────────────────────────

async function reviewExperiments(ctx: RunContext, scope: InvestigationScope, b: EvidenceBundle) {
  const res = await callTool(
    ctx,
    { tool: 'experiments.listActiveExperiments', source: 'experiments', stage: 'evidence', action: 'Checked active experiments', input: `as of ${fmtTime(scope.asOf)}`, investigationId: scope.investigation.id },
    () => ctx.adapters.experiments.listActiveExperiments(scope.asOf),
    (v) => `${v.length} running: ${v.map((e) => e.name).join(', ')}`,
  );
  if (!res.ok) {
    if (res.unavailable) gap(scope, b, 'experiments', 'Experiments unavailable — experiment impact not checked');
    return;
  }
  b.sourcesQueried.add('experiments');
  const surfaces = surfacesOf(scope);
  const primaryDef = defOf(scope, scope.primary.metricId);
  const relevant = res.value.filter(
    (e) => e.surface && surfaces.includes(e.surface) && (!e.platform || !primaryDef?.platform || e.platform === primaryDef.platform),
  );
  const windowStart = addMinutes(scope.onsetAt, -180);
  const windowEnd = addMinutes(scope.onsetAt, 30);
  const memberIds = scope.members.map((m) => m.metricId);

  for (const exp of relevant) {
    const o = ctx.observe({
      source: 'experiments',
      tool: 'experiments.listActiveExperiments',
      summary: exp.name,
      data: {
        started: exp.startedAt,
        changes: exp.changes.map((c) => `${fmtTime(c.at)} ${c.description}`),
        results: exp.results.map((r) => `${r.variant}: ${r.value} (${r.users} users)`),
      },
    });
    const change = exp.changes.find((c) => !isBefore(c.at, windowStart) && isBefore(c.at, windowEnd));
    if (change) {
      b.entities.add(exp.name);
      b.timeline.push({ at: change.at, label: `${exp.name}: ${change.description}`, kind: 'experiment', source: 'experiments' });
      b.evidence.push(
        makeEvidence(scope, `experiment:${exp.id}:change`, {
          kind: 'experiment_change',
          source: 'experiments',
          title: `${exp.name} ramped to ${change.allocation}%`,
          detail: `${exp.name} changed at ${fmtTime(change.at)}: ${change.description.toLowerCase()}. The metric started moving in the ${fmtTime(scope.onsetAt)} bucket.`,
          value: `${change.allocation}%`,
          strength: 1,
          entities: [exp.name, ...(exp.platform ? [exp.platform] : [])],
          observationIds: [o.id],
          observedAt: change.at,
        }),
      );
    }
    const control = exp.results.find((r) => r.variant === 'control' && memberIds.includes(r.metricId));
    const variant = exp.results.find((r) => r.variant !== 'control' && r.metricId === control?.metricId);
    if (control && variant) {
      const diff = ((variant.value - control.value) / control.value) * 100;
      const threshold = scope.members.find((m) => m.metricId === control.metricId)?.thresholdPct ?? 5;
      if (Math.abs(diff) >= threshold) {
        const z = twoProportionZ(control.value / 100, control.users, variant.value / 100, variant.users);
        b.evidence.push(
          makeEvidence(scope, `experiment:${exp.id}:result`, {
            kind: 'experiment_result',
            source: 'experiments',
            title: `${variant.variant} ${fmtPct(diff)} vs control`,
            detail: `In ${exp.name}, ${variant.variant} converts at ${variant.value}% versus ${control.value}% for control (${variant.users.toLocaleString('en-US')} vs ${control.users.toLocaleString('en-US')} users, z = ${z.toFixed(1)}). A randomised comparison, so the gap is caused by the variant, not by the night.`,
            value: fmtPct(diff),
            strength: Math.min(1, Math.abs(diff) / 10),
            entities: [exp.name],
            observationIds: [o.id],
          }),
        );
        continue;
      }
    }
    if (!change) {
      const days = Math.round(minutesBetween(exp.startedAt, scope.asOf) / 1440);
      b.evidence.push(
        makeEvidence(scope, `experiment:${exp.id}:stable`, {
          kind: 'experiment_stable',
          source: 'experiments',
          title: `${exp.name} unchanged`,
          detail: `${exp.name} has run for ${days} days with no allocation change tonight${control && variant ? `, and both arms are level (${control.value}% vs ${variant.value}%)` : ''}. It cannot explain a change that started tonight.`,
          value: 'No change',
          strength: 1,
          entities: [exp.name],
          observationIds: [o.id],
        }),
      );
    }
  }
}

function twoProportionZ(p1: number, n1: number, p2: number, n2: number): number {
  const p = (p1 * n1 + p2 * n2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se === 0 ? 0 : (p2 - p1) / se;
}

// ─────────────────────────────────────────────────────────────
// Step 6 — platform health (from the current sweep)
// ─────────────────────────────────────────────────────────────

function reviewPlatformHealth(scope: InvestigationScope, b: EvidenceBundle) {
  const memberIds = new Set(scope.members.map((m) => m.metricId));
  const spikes = scope.allSignals.filter((s) => s.category === 'reliability' && s.status === 'anomalous' && !memberIds.has(s.metricId));
  for (const s of spikes) {
    b.entities.add('platform');
    b.evidence.push(
      makeEvidence(scope, `reliability:${s.metricId}`, {
        kind: 'reliability_spike',
        source: 'analytics',
        title: `${s.name} ${fmtPct(s.changePct)}`,
        detail: `${s.name} is ${fmtMetric(s.current, s.unit)} versus ${fmtMetric(s.baseline.mean, s.unit)} — the platform itself is unhealthy.`,
        value: fmtPct(s.changePct),
        strength: 1,
        entities: [s.metricId, 'platform'],
        observationIds: [],
      }),
    );
  }
}

function gap(scope: InvestigationScope, b: EvidenceBundle, source: SourceKind, title: string) {
  b.sourcesUnavailable.add(source);
  b.evidence.push(
    makeEvidence(scope, `gap:${source}`, {
      kind: 'source_unavailable',
      source,
      title,
      detail: `${title}. JAGR will not guess what this source would have shown; confidence is reduced accordingly.`,
      value: 'Unavailable',
      strength: 0,
      entities: [source],
      observationIds: [],
    }),
  );
}

// ─────────────────────────────────────────────────────────────
// Impact
// ─────────────────────────────────────────────────────────────

function estimateImpact(scope: InvestigationScope): ImpactMetric[] {
  const impact: ImpactMetric[] = [
    {
      label: scope.primary.name,
      value: fmtPct(scope.primary.changePct),
      detail: `${fmtMetric(scope.primary.current, scope.primary.unit)} vs ${fmtMetric(scope.primary.baseline.mean, scope.primary.unit)} baseline`,
    },
  ];
  for (const m of scope.members) {
    if (m === scope.primary) continue;
    impact.push({ label: m.name, value: signalValueLabel(m), detail: `${fmtMetric(m.current, m.unit)} vs ${fmtMetric(m.baseline.mean, m.unit)}` });
  }
  const checkout = scope.allSignals.find((s) => s.metricId === 'checkout_conversion');
  const sessions = scope.allSignals.find((s) => s.metricId === 'checkout_sessions');
  const arpu = scope.allSignals.find((s) => s.metricId === 'arpu_new');
  if (checkout && sessions && scope.members.some((m) => m.metricId === 'checkout_conversion')) {
    let lost = 0;
    for (const p of checkout.series) {
      if (isBefore(p.t, scope.onsetAt)) continue;
      const s = sessions.series.find((x) => x.t === p.t);
      if (s) lost += (s.value * (checkout.baseline.mean - p.value)) / 100;
    }
    if (lost > 0) {
      impact.push({
        label: 'Checkouts not completed',
        value: `≈ ${Math.round(lost).toLocaleString('en-US')}`,
        detail: `since ${fmtTime(scope.onsetAt)}, versus the baseline completion rate`,
      });
      if (arpu) {
        impact.push({
          label: 'First-month bookings at risk',
          value: `≈ $${(Math.round((lost * arpu.current) / 100) * 100).toLocaleString('en-US')}`,
          detail: `${Math.round(lost)} × ${fmtMetric(arpu.current, 'currency')} new-subscriber ARPU`,
        });
      }
    }
  }
  return impact;
}

// ─────────────────────────────────────────────────────────────
// Playbook runner
// ─────────────────────────────────────────────────────────────

export function choosePlaybook(scope: InvestigationScope): Investigation['playbook'] {
  if (scope.transient) return 'transient_check';
  const surfaces = surfacesOf(scope);
  if (surfaces.includes('checkout')) return 'purchase_funnel';
  if (surfaces.includes('onboarding')) return 'activation';
  return 'generic';
}

export async function gatherEvidence(ctx: RunContext, scope: InvestigationScope): Promise<EvidenceBundle> {
  const playbook = choosePlaybook(scope);
  const b: EvidenceBundle = {
    evidence: [],
    entities: new Set(surfacesOf(scope)),
    sourcesQueried: new Set(['analytics']),
    sourcesUnavailable: new Set(),
    relatedReleaseIds: [],
    relatedTicketIds: [],
    releases: [],
    tickets: [],
    timeline: [],
    impact: [],
    playbook,
  };
  for (const m of scope.members) if (m.area === 'payments') b.entities.add('payments');
  const hasReliability = scope.members.some((m) => m.category === 'reliability') || scope.allSignals.some((s) => s.category === 'reliability' && s.status === 'anomalous');

  await decompose(ctx, scope, b);
  if (playbook === 'purchase_funnel') await compareProviders(ctx, scope, b);
  if (ctx.settings.watch.releases) await reviewReleases(ctx, scope, b);
  await reviewSupport(ctx, scope, b, hasReliability);
  if (ctx.settings.watch.experiments && playbook !== 'transient_check') await reviewExperiments(ctx, scope, b);
  if (playbook !== 'transient_check') reviewPlatformHealth(scope, b);

  b.impact = estimateImpact(scope);
  b.timeline.push({ at: scope.onsetAt, label: `${scope.primary.name} begins to degrade`, kind: 'metric', source: 'analytics' });
  b.timeline.sort((a, c) => Date.parse(a.at) - Date.parse(c.at));
  return b;
}

export function countBySource(evidence: Evidence[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of evidence) out[e.source] = (out[e.source] ?? 0) + 1;
  return out;
}

export function evidenceOfKind(evidence: Evidence[], kind: EvidenceKind) {
  return evidence.filter((e) => e.kind === kind);
}

