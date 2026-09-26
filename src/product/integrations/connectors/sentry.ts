import { z } from 'zod';
import type { Area } from '../../types.js';
import type { ChangeRecord, ChangeTiming, MetricDefinition, MetricPoint, MetricSeries, TimeWindow, WorkItem } from '../../roles/types.js';
import type { ConnectorContext, ConnectorDescriptor, ReadStamp } from './types.js';
import { requestJson } from './http.js';
import { provenance } from './runtime.js';
import { redactPersonalData } from './redact.js';
import { seasonalBaseline } from './amplitude.js';
import { ProviderUnavailableError } from '../types.js';

/**
 * Sentry — error and crash telemetry as a MetricSource, ChangeSource (releases) and WorkItemSource
 * (issues). Sentry REST API with an organization auth token (read-only scopes: org:read,
 * project:read, event:read). Read-only.
 *
 *   GET /api/0/organizations/{org}/events-stats/   hourly error events (or affected users) for a query
 *   GET /api/0/organizations/{org}/sessions/       hourly crash-free session (or user) rate
 *   GET /api/0/organizations/{org}/releases/       releases, with their last deploy
 *   GET /api/0/organizations/{org}/issues/         issues first seen in the window (new or regressed)
 *
 * Only the minimum is normalized into the neutral role records: counts, crash-free rate, issue id /
 * title / first and last seen / events / users, release version / environment / time, and a link.
 * Stack traces, event payloads and user identities are never read.
 *
 * Metrics are configured per workspace:
 *   errors      events (or unique users) matching a Sentry search query — bad when it goes UP (relative %)
 *   crash_free  crash-free session (or user) rate in percent — bad when it goes DOWN (absolute points)
 * Each series is hourly over the run's window plus the previous 7 days; the baseline is the same hours
 * of day on those days (as for Amplitude), so daily rhythm is not mistaken for a spike.
 *
 * Release timing (what the investigation may use to associate a change with a degradation):
 *   actual    a deploy of the release finished (lastDeploy.dateFinished) — it reached an environment
 *   reported  the release has a release date (dateReleased)
 *   planned   only its creation time is known — which says nothing about when it reached users
 */

const AREAS = ['checkout', 'signup', 'search', 'stability', 'general'] as const;
const Key = z.string().regex(/^[a-z][a-z0-9_]{1,60}$/);

const Binding = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('errors'),
      key: Key,
      name: z.string().min(1).max(80),
      area: z.enum(AREAS).default('stability'),
      /** A Sentry search query, e.g. "transaction:/checkout*" or "level:error". Empty = all errors. */
      query: z.string().max(200).default(''),
      measure: z.enum(['events', 'users']).default('events'),
      /** Rise, in %, over the baseline that counts as a spike. */
      threshold: z.number().positive().max(1000),
      platform: z.enum(['ios', 'android', 'web']).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('crash_free'),
      key: Key,
      name: z.string().min(1).max(80),
      of: z.enum(['session', 'user']).default('session'),
      /** Fall, in percentage points, that counts as a regression (e.g. 0.5). */
      threshold: z.number().positive().max(100),
      platform: z.enum(['ios', 'android', 'web']).optional(),
    })
    .strict(),
]);
export type SentryBinding = z.infer<typeof Binding>;

export const SentryConfig = z
  .object({
    region: z.enum(['us', 'de']).default('us'),
    organization: z.string().regex(/^[a-z0-9][a-z0-9-]{0,49}$/),
    /** Numeric Sentry project ids. */
    projects: z.array(z.number().int().positive()).min(1).max(10),
    environment: z.string().regex(/^[\w.-]{1,64}$/).optional(),
    metrics: z.array(Binding).min(1).max(15),
    releases: z.boolean().default(true),
    issues: z.boolean().default(true),
  })
  .strict()
  .superRefine((c, ctx) => {
    const keys = c.metrics.map((m) => m.key);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'metric keys must be unique', path: ['metrics'] });
  });
export type SentryConfig = z.infer<typeof SentryConfig>;

const HOST = { us: 'sentry.io', de: 'de.sentry.io' } as const;
const HOUR = 3_600_000;
const BASELINE_DAYS = 7;

// ─────────────────────────────────────────────────────────────
// Normalization — pure, one function per API response. Exported for tests.
// ─────────────────────────────────────────────────────────────

const iso = (ms: number) => new Date(ms).toISOString();

