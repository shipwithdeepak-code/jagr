import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });
import type { IdentityProvider, VerifiedIdentity } from '../src/product/ports/identity';
import type { HttpRequest } from '../src/product/ports/http';
import { manualClock } from '../src/product/ports/clock';
import { sourcesForRun } from '../src/product/app/monitoring';
import { scriptedHttp, type Reply } from '../src/product/testkit/connectorContract';
import { freshPglite } from './postgres/pglite';
import type { SqlClient } from './postgres/sql';
import { createRuntime } from './runtime';
import { createApp } from './app';
import type { ApiRequest, ApiResponse } from './http/types';

/** The connection lifecycle over the HTTP API, on real Postgres (PGlite), with scripted provider responses. */

const PEOPLE: Record<string, VerifiedIdentity> = {
  'code-ana': { provider: 'fake', subject: 'ana-1', emailVerified: true, displayName: 'Ana' },
  'code-ben': { provider: 'fake', subject: 'ben-2', emailVerified: true, displayName: 'Ben' },
  'code-cy': { provider: 'fake', subject: 'cy-3', emailVerified: true, displayName: 'Cy' },
};
const idp: IdentityProvider = { id: 'fake', authorizationUrl: ({ state }) => `https://idp.example/authorize?state=${state}`, exchange: async ({ code }) => PEOPLE[code] ?? Promise.reject(new Error('bad code')) };

const JIRA_TOKEN = 'ATATT3xFfGF0-jira-token-value';
const JIRA_TOKEN_2 = 'ATATT3xFfGF0-jira-token-rotated';
let jiraAccepts = JIRA_TOKEN;
const route = (u: URL, init?: HttpRequest): Reply | undefined => {
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
  if (u.hostname === 'acme.atlassian.net') {
    if (auth !== `Basic ${Buffer.from(`svc@acme.test:${jiraAccepts}`).toString('base64')}`) return { status: 401, body: {} };
    if (u.pathname === '/rest/api/3/project/SHOP') return { body: { key: 'SHOP' } };
    return undefined;
  }
  if (u.hostname === 'slack.com' && u.pathname === '/api/auth.test') return { body: auth === 'Bearer xoxb-good-test-token' ? { ok: true, team: 'Acme' } : { ok: false, error: 'invalid_auth' } };
  return undefined;
};

