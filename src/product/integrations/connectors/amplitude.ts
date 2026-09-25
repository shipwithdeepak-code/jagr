import { z } from 'zod';
import type { Area } from '../../types.js';
import type { ChangeRecord, MetricDefinition, MetricPoint, MetricSeries, SegmentSeries, TimeWindow } from '../../roles/types.js';
import type { ConnectorContext, ConnectorDescriptor, ReadStamp } from './types.js';
import { basicAuth, requestJson } from './http.js';
import { provenance } from './runtime.js';
import { redactPersonalData } from './redact.js';
import { ProviderUnavailableError } from '../types.js';

/**
 * Amplitude — MetricSource (event segmentation) and ChangeSource (chart annotations).
 * Dashboard REST API, HTTP Basic auth with the project's API key + secret key. Read-only.
 *
 *   GET /api/2/events/segmentation   hourly totals / uniques, optionally grouped by a property
 *   GET /api/2/annotations           chart annotations
 *
 * Metrics are configured per workspace ("bindings"): a count of one event, or a ratio of two
 * (numerator / denominator uniques, as a percentage). Each series is read hourly over the run's
 * window plus the previous 7 days; its baseline is the same hours of day on those 7 days, so daily
 * rhythm is not mistaken for a drop. Only complete hours are returned.
 *
 * Known limitations (surfaced, not hidden):
 *   - Amplitude buckets hours in the project's timezone. Set `utcOffsetMinutes` to match it (DST is
 *     not modelled — a project in a DST timezone is one hour off for half the year; UTC projects are exact).
 *   - Hourly buckets: a sustained drop is detected after ~3 complete hours (detection needs 3 of the
 *     last 4 buckets degraded).
 *   - Date-only annotations have day precision: they are change evidence with `planned`-strength
 *     timing (shown, never used to claim a timing association). Annotations with a time are `reported`.
 */

const EventSpec = z
  .object({
    event_type: z.string().min(1),
    filters: z.array(z.object({ subprop_type: z.enum(['event', 'user']), subprop_key: z.string().min(1), subprop_op: z.string().min(1), subprop_value: z.array(z.string()) }).strict()).optional(),
  })
  .strict();

const AREAS = ['checkout', 'signup', 'search', 'stability', 'general'] as const;

const Common = {
  key: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/),
  name: z.string().min(1).max(80),
  area: z.enum(AREAS).default('general'),
  badDirection: z.enum(['down', 'up']),
  threshold: z.number().positive().max(100),
  platform: z.enum(['ios', 'android', 'web']).optional(),
};

const Binding = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('count'), event: EventSpec, measure: z.enum(['totals', 'uniques']).default('totals'), ...Common }).strict(),
  z.object({ kind: z.literal('ratio'), numerator: EventSpec, denominator: EventSpec, ...Common }).strict(),
]);
export type AmplitudeBinding = z.infer<typeof Binding>;

export const AmplitudeConfig = z
  .object({
    region: z.enum(['us', 'eu']).default('us'),
    metrics: z.array(Binding).min(1).max(25),
    /** Workspace dimension → Amplitude property used for breakdowns. */
    dimensions: z.record(z.string().regex(/^[a-z_]{1,40}$/), z.string().min(1).max(80)).default({ platform: 'platform', app_version: 'version', country: 'country' }),
    utcOffsetMinutes: z.number().int().min(-720).max(840).default(0),
    /** Link target for evidence, e.g. https://app.amplitude.com/analytics/your-org */
    appUrl: z
      .string()
      .regex(/^https:\/\/(app|analytics\.eu)\.amplitude\.com(\/[\w./-]*)?$/)
      .default('https://app.amplitude.com'),
    annotations: z.boolean().default(true),
  })
  .strict()
  .superRefine((c, ctx) => {
    const keys = c.metrics.map((m) => m.key);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'metric keys must be unique', path: ['metrics'] });
  });
export type AmplitudeConfig = z.infer<typeof AmplitudeConfig>;

const HOST = { us: 'amplitude.com', eu: 'analytics.eu.amplitude.com' } as const;
const HOUR = 3_600_000;
const BASELINE_DAYS = 7;

interface SegmentationResponse {
  data?: { series?: number[][]; seriesLabels?: unknown[]; xValues?: string[] };
}
interface AnnotationsResponse {
  data?: { id: number | string; date?: string; start?: string; label?: string; details?: string }[];
}

const pad = (n: number) => String(n).padStart(2, '0');
/** YYYYMMDD of an instant, in the project's timezone. */
function projectDate(ms: number, offsetMin: number): string {
  const d = new Date(ms + offsetMin * 60_000);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}
/** Amplitude's local "2026-09-24T10:00:00" (project timezone) → UTC ISO. */
function bucketToIso(x: string, offsetMin: number): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(x);
  if (!m) return undefined;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)) - offsetMin * 60_000;
  return new Date(ms).toISOString();
}
const labelOf = (l: unknown): string => (Array.isArray(l) ? String(l[l.length - 1]) : String(l ?? ''));

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Baseline for the latest buckets: the same hours of day on the previous days. Falls back to the
 * median of all earlier points (labelled) when history is short.
 */
