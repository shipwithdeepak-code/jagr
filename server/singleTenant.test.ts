import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });
import type { IdentityProvider, VerifiedIdentity } from '../src/product/ports/identity';
import type { HttpClient } from '../src/product/ports/http';
import { scriptedHttp } from '../src/product/testkit/connectorContract';
import { manualClock } from '../src/product/ports/clock';
import { sourcesForRun, type Connector } from '../src/product/app/monitoring';
import { freshPglite } from './postgres/pglite';
import type { SqlClient } from './postgres/sql';
import { createRuntime } from './runtime';
import { createApp } from './app';
import { OWNER_WORKSPACE_ID } from './singleTenant';
import type { ApiRequest, ApiResponse } from './http/types';

/** Single-tenant dogfood mode on real Postgres (PGlite): env credentials → encrypted SecretStore, never anywhere else. */

const PEOPLE: Record<string, VerifiedIdentity> = {
  'code-owner': { provider: 'fake', subject: 'owner-1', email: 'owner@example.com', emailVerified: true, displayName: 'Owner' },
  'code-stranger': { provider: 'fake', subject: 'stranger-2', email: 'stranger@example.com', emailVerified: true, displayName: 'Stranger' },
};
const fakeIdp: IdentityProvider = {
  id: 'fake',
  authorizationUrl: ({ state }) => `https://idp.example/authorize?state=${state}`,
  exchange: async ({ code }) => {
    if (!PEOPLE[code]) throw new Error('bad code');
    return PEOPLE[code];
  },
};

const SECRETS = {
  JAGR_AMPLITUDE_API_KEY: 'amp-api-key-7f3a9c',
  JAGR_AMPLITUDE_SECRET_KEY: 'amp-secret-key-51be02',
  JAGR_GITHUB_TOKEN: 'ghp_ownerTokenValue0123456789abcdef',
  JAGR_JIRA_EMAIL: 'owner@example.com',
  JAGR_JIRA_API_TOKEN: 'jira-api-token-99d1e4',
  JAGR_INTERCOM_TOKEN: 'intercom-token-3c0ffee',
  JAGR_SLACK_BOT_TOKEN: 'xoxb-owner-slack-token-42',
};

function baseEnv(sessionSecret: string, secretKey: string, extra: Record<string, string | undefined> = {}) {
  return {
    JAGR_SESSION_SECRET: sessionSecret,
    JAGR_SECRET_KEY: secretKey,
    JAGR_APP_URL: 'https://jagr.test',
    JAGR_MODE: 'single-tenant',
    JAGR_OWNER_IDENTITIES: 'fake:owner-1',
    ...SECRETS,
    JAGR_GITHUB_REPOS: 'acme/web, acme/api',
    JAGR_JIRA_SITE: 'https://acme.atlassian.net',
    JAGR_JIRA_PROJECT: 'SHOP',
    JAGR_SLACK_CHANNEL: 'C0123456789',
    ...extra,
  };
}

async function boot(extra: Record<string, string | undefined> = {}, reuse?: { sql: SqlClient; sessionSecret: string; secretKey: string }, connectors?: Record<string, Connector>, http?: HttpClient) {
  const sql = reuse?.sql ?? (await freshPglite());
  const sessionSecret = reuse?.sessionSecret ?? randomBytes(32).toString('hex');
  const secretKey = reuse?.secretKey ?? randomBytes(32).toString('base64');
  const clock = manualClock('2026-09-25T10:00:00.000Z');
  const rt = await createRuntime(baseEnv(sessionSecret, secretKey, extra), { sql, clock, identity: { fake: fakeIdp }, connectors, http: http ?? (async () => { throw new Error('tests make no network calls'); }) });
  return { rt, app: createApp(rt), sql, sessionSecret, secretKey, clock };
}

