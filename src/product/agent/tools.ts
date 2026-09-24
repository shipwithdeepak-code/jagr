import type { Area, ToolName, Watch } from '../types';
import type { SourceRegistry } from '../roles/registry';
import type { ChangeRecord, FeedbackItem, MetricSeries, Role, SegmentSeries, SourceId, WorkItem } from '../roles/types';
import { ProviderUnavailableError } from '../integrations/types';
import { labelOf, type ProviderLabels } from '../integrations/adapters';
import { negativeFeedback, problemItems, readMetric, withWatchThreshold, type MetricReading } from '../engine/detect';

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
  | { ok: true; data: T }
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

export interface VolumeResult {
  count: number;
  /** Negative items per hour, oldest first. */
  perHour: { t: string; value: number }[];
}

export interface Toolbox {
  getMetric(i: { source: SourceId; metric: string; until: string }): Promise<ToolOutcome<MetricResult>>;
  getMetricBreakdown(i: { source: SourceId; metric: string; dimension: string; until: string }): Promise<ToolOutcome<SegmentResult[]>>;
  getChanges(i: TimeRange & { source: SourceId }): Promise<ToolOutcome<ChangeRecord[]>>;
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
  async function call<T>(source: SourceId, role: Role, fn: (s: NonNullable<ReturnType<SourceRegistry['get']>>) => Promise<T>): Promise<ToolOutcome<T>> {
    const s = reg.get(source);
    if (!watch.sources.includes(source) || !s) return { ok: false, state: 'not_in_watch', detail: `${P(source).name} is not part of this watch` };
    if (!s[role]) return { ok: false, state: 'not_in_watch', detail: `${P(source).name} does not provide ${role.replace('_', ' ')}` };
    try {
      return { ok: true, data: await fn(s) };
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
      call(i.source, 'metrics', async (s) => {
        const raw = await s.metrics!.getSeries({ metric: i.metric, window: { start: worldStart, end: i.until } });
        if (!raw) throw new NoDataError(i.metric);
        const series = withWatchThreshold(raw, watch.thresholds);
        return { series, reading: readMetric(series) };
      }),
    getMetricBreakdown: (i) =>
      call(i.source, 'metrics', async (s) => {
        if (!s.metrics!.listDimensions(i.metric).includes(i.dimension)) throw new NoDataError(`${i.metric} by ${i.dimension}`);
        const segments: SegmentSeries[] = await s.metrics!.getBreakdown({ metric: i.metric, dimension: i.dimension, window: { start: worldStart, end: i.until } });
        return segments.map((x) => {
          const series = withWatchThreshold(x.series, watch.thresholds);
          return { segment: x.segment, series, reading: readMetric(series) };
        });
      }),
    getChanges: (i) => call(i.source, 'changes', (s) => s.changes!.getChanges({ window: window(i) })),
    getWorkItems: (i) => call(i.source, 'work_items', async (s) => problemItems(await s.work_items!.getWorkItems({ window: window(i) }), i.area)),
    getFeedback: (i) => call(i.source, 'feedback', async (s) => negativeFeedback(await s.feedback!.getFeedback({ window: window(i) }), i.area)),
    getFeedbackVolume: (i) =>
      call(i.source, 'feedback', async (s) => {
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
