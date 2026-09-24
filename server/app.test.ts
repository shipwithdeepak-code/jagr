import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

// The first PGlite instance loads Postgres (WASM) from disk; allow for a cold start.
vi.setConfig({ testTimeout: 30_000 });
import type { IdentityProvider, VerifiedIdentity } from '../src/product/ports/identity';
import { manualClock } from '../src/product/ports/clock';
import { watchFromTemplate } from '../src/product/catalog';
import { freshPglite } from './postgres/pglite';
import { createRuntime, type Runtime } from './runtime';
import { createApp } from './app';
import type { ApiRequest, ApiResponse } from './http/types';
import { hashToken } from './auth';

/**
 * The API end to end, on real Postgres (PGlite) with a fake identity provider standing in for
 * Google / GitHub. Every assertion goes through the HTTP surface a browser would use.
 */

const fixture = JSON.parse(readFileSync('src/product/export/__fixtures__/export-v1.sample.json', 'utf8'));

function fakeIdp(people: Record<string, VerifiedIdentity>): IdentityProvider {
  return {
    id: 'fake',
    authorizationUrl: ({ state }) => `https://idp.example/authorize?state=${state}`,
    exchange: async ({ code }) => {
      const who = people[code];
      if (!who) throw new Error('bad code');
      return who;
    },
  };
}

const PEOPLE: Record<string, VerifiedIdentity> = {
  'code-ana': { provider: 'fake', subject: 'ana-1', email: 'ana@example.com', emailVerified: true, displayName: 'Ana' },
  'code-ben': { provider: 'fake', subject: 'ben-2', email: 'ben@example.com', emailVerified: true, displayName: 'Ben' },
  // Same email as Ana, different account: must NOT become Ana.
  'code-imposter': { provider: 'fake', subject: 'other-3', email: 'ana@example.com', emailVerified: false, displayName: 'Imposter' },
};

async function setup(extraEnv: Record<string, string> = {}) {
  const clock = manualClock('2026-09-25T10:00:00.000Z');
  const rt = await createRuntime(
    { JAGR_SESSION_SECRET: randomBytes(32).toString('hex'), JAGR_SECRET_KEY: randomBytes(32).toString('base64'), CRON_SECRET: 'cron-secret', JAGR_APP_URL: 'https://jagr.test', ...extraEnv },
    { sql: await freshPglite(), clock, identity: { fake: fakeIdp(PEOPLE) } },
  );
  const app = createApp(rt);
  return { rt, app, clock };
}

