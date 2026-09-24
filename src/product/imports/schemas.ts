import type { Area } from '../types';
import type { IssueRecord, ReleaseRecord, ReviewRecord } from '../integrations/types';
import { classifyText } from '../catalog';
import { parseFile, type RawRow } from './parse';

/**
 * Bring-your-own-data: four kinds of product evidence, validated row by row and normalised into the
 * records the engine already understands. Nothing is silently discarded — every rejected row keeps
 * its line number and the reason, so the user can see and fix it.
 */

export type ImportKind = 'metrics' | 'issues' | 'releases' | 'feedback';

export const IMPORT_KINDS: { kind: ImportKind; label: string; required: string[]; optional: string[]; example: string }[] = [
  { kind: 'metrics', label: 'Metrics', required: ['timestamp', 'metric', 'value'], optional: ['baseline'], example: 'timestamp,metric,value,baseline\n2026-09-24T19:00:00Z,checkout_conversion,2.79,3.40' },
  { kind: 'issues', label: 'Issues', required: ['id', 'title', 'created_at'], optional: ['status', 'labels', 'priority', 'type', 'version', 'component'], example: 'id,title,status,created_at,labels\nPAY-512,Checkout payment failures,open,2026-09-24T19:20:00Z,checkout' },
  { kind: 'releases', label: 'Releases', required: ['id', 'name', 'date'], optional: ['status', 'version', 'rollout', 'platform'], example: 'id,name,date,status\nREL-481,Release 4.8.1,2026-09-24T18:30:00Z,deployed' },
  { kind: 'feedback', label: 'Customer feedback', required: ['id', 'text', 'rating', 'created_at'], optional: ['title', 'version'], example: 'id,text,rating,created_at\nREV-102,Payment failed twice,2,2026-09-24T20:10:00Z' },
];

/**
 * Metrics Jagr's investigation engine can reason about in V1, and the names users may give them.
 * Anything else is rejected with an explicit reason rather than imported and ignored.
 */
export const METRIC_ALIASES: Record<string, string> = {
  checkout_conversion: 'ga4.checkout_conversion',
  checkout_conversion_rate: 'ga4.checkout_conversion',
  checkout_rate: 'ga4.checkout_conversion',
  signup_conversion: 'ga4.signup_conversion',
  signup_conversion_rate: 'ga4.signup_conversion',
  signup_rate: 'ga4.signup_conversion',
  purchase_revenue: 'ga4.purchase_revenue',
  revenue: 'ga4.purchase_revenue',
  sessions: 'ga4.sessions',
  traffic: 'ga4.sessions',
  visits: 'ga4.sessions',
  search_usage: 'ga4.search_usage',
  searches: 'ga4.search_usage',
};
export const SUPPORTED_METRICS = ['checkout_conversion', 'signup_conversion', 'purchase_revenue', 'sessions', 'search_usage'];

export interface MetricRow {
  metricId: string;
  name: string;
  timestamp: string;
  value: number;
  baseline?: number;
}

export interface RejectedRow {
  line: number;
  reason: string;
  values: Record<string, string>;
}

export interface ImportedDataset {
  id: string;
  kind: ImportKind;
  filename: string;
  importedAt: string;
  format: 'csv' | 'json';
  columns: string[];
  totalRows: number;
  metrics: MetricRow[];
  issues: IssueRecord[];
  releases: ReleaseRecord[];
  feedback: ReviewRecord[];
  rejected: RejectedRow[];
  /** Accepted but worth knowing (e.g. a release that is not deployed yet). */
  notes: string[];
  /** The file as a whole could not be read. */
  error?: string;
}

export const MAX_ROWS = 5000;
export const MAX_BYTES = 2_000_000;

const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;

/** ISO 8601 only. Local formats like 09/24/2026 are ambiguous — rejected, not guessed. No zone → UTC. */
export function parseTimestamp(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (!ISO.test(s)) return undefined;
  const withTime = s.length === 10 ? `${s}T00:00:00Z` : s.replace(' ', 'T');
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(withTime) ? withTime : `${withTime}Z`;
  const ms = Date.parse(zoned);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

const num = (v: string | undefined) => {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v.replace(/%$/, '').trim());
  return Number.isFinite(n) ? n : NaN;
};

const pick = (row: Record<string, string>, ...names: string[]) => names.map((n) => row[n]).find((v) => v !== undefined && v !== '');
const splitList = (v: string | undefined) => (v ? v.split(/[;|,]/).map((x) => x.trim().toLowerCase()).filter(Boolean) : []);

