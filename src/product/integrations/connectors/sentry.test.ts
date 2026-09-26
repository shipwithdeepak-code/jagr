import { describe, expect, it } from 'vitest';
import type { Connection } from '../../ports/persistence';
import type { SecretPayload } from '../../ports/secrets';
import { manualClock } from '../../ports/clock';
import { connectorContract, scriptedHttp } from '../../testkit/connectorContract';
import { checkConnector, connectorFactory } from './runtime';
import { normalizeEventsStats, normalizeIssues, normalizeReleases, normalizeSessions, sentryConnector } from './sentry';
import { ProviderUnavailableError } from '../types';
import { HOURS, sentryRoute } from './__fixtures__/sentry';

/** Sentry connector — recorded responses in the documented shapes of the Sentry REST API. */

const NOW = '2026-09-25T06:00:00.000Z';
const window = { start: '2026-09-24T18:00:00.000Z', end: NOW };
const CONFIG = {
  organization: 'acme',
  projects: [42],
  environment: 'production',
  metrics: [
    { kind: 'errors', key: 'checkout_errors', name: 'Checkout errors', area: 'checkout', query: 'transaction:/checkout*', threshold: 100 },
    { kind: 'crash_free', key: 'crash_free_sessions', name: 'Crash-free sessions', threshold: 0.5 },
  ],
};

const connection: Connection = { id: 'conn-sentry', workspaceId: 'ws-1', source: 'sentry', provider: 'sentry', roles: ['metrics', 'changes', 'work_items'], authKind: 'api_key', state: 'connected', detail: 'Sentry', config: CONFIG, updatedAt: NOW };

const secret: SecretPayload = { kind: 'api_key', fields: { authToken: 'sntrys_token_123456' } };

connectorContract({
  name: 'Sentry',
  descriptor: sentryConnector,
  connection,
  secret,
  otherSecret: { kind: 'api_key', fields: { authToken: 'sntrys_other_999999' } },
  route: sentryRoute,
  window,
  expectRecords: { metrics: 2, changes: 2, work_items: 1 },
  invalidConfigs: [
    { ...CONFIG, metrics: [] },
    { ...CONFIG, organization: 'Acme Corp' },
    { ...CONFIG, projects: ['web'] },
    { ...CONFIG, region: 'moon' },
    { ...CONFIG, metrics: [CONFIG.metrics[0], CONFIG.metrics[0]] },
  ],
});

const build = (http = scriptedHttp(sentryRoute).http, s: SecretPayload = secret) => connectorFactory(sentryConnector)(connection, { secret: s, http, clock: manualClock(NOW) });

describe('Sentry normalization', () => {
  it('event stats: sums the yAxis counts per hour, complete hours only', () => {
    const pts = normalizeEventsStats({ data: [[1000, [{ count: 2 }, { count: 3 }]], [4600, [{ count: 7 }]], ['bad', []]] }, 0, 5_000_000);
    expect(pts).toEqual([{ t: new Date(1_000_000).toISOString(), value: 5 }]);
    expect(() => normalizeEventsStats({ nope: 1 }, 0, 1)).toThrow(ProviderUnavailableError);
  });

  it('sessions: crash-free rate as percent; an hour without sessions is no reading, not 0%', () => {
    const pts = normalizeSessions({ intervals: ['2026-09-25T00:00:00Z', '2026-09-25T01:00:00Z'], groups: [{ series: { 'crash_free_rate(session)': [0.9951, null] } }] }, 'crash_free_rate(session)', 0, Date.parse(NOW));
    expect(pts).toEqual([{ t: '2026-09-25T00:00:00.000Z', value: 99.51 }]);
    expect(() => normalizeSessions({ intervals: [] }, 'x', 0, 1)).toThrow(ProviderUnavailableError);
  });

  it('releases: a finished deploy is actual timing, a release date reported, a creation date only planned', () => {
    const r = normalizeReleases([
      { version: 'a', dateCreated: '2026-09-25T00:00:00Z', dateReleased: '2026-09-25T00:10:00Z', lastDeploy: { dateFinished: '2026-09-25T00:20:00Z', environment: 'production' } },
      { version: 'b', dateCreated: '2026-09-25T00:00:00Z', dateReleased: '2026-09-25T00:10:00Z' },
      { version: 'c', dateCreated: '2026-09-25T00:00:00Z' },
      { dateCreated: '2026-09-25T00:00:00Z' },
    ]);
    expect(r.map((x) => [x.version, x.timing, x.at])).toEqual([
      ['a', 'actual', '2026-09-25T00:20:00.000Z'],
      ['b', 'reported', '2026-09-25T00:10:00.000Z'],
      ['c', 'planned', '2026-09-25T00:00:00.000Z'],
    ]);
  });

  it('issues: minimal fields, counts parsed, personal data redacted, links only to sentry.io', () => {
    const [i, j] = normalizeIssues([
      { id: '1', shortId: 'W-1', title: 'Boom for ana@example.org', level: 'fatal', count: '12', userCount: 4, firstSeen: '2026-09-25T02:00:00Z', lastSeen: '2026-09-25T03:00:00Z', permalink: 'https://acme.sentry.io/issues/1/' },
      { id: '2', title: 'x', firstSeen: '2026-09-25T02:00:00Z', permalink: 'https://evil.example.com/issues/2/' },
    ]);
    expect(i).toMatchObject({ shortId: 'W-1', level: 'fatal', events: 12, users: 4, firstSeen: '2026-09-25T02:00:00.000Z', lastSeen: '2026-09-25T03:00:00.000Z', url: 'https://acme.sentry.io/issues/1/' });
    expect(i.title).not.toContain('ana@example.org');
    expect(j.url).toBeUndefined();
  });
});

