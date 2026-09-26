import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { HttpRequest } from '../src/product/ports/http';
import type { IdentityProvider } from '../src/product/ports/identity';
import { manualClock } from '../src/product/ports/clock';
import { scriptedHttp, type Reply } from '../src/product/testkit/connectorContract';
import { composeBriefJob } from '../src/product/app/monitoring';
import { productStateFromSnapshot, type WorkspaceSnapshot } from '../src/product/app/workspaceSnapshot';
import { watchCardStatus } from '../src/product/view/watchCard';
import { freshPglite } from './postgres/pglite';
import { createRuntime } from './runtime';
import { createApp } from './app';
import type { ApiRequest, ApiResponse } from './http/types';

vi.setConfig({ testTimeout: 60_000 });

/**
 * The GitHub production changes watch end to end on the server: connect GitHub, create the watch from
 * its template, and let the scheduler run it against a scripted GitHub API (never the real one).
 */

const TOKEN = 'github_pat_TEST_ONLY_not_a_real_token';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

type Deployment = { id: number; sha: string; ref: string; environment: string; created_at: string; statuses: { state: string; created_at: string }[] };
const gh = { deployments: [] as Deployment[], down: false };

const route = (u: URL, init?: HttpRequest): Reply | undefined => {
  if (u.hostname !== 'api.github.com') return undefined;
  const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
  if (auth !== `Bearer ${TOKEN}`) return { status: 401, body: {} };
  if (gh.down && u.pathname !== '/repos/acme/web') return { status: 503, body: {} };
  if (u.pathname === '/repos/acme/web') return { body: { full_name: 'acme/web' } };
  if (u.pathname === '/repos/acme/web/deployments') return { body: gh.deployments.filter((d) => d.environment.toLowerCase() === (u.searchParams.get('environment') ?? '').toLowerCase()).map(({ statuses: _s, ...d }) => (void _s, d)) };
  const st = /^\/repos\/acme\/web\/deployments\/(\d+)\/statuses$/.exec(u.pathname);
  if (st) return { body: gh.deployments.find((d) => d.id === Number(st[1]))?.statuses ?? [] };
  if (u.pathname === '/repos/acme/web/releases') return { body: [] };
  return undefined;
};