const PRIORITY: Record<string, IssueRecord['priority']> = { highest: 'Highest', critical: 'Highest', blocker: 'Highest', high: 'High', medium: 'Medium', normal: 'Medium', low: 'Low', lowest: 'Low' };
const DEPLOYED = ['deployed', 'released', 'live', 'rolled_out', 'rolling_out', 'complete', 'completed', 'shipped', ''];

type RowResult<T> = { ok: true; record: T; note?: string } | { ok: false; reason: string };

function metricRow(r: RawRow): RowResult<MetricRow> {
  const v = r.values;
  const timestamp = parseTimestamp(pick(v, 'timestamp', 'time', 'date', 'datetime'));
  if (!timestamp) return { ok: false, reason: 'Invalid or missing timestamp (use ISO 8601, e.g. 2026-09-24T19:00:00Z).' };
  const rawName = (pick(v, 'metric', 'name', 'metric_name') ?? '').trim();
  if (!rawName) return { ok: false, reason: 'Missing metric name.' };
  const key = rawName.toLowerCase().replace(/[\s-]+/g, '_');
  const metricId = METRIC_ALIASES[key];
  if (!metricId) return { ok: false, reason: `Unknown metric “${rawName}”. V1 can investigate: ${SUPPORTED_METRICS.join(', ')}.` };
  const value = num(pick(v, 'value'));
  if (value === undefined || Number.isNaN(value)) return { ok: false, reason: 'Missing or non-numeric value.' };
  const baseline = num(pick(v, 'baseline', 'expected', 'baseline_value'));
  if (Number.isNaN(baseline)) return { ok: false, reason: 'Baseline is not a number.' };
  if (baseline !== undefined && baseline <= 0) return { ok: false, reason: 'Baseline must be greater than zero.' };
  return { ok: true, record: { metricId, name: rawName, timestamp, value, baseline } };
}