async function setup(extraEnv: Record<string, string> = {}) {
  const sql: SqlClient = await freshPglite();
  const clock = manualClock('2026-09-25T10:00:00.000Z');
  const { http, calls } = scriptedHttp(route);
  const rt = await createRuntime({ JAGR_SESSION_SECRET: randomBytes(32).toString('hex'), JAGR_SECRET_KEY: randomBytes(32).toString('base64'), JAGR_APP_URL: 'https://jagr.test', ...extraEnv }, { sql, clock, identity: { fake: idp }, http });
  return { rt, app: createApp(rt), sql, calls };
}
type S = { cookie: string; csrf: string };
const req = (method: string, path: string, s?: S, body?: unknown, extra: Record<string, string> = {}): ApiRequest => {
  const [p, q] = path.split('?');
  return { method, path: p, query: Object.fromEntries(new URLSearchParams(q ?? '')), headers: { ...(s ? { cookie: s.cookie, 'x-jagr-csrf': s.csrf } : {}), ...extra }, body };
};
const cookiesOf = (r: ApiResponse) => Object.fromEntries((r.cookies ?? []).map((c) => c.split(';')[0].split('=')).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
async function signIn(app: ReturnType<typeof createApp>, code: string): Promise<S> {
  const start = await app(req('GET', '/api/auth/fake/start'));
  const state = new URL(start.headers!.location).searchParams.get('state')!;
  const cb = await app(req('GET', `/api/auth/fake/callback?code=${code}&state=${state}`, undefined, undefined, { cookie: `jagr_oauth=${encodeURIComponent(cookiesOf(start).jagr_oauth)}` }));
  const c = cookiesOf(cb);
  return { cookie: `jagr_session=${c.jagr_session}; jagr_csrf=${c.jagr_csrf}`, csrf: c.jagr_csrf };
}
async function workspace(app: ReturnType<typeof createApp>, s: S, mode: 'connected' | 'imported' = 'connected'): Promise<string> {
  const r = await app(req('POST', '/api/workspaces', s, { name: 'Acme', mode }));
  return (r.body as { workspace: { id: string } }).workspace.id;
}
const JIRA = { provider: 'jira', config: { site: 'https://acme.atlassian.net', project: 'SHOP' }, credential: { email: 'svc@acme.test', apiToken: JIRA_TOKEN } };
type ConnBody = { connection: { id: string; health: string; status: string; needsReconnect: boolean; lastSuccessfulCheckAt?: string; account?: string }; check: { state: string } };

describe('connection lifecycle API', () => {
  it('lists the connection types this deployment offers — field names, never values', async () => {
    const { app } = await setup();
    const s = await signIn(app, 'code-ana');
    const r = await app(req('GET', '/api/connection-types', s));
    const types = (r.body as { types: { provider: string; credentialFields: { key: string }[]; roles: string[] }[] }).types;
    expect(types.map((t) => t.provider).sort()).toEqual(['amplitude', 'github', 'intercom', 'jira', 'sentry', 'slack']);
    expect(types.find((t) => t.provider === 'jira')!.credentialFields.map((f) => f.key)).toEqual(['email', 'apiToken']);
    expect(types.find((t) => t.provider === 'slack')!.roles).toEqual([]);
  });

  it('connect → tested immediately → healthy; the credential never comes back and is encrypted at rest', async () => {
    jiraAccepts = JIRA_TOKEN;
    const { app, sql, rt } = await setup();
    const s = await signIn(app, 'code-ana');
    const ws = await workspace(app, s);
    const r = await app(req('PUT', `/api/workspaces/${ws}/connections`, s, JIRA));
    expect(r.status).toBe(200);
    const body = r.body as ConnBody;
    expect(body.check.state).toBe('connected');
    expect(body.connection).toMatchObject({ id: 'conn-jira', health: 'healthy', status: 'connected', needsReconnect: false, account: 'acme.atlassian.net · SHOP' });
    const everything = JSON.stringify([r.body, (await app(req('GET', `/api/workspaces/${ws}/connections`, s))).body, (await app(req('GET', `/api/workspaces/${ws}`, s))).body, (await app(req('GET', `/api/workspaces/${ws}/audit`, s))).body]);
    expect(everything).not.toContain(JIRA_TOKEN);
    expect(everything).not.toContain('svc@acme.test');
    expect(everything).not.toMatch(/secretRef/);
    const dump = JSON.stringify((await sql.query('select * from workspace_docs')).rows) + JSON.stringify((await sql.query('select * from secrets')).rows) + JSON.stringify((await sql.query('select * from audit_log')).rows);
    expect(dump).not.toContain(JIRA_TOKEN);
    expect(dump).not.toContain('svc@acme.test');
    // The source is readable by monitoring through the same connector path as every other connection.
    const run = await sourcesForRun(rt, (await rt.repos.workspaces.get(ws))!, '2026-09-25T10:00:00.000Z');
    expect(run.registry.sources().map((x) => x.id)).toEqual(['jira']);
  });

  it('validates before storing or calling anything', async () => {
    const { app, calls } = await setup();
    const s = await signIn(app, 'code-ana');
    const ws = await workspace(app, s);
    const put = (body: unknown) => app(req('PUT', `/api/workspaces/${ws}/connections`, s, body));
    expect((await put({ ...JIRA, config: { site: 'https://evil.example.com', project: 'SHOP' } })).body).toMatchObject({ code: 'invalid_config' });
    expect((await put({ ...JIRA, credential: { email: 'svc@acme.test' } })).body).toMatchObject({ code: 'invalid_credential' });
    expect((await put({ ...JIRA, credential: { ...JIRA.credential, password: 'x' } })).body).toMatchObject({ code: 'invalid_credential' });
    expect((await put({ ...JIRA, provider: 'zendesk' })).body).toMatchObject({ code: 'unknown_provider' });
    expect(calls).toHaveLength(0);
    expect(((await app(req('GET', `/api/workspaces/${ws}/connections`, s))).body as { connections: unknown[] }).connections).toEqual([]);
  });

  it('a rejected credential → needs reconnect; reconnect rotates the secret in place and recovers', async () => {
    jiraAccepts = JIRA_TOKEN;
    const { app, rt } = await setup();
    const s = await signIn(app, 'code-ana');
    const ws = await workspace(app, s);
    await app(req('PUT', `/api/workspaces/${ws}/connections`, s, JIRA));
    const ref = (await rt.repos.connections.get(ws, 'conn-jira'))!.secretRef!;
    jiraAccepts = JIRA_TOKEN_2; // the provider revokes the old token
    const test = (await app(req('POST', `/api/workspaces/${ws}/connections/conn-jira/check`, s))).body as ConnBody;
    expect(test.check.state).toBe('needs_reconnect');
    expect(test.connection).toMatchObject({ health: 'needs_reconnect', needsReconnect: true });
    const run = await sourcesForRun(rt, (await rt.repos.workspaces.get(ws))!, '2026-09-25T10:00:00.000Z');
    expect(run.registry.sources()).toHaveLength(0);
    const re = (await app(req('POST', `/api/workspaces/${ws}/connections/conn-jira/reconnect`, s, { credential: { email: 'svc@acme.test', apiToken: JIRA_TOKEN_2 } }))).body as ConnBody;
    expect(re.connection).toMatchObject({ health: 'healthy', needsReconnect: false });
    expect((await rt.repos.connections.get(ws, 'conn-jira'))!.secretRef).toBe(ref);
    expect((await rt.secrets.get(ref)).version).toBe(2);
  });

  it('disconnect deletes the credential and turns the source into a named gap', async () => {
    jiraAccepts = JIRA_TOKEN;
    const { app, rt } = await setup();
    const s = await signIn(app, 'code-ana');
    const ws = await workspace(app, s);
    await app(req('PUT', `/api/workspaces/${ws}/connections`, s, JIRA));
    const ref = (await rt.repos.connections.get(ws, 'conn-jira'))!.secretRef!;
    const d = await app(req('DELETE', `/api/workspaces/${ws}/connections/conn-jira`, s));
    expect((d.body as { connection: { health: string } }).connection.health).toBe('not_configured');
    await expect(rt.secrets.get(ref)).rejects.toThrow();
    const run = await sourcesForRun(rt, (await rt.repos.workspaces.get(ws))!, '2026-09-25T10:00:00.000Z');
    expect(run.registry.sources()).toHaveLength(0);
    expect(run.connections[0].state).toBe('not_configured');
    const audit = ((await app(req('GET', `/api/workspaces/${ws}/audit`, s))).body as { entries: { action: string }[] }).entries.map((e) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['connection.connected', 'connection.disconnected']));
  });

  it('permissions and isolation: members read, only owners/admins change; other workspaces see nothing', async () => {
    jiraAccepts = JIRA_TOKEN;
    const { app, rt } = await setup();
    const ana = await signIn(app, 'code-ana');
    const ben = await signIn(app, 'code-ben');
    const cy = await signIn(app, 'code-cy');
    const ws = await workspace(app, ana);
    await app(req('PUT', `/api/workspaces/${ws}/connections`, ana, JIRA));
    const benUser = ((await app(req('GET', '/api/me', ben))).body as { user: { id: string } }).user.id;
    await rt.repos.members.add({ workspaceId: ws, userId: benUser, role: 'member', canApprove: false });
    const ben2 = await signIn(app, 'code-ben'); // memberships are read at sign-in time
    expect((await app(req('GET', `/api/workspaces/${ws}/connections`, ben2))).status).toBe(200);
    expect((await app(req('PUT', `/api/workspaces/${ws}/connections`, ben2, JIRA))).status).toBe(403);
    expect((await app(req('DELETE', `/api/workspaces/${ws}/connections/conn-jira`, ben2))).status).toBe(403);
    expect((await app(req('POST', `/api/workspaces/${ws}/connections/conn-jira/reconnect`, ben2, { credential: JIRA.credential }))).status).toBe(403);
    // Cy's own workspace has the same connection id; neither sees the other's.
    const cyWs = await workspace(app, cy);
    expect((await app(req('GET', `/api/workspaces/${ws}/connections/conn-jira`, cy))).status).toBe(404);
    expect((await app(req('GET', `/api/workspaces/${cyWs}/connections/conn-jira`, cy))).status).toBe(404);
    expect((await app(req('DELETE', `/api/workspaces/${ws}/connections/conn-jira`, cy))).status).toBe(404);
  });

  it('refuses live connections in imported workspaces', async () => {
    const { app } = await setup();
    const s = await signIn(app, 'code-ana');
    const ws = await workspace(app, s, 'imported');
    expect((await app(req('PUT', `/api/workspaces/${ws}/connections`, s, JIRA))).body).toMatchObject({ code: 'wrong_workspace_mode' });
  });

  it('Slack channel: the bot token is verified with auth.test (nothing is sent)', async () => {
    const { app, calls } = await setup();
    const s = await signIn(app, 'code-ana');
    const ws = await workspace(app, s);
    const bad = (await app(req('PUT', `/api/workspaces/${ws}/connections`, s, { provider: 'slack', config: { channel: 'C0123456789' }, credential: { botToken: 'xoxb-bad' } }))).body as ConnBody;
    expect(bad.check.state).toBe('needs_reconnect');
    const good = (await app(req('POST', `/api/workspaces/${ws}/connections/conn-slack/reconnect`, s, { credential: { botToken: 'xoxb-good-test-token' } }))).body as ConnBody;
    expect(good.connection).toMatchObject({ health: 'healthy', account: 'Acme' });
    expect(calls.every((c) => new URL(c.url).pathname === '/api/auth.test')).toBe(true);
  });
});