type Session = { cookie: string; csrf: string };
const req = (method: string, path: string, s?: Session, body?: unknown, extra: Record<string, string> = {}): ApiRequest => {
  const [p, q] = path.split('?');
  return { method, path: p, query: Object.fromEntries(new URLSearchParams(q ?? '')), headers: { ...(s ? { cookie: s.cookie, 'x-jagr-csrf': s.csrf } : {}), ...extra }, body };
};
const cookiesOf = (r: ApiResponse) => Object.fromEntries((r.cookies ?? []).map((c) => c.split(';')[0].split('=')).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

async function signIn(app: ReturnType<typeof createApp>, code: string): Promise<Session> {
  const start = await app(req('GET', '/api/auth/fake/start'));
  expect(start.status).toBe(302);
  const state = new URL(start.headers!.location).searchParams.get('state')!;
  const oauth = cookiesOf(start).jagr_oauth;
  const cb = await app(req('GET', `/api/auth/fake/callback?code=${code}&state=${state}`, undefined, undefined, { cookie: `jagr_oauth=${encodeURIComponent(oauth)}` }));
  expect(cb.status).toBe(302);
  const c = cookiesOf(cb);
  return { cookie: `jagr_session=${c.jagr_session}; jagr_csrf=${c.jagr_csrf}`, csrf: c.jagr_csrf };
}

async function importFixture(app: ReturnType<typeof createApp>, s: Session): Promise<string> {
  const r = await app(req('POST', '/api/import/commit', s, { doc: fixture, confirm: true }));
  expect(r.status).toBe(201);
  return (r.body as { workspace: { id: string } }).workspace.id;
}

describe('auth', () => {
  it('health is public; everything else needs a session', async () => {
    const { app } = await setup();
    expect((await app(req('GET', '/api/health'))).body).toMatchObject({ ok: true, mode: 'multi-tenant', signIn: ['fake'] });
    expect((await app(req('GET', '/api/me'))).status).toBe(401);
  });

  it('sign-in: state + PKCE round trip, httpOnly session cookie, session stored only as a hash', async () => {
    const { app, rt } = await setup();
    const start = await app(req('GET', '/api/auth/fake/start'));
    expect(start.cookies![0]).toMatch(/jagr_oauth=.*HttpOnly.*Secure/);
    const s = await signIn(app, 'code-ana');
    const me = await app(req('GET', '/api/me', s));
    expect(me.body).toMatchObject({ user: { displayName: 'Ana' }, memberships: [] });
    const token = s.cookie.match(/jagr_session=([^;]+)/)![1];
    expect(await rt.repos.sessions.get(token)).toBeNull();
    expect(await rt.repos.sessions.get(hashToken(token))).not.toBeNull();
  });

  it('a callback with a forged or missing state is refused', async () => {
    const { app } = await setup();
    const start = await app(req('GET', '/api/auth/fake/start'));
    const oauth = cookiesOf(start).jagr_oauth;
    expect((await app(req('GET', '/api/auth/fake/callback?code=code-ana&state=forged', undefined, undefined, { cookie: `jagr_oauth=${encodeURIComponent(oauth)}` }))).status).toBe(400);
    expect((await app(req('GET', '/api/auth/fake/callback?code=code-ana&state=x'))).status).toBe(400);
  });

  it('accounts are linked by (provider, subject), never by email', async () => {
    const { app } = await setup();
    const ana = await signIn(app, 'code-ana');
    const imposter = await signIn(app, 'code-imposter');
    const a = (await app(req('GET', '/api/me', ana))).body as { user: { id: string } };
    const b = (await app(req('GET', '/api/me', imposter))).body as { user: { id: string } };
    expect(a.user.id).not.toBe(b.user.id);
  });

  it('state-changing requests need the CSRF token', async () => {
    const { app } = await setup();
    const s = await signIn(app, 'code-ana');
    expect((await app(req('POST', '/api/workspaces', { cookie: s.cookie, csrf: 'wrong' }, { name: 'X' }))).status).toBe(403);
    expect((await app(req('POST', '/api/workspaces', s, { name: 'X' }))).status).toBe(201);
  });

  it('logout revokes the session', async () => {
    const { app } = await setup();
    const s = await signIn(app, 'code-ana');
    expect((await app(req('POST', '/api/auth/logout', s))).status).toBe(200);
    expect((await app(req('GET', '/api/me', s))).status).toBe(401);
  });
});

describe('local → server workspace migration', () => {
  it('dry run → report; commit needs confirmation; a second import is refused', async () => {
    const { app, rt } = await setup();
    const s = await signIn(app, 'code-ana');
    const plan = await app(req('POST', '/api/import/plan', s, { doc: fixture }));
    expect(plan.status).toBe(200);
    expect((plan.body as { report: { ok: boolean; counts: { investigations: number } } }).report).toMatchObject({ ok: true, counts: { investigations: 2 } });
    expect((await app(req('POST', '/api/import/commit', s, { doc: fixture }))).status).toBe(400);
    const id = await importFixture(app, s);
    const ws = (await app(req('GET', `/api/workspaces/${id}`, s))).body as { workspace: { mode: string; importedFrom: { origin: string } }; watches: unknown[]; membership: { role: string; canApprove: boolean } };
    expect(ws.workspace).toMatchObject({ mode: 'sample', importedFrom: { origin: 'browser-local' } });
    expect(ws.watches).toHaveLength(4);
    expect(ws.membership).toMatchObject({ role: 'owner', canApprove: true });
    expect((await app(req('POST', '/api/import/commit', s, { doc: fixture, confirm: true }))).status).toBe(422);
    expect((await rt.repos.audit.list(id)).map((e) => e.action)).toContain('workspace.imported');
  });

  it('the server export of an imported workspace carries no secrets or email addresses', async () => {
    const { app } = await setup();
    const s = await signIn(app, 'code-ana');
    const id = await importFixture(app, s);
    const exp = await app(req('GET', `/api/workspaces/${id}/export`, s));
    expect(exp.status).toBe(200);
    expect(JSON.stringify(exp.body)).not.toMatch(/@example\.com|secretRef|jagr_session/);
  });
});

describe('workspace isolation and approvals', () => {
  it('another user cannot see or touch a workspace they are not a member of', async () => {
    const { app } = await setup();
    const ana = await signIn(app, 'code-ana');
    const ben = await signIn(app, 'code-ben');
    const id = await importFixture(app, ana);
    for (const path of [`/api/workspaces/${id}`, `/api/workspaces/${id}/investigations`, `/api/workspaces/${id}/export`, `/api/workspaces/${id}/audit`]) {
      expect((await app(req('GET', path, ben))).status).toBe(404);
    }
    expect((await app(req('POST', `/api/workspaces/${id}/decisions`, ben, { actionId: 'x', status: 'approved' }))).status).toBe(404);
  });

  it('HIGH-risk approvals are enforced on the server — and recorded with who decided', async () => {
    const { app, rt } = await setup();
    const ana = await signIn(app, 'code-ana');
    const ben = await signIn(app, 'code-ben');
    const id = await importFixture(app, ana);
    const benId = ((await app(req('GET', '/api/me', ben))).body as { user: { id: string } }).user.id;
    await rt.repos.members.add({ workspaceId: id, userId: benId, role: 'member', canApprove: false });
    const benAgain = await signIn(app, 'code-ben');
    const invs = (await app(req('GET', `/api/workspaces/${id}/investigations`, ana))).body as { investigations: { id: string; area: string }[] };
    const checkout = invs.investigations.find((i) => i.area === 'checkout')!;
    const inv = ((await app(req('GET', `/api/workspaces/${id}/investigations/${checkout.id}`, ana))).body as { investigation: { actions: { id: string; kind: string; risk: string }[] } }).investigation;
    const pause = inv.actions.find((a) => a.kind === 'pause_rollout')!;
    expect(pause.risk).toBe('HIGH');
    expect((await app(req('POST', `/api/workspaces/${id}/decisions`, benAgain, { actionId: pause.id, status: 'approved' }))).status).toBe(403);
    expect((await app(req('POST', `/api/workspaces/${id}/decisions`, ana, { actionId: pause.id, status: 'done' }))).status).toBe(409);
    const ok = await app(req('POST', `/api/workspaces/${id}/decisions`, ana, { actionId: pause.id, status: 'approved', optionId: 'android' }));
    expect(ok.status).toBe(200);
    expect((await rt.repos.decisions.list(id)).find((d) => d.actionId === pause.id)).toMatchObject({ status: 'approved', decidedBy: { displayName: 'Ana' } });
    expect((await rt.repos.audit.list(id)).some((e) => e.action === 'decision.approved' && e.target === pause.id)).toBe(true);
  });
});

describe('server-side monitoring', () => {
  it('an imported (sample) workspace runs on demand; investigations and notifications are persisted', async () => {
    const { app, rt } = await setup();
    const s = await signIn(app, 'code-ana');
    const id = await importFixture(app, s);
    const run = await app(req('POST', `/api/workspaces/${id}/runs`, s));
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ workspaceId: id });
    const invs = await rt.repos.investigations.list(id);
    expect(invs.some((i) => i.area === 'checkout' && i.attention === 'HIGH')).toBe(true);
    expect((await rt.repos.notifications.list(id)).length).toBeGreaterThan(0);
    expect((await rt.repos.audit.list(id)).some((e) => e.action === 'monitor.run_now')).toBe(true);
  });

  it('cron: refuses without the secret; ticks the scheduler and drains the queue for connected workspaces', async () => {
    const { app, rt, clock } = await setup();
    expect((await app(req('GET', '/api/cron/tick'))).status).toBe(401);
    const s = await signIn(app, 'code-ana');
    const created = (await app(req('POST', '/api/workspaces', s, { name: 'Acme', mode: 'connected' }))).body as { workspace: { id: string } };
    const id = created.workspace.id;
    await rt.repos.watches.save(id, watchFromTemplate('w-checkout', 'checkout_health', { schedule: { frequency: '15m', dailyAt: '07:00' } }, '2026-09-25T09:00:00.000Z'));
    const cron = { authorization: 'Bearer cron-secret' };
    await app(req('GET', '/api/cron/tick', undefined, undefined, cron));
    clock.set('2026-09-25T10:15:00.000Z');
    const r = await app(req('GET', '/api/cron/tick', undefined, undefined, cron));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ tick: { enqueued: 1 }, run: { done: 1, failed: 0 } });
    expect(await rt.queue.inspect(`${id}:run:w-checkout:2026-09-25T10:15:00.000Z`)).toMatchObject({ state: 'done' });
    // No connectors registered → no sources → nothing investigated, and nothing fabricated.
    expect(await rt.repos.investigations.list(id)).toEqual([]);
  });
});

