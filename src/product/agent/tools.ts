import type { Area, ToolName, Watch } from '../types.js';
import type { SourceRegistry } from '../roles/registry.js';
import type { ChangeRecord, FeedbackItem, MetricSeries, Role, SegmentSeries, SourceHealth, SourceId, WorkItem } from '../roles/types.js';
import { healthOf } from '../roles/types.js';
import { ProviderUnavailableError } from '../integrations/types.js';
import { labelOf, type ProviderLabels } from '../integrations/adapters.js';
import { negativeFeedback, problemItems, readMetric, withWatchThreshold, type MetricReading } from '../engine/detect.js';

/**
 * The agent's tools — one per evidence ROLE. Every source access the investigator makes goes
 * through one of these named calls, so each can be traced, tested and validated. A call names a
 * source id (opaque to the engine) and a role; the registry resolves which implementation answers.
 * Nothing here knows or asks which vendor is behind a source.
 */

export const TOOL_NAMES: ToolName[] = ['getMetric', 'getMetricBreakdown', 'getChanges', 'getWorkItems', 'getFeedback', 'getFeedbackVolume'];

/** The role each tool reads. */
export const TOOL_ROLE: Record<ToolName, Role> = {
  getMetric: 'metrics',
  getMetricBreakdown: 'metrics',
  getChanges: 'changes',
  getWorkItems: 'work_items',
  getFeedback: 'feedback',
  getFeedbackVolume: 'feedback',
};

export interface TimeRange {
  since: string;
  until: string;
}

export type ToolOutcome<T> =
  /** `stale`: the source answered, but its data is only complete up to `freshAsOf` — silence after it proves nothing. */
  | { ok: true; data: T; stale?: { freshAsOf: string } }
  | { ok: false; state: 'unavailable' | 'error' | 'not_in_watch' | 'no_data'; detail: string };

export interface MetricResult {
  series: MetricSeries;
  reading: MetricReading;
}

export interface SegmentResult {
  segment: string;
  series: MetricSeries;
  reading: MetricReading;
}

/**
 * A change scan: every change source asked in one role query, with what each could answer.
 * "No change" is only true for sources whose coverage is `ok`.
 */
export interface ChangeScan {
  records: ChangeRecord[];
  coverage: SourceHealth[];
}

export interface VolumeResult {
  count: number;
  /** Negative items per hour, oldest first. */
  perHour: { t: string; value: number }[];
}

export interface Toolbox {
  getMetric(i: { source: SourceId; metric: string; until: string }): Promise<ToolOutcome<MetricResult>>;
  getMetricBreakdown(i: { source: SourceId; metric: string; dimension: string; until: string }): Promise<ToolOutcome<SegmentResult[]>>;
  /** Reads every change source in the watch (or just `sources`) — one role query, per-source coverage. */
  getChanges(i: TimeRange & { sources?: SourceId[] }): Promise<ToolOutcome<ChangeScan>>;
  getWorkItems(i: TimeRange & { source: SourceId; area: Area }): Promise<ToolOutcome<WorkItem[]>>;
  getFeedback(i: TimeRange & { source: SourceId; area: Area }): Promise<ToolOutcome<FeedbackItem[]>>;
  getFeedbackVolume(i: TimeRange & { source: SourceId; area: Area }): Promise<ToolOutcome<VolumeResult>>;
}

class NoDataError extends Error {
  constructor(readonly metric: string) {
    super(`no ${metric.replace(/_/g, ' ')} data`);
  }
}