function issueRow(r: RawRow): RowResult<IssueRecord> {
  const v = r.values;
  const id = pick(v, 'id', 'key', 'issue', 'issue_key');
  if (!id) return { ok: false, reason: 'Missing issue id.' };
  const title = pick(v, 'title', 'summary', 'name');
  if (!title) return { ok: false, reason: 'Missing title.' };
  const createdAt = parseTimestamp(pick(v, 'created_at', 'created', 'date', 'timestamp'));
  if (!createdAt) return { ok: false, reason: 'Invalid or missing created_at timestamp (ISO 8601).' };
  const labels = splitList(pick(v, 'labels', 'label', 'tags'));
  const component = pick(v, 'component', 'components') ?? '';
  const typeRaw = (pick(v, 'type', 'issue_type') ?? '').toLowerCase();
  const type: IssueRecord['type'] = typeRaw.includes('incident') ? 'Incident' : typeRaw.includes('task') || typeRaw.includes('story') ? 'Task' : 'Bug';
  const priority = PRIORITY[(pick(v, 'priority') ?? '').toLowerCase()] ?? 'Medium';
  const version = pick(v, 'version', 'affects_version', 'affected_version', 'fix_version');
  const area: Area = classifyText([title, component, ...labels].join(' '))[0] ?? 'general';
  const status = (pick(v, 'status') ?? '').toLowerCase();
  return {
    ok: true,
    record: { id, provider: 'jira', title, type, priority, component, area, labels, affectsVersion: version, reporter: 'Imported', createdAt },
    note: /^(closed|done|resolved|won'?t fix)$/.test(status) ? `${id} is ${status}; still counted as evidence of when it was reported.` : undefined,
  };
}

function releaseRow(r: RawRow): RowResult<ReleaseRecord> {
  const v = r.values;
  const id = pick(v, 'id', 'key');
  if (!id) return { ok: false, reason: 'Missing release id.' };
  const name = pick(v, 'name', 'title') ?? '';
  const version = pick(v, 'version') ?? name.match(/\d+(?:\.\d+)+/)?.[0] ?? name.trim();
  if (!version) return { ok: false, reason: 'Missing release name or version.' };
  const releasedAt = parseTimestamp(pick(v, 'date', 'released_at', 'release_date', 'deployed_at', 'timestamp'));
  if (!releasedAt) return { ok: false, reason: 'Invalid or missing date (ISO 8601).' };
  const status = (pick(v, 'status') ?? '').toLowerCase().replace(/\s+/g, '_');
  if (!DEPLOYED.includes(status)) return { ok: false, reason: `Status “${status}” is not a deployed release (planned or cancelled releases are not changes that can explain a shift).` };
  const platformRaw = (pick(v, 'platform') ?? '').toLowerCase();
  const platform: ReleaseRecord['platform'] = platformRaw === 'ios' || platformRaw === 'android' || platformRaw === 'web' ? platformRaw : 'all';
  return { ok: true, record: { id, provider: 'jira', version, platform, releasedAt, notes: name || `Release ${version}`, rollout: pick(v, 'rollout') } };
}

function feedbackRow(r: RawRow): RowResult<ReviewRecord> {
  const v = r.values;
  const id = pick(v, 'id');
  if (!id) return { ok: false, reason: 'Missing feedback id.' };
  const body = pick(v, 'text', 'body', 'comment', 'review', 'feedback');
  if (!body) return { ok: false, reason: 'Missing text.' };
  const rating = num(pick(v, 'rating', 'score', 'stars'));
  if (rating === undefined || Number.isNaN(rating) || !Number.isInteger(rating) || rating < 1 || rating > 5) return { ok: false, reason: 'Rating must be a whole number from 1 to 5.' };
  const createdAt = parseTimestamp(pick(v, 'created_at', 'created', 'date', 'timestamp'));
  if (!createdAt) return { ok: false, reason: 'Invalid or missing created_at timestamp (ISO 8601).' };
  const title = pick(v, 'title') ?? (body.length > 60 ? `${body.slice(0, 57)}…` : body);
  return { ok: true, record: { id, provider: 'app_store', rating: rating as ReviewRecord['rating'], title, body, version: pick(v, 'version') ?? '', createdAt } };
}

const ID_OF = { metrics: (m: MetricRow) => `${m.metricId}@${m.timestamp}`, issues: (x: IssueRecord) => x.id, releases: (x: ReleaseRecord) => x.id, feedback: (x: ReviewRecord) => x.id };

/** Parse and validate one uploaded file. Pure: same bytes in → same dataset out. */
export function importFile(kind: ImportKind, filename: string, text: string, importedAt: string, id = `imp-${kind}-${importedAt}`): ImportedDataset {
  const base: ImportedDataset = { id, kind, filename, importedAt, format: /\.json$/i.test(filename) ? 'json' : 'csv', columns: [], totalRows: 0, metrics: [], issues: [], releases: [], feedback: [], rejected: [], notes: [] };
  if (text.length > MAX_BYTES) return { ...base, error: `The file is larger than ${MAX_BYTES / 1_000_000} MB.` };
  const parsed = parseFile(filename, text);
  if (parsed.error) return { ...base, format: parsed.format, error: parsed.error };
  const spec = IMPORT_KINDS.find((k) => k.kind === kind)!;
  const out: ImportedDataset = { ...base, format: parsed.format, columns: parsed.columns, totalRows: parsed.rows.length };
  if (parsed.rows.length > MAX_ROWS) return { ...out, error: `The file has ${parsed.rows.length} rows; V1 imports up to ${MAX_ROWS} per file.` };

  const seen = new Set<string>();
  for (const row of parsed.rows) {
    const res = kind === 'metrics' ? metricRow(row) : kind === 'issues' ? issueRow(row) : kind === 'releases' ? releaseRow(row) : feedbackRow(row);
    if (!res.ok) {
      out.rejected.push({ line: row.line, reason: res.reason, values: row.values });
      continue;
    }
    const key = (ID_OF[kind] as (x: unknown) => string)(res.record);
    if (seen.has(key)) {
      out.rejected.push({ line: row.line, reason: `Duplicate of an earlier row (${key}) — not counted twice.`, values: row.values });
      continue;
    }
    seen.add(key);
    if (res.note) out.notes.push(res.note);
    if (kind === 'metrics') out.metrics.push(res.record as MetricRow);
    else if (kind === 'issues') out.issues.push(res.record as IssueRecord);
    else if (kind === 'releases') out.releases.push(res.record as ReleaseRecord);
    else out.feedback.push(res.record as ReviewRecord);
  }
  const missing = spec.required.filter((c) => !parsed.columns.some((col) => col === c || (c === 'created_at' && ['created', 'date', 'timestamp'].includes(col)) || (c === 'timestamp' && ['time', 'date', 'datetime'].includes(col)) || (c === 'metric' && ['name', 'metric_name'].includes(col)) || (c === 'name' && ['title', 'version'].includes(col)) || (c === 'date' && ['released_at', 'release_date', 'deployed_at'].includes(col)) || (c === 'text' && ['body', 'comment', 'review', 'feedback'].includes(col)) || (c === 'rating' && ['score', 'stars'].includes(col)) || (c === 'id' && ['key', 'issue', 'issue_key'].includes(col))));
  if (missing.length) out.notes.unshift(`Missing expected column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
  return out;
}

export const acceptedCount = (d: ImportedDataset) => d.metrics.length + d.issues.length + d.releases.length + d.feedback.length;
