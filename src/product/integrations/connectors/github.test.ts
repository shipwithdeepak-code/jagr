import { describe, expect, it } from 'vitest';
import type { Connection } from '../../ports/persistence';
import type { HttpClient } from '../../ports/http';
import { manualClock } from '../../ports/clock';
import { createMemoryPersistence, createMemorySecretStore } from '../../ports/memory';
import { runWatchJob, sourcesForRun } from '../../app/monitoring';
import { watchFromTemplate } from '../../catalog';
import { connectorContract, response, scriptedHttp, type Reply } from '../../testkit/connectorContract';
import { githubConnector } from './github';
import { amplitudeConnector } from './amplitude';
import { connectorFactory } from './runtime';
import { connectorsFrom } from './index';
import type { ConnectorDescriptor } from './types';
import { ConnectorRateLimited } from './errors';

/**
 * GitHub connector against responses in the REST API's documented shape (deployments, deployment
 * statuses, releases). Synthesised fixtures, not a live recording — `npm run eval:connectors` is the live check.
 */

const NOW = '2026-09-25T06:00:00.000Z';
const window = { start: '2026-09-24T06:00:00.000Z', end: NOW };

const DEPLOYMENTS = [
  { id: 107, sha: 'aaaaaaa7777777', ref: 'main', environment: 'production', created_at: '2026-09-25T05:40:00Z', description: null },
  { id: 104, sha: 'aaaaaaa4444444', ref: 'main', environment: 'production', created_at: '2026-09-25T07:00:00Z', description: null },
  { id: 103, sha: 'aaaaaaa3333333', ref: 'main', environment: 'production', created_at: '2026-09-25T05:50:00Z', description: 'hotfix by ops@acme.test' },
  { id: 102, sha: 'aaaaaaa2222222', ref: 'main', environment: 'production', created_at: '2026-09-25T03:00:00Z', description: null },
  { id: 101, sha: 'aaaaaaa1111111', ref: 'v2.3.0', environment: 'production', created_at: '2026-09-25T01:30:00Z', description: 'Checkout v2' },
  { id: 105, sha: 'aaaaaaa5555555', ref: 'main', environment: 'production', created_at: '2026-09-24T05:55:00Z', description: null },
  { id: 106, sha: 'aaaaaaa6666666', ref: 'main', environment: 'production', created_at: '2026-09-23T10:00:00Z', description: null },
];
const STATUSES: Record<number, { state: string; created_at: string }[]> = {
  101: [
    { state: 'success', created_at: '2026-09-25T01:45:00Z' },
    { state: 'in_progress', created_at: '2026-09-25T01:31:00Z' },
  ],
  102: [{ state: 'failure', created_at: '2026-09-25T03:10:00Z' }],
  103: [{ state: 'in_progress', created_at: '2026-09-25T05:51:00Z' }],
  104: [{ state: 'success', created_at: '2026-09-25T07:10:00Z' }],
  105: [{ state: 'success', created_at: '2026-09-24T06:05:00Z' }],
  106: [{ state: 'success', created_at: '2026-09-23T10:10:00Z' }],
  // Finishes after the run's "as of" time: still in progress as far as this run can know.
  107: [
    { state: 'success', created_at: '2026-09-25T06:30:00Z' },
    { state: 'in_progress', created_at: '2026-09-25T05:41:00Z' },
  ],
};
const RELEASES = [
  { id: 9, tag_name: 'v2.5.0', name: 'Future', published_at: '2026-09-25T08:00:00Z', html_url: 'https://github.com/acme/web/releases/tag/v2.5.0', draft: false, prerelease: false },
  { id: 8, tag_name: 'v2.4.0-rc1', name: null, published_at: '2026-09-25T04:00:00Z', html_url: 'https://github.com/acme/web/releases/tag/v2.4.0-rc1', draft: false, prerelease: true },
  { id: 7, tag_name: 'v2.4.0', name: 'Draft', published_at: null, html_url: 'https://github.com/acme/web/releases/tag/untagged', draft: true, prerelease: false },
  { id: 6, tag_name: 'v2.3.0', name: 'Checkout v2', published_at: '2026-09-25T01:50:00Z', html_url: 'https://github.com/acme/web/releases/tag/v2.3.0', draft: false, prerelease: false },
  { id: 5, tag_name: 'v2.2.0', name: 'Old', published_at: '2026-09-01T10:00:00Z', html_url: 'https://github.com/acme/web/releases/tag/v2.2.0', draft: false, prerelease: false },
];