export function createToolbox(reg: SourceRegistry, watch: Watch, worldStart: string, labels?: ProviderLabels): Toolbox {
  const P = labelOf(labels);
  async function call<T>(source: SourceId, role: Role, until: string, fn: (s: NonNullable<ReturnType<SourceRegistry['get']>>) => Promise<T>): Promise<ToolOutcome<T>> {
    const s = reg.get(source);
    if (!watch.sources.includes(source) || !s) return { ok: false, state: 'not_in_watch', detail: `${P(source).name} is not part of this watch` };
    if (!s[role]) return { ok: false, state: 'not_in_watch', detail: `${P(source).name} does not provide ${role.replace('_', ' ')}` };
    try {
      const data = await fn(s);
      const health = healthOf(source, s.connection, until);
      return health.state === 'stale' ? { ok: true, data, stale: { freshAsOf: health.freshAsOf! } } : { ok: true, data };
    } catch (err) {
      if (err instanceof ProviderUnavailableError) return { ok: false, state: err.state, detail: err.message };
      // The source works; this particular metric simply is not in the data (common with imported data).
      if (err instanceof NoDataError) return { ok: false, state: 'no_data', detail: err.message };
      throw err;
    }
  }

  const window = (i: TimeRange) => ({ start: i.since, end: i.until });

  return {
    getMetric: (i) =>
      call(i.source, 'metrics', i.until, async (s) => {
        const raw = await s.metrics!.getSeries({ metric: i.metric, window: { start: worldStart, end: i.until } });
        if (!raw) throw new NoDataError(i.metric);
        const series = withWatchThreshold(raw, watch.thresholds);
        return { series, reading: readMetric(series) };
      }),
    getMetricBreakdown: (i) =>
      call(i.source, 'metrics', i.until, async (s) => {
        if (!s.metrics!.listDimensions(i.metric).includes(i.dimension)) throw new NoDataError(`${i.metric} by ${i.dimension}`);
        const segments: SegmentSeries[] = await s.metrics!.getBreakdown({ metric: i.metric, dimension: i.dimension, window: { start: worldStart, end: i.until } });
        return segments.map((x) => {
          const series = withWatchThreshold(x.series, watch.thresholds);
          return { segment: x.segment, series, reading: readMetric(series) };
        });
      }),
    getChanges: async (i) => {
      const inWatch = reg.withRole('changes', watch.sources.filter((p): p is SourceId => p !== 'email')).map((s) => s.id);
      const targets = i.sources ? inWatch.filter((id) => i.sources!.includes(id)) : inWatch;
      if (!targets.length) return { ok: false, state: 'not_in_watch', detail: 'No change source is part of this watch' };
      const records: ChangeRecord[] = [];
      const coverage: SourceHealth[] = [];
      for (const id of targets) {
        const s = reg.get(id)!;
        const health = healthOf(id, s.connection, i.until);
        // A source known to be down or unconfigured is recorded, never called.
        if (health.state === 'unavailable' || health.state === 'error' || health.state === 'not_configured') {
          coverage.push(health);
          continue;
        }
        try {
          records.push(...(await s.changes!.getChanges({ window: window(i) })));
          coverage.push(health);
        } catch (err) {
          if (!(err instanceof ProviderUnavailableError)) throw err;
          coverage.push({ ...health, state: err.state, detail: err.message });
        }
      }
      return { ok: true, data: { records, coverage } };
    },
    getWorkItems: (i) => call(i.source, 'work_items', i.until, async (s) => problemItems(await s.work_items!.getWorkItems({ window: window(i) }), i.area)),
    getFeedback: (i) => call(i.source, 'feedback', i.until, async (s) => negativeFeedback(await s.feedback!.getFeedback({ window: window(i) }), i.area)),
    getFeedbackVolume: (i) =>
      call(i.source, 'feedback', i.until, async (s) => {
        const items = negativeFeedback(await s.feedback!.getFeedback({ window: window(i) }), i.area);
        const buckets = new Map<string, number>();
        for (const f of items) {
          const hour = `${f.createdAt.slice(0, 13)}:00:00.000Z`;
          buckets.set(hour, (buckets.get(hour) ?? 0) + 1);
        }
        return { count: items.length, perHour: [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([t, value]) => ({ t, value })) };
      }),
  };
}
