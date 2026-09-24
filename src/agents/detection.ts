import type { MetricBaseline, MetricDefinition, SeriesPoint, Severity, Signal, SignalCategory, WatchArea, WorkspaceSettings } from '@/domain/types';
import { addMinutes, BUCKET_MINUTES } from '@/lib/time';

/**
 * Anomaly detection — pure functions, no I/O.
 *
 * A metric is anomalous only when all three hold:
 *   1. the trailing 90-minute mean moved past the PM's threshold in the bad direction,
 *   2. the move is statistically unusual versus the same hours on previous nights (|z| ≥ 3),
 *   3. it persisted — each of the last three 30-minute buckets is individually degraded.
 * A single bad bucket puts the metric on "watching"; if it recovers it's dismissed as transient.
 */

export const WINDOW_BUCKETS = 3;
export const Z_THRESHOLD = 3;
export const PERSISTENCE_FRACTION = 0.6;

export const CATEGORY_WATCH_AREA: Record<SignalCategory, WatchArea> = {
  activation: 'activation',
  conversion: 'conversion',
  retention: 'retention',
  revenue: 'revenue',
  payments: 'payment_failures',
  support: 'support_volume',
  engagement: 'engagement',
  reliability: 'reliability',
};

export function isWatched(def: MetricDefinition, settings: WorkspaceSettings): boolean {
  return settings.watch[CATEGORY_WATCH_AREA[def.category]];
}

/** Positive = moved in the bad direction. */
export function badChangePct(value: number, baseline: number, badDirection: 'up' | 'down'): number {
  const change = ((value - baseline) / baseline) * 100;
  return badDirection === 'down' ? -change : change;
}

export function classifySeverity(tier: 1 | 2 | 3, badChange: number, thresholdPct: number): Severity {
  const ratio = badChange / thresholdPct;
  if (ratio < 1) return 'normal';
  if (tier === 1 && ratio >= 2) return 'critical';
  if (tier === 1 || ratio >= 1.5) return 'high';
  return 'medium';
}

export function evaluateSignal(
  def: MetricDefinition,
  series: SeriesPoint[],
  baseline: MetricBaseline,
  thresholdPct: number,
  asOf: string,
  watched: boolean,
): Signal {
  const window = series.slice(-WINDOW_BUCKETS);
  const base: Omit<Signal, 'current' | 'changePct' | 'zScore' | 'severity' | 'status'> = {
    id: `sig-${def.id}`,
    metricId: def.id,
    name: def.name,
    category: def.category,
    unit: def.unit,
    badDirection: def.badDirection,
    tier: def.tier,
    area: def.area,
    baseline,
    observedAt: asOf,
    series,
    thresholdPct,
    watched,
  };

  if (window.length === 0) {
    return { ...base, current: baseline.mean, changePct: 0, zScore: 0, severity: 'normal', status: 'normal' };
  }

  const current = window.reduce((a, p) => a + p.value, 0) / window.length;
  const changePct = ((current - baseline.mean) / baseline.mean) * 100;
  const zScore = baseline.stdDev > 0 ? (current - baseline.mean) / baseline.stdDev : 0;
  const bad = badChangePct(current, baseline.mean, def.badDirection);
  const badZ = def.badDirection === 'down' ? -zScore : zScore;
  const bucketBad = window.map((p) => badChangePct(p.value, baseline.mean, def.badDirection));
  const latestBad = bucketBad[bucketBad.length - 1];

  const persistent = window.length === WINDOW_BUCKETS && bucketBad.every((b) => b >= thresholdPct * PERSISTENCE_FRACTION);
  const anomalous = bad >= thresholdPct && badZ >= Z_THRESHOLD && persistent;
  const latestZ = baseline.stdDev > 0 ? ((latestBad / 100) * baseline.mean) / baseline.stdDev : 0;
  const watching = !anomalous && latestBad >= thresholdPct && latestZ >= Z_THRESHOLD;

  let onsetAt: string | undefined;
  if (anomalous || watching) {
    // Walk back through the night to find where the degradation began.
    let i = series.length - 1;
    while (i > 0 && badChangePct(series[i - 1].value, baseline.mean, def.badDirection) >= thresholdPct * 0.5) i--;
    onsetAt = series[i].t;
  }

  return {
    ...base,
    current,
    changePct,
    zScore,
    severity: anomalous ? classifySeverity(def.tier, bad, thresholdPct) : 'normal',
    status: anomalous ? 'anomalous' : watching ? 'watching' : 'normal',
    onsetAt,
  };
}

