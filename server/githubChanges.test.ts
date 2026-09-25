import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { HttpRequest } from '../src/product/ports/http';
import type { IdentityProvider } from '../src/product/ports/identity';
import { manualClock } from '../src/product/ports/clock';
import { scriptedHttp, type Reply } from '../src/product/testkit/connectorContract';
import { composeBriefJob } from '../src/product/app/monitoring';
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