const route = (u: URL): Reply | undefined => {
  if (u.hostname !== 'api.github.com') return undefined;
  let m: RegExpExecArray | null;
  if (u.pathname === '/repos/acme/web') return { body: { full_name: 'acme/web' } };
  if (u.pathname === '/repos/acme/web/deployments') return { body: u.searchParams.get('environment') === 'production' && u.searchParams.get('page') === '1' ? DEPLOYMENTS : [] };
  if ((m = /^\/repos\/acme\/web\/deployments\/(\d+)\/statuses$/.exec(u.pathname))) return { body: STATUSES[Number(m[1])] ?? [] };
  if (u.pathname === '/repos/acme/web/releases') return { body: RELEASES };
  return undefined;
};

const connection: Connection = {
  id: 'owner-github',
  workspaceId: 'ws-1',
  source: 'github',
  provider: 'github',
  roles: ['changes'],
  authKind: 'owner_env',
  state: 'connected',
  detail: 'GitHub',
  config: { repos: ['acme/web'], auth: 'token' },
  updatedAt: '2026-09-24T00:00:00.000Z',
};
const secret = { kind: 'api_key' as const, fields: { token: 'github_pat_11AAAAAAAAAAAAAAAAAAAA' } };

connectorContract({
  name: 'GitHub',
  descriptor: githubConnector,
  connection,
  secret,
  otherSecret: { kind: 'api_key', fields: { token: 'github_pat_22BBBBBBBBBBBBBBBBBBBB' } },
  route,
  window,
  expectRecords: { changes: 5 },
  invalidConfigs: [
    { repos: [] },
    { repos: ['not a repo'] },
    { repos: ['acme/web'], auth: 'app' },
    { repos: ['acme/web'], host: 'github.example.com' },
  ],
});

const build = (http: HttpClient = scriptedHttp(route).http) => connectorFactory(githubConnector)(connection, { secret, http, clock: manualClock(NOW) });

describe('GitHub mapping', () => {
  it('deployments: actual time is the success status; failures and in-progress deploys are labelled; "as of" the run', async () => {
    const changes = await build().changes!.getChanges({ window });
    const deploys = changes.filter((c) => c.kind === 'deploy').map((c) => [c.title.slice(7, 14), c.at, c.status, c.timing]);
    expect(deploys).toEqual([
      ['aaaaaaa', '2026-09-24T06:05:00.000Z', 'success', 'actual'],
      ['aaaaaaa', '2026-09-25T01:45:00.000Z', 'success', 'actual'],
      ['aaaaaaa', '2026-09-25T03:10:00.000Z', 'failed', 'actual'],
      ['aaaaaaa', '2026-09-25T05:40:00.000Z', 'in_progress', 'reported'],
      ['aaaaaaa', '2026-09-25T05:50:00.000Z', 'in_progress', 'reported'],
    ]);
    expect(changes.find((c) => c.at === '2026-09-25T01:45:00.000Z')!.provenance.url).toBe('https://github.com/acme/web/commit/aaaaaaa1111111');
    expect(JSON.stringify(changes)).not.toContain('ops@acme.test');
  });

  it('releases: published, non-draft, in-window only; reported timing, never claimed as when users got it', async () => {
    const rel = (await build().changes!.getChanges({ window })).filter((c) => c.kind === 'release');
    expect(rel.map((r) => [r.version, r.timing])).toEqual([
      ['v2.3.0', 'reported'],
      ['v2.4.0-rc1', 'reported'],
    ]);
    expect(rel[1].notes).toMatch(/pre-release/);
    expect(rel[0].notes).toMatch(/not known from GitHub/);
  });

  it('a 403 with no remaining quota is a rate limit, not a credential problem', async () => {
    const http: HttpClient = async () => response({ status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '60' } });
    await expect(build(http).changes!.getChanges({ window })).rejects.toBeInstanceOf(ConnectorRateLimited);
  });

  it('sends the token as a bearer header to api.github.com only', async () => {
    const { http, calls } = scriptedHttp(route);
    await build(http).changes!.getChanges({ window });
    expect(new Set(calls.map((c) => new URL(c.url).hostname))).toEqual(new Set(['api.github.com']));
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe('Bearer github_pat_11AAAAAAAAAAAAAAAAAAAA');
  });
});