/** Bucket end time helper: a bucket starting at t is complete at t + 30min. */
export function bucketEnd(t: string): string {
  return addMinutes(t, BUCKET_MINUTES);
}

// ─────────────────────────────────────────────────────────────
// Prioritisation: group related anomalies via the metric tree
// ─────────────────────────────────────────────────────────────

export interface AnomalyCluster {
  primary: Signal;
  members: Signal[];
  severity: Severity;
  score: number;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, normal: 0 };

export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s];
}

export function maxSeverity(list: Severity[]): Severity {
  return list.reduce<Severity>((m, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[m] ? s : m), 'normal');
}

/** Metrics are related when one appears in the other's driver tree (transitively). */
export function relatedMetricIds(metricId: string, defs: MetricDefinition[]): Set<string> {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const related = new Set<string>([metricId]);
  const down = (id: string) => {
    for (const d of byId.get(id)?.drivers ?? []) {
      if (!related.has(d)) {
        related.add(d);
        down(d);
      }
    }
  };
  const up = (id: string) => {
    for (const d of defs) {
      if (d.drivers?.includes(id) && !related.has(d.id)) {
        related.add(d.id);
        up(d.id);
      }
    }
  };
  down(metricId);
  up(metricId);
  return related;
}

/** Related = connected in the metric tree, or degraded starting in the same 30-minute window. */
export function signalsRelated(a: Signal, b: Signal, defs: MetricDefinition[]): boolean {
  if (relatedMetricIds(a.metricId, defs).has(b.metricId)) return true;
  if (a.onsetAt && b.onsetAt) return Math.abs(Date.parse(a.onsetAt) - Date.parse(b.onsetAt)) <= BUCKET_MINUTES * 60_000;
  return false;
}

export function clusterAnomalies(anomalies: Signal[], defs: MetricDefinition[]): AnomalyCluster[] {
  const remaining = [...anomalies];
  const clusters: AnomalyCluster[] = [];
  while (remaining.length) {
    const seed = remaining.shift()!;
    const members = [seed];
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = remaining.length - 1; i >= 0; i--) {
        const cand = remaining[i];
        if (members.some((m) => signalsRelated(m, cand, defs))) {
          members.push(cand);
          remaining.splice(i, 1);
          grew = true;
        }
      }
    }
    // Primary = the outcome metric at the top of the tree (not a driver of another member).
    const isDriverOfMember = (s: Signal) =>
      members.some((m) => m !== s && defs.find((d) => d.id === m.metricId)?.drivers?.includes(s.metricId));
    const roots = members.filter((m) => !isDriverOfMember(m));
    const primary = [...(roots.length ? roots : members)].sort(
      (a, b) => a.tier - b.tier || Math.abs(b.changePct) / b.thresholdPct - Math.abs(a.changePct) / a.thresholdPct,
    )[0];
    const severity = maxSeverity(members.map((m) => m.severity));
    const score = SEVERITY_RANK[severity] * 100 + (4 - primary.tier) * 10 + Math.min(9, Math.abs(primary.changePct) / primary.thresholdPct);
    // Order: primary, its direct drivers, then everything else.
    const primaryDrivers = defs.find((d) => d.id === primary.metricId)?.drivers ?? [];
    members.sort((a, b) => rankMember(a) - rankMember(b));
    function rankMember(s: Signal) {
      if (s === primary) return 0;
      if (primaryDrivers.includes(s.metricId)) return 1;
      return 2 + s.tier;
    }
    clusters.push({ primary, members, severity, score });
  }
  return clusters.sort((a, b) => b.score - a.score);
}
