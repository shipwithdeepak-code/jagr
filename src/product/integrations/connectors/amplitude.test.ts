import { describe, expect, it } from 'vitest';
import type { Connection } from '../../ports/persistence';
import { manualClock } from '../../ports/clock';
import { createMemoryPersistence, createMemorySecretStore } from '../../ports/memory';
import { runWatchJob, sourcesForRun } from '../../app/monitoring';
import { watchFromTemplate } from '../../catalog';
import { connectorContract, scriptedHttp, type Reply } from '../../testkit/connectorContract';
import { amplitudeConnector, seasonalBaseline } from './amplitude';
import { connectorFactory } from './runtime';
import { connectorsFrom } from './index';
import type { ConnectorDescriptor } from './types';

/**
 * Amplitude connector against responses in the Dashboard REST API's documented shape
 * (events/segmentation with hourly interval; annotations). Synthesised fixtures, not a live
 * recording: the live check is scripts/eval/connectors.live.ts.
 */

const NOW = '2026-09-25T06:00:00.000Z';
const HOUR = 3_600_000;
const pad = (n: number) => String(n).padStart(2, '0');
const local = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:00:00`;
};

/** Hourly buckets from 8 days before NOW through the current (incomplete) hour. */
const HOURS = Array.from({ length: 8 * 24 + 1 }, (_, i) => Date.parse(NOW) - 8 * 24 * HOUR + i * HOUR);
const diurnal = (ms: number) => 1 + 0.5 * Math.sin(((new Date(ms).getUTCHours() - 6) / 24) * 2 * Math.PI);
const started = (ms: number, platform?: 'iOS' | 'Android') => Math.round(200 * diurnal(ms) * (platform ? 0.5 : 1));
/** Conversion ~30%; iOS drops to ~15% for the last 4 complete hours (02:00–05:00). */
const dropped = (ms: number) => ms >= Date.parse(NOW) - 4 * HOUR && ms < Date.parse(NOW);
const completed = (ms: number, platform?: 'iOS' | 'Android'): number => {
  if (platform === 'iOS') return Math.round(started(ms, 'iOS') * (dropped(ms) ? 0.15 : 0.3));
  if (platform === 'Android') return Math.round(started(ms, 'Android') * 0.3);
  return completed(ms, 'iOS') + completed(ms, 'Android');
};

function segmentation(u: URL): Reply {
  const e = JSON.parse(u.searchParams.get('e') ?? '{}') as { event_type: string };
  const g = u.searchParams.get('g');
  const value = (ms: number, p?: 'iOS' | 'Android') => (e.event_type === 'Order Completed' ? completed(ms, p) : e.event_type === 'Checkout Started' ? started(ms, p) : 0);
  if (g === 'platform')
    return { body: { data: { series: [HOURS.map((h) => value(h, 'iOS')), HOURS.map((h) => value(h, 'Android'))], seriesLabels: [[0, 'iOS'], [1, 'Android']], xValues: HOURS.map(local) } } };
  return { body: { data: { series: [HOURS.map((h) => value(h))], seriesLabels: [0], xValues: HOURS.map(local) } } };
}

const ANNOTATIONS = {
  data: [
    { id: 11, start: '2026-09-25T01:40:00Z', label: 'Checkout v2 rollout 100%', details: 'owner: payments team (pay@acme.test)' },
    { id: 12, date: '2026-09-25', label: 'Pricing page copy change' },
    { id: 13, start: '2026-09-25T09:00:00Z', label: 'Future annotation' },
    { id: 14, date: '2026-09-10', label: 'Old annotation' },
  ],
};

const route = (u: URL): Reply | undefined => {
  if (u.hostname !== 'amplitude.com') return undefined;
  if (u.pathname === '/api/2/events/segmentation') return segmentation(u);
  if (u.pathname === '/api/2/annotations') return { body: ANNOTATIONS };
  return undefined;
};

const CONFIG = {
  region: 'us',
  metrics: [
    { kind: 'ratio', key: 'checkout_conversion', name: 'Checkout conversion', area: 'checkout', numerator: { event_type: 'Order Completed' }, denominator: { event_type: 'Checkout Started' }, badDirection: 'down', threshold: 10 },
    { kind: 'count', key: 'checkouts_started', name: 'Checkouts started', area: 'checkout', event: { event_type: 'Checkout Started' }, measure: 'uniques', badDirection: 'down', threshold: 30 },
  ],
  dimensions: { platform: 'platform' },
  appUrl: 'https://app.amplitude.com/analytics/acme',
};

const connection: Connection = {
  id: 'owner-amplitude',
  workspaceId: 'ws-1',
  source: 'amplitude',
  provider: 'amplitude',
  roles: ['metrics', 'changes'],
  authKind: 'owner_env',
  state: 'connected',
  detail: 'Amplitude',
  config: CONFIG,
  updatedAt: '2026-09-24T00:00:00.000Z',
};
const secret = { kind: 'api_key' as const, fields: { apiKey: 'amp_api_key_111111', secretKey: 'amp_secret_key_222222' } };
const window = { start: '2026-09-24T06:00:00.000Z', end: NOW };

connectorContract({
  name: 'Amplitude',
  descriptor: amplitudeConnector,
  connection,
  secret,
  otherSecret: { kind: 'api_key', fields: { apiKey: 'amp_api_key_999999', secretKey: 'amp_secret_key_888888' } },
  route,
  window,
  expectRecords: { metrics: 2, changes: 2 },
  invalidConfigs: [
    { ...CONFIG, metrics: [] },
    { ...CONFIG, appUrl: 'https://evil.example.com' },
    { ...CONFIG, region: 'moon' },
    { ...CONFIG, metrics: 'not json' },
    { ...CONFIG, metrics: [CONFIG.metrics[0], CONFIG.metrics[0]] },
  ],
});

const build = (http = scriptedHttp(route).http) => connectorFactory(amplitudeConnector)(connection, { secret, http, clock: manualClock(NOW) });

describe('Amplitude mapping', () => {
  it('ratio metrics: percent per complete hour, the current hour excluded, seasonal baseline', async () => {
    const s = (await build().metrics!.getSeries({ metric: 'checkout_conversion', window }))!;
    expect(s.unit).toBe('percent');
    expect(s.points.length).toBe(24);
    expect(s.points[s.points.length - 1].t).toBe('2026-09-25T05:00:00.000Z');
    expect(s.points[0].value).toBeCloseTo(30, 0);
    expect(s.points[s.points.length - 1].value).toBeLessThan(25);
    expect(s.baseline.mean).toBeCloseTo(30, 0);
    expect(s.baseline.window).toMatch(/Same hours on the previous 7 days/);
    expect(s.provenance).toMatchObject({ mode: 'connected', provider: 'amplitude', url: 'https://app.amplitude.com/analytics/acme' });
  });

  it('sends Basic auth, an hourly interval and the event definition', async () => {
    const { http, calls } = scriptedHttp(route);
    await build(http).metrics!.getSeries({ metric: 'checkouts_started', window });
    const u = new URL(calls[0].url);
    expect(u.searchParams.get('i')).toBe('-3600000');
    expect(u.searchParams.get('m')).toBe('uniques');
    expect(u.searchParams.get('start')).toBe('20260917');
    expect(u.searchParams.get('end')).toBe('20260925');
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('amp_api_key_111111:amp_secret_key_222222').toString('base64')}`);
  });

  it('breakdowns by configured dimensions; unknown dimensions are not offered', async () => {
    const src = build();
    expect(src.metrics!.listDimensions('checkout_conversion')).toEqual(['platform']);
    const segs = await src.metrics!.getBreakdown({ metric: 'checkout_conversion', window, dimension: 'platform' });
    const ios = segs.find((x) => x.segment === 'iOS')!;
    const android = segs.find((x) => x.segment === 'Android')!;
    expect(ios.series.points[ios.series.points.length - 1].value).toBeCloseTo(15, 0);
    expect(android.series.points[android.series.points.length - 1].value).toBeCloseTo(30, 0);
    expect(await src.metrics!.getBreakdown({ metric: 'checkout_conversion', window, dimension: 'country' })).toEqual([]);
  });

  it('annotations: timed → reported; date-only → day precision, never timing evidence; future and old excluded; emails removed', async () => {
    const changes = await build().changes!.getChanges({ window });
    expect(changes.map((c) => [c.title, c.timing])).toEqual([
      ['Checkout v2 rollout 100%', 'reported'],
      ['Pricing page copy change', 'planned'],
    ]);
    expect(changes[1].notes).toMatch(/precision: day/);
    expect(JSON.stringify(changes)).not.toContain('pay@acme.test');
  });

  it('seasonal baseline falls back (labelled) on short history', () => {
    const pts = Array.from({ length: 6 }, (_, i) => ({ t: new Date(Date.parse(NOW) - (6 - i) * HOUR).toISOString(), value: 10 }));
    expect(seasonalBaseline(pts, 4).window).toMatch(/short history/);
  });
});