/** events-stats `{ data: [[unixSeconds, [{ count }]], …] }` → complete hourly points up to `endMs`. */
export function normalizeEventsStats(body: unknown, startMs: number, endMs: number): MetricPoint[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new ProviderUnavailableError('sentry', 'error', 'Sentry returned event stats Jagr could not read.');
  const out: MetricPoint[] = [];
  for (const row of data) {
    if (!Array.isArray(row) || typeof row[0] !== 'number' || !Array.isArray(row[1])) continue;
    const ms = row[0] * 1000;
    const value = (row[1] as { count?: unknown }[]).reduce((a, c) => a + (typeof c?.count === 'number' && Number.isFinite(c.count) ? c.count : 0), 0);
    // Complete hours only: the bucket must have ended by the read time.
    if (ms < startMs || ms + HOUR > endMs) continue;
    out.push({ t: iso(ms), value });
  }
  return out;
}

/** sessions `{ intervals: [iso…], groups: [{ series: { field: [rate 0–1 | null …] } }] }` → percent points. */
export function normalizeSessions(body: unknown, field: string, startMs: number, endMs: number): MetricPoint[] {
  const b = body as { intervals?: unknown; groups?: { series?: Record<string, unknown> }[] };
  const values = b?.groups?.[0]?.series?.[field];
  if (!Array.isArray(b?.intervals) || !Array.isArray(values)) throw new ProviderUnavailableError('sentry', 'error', 'Sentry returned session health Jagr could not read.');
  const out: MetricPoint[] = [];
  (b.intervals as unknown[]).forEach((t, i) => {
    const v = values[i];
    const ms = typeof t === 'string' ? Date.parse(t) : NaN;
    // A null rate means no sessions in that hour — no reading, not a 0% crash-free hour.
    if (!Number.isFinite(ms) || typeof v !== 'number' || !Number.isFinite(v) || ms < startMs || ms + HOUR > endMs) return;
    out.push({ t: iso(ms), value: Math.round(v * 100_000) / 1000 });
  });
  return out;
}

export interface SentryRelease {
  version: string;
  at: string;
  timing: ChangeTiming;
  environment?: string;
}

/** releases `[{ version, dateCreated, dateReleased, lastDeploy: { dateFinished, environment } }]` → timed releases. */
export function normalizeReleases(body: unknown): SentryRelease[] {
  if (!Array.isArray(body)) throw new ProviderUnavailableError('sentry', 'error', 'Sentry returned releases Jagr could not read.');
  const out: SentryRelease[] = [];
  for (const r of body as { version?: unknown; dateCreated?: unknown; dateReleased?: unknown; lastDeploy?: { dateFinished?: unknown; environment?: unknown } | null }[]) {
    if (typeof r?.version !== 'string' || !r.version) continue;
    const deployed = typeof r.lastDeploy?.dateFinished === 'string' ? r.lastDeploy.dateFinished : undefined;
    const released = typeof r.dateReleased === 'string' ? r.dateReleased : undefined;
    const created = typeof r.dateCreated === 'string' ? r.dateCreated : undefined;
    const [at, timing]: [string | undefined, ChangeTiming] = deployed ? [deployed, 'actual'] : released ? [released, 'reported'] : [created, 'planned'];
    if (!at || Number.isNaN(Date.parse(at))) continue;
    out.push({ version: r.version, at: iso(Date.parse(at)), timing, environment: typeof r.lastDeploy?.environment === 'string' ? r.lastDeploy.environment : undefined });
  }
  return out;
}

export interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  level: string;
  events: number;
  users: number;
  firstSeen: string;
  lastSeen: string;
  url?: string;
}

/** issues `[{ id, shortId, title, level, count, userCount, firstSeen, lastSeen, permalink }]` → issues. */
export function normalizeIssues(body: unknown): SentryIssue[] {
  if (!Array.isArray(body)) throw new ProviderUnavailableError('sentry', 'error', 'Sentry returned issues Jagr could not read.');
  const out: SentryIssue[] = [];
  for (const i of body as Record<string, unknown>[]) {
    if (typeof i?.id !== 'string' || typeof i.firstSeen !== 'string' || Number.isNaN(Date.parse(i.firstSeen))) continue;
    const permalink = typeof i.permalink === 'string' && /^https:\/\/([a-z0-9-]+\.)*sentry\.io\//.test(i.permalink) ? i.permalink : undefined;
    out.push({
      id: i.id,
      shortId: typeof i.shortId === 'string' ? i.shortId : i.id,
      // Titles can carry values from the failing request — redact personal data before storing anything.
      title: redactPersonalData(typeof i.title === 'string' ? i.title : 'Sentry issue').slice(0, 200),
      level: typeof i.level === 'string' ? i.level : 'error',
      events: Number(i.count) || 0,
      users: Number(i.userCount) || 0,
      firstSeen: iso(Date.parse(i.firstSeen)),
      lastSeen: typeof i.lastSeen === 'string' && !Number.isNaN(Date.parse(i.lastSeen)) ? iso(Date.parse(i.lastSeen)) : iso(Date.parse(i.firstSeen)),
      url: permalink,
    });
  }
  return out;
}

