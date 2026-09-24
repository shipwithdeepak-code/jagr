import type { Area, ProviderId, ToolName, Watch } from '../types';
import { PROVIDERS, type AdapterRegistry } from '../integrations/adapters';
import { ProviderUnavailableError, type IssueRecord, type MetricSeries, type ReleaseRecord, type ReviewRecord } from '../integrations/types';
import { classifyText } from '../catalog';
import { issueArea, isNegative, readMetric, type MetricReading } from '../engine/detect';

/**
 * The agent's tools. Every source access the investigator makes goes through one of these
 * named calls — nothing is hidden in helpers — so each call can be traced, tested and replaced
 * by a real connector behind the same IntegrationAdapter boundary.
 */

export interface TimeRange {
  since: string;
  until: string;
}

export type ToolOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; state: 'unavailable' | 'error' | 'not_in_watch' | 'no_data'; detail: string };

export interface MetricResult {
  series: MetricSeries;
  reading: MetricReading;
}

export interface Toolbox {
  getAnalyticsMetric(i: { metricId: string; until: string }): Promise<ToolOutcome<MetricResult>>;
  getAnalyticsTraffic(i: { until: string }): Promise<ToolOutcome<MetricResult>>;
  getJiraRelease(i: TimeRange): Promise<ToolOutcome<ReleaseRecord[]>>;
  getRecentJiraIssues(i: TimeRange & { area: Area }): Promise<ToolOutcome<IssueRecord[]>>;
  getStoreReleases(i: TimeRange & { store: 'app_store' | 'google_play' }): Promise<ToolOutcome<ReleaseRecord[]>>;
  getStoreCrashRate(i: { store: 'app_store' | 'google_play'; until: string }): Promise<ToolOutcome<MetricResult>>;
  getAppStoreReviews(i: TimeRange & { area: Area }): Promise<ToolOutcome<ReviewRecord[]>>;
  getPlayStoreReviews(i: TimeRange & { area: Area }): Promise<ToolOutcome<ReviewRecord[]>>;
}

export const TOOL_SOURCE: Record<ToolName, ProviderId | 'store'> = {
  getAnalyticsMetric: 'ga4',
  getAnalyticsTraffic: 'ga4',
  getJiraRelease: 'jira',
  getRecentJiraIssues: 'jira',
  getStoreReleases: 'store',
  getStoreCrashRate: 'store',
  getAppStoreReviews: 'app_store',
  getPlayStoreReviews: 'google_play',
};

class NoDataError extends Error {
  constructor(readonly metricId: string) {
    super(`no ${metricId.replace(/^[a-z_]+\./, '').replace(/_/g, ' ')} data`);
  }
}

export function createToolbox(reg: AdapterRegistry, watch: Watch, worldStart: string): Toolbox {
  async function call<T>(provider: Exclude<ProviderId, 'email'>, fn: () => Promise<T>): Promise<ToolOutcome<T>> {
    if (!watch.sources.includes(provider)) return { ok: false, state: 'not_in_watch', detail: `${PROVIDERS[provider].name} is not part of this watch` };
    try {
      return { ok: true, data: await fn() };
    } catch (err) {
      if (err instanceof ProviderUnavailableError) return { ok: false, state: err.state, detail: err.message };
      // The source works; this particular metric simply is not in the data (common with imported data).
      if (err instanceof NoDataError) return { ok: false, state: 'no_data', detail: err.message };
      throw err;
    }
  }

  const metric = (provider: Exclude<ProviderId, 'email'>, id: string, until: string) =>
    call(provider, async () => {
      const [series] = await reg.sources[provider].getMetrics([id], { start: worldStart, end: until });
      if (!series) throw new NoDataError(id);
      return { series, reading: readMetric(series) };
    });

  const reviews = (provider: 'app_store' | 'google_play', i: TimeRange & { area: Area }) =>
    call(provider, async () => (await reg.sources[provider].getReviews({ start: i.since, end: i.until })).filter((r) => isNegative(r) && classifyText(`${r.title} ${r.body}`).includes(i.area)));

  return {
    getAnalyticsMetric: (i) => metric('ga4', i.metricId, i.until),
    getAnalyticsTraffic: (i) => metric('ga4', 'ga4.sessions', i.until),
    getJiraRelease: (i) => call('jira', () => reg.sources.jira.getReleases({ start: i.since, end: i.until })),
    getRecentJiraIssues: (i) => call('jira', async () => (await reg.sources.jira.getIssues({ start: i.since, end: i.until })).filter((x) => x.type !== 'Task' && issueArea(x).includes(i.area))),
    getStoreReleases: (i) => call(i.store, () => reg.sources[i.store].getReleases({ start: i.since, end: i.until })),
    getStoreCrashRate: (i) => metric(i.store, `${i.store}.crash_free_sessions`, i.until),
    getAppStoreReviews: (i) => reviews('app_store', i),
    getPlayStoreReviews: (i) => reviews('google_play', i),
  };
}