describe('single-tenant mode', () => {
  it('only the configured owner identity can sign in', async () => {
    const { app } = await setup({ JAGR_MODE: 'single-tenant', JAGR_OWNER_IDENTITIES: 'fake:ana-1' });
    expect((await app(req('GET', '/api/health'))).body).toMatchObject({ mode: 'single-tenant' });
    await signIn(app, 'code-ana');
    const start = await app(req('GET', '/api/auth/fake/start'));
    const state = new URL(start.headers!.location).searchParams.get('state')!;
    const denied = await app(req('GET', `/api/auth/fake/callback?code=code-ben&state=${state}`, undefined, undefined, { cookie: `jagr_oauth=${encodeURIComponent(cookiesOf(start).jagr_oauth)}` }));
    expect(denied.status).toBe(403);
    expect(denied.cookies?.some((c) => c.startsWith('jagr_session='))).toBeFalsy();
  });

  it('refuses to start single-tenant without an owner, or without a session secret', async () => {
    await expect(setup({ JAGR_MODE: 'single-tenant' })).rejects.toThrow(/JAGR_OWNER_IDENTITIES/);
    await expect(createRuntime({ JAGR_SECRET_KEY: randomBytes(32).toString('base64') }, { sql: await freshPglite() })).rejects.toThrow(/JAGR_SESSION_SECRET/);
  });
});

export type { Runtime };