const PRIORITY: Record<string, WorkItem['priority']> = { fatal: 'critical', error: 'high', warning: 'medium' };

// ─────────────────────────────────────────────────────────────
// Reader
// ─────────────────────────────────────────────────────────────

class SentryReader {
  constructor(private readonly ctx: ConnectorContext<SentryConfig>) {}

  private stamp(): ReadStamp {
    return { connectionId: this.ctx.connection.id, provider: 'sentry', source: 'sentry', fetchedAt: this.ctx.clock.now() };
  }
  private get token() {
    const s = this.ctx.secret;
    if (s.kind !== 'api_key' || !s.fields.authToken) throw new ProviderUnavailableError('sentry', 'error', 'Sentry credential is incomplete (auth token).');
    return s.fields.authToken;
  }
  private url(path: string, params: [string, string][]): string {
    const c = this.ctx.config;
    const u = new URL(`https://${HOST[c.region]}/api/0/organizations/${c.organization}${path}`);
    for (const p of c.projects) u.searchParams.append('project', String(p));
    if (c.environment) u.searchParams.append('environment', c.environment);
    for (const [k, v] of params) u.searchParams.append(k, v);
    return u.toString();
  }
  private get(path: string, params: [string, string][]) {
    return requestJson<unknown>(this.ctx.http, 'sentry', 'Sentry', this.url(path, params), { headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' } });
  }
  /** Web link for evidence (the organization's own Sentry, never the API host). */
  private web(path: string): string {
    return `https://${this.ctx.config.organization}.sentry.io${path}`;
  }
  private range(window: TimeWindow) {
    const endMs = Math.min(Date.parse(window.end), Date.parse(this.ctx.clock.now()));
    const startMs = Date.parse(window.start) - BASELINE_DAYS * 24 * HOUR;
    return { startMs, endMs, params: [['start', iso(startMs)], ['end', iso(endMs)], ['interval', '1h']] as [string, string][] };
  }

  async points(b: SentryBinding, window: TimeWindow): Promise<MetricPoint[]> {
    const { startMs, endMs, params } = this.range(window);
    if (b.kind === 'errors') {
      const yAxis = b.measure === 'users' ? 'count_unique(user)' : 'count()';
      const body = await this.get('/events-stats/', [...params, ['yAxis', yAxis], ['query', b.query]]);
      return normalizeEventsStats(body, startMs, endMs);
    }
    const field = `crash_free_rate(${b.of})`;
    const body = await this.get('/sessions/', [...params, ['field', field]]);
    return normalizeSessions(body, field, startMs, endMs);
  }

  series(b: SentryBinding, all: MetricPoint[], window: TimeWindow): MetricSeries {
    const pts = all.filter((p) => p.t >= window.start && p.t <= window.end);
    const last = pts[pts.length - 1]?.t ?? window.end;
    const baseline = seasonalBaseline(all, 4);
    // A quiet error stream has a near-zero baseline: floor it at one event per hour, so the first few
    // errors are a large relative rise, not an infinite one.
    if (b.kind === 'errors' && baseline.mean < 1) baseline.mean = 1;
    const link = b.kind === 'errors' ? this.web(`/issues/?project=${this.ctx.config.projects.join('&project=')}${b.query ? `&query=${encodeURIComponent(b.query)}` : ''}`) : this.web(`/releases/?project=${this.ctx.config.projects.join('&project=')}`);
    return { ...definition(b), source: 'sentry', ref: { provider: 'sentry', kind: 'metric', id: b.key }, provenance: provenance(this.stamp(), b.key, last, link), baseline, points: pts };
  }

  async releases(window: TimeWindow): Promise<ChangeRecord[]> {
    const body = await this.get('/releases/', [['per_page', '50']]);
    const stamp = this.stamp();
    const endMs = Math.min(Date.parse(window.end), Date.parse(this.ctx.clock.now()));
    return normalizeReleases(body)
      .filter((r) => r.at >= window.start && Date.parse(r.at) <= endMs)
      .map((r) => ({
        id: `sentry-release-${r.version}`,
        source: 'sentry' as const,
        kind: 'release' as const,
        timing: r.timing,
        title: `Release ${r.version}`.slice(0, 200),
        at: r.at,
        version: r.version,
        notes: [r.environment ? `deployed to ${r.environment}` : undefined, r.timing === 'planned' ? 'precision: created, not shipped (Sentry has no deploy or release date for it)' : undefined].filter(Boolean).join(' · ') || undefined,
        ref: { provider: 'sentry' as const, kind: 'release' as const, id: r.version },
        provenance: provenance(stamp, r.version, r.at, this.web(`/releases/${encodeURIComponent(r.version)}/`)),
      }));
  }

  async issues(window: TimeWindow): Promise<WorkItem[]> {
    const endMs = Math.min(Date.parse(window.end), Date.parse(this.ctx.clock.now()));
    const body = await this.get('/issues/', [['query', 'is:unresolved'], ['sort', 'freq'], ['limit', '25'], ['start', window.start], ['end', iso(endMs)]]);
    const stamp = this.stamp();
    return normalizeIssues(body)
      // New in the window only: an issue first seen before it is not evidence of a change now.
      .filter((i) => i.firstSeen >= window.start && Date.parse(i.firstSeen) <= endMs)
      .map((i) => ({
        id: i.shortId,
        source: 'sentry' as const,
        title: i.title,
        type: 'bug' as const,
        priority: PRIORITY[i.level] ?? 'low',
        status: `unresolved · ${i.events} events · ${i.users} users · last seen ${i.lastSeen}`,
        area: 'stability' as Area,
        labels: ['sentry', i.level],
        versions: [],
        createdAt: i.firstSeen,
        ref: { provider: 'sentry' as const, kind: 'issue' as const, id: i.shortId },
        provenance: provenance(stamp, i.shortId, i.firstSeen, i.url ?? this.web(`/issues/${i.id}/`)),
      }));
  }
}

function definition(b: SentryBinding): MetricDefinition {
  return b.kind === 'errors'
    ? { key: b.key, name: b.name, unit: 'count', area: b.area as Area, badDirection: 'up', mode: 'relative', threshold: b.threshold, telemetry: 'errors', ...(b.platform ? { platform: b.platform } : {}) }
    : { key: b.key, name: b.name, unit: 'percent', area: 'stability', badDirection: 'down', mode: 'absolute', threshold: b.threshold, telemetry: 'crash_free', ...(b.platform ? { platform: b.platform } : {}) };
}

export const sentryConnector: ConnectorDescriptor<SentryConfig> = {
  id: 'sentry',
  source: 'sentry',
  name: 'Sentry',
  roles: ['metrics', 'changes', 'work_items'],
  config: SentryConfig as unknown as z.ZodType<SentryConfig>,
  secretKinds: ['api_key'],
  credentialFields: [{ key: 'authToken', label: 'Auth token (org:read, project:read, event:read)' }],
  hosts: (cfg) => [HOST[cfg.region]],
  build(ctx) {
    const r = new SentryReader(ctx);
    const find = (key: string) => ctx.config.metrics.find((m) => m.key === key);
    return {
      metrics: {
        metricDefinitions: () => ctx.config.metrics.map(definition),
        listDimensions: () => [],
        async getSeries({ metric, window }) {
          const b = find(metric);
          if (!b) return null;
          return r.series(b, await r.points(b, window), window);
        },
        getBreakdown: async () => [],
      },
      changes: ctx.config.releases ? { tracksRollout: false, getChanges: ({ window }) => r.releases(window) } : undefined,
      work_items: ctx.config.issues ? { getWorkItems: ({ window }) => r.issues(window) } : undefined,
    };
  },
  async check(ctx) {
    const body = await requestJson<unknown>(ctx.http, 'sentry', 'Sentry', `https://${HOST[ctx.config.region]}/api/0/organizations/${ctx.config.organization}/projects/`, {
      headers: { authorization: `Bearer ${ctx.secret.kind === 'api_key' ? (ctx.secret.fields.authToken ?? '') : ''}`, accept: 'application/json' },
    });
    if (!Array.isArray(body)) throw new ProviderUnavailableError('sentry', 'error', 'Sentry returned projects Jagr could not read.');
    const ids = new Set((body as { id?: unknown }[]).map((p) => String(p?.id)));
    const missing = ctx.config.projects.filter((p) => !ids.has(String(p)));
    return {
      state: 'connected',
      detail: `Sentry (${ctx.config.organization}) · ${ctx.config.metrics.length} metric(s) configured`,
      account: ctx.config.organization,
      ...(missing.length ? { warnings: [`Project(s) ${missing.join(', ')} are not visible to this token.`] } : {}),
    };
  },
};
