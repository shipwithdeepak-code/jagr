import type { ProviderId, SourceConnection, Watch } from '../types';
import type { IssueRecord, MetricSeries, ReleaseRecord, ReviewRecord } from '../integrations/types';
import { METRIC_DEFS, type World } from '../integrations/world';
import { signalsForSources } from '../catalog';
import type { ImportedDataset, MetricRow } from './schemas';

/**
 * The bring-your-own-data adapter: user imports → the same `World` the engine investigates.
 *
 *   uploaded CSV / JSON → validated records → World (+ labelled connections) → watches → investigation
 *
 * The engine does not know the data came from a file. What it does know, via the connections, is
 * that these sources are USER IMPORT — and every piece of evidence is labelled that way.
 *
 * Channels: imported metrics use the analytics channel, issues and releases the issue-tracker
 * channel, customer feedback the reviews channel — each renamed so nothing reads "App Store" or
 * "Jira" when it came from the user's file.
 */

export const IMPORT_LABELS: Partial<Record<ProviderId, { name: string; short: string }>> = {
  ga4: { name: 'Imported metrics', short: 'Metrics' },
  jira: { name: 'Imported issues, releases & changes', short: 'Issues & releases' },
  app_store: { name: 'Imported customer feedback', short: 'Feedback' },
};

export interface ImportedWorld {
  world?: World;
  connections: SourceConnection[];
  /** Things the user should know (estimated baselines, duplicates across files, nothing to investigate). */
  notes: string[];
  counts: { metrics: number; issues: number; releases: number; changes: number; feedback: number; duplicates: number };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

/** Later imports win when the same record appears twice; each duplicate is counted, never double-counted. */
function merge<T>(lists: T[][], key: (x: T) => string): { items: T[]; duplicates: number } {
  const map = new Map<string, T>();
  let duplicates = 0;
  for (const list of lists) for (const x of list) {
    if (map.has(key(x))) duplicates++;
    map.set(key(x), x);
  }
  return { items: [...map.values()], duplicates };
}

function buildSeries(metricId: string, rows: MetricRow[], notes: string[]): MetricSeries | undefined {
  const def = METRIC_DEFS.find((d) => d.id === metricId);
  if (!def) return undefined;
  const points = [...rows].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).map((r) => ({ t: r.timestamp, value: r.value }));
  const given = rows.map((r) => r.baseline).filter((b): b is number => b !== undefined);
  let mean: number;
  let source: string;
  if (given.length) {
    mean = median(given);
    source = 'Baseline column in your import';
  } else {
    const n = Math.max(1, Math.ceil(points.length / 3));
    mean = median(points.slice(0, n).map((p) => p.value));
    source = `Estimated from the first ${n} point${n === 1 ? '' : 's'} (no baseline column)`;
    notes.push(`${def.name}: no baseline column, so the baseline (${mean}) was estimated from the first ${n} point${n === 1 ? '' : 's'}. Add a baseline column for a more reliable comparison.`);
  }
  // Spread: how much "normal" points vary around the baseline, floored at 1% so a flat series
  // doesn't make every wobble look extreme.
  const tolerance = (def.threshold / 100) * 0.5 * Math.abs(mean);
  const normal = points.filter((p) => Math.abs(p.value - mean) <= tolerance).map((p) => p.value - mean);
  const sd = normal.length > 1 ? Math.sqrt(normal.reduce((a, d) => a + d * d, 0) / (normal.length - 1)) : 0;
  const { base: _b, std: _s, ...rest } = def;
  void _b;
  void _s;
  return { ...rest, name: def.name, baseline: { mean, stdDev: Math.max(sd, 0.01 * Math.abs(mean)), window: source }, points };
}