export function seasonalBaseline(all: MetricPoint[], recentCount: number, days = BASELINE_DAYS): MetricSeries['baseline'] {
  const byT = new Map(all.map((p) => [Date.parse(p.t), p.value]));
  const recent = all.slice(-recentCount);
  const same: number[] = [];
  for (const p of recent) for (let d = 1; d <= days; d++) {
    const v = byT.get(Date.parse(p.t) - d * 24 * HOUR);
    if (v !== undefined) same.push(v);
  }
  let values = same;
  let window = `Same hours on the previous ${days} days (${same.length} readings)`;
  if (same.length < Math.max(3, recent.length * 2)) {
    values = all.slice(0, Math.max(1, all.length - recentCount)).map((p) => p.value);
    window = `Median of the ${values.length} earlier hourly readings (short history — less reliable)`;
  }
  const mean = values.length ? median(values) : 0;
  const sd = values.length > 1 ? Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1)) : 0;
  return { mean, stdDev: Math.max(sd, 0.01 * Math.abs(mean), 1e-9), window };
}

function eventParam(e: z.infer<typeof EventSpec>): string {
  return JSON.stringify({ event_type: e.event_type, ...(e.filters?.length ? { filters: e.filters } : {}) });
}

class AmplitudeReader {
  constructor(private readonly ctx: ConnectorContext<AmplitudeConfig>) {}

  private stamp(): ReadStamp {
    return { connectionId: this.ctx.connection.id, provider: 'amplitude', source: 'amplitude', fetchedAt: this.ctx.clock.now() };
  }
  private get auth() {
    const s = this.ctx.secret;
    if (s.kind !== 'api_key' || !s.fields.apiKey || !s.fields.secretKey) throw new ProviderUnavailableError('amplitude', 'error', 'Amplitude credential is incomplete (API key and secret key).');
    return basicAuth(s.fields.apiKey, s.fields.secretKey);
  }
  private url(path: string, params: [string, string][]): string {
    const u = new URL(`https://${HOST[this.ctx.config.region]}${path}`);
    for (const [k, v] of params) u.searchParams.append(k, v);
    return u.toString();
  }
  private get(path: string, params: [string, string][]) {
    return requestJson<unknown>(this.ctx.http, 'amplitude', 'Amplitude', this.url(path, params), { headers: { authorization: this.auth, accept: 'application/json' } });
  }

  /** One segmentation call → labelled hourly series (complete hours only, up to `end`). */
  async segmentation(event: z.infer<typeof EventSpec>, measure: 'totals' | 'uniques', window: TimeWindow, groupBy?: string): Promise<Map<string, MetricPoint[]>> {
    const off = this.ctx.config.utcOffsetMinutes;
    const endMs = Math.min(Date.parse(window.end), Date.parse(this.ctx.clock.now()));
    const startMs = Date.parse(window.start) - BASELINE_DAYS * 24 * HOUR;
    const params: [string, string][] = [
      ['e', eventParam(event)],
      ['m', measure],
      ['i', '-3600000'],
      ['start', projectDate(startMs, off)],
      ['end', projectDate(endMs, off)],
    ];
    if (groupBy) params.push(['g', groupBy], ['limit', '20']);
    const body = (await this.get('/api/2/events/segmentation', params)) as SegmentationResponse;
    const d = body?.data;
    if (!d || !Array.isArray(d.series) || !Array.isArray(d.xValues)) throw new ProviderUnavailableError('amplitude', 'error', 'Amplitude returned a segmentation Jagr could not read.');
    const times = d.xValues.map((x) => bucketToIso(x, off));
    const out = new Map<string, MetricPoint[]>();
    d.series.forEach((row, i) => {
      const pts: MetricPoint[] = [];
      row.forEach((v, j) => {
        const t = times[j];
        // Complete hours only: the bucket must have ended by the read time.
        if (!t || typeof v !== 'number' || !Number.isFinite(v) || Date.parse(t) + HOUR > endMs || Date.parse(t) < startMs) return;
        pts.push({ t, value: v });
      });
      out.set(groupBy ? labelOf(d.seriesLabels?.[i]) : '', pts);
    });
    return out;
  }

  /** Values of a binding, per group label. Ratios are numerator / denominator uniques, in percent. */
  async values(b: AmplitudeBinding, window: TimeWindow, groupBy?: string): Promise<Map<string, MetricPoint[]>> {
    if (b.kind === 'count') return this.segmentation(b.event, b.measure, window, groupBy);
    const [num, den] = await Promise.all([this.segmentation(b.numerator, 'uniques', window, groupBy), this.segmentation(b.denominator, 'uniques', window, groupBy)]);
    const out = new Map<string, MetricPoint[]>();
    for (const [label, dpts] of den) {
      const n = new Map((num.get(label) ?? []).map((p) => [p.t, p.value]));
      out.set(
        label,
        dpts.filter((p) => p.value > 0).map((p) => ({ t: p.t, value: Math.round(((n.get(p.t) ?? 0) / p.value) * 10_000) / 100 })),
      );
    }
    return out;
  }