describe('Amplitude in a connected workspace (end to end, no sample data)', () => {
  it('a scheduled watch run detects the drop from Amplitude and cites it as connected evidence', async () => {
    const { repos, tx } = createMemoryPersistence();
    const secrets = createMemorySecretStore();
    const clock = manualClock(NOW);
    await repos.workspaces.create({ id: 'ws-1', name: 'Acme', mode: 'connected', createdAt: NOW, settings: { planner: 'deterministic', aiEgressAllowed: false, timezone: 'UTC' }, brief: { enabled: true, time: '08:00', timezone: 'UTC' }, importedExportIds: [], version: 1 });
    const ref = await secrets.put({ workspaceId: 'ws-1', connectionId: connection.id }, secret);
    await repos.connections.save('ws-1', { ...connection, secretRef: ref });
    const deps = { repos, tx, secrets, clock, http: scriptedHttp(route).http, connectors: connectorsFrom([amplitudeConnector as ConnectorDescriptor<unknown>]) };

    const run = await sourcesForRun(deps, (await repos.workspaces.get('ws-1'))!, NOW);
    const watch = watchFromTemplate('w-checkout', 'checkout_health', { sources: ['amplitude'], metricKeys: run.registry.metrics().map((m) => m.def.key) }, NOW);
    expect(watch.signals.map((s) => s.key)).toContain('metric:checkout_conversion');
    await repos.watches.save('ws-1', watch);

    const summary = await runWatchJob(deps, { workspaceId: 'ws-1', payload: { watchId: 'w-checkout', dueAt: NOW } });
    expect(summary.investigations).toBeGreaterThan(0);
    const inv = (await repos.investigations.list('ws-1'))[0];
    expect(inv.signals[0].key).toBe('metric:checkout_conversion');
    const text = JSON.stringify(inv);
    expect(text).not.toMatch(/SIMULATED|[Ss]ample night|[Ss]imulated source/);
    expect(inv.sourceLinks.every((l) => !l.simulated)).toBe(true);
    // The rollout annotation (timed) is change evidence; the date-only one never claims timing.
    expect(text).toContain('Checkout v2 rollout 100%');
  });
});
