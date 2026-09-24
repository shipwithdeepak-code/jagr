import type { SourceConnection, SourceRef } from '../types';
import type {
  ChangeRecord,
  ChangeSource,
  FeedbackItem,
  FeedbackSource,
  MetricDefinition,
  MetricSeries,
  MetricSource,
  Provenance,
  RegisteredSource,
  SourceId,
  SourceMode,
  TimeWindow,
  WorkItem,
  WorkItemSource,
} from '../roles/types';
import type { IntegrationAdapter, IssueRecord, MetricSeries as NativeSeries, ReleaseRecord, ReviewRecord } from './types';

/**
 * Bridge: a native adapter (records shaped like its own API) → role-based sources.
 *
 * This is where source-specific shapes stop. Simulated fixtures, user imports and the Jira Cloud
 * connector all speak their native format; the engine only ever sees the neutral role records
 * produced here, each with full provenance.
 */

/** Neutral metric key for a native series id: "ga4.checkout_conversion" → "checkout_conversion"; platform variants get a suffix. */
export function metricKeyOf(nativeId: string, provider: string, platform?: string): string {
  const base = nativeId.startsWith(`${provider}.`) ? nativeId.slice(provider.length + 1) : nativeId;
  return platform === 'ios' || platform === 'android' ? `${base}_${platform}` : base;
}

/** The watch signal for a native metric series (e.g. an imported or simulated series). */
export function nativeMetricSignal(m: { id: string; provider: string; platform?: string }): `metric:${string}` {
  return `metric:${metricKeyOf(m.id, m.provider, m.platform)}`;
}

export function modeOf(conn: SourceConnection): SourceMode {
  return conn.state === 'connected' ? 'connected' : conn.state === 'imported' ? 'imported' : 'simulated';
}

const TYPE: Record<IssueRecord['type'], WorkItem['type']> = { Bug: 'bug', Task: 'task', Incident: 'incident' };
const PRIORITY: Record<IssueRecord['priority'], WorkItem['priority']> = { Highest: 'critical', High: 'high', Medium: 'medium', Low: 'low' };

export function roleSourceFromAdapter(adapter: IntegrationAdapter & { provider: SourceId }): RegisteredSource {
  const id = adapter.provider;
  const conn = () => adapter.connection();
  const provenance = (externalId: string, observedAt: string, fetchedAt: string, url?: string): Provenance => {
    const c = conn();
    const mode = modeOf(c);
    return { source: id, provider: mode === 'imported' ? 'import' : mode === 'simulated' ? 'simulated' : adapter.provider, connectionId: id, mode, externalId, url, observedAt, fetchedAt };
  };
  const ref = (kind: SourceRef['kind'], externalId: string): SourceRef => ({ provider: id, kind, id: externalId });

  const toSeries = (m: NativeSeries, window: TimeWindow): MetricSeries => ({
    key: metricKeyOf(m.id, m.provider, m.platform),
    name: m.name,
    unit: m.unit,
    area: m.area,
    badDirection: m.badDirection,
    mode: m.mode,
    threshold: m.threshold,
    platform: m.platform,
    baseline: m.baseline,
    points: m.points,
    source: id,
    ref: ref('metric', m.id),
    provenance: provenance(m.id, m.points.at(-1)?.t ?? window.end, window.end),
  });

  const toChange = (r: ReleaseRecord, window: TimeWindow): ChangeRecord => ({
    id: r.id,
    kind: 'release',
    timing: 'actual',
    title: `Release ${r.version}`,
    at: r.releasedAt,
    version: r.version,
    platform: r.platform,
    rollout: r.rollout,
    notes: r.notes,
    source: id,
    ref: ref('release', r.id),
    provenance: provenance(r.id, r.releasedAt, window.end),
  });

  const toWorkItem = (i: IssueRecord, window: TimeWindow): WorkItem => ({
    id: i.id,
    title: i.title,
    type: TYPE[i.type] ?? 'other',
    priority: PRIORITY[i.priority] ?? 'medium',
    component: i.component,
    area: i.area,
    labels: i.labels,
    versions: i.affectsVersion ? [i.affectsVersion] : [],
    createdAt: i.createdAt,
    source: id,
    ref: ref('issue', i.id),
    provenance: provenance(i.id, i.createdAt, window.end),
  });

  const toFeedback = (r: ReviewRecord, window: TimeWindow): FeedbackItem => ({
    id: r.id,
    channel: 'review',
    rating: r.rating,
    title: r.title,
    text: r.body,
    tags: [],
    version: r.version || undefined,
    createdAt: r.createdAt,
    source: id,
    ref: ref('review', r.id),
    provenance: provenance(r.id, r.createdAt, window.end),
  });

  const caps = adapter.capabilities;
  const nativeMetrics = () => adapter.listMetrics?.() ?? [];

  const metrics: MetricSource | undefined = caps.includes('metrics')
    ? {
        metricDefinitions: (): MetricDefinition[] =>
          nativeMetrics().map((m) => ({ key: metricKeyOf(m.id, m.provider, m.platform), name: m.name, unit: m.unit, area: m.area, badDirection: m.badDirection, mode: m.mode, threshold: m.threshold, platform: m.platform })),
        getSeries: async ({ metric, window }) => {
          const native = nativeMetrics().find((m) => metricKeyOf(m.id, m.provider, m.platform) === metric);
          if (!native) return null;
          const [raw] = await adapter.getMetrics([native.id], window);
          return raw ? toSeries(raw, window) : null;
        },
        listDimensions: () => [],
        getBreakdown: async () => [],
      }
    : undefined;

  const changes: ChangeSource | undefined =
    caps.includes('releases') || caps.includes('changes')
      ? { tracksRollout: caps.includes('rollout'), getChanges: async ({ window }) => (await adapter.getReleases(window)).map((r) => toChange(r, window)) }
      : undefined;

  const work_items: WorkItemSource | undefined = caps.includes('issues') ? { getWorkItems: async ({ window }) => (await adapter.getIssues(window)).map((i) => toWorkItem(i, window)) } : undefined;

  const feedback: FeedbackSource | undefined = caps.includes('reviews') ? { getFeedback: async ({ window }) => (await adapter.getReviews(window)).map((r) => toFeedback(r, window)) } : undefined;

  return {
    id,
    get connection() {
      return conn();
    },
    metrics,
    changes,
    work_items,
    feedback,
  };
}