export function buildImportedWorld(datasets: ImportedDataset[], updatedAt: string): ImportedWorld {
  const ok = datasets.filter((d) => !d.error);
  const notes: string[] = [];
  const metricsM = merge(ok.map((d) => d.metrics), (m) => `${m.metricId}@${m.timestamp}`);
  const issuesM = merge<IssueRecord>(ok.map((d) => d.issues), (x) => x.id);
  // Releases and other changes share one change channel (ids must be unique across both).
  const releasesM = merge<ReleaseRecord>(ok.flatMap((d) => [d.releases, d.changes ?? []]), (x) => x.id);
  const feedbackM = merge<ReviewRecord>(ok.map((d) => d.feedback), (x) => x.id);
  const duplicates = metricsM.duplicates + issuesM.duplicates + releasesM.duplicates + feedbackM.duplicates;
  if (duplicates) notes.push(`${duplicates} record${duplicates === 1 ? ' appears' : 's appear'} in more than one import; the latest import was kept and each is counted once.`);

  const byMetric = new Map<string, MetricRow[]>();
  for (const m of metricsM.items) byMetric.set(m.metricId, [...(byMetric.get(m.metricId) ?? []), m]);
  const metrics = [...byMetric.entries()].map(([id, rows]) => buildSeries(id, rows, notes)).filter((s): s is MetricSeries => !!s);
  for (const s of metrics) if (s.points.length < 4) notes.push(`${s.name} has only ${s.points.length} point${s.points.length === 1 ? '' : 's'}; Jagr needs at least 4 to judge whether a change persists.`);

  const changeCount = releasesM.items.filter((r) => r.kind && r.kind !== 'release').length;
  const counts = { metrics: metricsM.items.length, issues: issuesM.items.length, releases: releasesM.items.length - changeCount, changes: changeCount, feedback: feedbackM.items.length, duplicates };
  const files = (kind: ImportedDataset['kind']) => ok.filter((d) => d.kind === kind).map((d) => d.filename);
  const conn = (provider: ProviderId, present: boolean, detail: string): SourceConnection =>
    present
      ? { provider, state: 'imported', detail, updatedAt, label: IMPORT_LABELS[provider] }
      : { provider, state: 'not_configured', detail: 'Nothing imported for this source.', updatedAt, label: IMPORT_LABELS[provider] };
  const connections: SourceConnection[] = [
    conn('ga4', metrics.length > 0, `${files('metrics').join(', ')} · ${counts.metrics} points · ${metrics.map((s) => s.name).join(', ')}`),
    conn('jira', counts.issues + counts.releases + counts.changes > 0, `${[...files('issues'), ...files('releases'), ...files('changes')].join(', ')} · ${counts.issues} issues · ${counts.releases} releases${counts.changes ? ` · ${counts.changes} other changes` : ''}`),
    conn('app_store', counts.feedback > 0, `${files('feedback').join(', ')} · ${counts.feedback} feedback items`),
    { provider: 'google_play', state: 'not_configured', detail: 'Not used with imported data.', updatedAt },
    { provider: 'email', state: 'simulated', detail: 'Emails are rendered in Jagr, never delivered.', updatedAt },
  ];

  const stamps = [...metricsM.items.map((m) => m.timestamp), ...issuesM.items.map((x) => x.createdAt), ...feedbackM.items.map((x) => x.createdAt), ...releasesM.items.filter((r) => r.kind && r.kind !== 'release').map((r) => r.releasedAt)].sort();
  if (!stamps.length) {
    return { connections, notes: [...notes, 'No metrics, issues or feedback imported yet — there is nothing to investigate.'], counts };
  }
  // Cadence: the typical spacing between metric points (hourly exports are common).
  const gaps = metrics.flatMap((s) => s.points.slice(1).map((p, i) => (Date.parse(p.t) - Date.parse(s.points[i].t)) / 60_000)).filter((g) => g > 0);
  const bucketMinutes = gaps.length ? Math.max(1, Math.round(median(gaps))) : 60;
  const metricStamps = metricsM.items.map((m) => m.timestamp).sort();
  const start = metricStamps[0] ?? stamps[0];
  const end = new Date(Date.parse(stamps[stamps.length - 1]) + bucketMinutes * 60_000).toISOString();
  return {
    world: {
      id: 'imported',
      name: 'Your imported data',
      start,
      end,
      bucketMinutes,
      metrics,
      metricCatalog: METRIC_DEFS.map(({ base: _b, std: _s, ...def }) => (void _b, void _s, def)),
      issues: issuesM.items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      releases: releasesM.items.sort((a, b) => a.releasedAt.localeCompare(b.releasedAt)),
      reviews: feedbackM.items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    },
    connections,
    notes,
    counts,
  };
}

/**
 * A watch only looks at sources that have data. Sources with nothing imported are left out of the
 * run (and shown as NOT CONFIGURED), so the investigation says "not part of this watch" rather
 * than pretending to have checked them.
 */
export function watchesForImportedData(watches: Watch[], connections: SourceConnection[]): Watch[] {
  const usable = new Set(connections.filter((c) => c.state === 'imported' || c.state === 'connected').map((c) => c.provider));
  return watches
    .map((w) => {
      const sources = w.sources.filter((p) => usable.has(p));
      return { ...w, sources, signals: signalsForSources(w.signals, sources) };
    })
    .filter((w) => w.sources.length > 0);
}