const req = (method: string, path: string, s?: { cookie: string; csrf: string }, body?: unknown, extra: Record<string, string> = {}): ApiRequest => {
  const [p, q] = path.split('?');
  return { method, path: p, query: Object.fromEntries(new URLSearchParams(q ?? '')), headers: { ...(s ? { cookie: s.cookie, 'x-jagr-csrf': s.csrf } : {}), ...extra }, body };
};
const cookiesOf = (r: ApiResponse) => Object.fromEntries((r.cookies ?? []).map((c) => c.split(';')[0].split('=')).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

async function signIn(app: ReturnType<typeof createApp>, code: string) {
  const start = await app(req('GET', '/api/auth/fake/start'));
  const state = new URL(start.headers!.location).searchParams.get('state')!;
  const cb = await app(req('GET', `/api/auth/fake/callback?code=${code}&state=${state}`, undefined, undefined, { cookie: `jagr_oauth=${encodeURIComponent(cookiesOf(start).jagr_oauth)}` }));
  if (cb.status !== 302) return { status: cb.status };
  const c = cookiesOf(cb);
  return { status: 302, session: { cookie: `jagr_session=${c.jagr_session}; jagr_csrf=${c.jagr_csrf}`, csrf: c.jagr_csrf } };
}

/** Every row of every table, as text — where a leaked credential would show up. */
async function dumpAll(sql: SqlClient): Promise<string> {
  const tables = ['workspaces', 'users', 'identities', 'memberships', 'sessions', 'workspace_docs', 'audit_log', 'jobs', 'secrets'];
  const out: string[] = [];
  for (const t of tables) out.push(JSON.stringify((await sql.query(`select * from ${t}`)).rows));
  return out.join('\n');
}

const leaks = (text: string) => Object.entries(SECRETS).filter(([, v]) => text.includes(v)).map(([k]) => k);

describe('single-tenant bootstrap', () => {
  it('creates the owner workspace with one connection per configured provider, secrets only in encrypted storage', async () => {
    const { rt, sql } = await boot();
    expect(rt.bootstrap?.configured.sort()).toEqual(['amplitude', 'github', 'intercom', 'jira', 'slack']);
    const ws = await rt.repos.workspaces.get(OWNER_WORKSPACE_ID);
    expect(ws?.mode).toBe('connected');
    const conns = await rt.repos.connections.list(OWNER_WORKSPACE_ID);
    expect(conns.map((c) => c.source).sort()).toEqual(['amplitude', 'github', 'intercom', 'jira', 'slack']);
    for (const c of conns) {
      expect(c.authKind).toBe('owner_env');
      expect(c.secretRef).toBeTruthy();
      expect(JSON.stringify(c)).not.toMatch(/@example\.com/);
    }
    expect(conns.find((c) => c.source === 'github')?.config).toEqual({ repos: ['acme/web', 'acme/api'], auth: 'token' });
    // The database holds no credential in plaintext — not in connections, audit, or the secrets table.
    expect(leaks(await dumpAll(sql))).toEqual([]);
    // …but the store can decrypt them for a connector.
    const gh = conns.find((c) => c.source === 'github')!;
    expect((await rt.secrets.get(gh.secretRef!)).secret).toEqual({ kind: 'api_key', fields: { token: SECRETS.JAGR_GITHUB_TOKEN } });
    const audit = await rt.repos.audit.list(OWNER_WORKSPACE_ID);
    expect(audit.filter((a) => a.action === 'connection.owner_env.configured')).toHaveLength(5);
  });

  it('is idempotent across restarts: same secret refs, nothing rotated', async () => {
    const first = await boot();
    const before = await first.rt.repos.connections.list(OWNER_WORKSPACE_ID);
    const second = await boot({}, first);
    expect(second.rt.bootstrap).toMatchObject({ configured: [], rotated: [], removed: [] });
    const after = await second.rt.repos.connections.list(OWNER_WORKSPACE_ID);
    expect(after.map((c) => c.secretRef)).toEqual(before.map((c) => c.secretRef));
  });

  it('rotates a changed credential in place and removes a deleted one', async () => {
    const first = await boot();
    const ref = (await first.rt.repos.connections.get(OWNER_WORKSPACE_ID, 'owner-intercom'))!.secretRef!;
    const second = await boot({ JAGR_INTERCOM_TOKEN: 'intercom-token-rotated', JAGR_SLACK_BOT_TOKEN: undefined }, first);
    expect(second.rt.bootstrap).toMatchObject({ configured: [], rotated: ['intercom'], removed: ['slack'] });
    const ic = (await second.rt.repos.connections.get(OWNER_WORKSPACE_ID, 'owner-intercom'))!;
    expect(ic.secretRef).toBe(ref);
    expect((await second.rt.secrets.get(ref)).secret).toEqual({ kind: 'api_key', fields: { token: 'intercom-token-rotated' } });
    const slack = (await second.rt.repos.connections.get(OWNER_WORKSPACE_ID, 'owner-slack'))!;
    expect(slack.state).toBe('not_configured');
    expect(slack.secretRef).toBeUndefined();
    expect(slack.detail).toMatch(/JAGR_SLACK_BOT_TOKEN/);
    const rows = (await second.sql.query<{ n: number }>('select count(*)::int as n from secrets')).rows[0].n;
    expect(rows).toBe(4);
    expect(JSON.stringify(await second.rt.repos.audit.list(OWNER_WORKSPACE_ID))).not.toContain('intercom-token-rotated');
  });

  it('only configured owners sign in, and the owner becomes a member of the owner workspace', async () => {
    const { app } = await boot();
    expect((await signIn(app, 'code-stranger')).status).toBe(403);
    const owner = await signIn(app, 'code-owner');
    expect(owner.status).toBe(302);
    const me = await app(req('GET', '/api/me', owner.session));
    expect((me.body as { memberships: { workspaceId: string; role: string }[] }).memberships).toEqual([expect.objectContaining({ workspaceId: OWNER_WORKSPACE_ID, role: 'owner', canApprove: true })]);
    // Signing in again does not duplicate the membership.
    const again = await signIn(app, 'code-owner');
    expect(((await app(req('GET', '/api/me', again.session))).body as { memberships: unknown[] }).memberships).toHaveLength(1);
  });

  it('never sends provider secrets or secret refs to the browser, and exports none', async () => {
    const { app } = await boot();
    const { session } = await signIn(app, 'code-owner');
    const ws = await app(req('GET', `/api/workspaces/${OWNER_WORKSPACE_ID}`, session));
    expect(ws.status).toBe(200);
    const text = JSON.stringify(ws.body);
    expect(leaks(text)).toEqual([]);
    expect(text).not.toMatch(/secretRef|@example\.com/);
    const exp = await app(req('GET', `/api/workspaces/${OWNER_WORKSPACE_ID}/export`, session));
    expect(exp.status).toBe(200);
    expect(leaks(JSON.stringify(exp.body))).toEqual([]);
    expect(JSON.stringify(exp.body)).not.toMatch(/secretRef|@example\.com/);
  });

  it('without a registered connector, a configured source is an honest gap — never sample data', async () => {
    const { rt } = await boot({}, undefined, {});
    const ws = (await rt.repos.workspaces.get(OWNER_WORKSPACE_ID))!;
    const run = await sourcesForRun(rt, ws, '2026-09-25T10:00:00.000Z');
    expect(run.registry.sources().length).toBe(0);
    expect(run.world.metrics).toEqual([]);
    for (const c of run.connections) {
      expect(c.state).toBe('not_configured');
      expect(c.detail).toMatch(/No connector/);
    }
  });

  it('the owner can create a watch from a template over the workspace’s sources', async () => {
    const { app } = await boot();
    const { session } = await signIn(app, 'code-owner');
    const bad = await app(req('POST', `/api/workspaces/${OWNER_WORKSPACE_ID}/watches`, session, { templateId: 'checkout_health', sources: ['ga4'] }));
    expect(bad.status).toBe(400);
    const ok = await app(req('POST', `/api/workspaces/${OWNER_WORKSPACE_ID}/watches`, session, { templateId: 'checkout_health', sources: ['amplitude', 'jira'] }));
    expect(ok.status).toBe(201);
    const watch = (ok.body as { watch: { id: string; sources: string[] } }).watch;
    expect(watch.sources).toEqual(['amplitude', 'jira']);
    expect((await app(req('DELETE', `/api/workspaces/${OWNER_WORKSPACE_ID}/watches/${watch.id}`, session))).status).toBe(200);
  });

  it('checking a connection without a live connector reports it honestly', async () => {
    const { app } = await boot({}, undefined, {});
    const { session } = await signIn(app, 'code-owner');
    const r = await app(req('POST', `/api/workspaces/${OWNER_WORKSPACE_ID}/connections/owner-intercom/check`, session));
    expect(r.status).toBe(200);
    expect((r.body as { check: { state: string; detail: string } }).check).toMatchObject({ state: 'error', detail: expect.stringMatching(/No connector/) });
    expect((await app(req('POST', `/api/workspaces/${OWNER_WORKSPACE_ID}/connections/nope/check`, session))).status).toBe(404);
  });

  it('a registered connector with unusable configuration is an error gap, not data', async () => {
    const { rt } = await boot({ JAGR_AMPLITUDE_METRICS: '{not json' });
    const ws = (await rt.repos.workspaces.get(OWNER_WORKSPACE_ID))!;
    const run = await sourcesForRun(rt, ws, '2026-09-25T10:00:00.000Z');
    const amp = run.connections.find((c) => c.provider === 'amplitude')!;
    expect(amp.state).toBe('error');
    expect(amp.detail).toMatch(/configuration is invalid/);
    expect(run.registry.sources().map((s) => s.id)).not.toContain('amplitude');
  });

  it('Slack is outbound only: a delivery log to read, and no endpoint that could approve anything from Slack', async () => {
    const { http, calls } = scriptedHttp((u) => (u.hostname === 'slack.com' && u.pathname === '/api/auth.test' ? { body: { ok: false, error: 'invalid_auth' } } : undefined));
    const { app } = await boot({}, undefined, undefined, http);
    const { session } = await signIn(app, 'code-owner');
    const log = await app(req('GET', `/api/workspaces/${OWNER_WORKSPACE_ID}/notifications`, session));
    expect(log.status).toBe(200);
    expect(log.body).toEqual({ notifications: [] });
    for (const path of ['/api/slack/interactions', '/api/slack/events', '/api/slack/commands']) expect((await app(req('POST', path, session, {}))).status).toBe(404);
    const check = await app(req('POST', `/api/workspaces/${OWNER_WORKSPACE_ID}/connections/owner-slack/check`, session));
    // The check verifies the bot token with auth.test (sending nothing); the test token is not a real one.
    expect((check.body as { check: { state: string; detail: string } }).check).toMatchObject({ state: 'needs_reconnect', detail: expect.stringMatching(/invalid_auth/) });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/api/auth.test']);
  });
});