describe('Sentry mapping', () => {
  it('error series: a telemetry count, bad when it rises, with a seasonal baseline', async () => {
    const s = (await build().metrics!.getSeries({ metric: 'checkout_errors', window }))!;
    expect(s).toMatchObject({ source: 'sentry', unit: 'count', badDirection: 'up', mode: 'relative', telemetry: 'errors', area: 'checkout' });
    expect(s.baseline.mean).toBe(5);
    expect(s.points[s.points.length - 1]).toEqual({ t: '2026-09-25T05:00:00.000Z', value: 40 });
    expect(s.provenance.url).toMatch(/^https:\/\/acme\.sentry\.io\/issues\/\?project=42&query=/);
  });

  it('crash-free series: a telemetry rate in percent, bad when it falls (points)', async () => {
    const s = (await build().metrics!.getSeries({ metric: 'crash_free_sessions', window }))!;
    expect(s).toMatchObject({ unit: 'percent', badDirection: 'down', mode: 'absolute', telemetry: 'crash_free', area: 'stability' });
    expect(s.baseline.mean).toBe(99.5);
    expect(s.points[s.points.length - 1].value).toBe(97);
  });

  it('a quiet error stream has a floored baseline, so a first error is a finite rise', async () => {
    const quiet = scriptedHttp((u) => (u.pathname.endsWith('/events-stats/') ? { body: { data: HOURS.map((h) => [h / 1000, [{ count: 0 }]]) } } : sentryRoute(u))).http;
    const s = (await build(quiet).metrics!.getSeries({ metric: 'checkout_errors', window }))!;
    expect(s.baseline.mean).toBe(1);
  });

  it('releases in the window, as change records with honest timing', async () => {
    const changes = await build().changes!.getChanges({ window });
    expect(changes.map((c) => [c.version, c.timing, c.at])).toEqual([
      ['4.8.1', 'actual', '2026-09-25T01:00:00.000Z'],
      ['4.8.0', 'reported', '2026-09-24T20:00:00.000Z'],
    ]);
    expect(changes[0].provenance.url).toBe('https://acme.sentry.io/releases/4.8.1/');
  });

  it('issues first seen in the window only, as bug work items with counts', async () => {
    const items = await build().work_items!.getWorkItems({ window });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'WEB-1A', type: 'bug', priority: 'high', createdAt: '2026-09-25T02:05:00.000Z', status: 'unresolved · 1204 events · 318 users · last seen 2026-09-25T05:40:00.000Z' });
  });

  it('missing credentials: never a read — a configuration error (and no request)', async () => {
    const { http, calls } = scriptedHttp(sentryRoute);
    const check = await checkConnector(sentryConnector, connection, { http, clock: manualClock(NOW) });
    expect(check).toMatchObject({ state: 'error', detail: 'Sentry has no stored credential.' });
    await expect(build(http, { kind: 'api_key', fields: {} }).metrics!.getSeries({ metric: 'checkout_errors', window })).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(calls).toHaveLength(0);
  });

  it('check: connected, and warns about a project the token cannot see', async () => {
    const ok = await checkConnector(sentryConnector, connection, { secret, http: scriptedHttp(sentryRoute).http, clock: manualClock(NOW) });
    expect(ok).toMatchObject({ state: 'connected', account: 'acme' });
    const other = await checkConnector(sentryConnector, { ...connection, config: { ...CONFIG, projects: [42, 77] } }, { secret, http: scriptedHttp(sentryRoute).http, clock: manualClock(NOW) });
    expect(other.warnings?.[0]).toContain('77');
  });
});
