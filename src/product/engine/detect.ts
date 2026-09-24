import type { Area } from '../types';
import type { IssueRecord, MetricSeries, ReviewRecord } from '../integrations/types';
import { classifyText } from '../catalog';
import { ISSUE_BASELINE_PER_3H, NEGATIVE_REVIEW_BASELINE_PER_6H } from '../integrations/world';

/**
 * Detection rules — pure functions.
 *
 * Metric: anomalous when the last hour (4 × 15-min buckets) moved past the threshold in the bad
 * direction, at least 3 of the 4 buckets are individually degraded, and the move is ≥3σ from
 * normal nights. One bad bucket alone is "watching" (possible fluctuation).
 * Counts (issues, negative reviews): unusual when the count clears both an absolute floor and a
 * multiple of the historical rate for the same window.
 */

export type DetectionStatus = 'normal' | 'watching' | 'anomalous';

export interface MetricReading {
  status: DetectionStatus;
  /** Move in the bad direction over the detection window: % for relative metrics, points for absolute ones. */
  bad: number;
  ratio: number;
  current: number;
  /** Value and move over the buckets since onset — what gets reported to people. */
  currentSinceOnset: number;
  badSinceOnset: number;
  onsetAt?: string;
  zScore: number;
}

const WINDOW = 4;

function badOf(series: MetricSeries, value: number): number {
  const delta = series.mode === 'relative' ? ((value - series.baseline.mean) / series.baseline.mean) * 100 : value - series.baseline.mean;
  return series.badDirection === 'down' ? -delta : delta;
}

/** Applies a watch's custom threshold for this metric, if it set a valid one. */
export function withWatchThreshold(series: MetricSeries, thresholds: Partial<Record<string, number>> | undefined): MetricSeries {
  const th = thresholds?.[series.id];
  return th !== undefined && Number.isFinite(th) && th > 0 ? { ...series, threshold: th } : series;
}

export function readMetric(series: MetricSeries): MetricReading {
  const pts = series.points;
  if (pts.length < WINDOW) return { status: 'normal', bad: 0, ratio: 0, current: series.baseline.mean, currentSinceOnset: series.baseline.mean, badSinceOnset: 0, zScore: 0 };
  const win = pts.slice(-WINDOW);
  const current = win.reduce((a, p) => a + p.value, 0) / WINDOW;
  const bad = badOf(series, current);
  const z = ((series.badDirection === 'down' ? -1 : 1) * (current - series.baseline.mean)) / series.baseline.stdDev;
  const buckets = win.map((p) => badOf(series, p.value));
  const th = series.threshold;
  const persistent = buckets.filter((b) => b >= th * 0.5).length >= 3;
  const latest = buckets[buckets.length - 1];
  const latestZ = ((series.badDirection === 'down' ? -1 : 1) * (win[WINDOW - 1].value - series.baseline.mean)) / series.baseline.stdDev;

  let status: DetectionStatus = 'normal';
  if (bad >= th && persistent && z >= 3) status = 'anomalous';
  else if (latest >= th && latestZ >= 3) status = 'watching';

  let onsetAt: string | undefined;
  if (status !== 'normal') {
    let i = pts.length - 1;
    while (i > 0 && badOf(series, pts[i - 1].value) >= th * 0.5) i--;
    onsetAt = pts[i].t;
  }
  const recent = onsetAt ? win.filter((p) => p.t >= onsetAt!) : win;
  const currentSinceOnset = recent.length ? recent.reduce((a, p) => a + p.value, 0) / recent.length : current;
  return { status, bad, ratio: bad / th, current, currentSinceOnset, badSinceOnset: badOf(series, currentSinceOnset), onsetAt, zScore: z };
}

export function fmtMagnitude(series: MetricSeries, reading: MetricReading): string {
  const change = series.badDirection === 'down' ? -reading.badSinceOnset : reading.badSinceOnset;
  const sign = change < 0 ? '−' : '+';
  return series.mode === 'relative' ? `${sign}${Math.abs(change).toFixed(Math.abs(change) >= 10 ? 0 : 1)}%` : `${sign}${Math.abs(change).toFixed(2)} pts`;
}

// ── Counts ───────────────────────────────────────────────────

export interface CountReading {
  status: DetectionStatus;
  count: number;
  ratio: number;
  onsetAt?: string;
  ids: string[];
  blockers: number;
}

function countReading(items: { id: string; createdAt: string }[], baseline: number, blockers = 0): CountReading {
  const floor = Math.max(3, Math.ceil(baseline * 3 + 2));
  const n = items.length;
  const status: DetectionStatus = n >= floor ? 'anomalous' : n >= floor - 1 && n >= 2 ? 'watching' : 'normal';
  return { status, count: n, ratio: n / floor, onsetAt: items[0]?.createdAt, ids: items.map((i) => i.id), blockers };
}

export function issueArea(issue: IssueRecord): Area[] {
  const areas = new Set<Area>([issue.area, ...classifyText(`${issue.title} ${issue.labels.join(' ')}`)]);
  return [...areas];
}

export function readIssues(issues: IssueRecord[], area: Area): CountReading {
  const matched = issues.filter((i) => i.type !== 'Task' && issueArea(i).includes(area));
  return countReading(matched, ISSUE_BASELINE_PER_3H[area], matched.filter((i) => i.priority === 'Highest').length);
}

export function isNegative(r: ReviewRecord) {
  return r.rating <= 2;
}

export function readReviews(reviews: ReviewRecord[], area: Area): CountReading {
  const matched = reviews.filter((r) => isNegative(r) && classifyText(`${r.title} ${r.body}`).includes(area));
  return countReading(matched, NEGATIVE_REVIEW_BASELINE_PER_6H[area]);
}

/** Areas that have any issue or negative review in the list — for watches that cover every area. */
export function areasPresent(issues: IssueRecord[], reviews: ReviewRecord[]): Area[] {
  const set = new Set<Area>();
  issues.forEach((i) => issueArea(i).forEach((a) => set.add(a)));
  reviews.filter(isNegative).forEach((r) => classifyText(`${r.title} ${r.body}`).forEach((a) => set.add(a)));
  return [...set];
}