  series(b: AmplitudeBinding, all: MetricPoint[], window: TimeWindow, segment?: string): MetricSeries {
    const pts = all.filter((p) => p.t >= window.start && p.t <= window.end);
    const last = pts[pts.length - 1]?.t ?? window.end;
    const id = segment ? `${b.key}:${segment}` : b.key;
    return {
      ...definition(b),
      source: 'amplitude',
      ref: { provider: 'amplitude', kind: 'metric', id },
      provenance: provenance(this.stamp(), id, last, this.ctx.config.appUrl),
      baseline: seasonalBaseline(all, 4),
      points: pts,
    };
  }

  async annotations(window: TimeWindow): Promise<ChangeRecord[]> {
    const body = (await this.get('/api/2/annotations', [])) as AnnotationsResponse;
    if (!body || !Array.isArray(body.data)) throw new ProviderUnavailableError('amplitude', 'error', 'Amplitude returned annotations Jagr could not read.');
    const stamp = this.stamp();
    const off = this.ctx.config.utcOffsetMinutes;
    const out: ChangeRecord[] = [];
    for (const a of body.data) {
      const timed = typeof a.start === 'string' && /T\d{2}:\d{2}/.test(a.start);
      const at = timed ? new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(a.start!) ? a.start! : `${a.start}Z`).toISOString() : a.date ? bucketToIso(a.date, off) : undefined;
      if (!at || Number.isNaN(Date.parse(at)) || at < window.start || at > window.end) continue;
      const id = String(a.id);
      out.push({
        id: `amplitude-annotation-${id}`,
        source: 'amplitude',
        kind: 'annotation',
        timing: timed ? 'reported' : 'planned',
        title: redactPersonalData(a.label ?? 'Annotation').slice(0, 200),
        at,
        notes: [a.details ? redactPersonalData(a.details).slice(0, 500) : undefined, timed ? undefined : 'precision: day (Amplitude annotation has a date, not a time)'].filter(Boolean).join(' · ') || undefined,
        ref: { provider: 'amplitude', kind: 'release', id: `annotation-${id}` },
        provenance: provenance(stamp, `annotation-${id}`, at, this.ctx.config.appUrl),
      });
    }
    return out;
  }
}

function definition(b: AmplitudeBinding): MetricDefinition {
  return {
    key: b.key,
    name: b.name,
    unit: b.kind === 'ratio' ? 'percent' : 'count',
    area: b.area as Area,
    badDirection: b.badDirection,
    mode: 'relative',
    threshold: b.threshold,
    ...(b.platform ? { platform: b.platform } : {}),
  };
}

export const amplitudeConnector: ConnectorDescriptor<AmplitudeConfig> = {
  id: 'amplitude',
  source: 'amplitude',
  name: 'Amplitude',
  roles: ['metrics', 'changes'],
  config: AmplitudeConfig as unknown as z.ZodType<AmplitudeConfig>,
  secretKinds: ['api_key'],
  credentialFields: [{ key: 'apiKey', label: 'API key' }, { key: 'secretKey', label: 'Secret key' }],
  hosts: (cfg) => [HOST[cfg.region]],
  build(ctx) {
    const r = new AmplitudeReader(ctx);
    const find = (key: string) => ctx.config.metrics.find((m) => m.key === key);
    return {
      metrics: {
        metricDefinitions: () => ctx.config.metrics.map(definition),
        listDimensions: (key) => (find(key) ? Object.keys(ctx.config.dimensions) : []),
        async getSeries({ metric, window }) {
          const b = find(metric);
          if (!b) return null;
          const all = (await r.values(b, window)).get('') ?? [];
          return r.series(b, all, window);
        },
        async getBreakdown({ metric, window, dimension }): Promise<SegmentSeries[]> {
          const b = find(metric);
          const prop = ctx.config.dimensions[dimension];
          if (!b || !prop) return [];
          const groups = await r.values(b, window, prop);
          return [...groups].filter(([label]) => label !== '').map(([segment, all]) => ({ dimension, segment, series: r.series(b, all, window, segment) }));
        },
      },
      changes: ctx.config.annotations ? { tracksRollout: false, getChanges: ({ window }) => r.annotations(window) } : undefined,
    };
  },
  async check(ctx) {
    await new AmplitudeReader(ctx).annotations({ start: ctx.clock.now(), end: ctx.clock.now() });
    return { state: 'connected', detail: `Amplitude (${ctx.config.region.toUpperCase()}) · ${ctx.config.metrics.length} metric(s) configured` };
  },
};