// ── End to end with Amplitude: a real (connected) metric drop and a real deploy ──
const HOUR = 3_600_000;
const pad = (n: number) => String(n).padStart(2, '0');
const HOURS = Array.from({ length: 8 * 24 + 1 }, (_, i) => Date.parse(NOW) - 8 * 24 * HOUR + i * HOUR);
const local = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:00:00`;
};
const ampRoute = (u: URL): Reply | undefined => {
  if (u.pathname === '/api/2/annotations') return { body: { data: [] } };
  if (u.pathname !== '/api/2/events/segmentation') return undefined;
  const e = JSON.parse(u.searchParams.get('e')!).event_type as string;
  const drop = (ms: number) => ms >= Date.parse('2026-09-25T02:00:00Z');
  return { body: { data: { series: [HOURS.map((h) => (e === 'Checkout Started' ? 200 : drop(h) ? 45 : 60))], seriesLabels: [0], xValues: HOURS.map(local) } } };
};
const ampConnection: Connection = {
  id: 'owner-amplitude',
  workspaceId: 'ws-1',
  source: 'amplitude',
  provider: 'amplitude',
  roles: ['metrics', 'changes'],
  authKind: 'owner_env',
  state: 'connected',
  detail: 'Amplitude',
  config: { metrics: [{ kind: 'ratio', key: 'checkout_conversion', name: 'Checkout conversion', area: 'checkout', numerator: { event_type: 'Order Completed' }, denominator: { event_type: 'Checkout Started' }, badDirection: 'down', threshold: 10 }], annotations: false },
  updatedAt: '2026-09-24T00:00:00.000Z',
};

async function connectedRun(githubHttp: (u: URL) => Reply | undefined) {
  const { repos, tx } = createMemoryPersistence();
  const secrets = createMemorySecretStore();
  const clock = manualClock(NOW);
  await repos.workspaces.create({ id: 'ws-1', name: 'Acme', mode: 'connected', createdAt: NOW, settings: { planner: 'deterministic', aiEgressAllowed: false, timezone: 'UTC' }, brief: { enabled: true, time: '08:00', timezone: 'UTC' }, importedExportIds: [], version: 1 });
  await repos.connections.save('ws-1', { ...ampConnection, secretRef: await secrets.put({ workspaceId: 'ws-1', connectionId: 'owner-amplitude' }, { kind: 'api_key', fields: { apiKey: 'k_1234567', secretKey: 's_1234567' } }) });
  await repos.connections.save('ws-1', { ...connection, secretRef: await secrets.put({ workspaceId: 'ws-1', connectionId: 'owner-github' }, secret) });
  const http = scriptedHttp((u) => (u.hostname === 'api.github.com' ? githubHttp(u) : ampRoute(u))).http;
  const deps = { repos, tx, secrets, clock, http, connectors: connectorsFrom([amplitudeConnector, githubConnector] as ConnectorDescriptor<unknown>[]) };
  const run = await sourcesForRun(deps, (await repos.workspaces.get('ws-1'))!, NOW);
  await repos.watches.save('ws-1', watchFromTemplate('w-checkout', 'checkout_health', { sources: ['amplitude', 'github'], metricKeys: run.registry.metrics().map((m) => m.def.key) }, NOW));
  await runWatchJob(deps, { workspaceId: 'ws-1', payload: { watchId: 'w-checkout', dueAt: NOW } });
  return (await repos.investigations.list('ws-1'))[0];
}

describe('GitHub + Amplitude in a connected workspace (end to end)', () => {
  it('associates the drop with the deploy that finished just before it — actual timing, correlation not cause', async () => {
    const inv = await connectedRun(route);
    expect(inv.releaseAssociation).toMatchObject({ kind: 'deploy', timing: 'actual', minutesBeforeOnset: 15 });
    const text = JSON.stringify(inv);
    expect(text).toMatch(/does not establish causation|not proven causal|timing is not causation/);
    expect(inv.evidence.some((e) => e.provider === 'github' && e.timing === 'actual')).toBe(true);
  });

  it('GitHub down: the change question stays open as a gap — never "no deploys"', async () => {
    const inv = await connectedRun(() => ({ status: 503, body: {} }));
    expect(inv.releaseAssociation).toBeUndefined();
    expect(inv.trace.some((t) => t.kind === 'result' && t.title === 'GitHub unavailable')).toBe(true);
    expect(inv.uncertainty).toMatch(/GitHub could not be checked/);
    // Release-related is never ruled out: an outage is not evidence that nothing shipped.
    const rel = inv.agentHypotheses.find((h) => h.kind === 'release_related')!;
    expect(['untested', 'open']).toContain(rel.status);
    expect(rel.evidenceAgainst).toEqual([]);
    expect(JSON.stringify(inv)).not.toMatch(/[Nn]o (release|deploy|change)s? (was|were )?(found|shipped)|nothing was released/);
  });
});