const idp: IdentityProvider = { id: 'fake', authorizationUrl: ({ state }) => `https://idp.example/a?state=${state}`, exchange: async () => ({ provider: 'fake', subject: 'ana-1', emailVerified: true, displayName: 'Ana' }) };
type S = { cookie: string; csrf: string };
const req = (method: string, path: string, s?: S, body?: unknown, extra: Record<string, string> = {}): ApiRequest => {
  const [p, q] = path.split('?');
  return { method, path: p, query: Object.fromEntries(new URLSearchParams(q ?? '')), headers: { ...(s ? { cookie: s.cookie, 'x-jagr-csrf': s.csrf } : {}), ...extra }, body };
};
const cookiesOf = (r: ApiResponse) => Object.fromEntries((r.cookies ?? []).map((c) => c.split(';')[0].split('=')).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

async function setup() {
  gh.deployments = [];
  gh.down = false;
  const clock = manualClock('2026-09-25T10:00:00.000Z');
  const { http } = scriptedHttp(route);
  const rt = await createRuntime({ JAGR_SESSION_SECRET: randomBytes(32).toString('hex'), JAGR_SECRET_KEY: randomBytes(32).toString('base64'), CRON_SECRET: 'cron-secret', JAGR_APP_URL: 'https://jagr.test' }, { sql: await freshPglite(), clock, identity: { fake: idp }, http });
  const app = createApp(rt);
  const start = await app(req('GET', '/api/auth/fake/start'));
  const state = new URL(start.headers!.location).searchParams.get('state')!;
  const cb = await app(req('GET', `/api/auth/fake/callback?code=x&state=${state}`, undefined, undefined, { cookie: `jagr_oauth=${encodeURIComponent(cookiesOf(start).jagr_oauth)}` }));
  const c = cookiesOf(cb);
  const s: S = { cookie: `jagr_session=${c.jagr_session}; jagr_csrf=${c.jagr_csrf}`, csrf: c.jagr_csrf };
  const id = ((await app(req('POST', '/api/workspaces', s, { name: 'Deepak Product Workspace', mode: 'connected' }))).body as { workspace: { id: string } }).workspace.id;
  return { rt, app, clock, s, id };
}

const cron = { authorization: 'Bearer cron-secret' };

describe('GitHub production changes — server, end to end', () => {
  it('connect → create the watch → a failed deployment opens one MEDIUM investigation; a later success closes it as a deployment outcome only', async () => {
    const { rt, app, clock, s, id } = await setup();
    const connect = await app(req('PUT', `/api/workspaces/${id}/connections`, s, { provider: 'github', config: { repos: ['acme/web'], environments: ['Production'] }, credential: { token: TOKEN } }));
    expect(connect.status).toBe(200);
    expect((connect.body as { connection: { health: string } }).connection.health).toBe('healthy');

    const created = await app(req('POST', `/api/workspaces/${id}/watches`, s, { templateId: 'github_changes', schedule: { frequency: '15m', dailyAt: '07:00' } }));
    expect(created.status).toBe(201);
    const watch = (created.body as { watch: { id: string; sources: string[]; signals: { key: string }[] } }).watch;
    expect(watch.sources).toEqual(['github']);
    expect(watch.signals.map((x) => x.key)).toEqual(['changes']);

    // 10:05 a Production deployment fails.
    gh.deployments = [{ id: 11, sha: SHA_A, ref: SHA_A, environment: 'Production', created_at: '2026-09-25T10:05:00Z', statuses: [{ state: 'failure', created_at: '2026-09-25T10:08:00Z' }] }];
    await app(req('GET', '/api/cron/tick', undefined, undefined, cron));
    clock.set('2026-09-25T10:15:00.000Z');
    expect((await app(req('GET', '/api/cron/tick', undefined, undefined, cron))).body).toMatchObject({ run: { done: 1, failed: 0 } });
    let invs = await rt.repos.investigations.list(id);
    expect(invs).toHaveLength(1);
    expect(invs[0]).toMatchObject({ attention: 'MEDIUM', status: 'CONFIRMED', title: `Deployment failed: Deploy aaaaaaa to Production (acme/web)` });
    expect(invs[0].unknowns.some((u) => /Why the deployment failed/.test(u))).toBe(true);

    // The next run sees the same failed deployment again: still one investigation.
    clock.set('2026-09-25T10:30:00.000Z');
    await app(req('GET', '/api/cron/tick', undefined, undefined, cron));
    invs = await rt.repos.investigations.list(id);
    expect(invs).toHaveLength(1);

    // 10:40 a later Production deployment succeeds → the deployment failure closes; product impact is not claimed.
    gh.deployments.push({ id: 12, sha: SHA_B, ref: SHA_B, environment: 'Production', created_at: '2026-09-25T10:38:00Z', statuses: [{ state: 'success', created_at: '2026-09-25T10:40:00Z' }] });
    clock.set('2026-09-25T10:45:00.000Z');
    await app(req('GET', '/api/cron/tick', undefined, undefined, cron));
    invs = await rt.repos.investigations.list(id);
    expect(invs).toHaveLength(1);
    expect(invs[0].status).toBe('RESOLVED');
    expect(invs[0].trace.some((t) => t.title === 'Deployment failure resolved by a subsequent successful deployment' && /not evidence that product impact is resolved/.test(t.detail ?? ''))).toBe(true);

    // The brief lists the successful deployment as context, not a finding.
    clock.set('2026-09-25T11:00:00.000Z');
    await composeBriefJob(rt, { workspaceId: id, payload: { dueAt: '2026-09-25T11:00:00.000Z' } });
    const [brief] = await rt.repos.briefs.list(id);
    expect(brief.shipped).toEqual([expect.objectContaining({ title: 'Deploy bbbbbbb to Production (acme/web)', kind: 'deploy' })]);
    expect(brief.shippedUnavailable).toBeUndefined();
  });

  it('a quiet scheduled run and a requested run appear in the snapshot as this watch’s run history, with what GitHub returned', async () => {
    const { app, clock, s, id } = await setup();
    // No Production deployments yet: the connection works, and the check names the empty environment.
    const connect = await app(req('PUT', `/api/workspaces/${id}/connections`, s, { provider: 'github', config: { repos: ['acme/web'], environments: ['Production'] }, credential: { token: TOKEN } }));
    const check = (connect.body as { check: { state: string; detail: string; warnings?: string[] } }).check;
    expect(check.state).toBe('connected');
    expect(check.warnings).toEqual(["no deployments found for environment 'Production' in acme/web; check the environment name/configuration"]);

    const created = await app(req('POST', `/api/workspaces/${id}/watches`, s, { templateId: 'github_changes', schedule: { frequency: '15m', dailyAt: '07:00' } }));
    const watch = (created.body as { watch: { id: string } }).watch;
    let snap = (await app(req('GET', `/api/workspaces/${id}/snapshot`, s))).body as WorkspaceSnapshot;
    expect(snap.runs).toEqual([]);

    // Scheduled runs that find nothing (the 10:00 slot, when the watch was created, and 10:15).
    await app(req('GET', '/api/cron/tick', undefined, undefined, cron));
    clock.set('2026-09-25T10:15:00.000Z');
    expect((await app(req('GET', '/api/cron/tick', undefined, undefined, cron))).body).toMatchObject({ run: { done: 1, failed: 0 } });
    // A requested run after a deployment lands.
    gh.deployments = [{ id: 21, sha: SHA_A, ref: 'main', environment: 'Production', created_at: '2026-09-25T10:16:00Z', statuses: [{ state: 'success', created_at: '2026-09-25T10:18:00Z' }] }];
    clock.set('2026-09-25T10:20:00.000Z');
    expect((await app(req('POST', `/api/workspaces/${id}/runs`, s))).status).toBe(200);

    snap = (await app(req('GET', `/api/workspaces/${id}/snapshot`, s))).body as WorkspaceSnapshot;
    expect(snap.runs).toEqual([
      { watchId: watch.id, at: '2026-09-25T10:00:00.000Z', outcome: 'GitHub: 0 deployments, 0 releases in the last 6h' },
      { watchId: watch.id, at: '2026-09-25T10:15:00.000Z', outcome: 'GitHub: 0 deployments, 0 releases in the last 6h' },
      { watchId: watch.id, at: '2026-09-25T10:20:00.000Z', outcome: 'GitHub: 1 deployment, 0 releases in the last 6h' },
    ]);
    const state = productStateFromSnapshot(snap, { emailFrom: 'jagr@test' });
    const card = watchCardStatus(snap.watches[0], { location: 'server', result: state.result, clock: state.clock, snapshotAt: snap.at });
    expect(card.runs).toHaveLength(3);
    expect(card.lastRun?.outcome).toBe('GitHub: 1 deployment, 0 releases in the last 6h');
    expect(card.quiet).toBe('No open investigations');
    // The next check is the scheduler's own 15-minute slot after the snapshot time.
    expect(card.nextRun).toBe(new Date(Date.parse(snap.watches[0].createdAt) + Math.ceil((Date.parse(snap.at) + 1 - Date.parse(snap.watches[0].createdAt)) / 900_000) * 900_000).toISOString());
  });

  it('GitHub unavailable: the brief says its change list could not be read — never "nothing shipped"', async () => {
    const { rt, app, clock, s, id } = await setup();
    await app(req('PUT', `/api/workspaces/${id}/connections`, s, { provider: 'github', config: { repos: ['acme/web'], environments: ['Production'] }, credential: { token: TOKEN } }));
    await app(req('POST', `/api/workspaces/${id}/watches`, s, { templateId: 'github_changes' }));
    gh.down = true;
    clock.set('2026-09-25T11:00:00.000Z');
    await composeBriefJob(rt, { workspaceId: id, payload: { dueAt: '2026-09-25T11:00:00.000Z' } });
    const [brief] = await rt.repos.briefs.list(id);
    expect(brief.shipped).toBeUndefined();
    expect(brief.shippedUnavailable).toEqual(['github']);
    expect(await rt.repos.investigations.list(id)).toEqual([]);
  });
});

describe('Edit a connection’s configuration (the stored credential is kept)', () => {
  const config = (environments: string[]) => ({ repos: ['acme/web'], environments });
  const put = (app: Awaited<ReturnType<typeof setup>>['app'], s: S, id: string, body: unknown) => app(req('PUT', `/api/workspaces/${id}/connections`, s, body));
  type Result = { connection: { id: string; health: string; config: Record<string, unknown>; lastSuccessfulCheckAt?: string }; check: { state: string; warnings?: string[] } };

  it('a configuration-only update keeps the stored credential, needs no credential, and is tested at once', async () => {
    const { rt, app, clock, s, id } = await setup();
    gh.deployments = [{ id: 31, sha: SHA_A, ref: 'main', environment: 'Production', created_at: '2026-09-25T09:00:00Z', statuses: [{ state: 'success', created_at: '2026-09-25T09:02:00Z' }] }];
    // Connected with a wrong environment name: the check warns.
    const first = (await put(app, s, id, { provider: 'github', config: config(['Prod']), credential: { token: TOKEN } })).body as Result;
    expect(first.check.warnings).toEqual(["no deployments found for environment 'Prod' in acme/web; check the environment name/configuration"]);
    const before = (await rt.repos.connections.get(id, first.connection.id))!;

    // Fix only the environment: no credential in the request.
    clock.set('2026-09-25T10:05:00.000Z');
    const res = await put(app, s, id, { provider: 'github', config: config(['Production']) });
    expect(res.status).toBe(200);
    const fixed = res.body as Result;
    // Tested against GitHub with the stored token (GitHub answers 401 to any other): connected, no warning.
    expect(fixed.check).toMatchObject({ state: 'connected' });
    expect(fixed.check.warnings).toBeUndefined();
    expect(fixed.connection).toMatchObject({ health: 'healthy', lastSuccessfulCheckAt: '2026-09-25T10:05:00.000Z', config: expect.objectContaining({ environments: ['Production'] }) });
    const after = (await rt.repos.connections.get(id, first.connection.id))!;
    expect(after.secretRef).toEqual(before.secretRef);
    expect((await rt.secrets.get(after.secretRef!)).secret).toEqual({ kind: 'api_key', fields: { token: TOKEN } });
    // Recorded as a configuration change; the credential is never echoed back.
    const audit = await rt.repos.audit.list(id);
    expect(audit.filter((e) => e.action === 'connection.configured').map((e) => e.detail)).toEqual(['GitHub: configuration saved (repos, environments, releases, auth).']);
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });

  it('a new connection still needs a credential', async () => {
    const { app, s, id } = await setup();
    const res = await put(app, s, id, { provider: 'github', config: config(['Production']) });
    expect(res.status).toBe(400);
  });

  it('reconnect still replaces the credential and tests it, keeping the configuration', async () => {
    const { rt, app, s, id } = await setup();
    const first = (await put(app, s, id, { provider: 'github', config: config(['Production']), credential: { token: TOKEN } })).body as Result;
    const bad = await app(req('POST', `/api/workspaces/${id}/connections/${first.connection.id}/reconnect`, s, { credential: { token: 'github_pat_WRONG' } }));
    expect((bad.body as Result).check.state).toBe('needs_reconnect');
    const good = await app(req('POST', `/api/workspaces/${id}/connections/${first.connection.id}/reconnect`, s, { credential: { token: TOKEN } }));
    expect(good.status).toBe(200);
    expect((good.body as Result).check.state).toBe('connected');
    expect((good.body as Result).connection.config).toMatchObject({ environments: ['Production'] });
    expect((await rt.repos.audit.list(id)).map((e) => e.action).filter((a) => a.startsWith('connection.'))).toEqual(expect.arrayContaining(['connection.connected', 'connection.reconnected']));
  });
});

describe('production-path regressions (scheduler → GitHub → audit → snapshot)', () => {
  type Tick = { tick: { enqueued: number }; run: { done: number; failed: number } };
  const tick = async (app: Awaited<ReturnType<typeof setup>>['app']) => (await app(req('GET', '/api/cron/tick', undefined, undefined, cron))).body as Tick;
  const watchRuns = async (rt: Awaited<ReturnType<typeof setup>>['rt'], id: string) => (await rt.repos.audit.list(id)).filter((e) => e.action === 'monitor.watch');

  async function githubWatch(env = 'Production') {
    const ctx = await setup();
    await ctx.app(req('PUT', `/api/workspaces/${ctx.id}/connections`, ctx.s, { provider: 'github', config: { repos: ['acme/web'], environments: [env] }, credential: { token: TOKEN } }));
    const watch = ((await ctx.app(req('POST', `/api/workspaces/${ctx.id}/watches`, ctx.s, { templateId: 'github_changes', schedule: { frequency: '15m', dailyAt: '07:00' } }))).body as { watch: { id: string } }).watch;
    return { ...ctx, watch };
  }

  it('a tick with a due slot enqueues the watch, runs it, and records monitor.watch against the watch; a tick with none enqueues 0 and runs nothing', async () => {
    const { rt, app, clock, id, watch } = await githubWatch();
    // 10:00: the watch's first slot (its creation time) is due.
    expect(await tick(app)).toMatchObject({ tick: { enqueued: 1 }, run: { done: 1, failed: 0 } });
    expect(await watchRuns(rt, id)).toEqual([expect.objectContaining({ target: watch.id, at: '2026-09-25T10:00:00.000Z', detail: '0 investigation(s), 0 notification(s) · GitHub: 0 deployments, 0 releases in the last 6h' })]);
    // 10:07: no slot between the last tick and now — normal, and no run happens.
    clock.set('2026-09-25T10:07:00.000Z');
    expect(await tick(app)).toMatchObject({ tick: { enqueued: 0 }, run: { done: 0, failed: 0 } });
    expect(await watchRuns(rt, id)).toHaveLength(1);
    // 10:16: the 10:15 slot is due.
    clock.set('2026-09-25T10:16:00.000Z');
    expect(await tick(app)).toMatchObject({ tick: { enqueued: 1 }, run: { done: 1, failed: 0 } });
    expect((await watchRuns(rt, id)).map((e) => [e.target, e.at])).toEqual([[watch.id, '2026-09-25T10:00:00.000Z'], [watch.id, '2026-09-25T10:15:00.000Z']]);
    // Several missed slots: only the latest is run (the 6-hour change lookback covers the gap).
    clock.set('2026-09-25T11:20:00.000Z');
    expect(await tick(app)).toMatchObject({ tick: { enqueued: 1 }, run: { done: 1 } });
    expect((await watchRuns(rt, id)).at(-1)!.at).toBe('2026-09-25T11:15:00.000Z');
  });

  it('a quiet scheduled run: the snapshot carries it for its watch, and the card shows it as the last run', async () => {
    const { app, id, s, watch } = await githubWatch();
    await tick(app);
    const snap = (await app(req('GET', `/api/workspaces/${id}/snapshot`, s))).body as WorkspaceSnapshot;
    expect(snap.runs).toEqual([{ watchId: watch.id, at: '2026-09-25T10:00:00.000Z', outcome: 'GitHub: 0 deployments, 0 releases in the last 6h' }]);
    const state = productStateFromSnapshot(snap, { emailFrom: 'jagr@test' });
    const card = watchCardStatus(snap.watches[0], { location: 'server', result: state.result, clock: state.clock, snapshotAt: snap.at });
    expect(card.lastRun).toMatchObject({ scheduledAt: '2026-09-25T10:00:00.000Z', outcome: 'GitHub: 0 deployments, 0 releases in the last 6h' });
    expect(card.quiet).toBe('No open investigations');
  });

  for (const [kind, ref, laterRef] of [['branch', 'main', 'main'], ['tag', 'v2.4.0', 'v2.4.1']] as const) {
    it(`${kind} ref: a failed deployment closes when a later deployment to the same repository and environment succeeds`, async () => {
      const { rt, app, clock, id } = await githubWatch();
      gh.deployments = [{ id: 41, sha: SHA_A, ref, environment: 'Production', created_at: '2026-09-25T09:50:00Z', statuses: [{ state: 'failure', created_at: '2026-09-25T09:55:00Z' }] }];
      await tick(app);
      let [inv] = await rt.repos.investigations.list(id);
      expect(inv).toMatchObject({ status: 'CONFIRMED', attention: 'MEDIUM', deployment: expect.objectContaining({ target: 'acme/web:production', version: ref }) });
      gh.deployments.push({ id: 42, sha: SHA_B, ref: laterRef, environment: 'Production', created_at: '2026-09-25T10:05:00Z', statuses: [{ state: 'success', created_at: '2026-09-25T10:10:00Z' }] });
      clock.set('2026-09-25T10:16:00.000Z');
      await tick(app);
      const invs = await rt.repos.investigations.list(id);
      expect(invs).toHaveLength(1);
      [inv] = invs;
      expect(inv.status).toBe('RESOLVED');
      expect(inv.attention).toBe('MEDIUM');
      expect(inv.trace.some((t) => t.title === 'Deployment failure resolved by a subsequent successful deployment' && /not evidence that product impact is resolved/.test(t.detail ?? ''))).toBe(true);
    });
  }

  it('environment mismatch: the check warns by name, and runs say what was read — never "nothing changed" or "within normal range"', async () => {
    gh.deployments = [];
    const ctx = await setup();
    gh.deployments = [{ id: 51, sha: SHA_A, ref: 'main', environment: 'Production', created_at: '2026-09-25T09:30:00Z', statuses: [{ state: 'success', created_at: '2026-09-25T09:32:00Z' }] }];
    const connect = await ctx.app(req('PUT', `/api/workspaces/${ctx.id}/connections`, ctx.s, { provider: 'github', config: { repos: ['acme/web'], environments: ['prod'] }, credential: { token: TOKEN } }));
    expect((connect.body as { check: { warnings?: string[] } }).check.warnings).toEqual(["no deployments found for environment 'prod' in acme/web; check the environment name/configuration"]);
    await ctx.app(req('POST', `/api/workspaces/${ctx.id}/watches`, ctx.s, { templateId: 'github_changes', schedule: { frequency: '15m', dailyAt: '07:00' } }));
    await tick(ctx.app);
    const [run] = await watchRuns(ctx.rt, ctx.id);
    expect(run.detail).toMatch(/GitHub: 0 deployments, 0 releases in the last 6h/);
    expect(run.detail).not.toMatch(/nothing changed|no changes|within normal range/i);
  });

  it('GitHub unavailable on a scheduled run: an explicit gap in the run record, no investigation, never "no changes"', async () => {
    const { rt, app, id, watch } = await githubWatch();
    gh.down = true;
    expect(await tick(app)).toMatchObject({ run: { done: 1, failed: 0 } });
    const [run] = await watchRuns(rt, id);
    expect(run.target).toBe(watch.id);
    expect(run.detail).toMatch(/GitHub unavailable/);
    expect(run.detail).not.toMatch(/\d+ deployments?|no changes|nothing changed|within normal range/i);
    expect(await rt.repos.investigations.list(id)).toEqual([]);
  });
});
