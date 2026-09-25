import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });
import type { IdentityProvider, VerifiedIdentity } from '../src/product/ports/identity';
import type { HttpRequest } from '../src/product/ports/http';
import { manualClock } from '../src/product/ports/clock';
import { productStateFromSnapshot, type WorkspaceSnapshot } from '../src/product/app/workspaceSnapshot';
import { scriptedHttp, type Reply } from '../src/product/testkit/connectorContract';
import { freshPglite } from './postgres/pglite';
import { createRuntime } from './runtime';
import { createApp } from './app';
import type { ApiRequest, ApiResponse } from './http/types';

/**
 * The server workspace path the browser uses: list / open / snapshot, connect, watches, run, investigations,
 * approvals, settings, imports — through the HTTP API on real Postgres (PGlite).
 */

const PEOPLE: Record<string, VerifiedIdentity> = {
  'code-ana': { provider: 'fake', subject: 'ana-1', emailVerified: true, displayName: 'Ana' },
  'code-ben': { provider: 'fake', subject: 'ben-2', emailVerified: true, displayName: 'Ben' },
};
const idp: IdentityProvider = { id: 'fake', authorizationUrl: ({ state }) => `https://idp.example/authorize?state=${state}`, exchange: async ({ code }) => PEOPLE[code] ?? Promise.reject(new Error('bad code')) };
const NOW = '2026-09-25T10:00:00.000Z';

// Jira: five checkout bugs in the last hour (well above the usual rate), with a customer email in one summary.
const issues = ['09:05', '09:15', '09:25', '09:40', '09:50'].map((t, i) => ({
  key: `SHOP-${300 + i}`,
  fields: { summary: `Checkout payment fails on submit (${i + 1})${i === 0 ? ' — reported by jo@acme.test' : ''}`, created: `2026-09-25T${t}:00.000+0000`, issuetype: { name: 'Bug' }, priority: { name: 'High' }, components: [{ name: 'Checkout' }], labels: [], versions: [] },
}));
const route = (u: URL, init?: HttpRequest): Reply | undefined => {
  if (u.hostname !== 'acme.atlassian.net') return undefined;
  if (u.pathname === '/rest/api/3/project/SHOP') return { body: { key: 'SHOP' } };
  if (u.pathname === '/rest/api/3/search/jql' && init?.method === 'POST') return { body: { issues, isLast: true } };
  if (u.pathname === '/rest/api/3/project/SHOP/versions') return { body: [] };
  return undefined;
};

async function setup() {
  const clock = manualClock(NOW);
  const rt = await createRuntime({ JAGR_SESSION_SECRET: randomBytes(32).toString('hex'), JAGR_SECRET_KEY: randomBytes(32).toString('base64'), JAGR_APP_URL: 'https://jagr.test' }, { sql: await freshPglite(), clock, identity: { fake: idp }, http: scriptedHttp(route).http });
  return { rt, app: createApp(rt), clock };
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

describe('server workspace (the browser path)', () => {
  it('sign in → create → connect → watch → run → investigation → approval, all visible in one snapshot', async () => {
    const { app } = await setup();
    const ana = await signIn(app, 'code-ana');
    const ws = ((await app(req('POST', '/api/workspaces', ana, { name: 'Acme', mode: 'connected' }))).body as { workspace: { id: string } }).workspace.id;
    expect(((await app(req('GET', '/api/workspaces', ana))).body as { workspaces: { id: string; role: string }[] }).workspaces).toEqual([expect.objectContaining({ id: ws, role: 'owner', mode: 'connected' })]);

    const conn = await app(req('PUT', `/api/workspaces/${ws}/connections`, ana, { provider: 'jira', config: { site: 'https://acme.atlassian.net', project: 'SHOP' }, credential: { email: 'svc@acme.test', apiToken: 'ATATT-test-token-value' } }));
    expect((conn.body as { connection: { health: string } }).connection.health).toBe('healthy');

    const w = await app(req('POST', `/api/workspaces/${ws}/watches`, ana, { templateId: 'customer_issues', sources: ['jira'], name: 'Checkout issues', schedule: { frequency: '30m', dailyAt: '07:00' } }));
    expect(w.status).toBe(201);
    const watch = (w.body as { watch: { id: string; name: string; schedule: { frequency: string } } }).watch;
    expect(watch).toMatchObject({ name: 'Checkout issues', schedule: { frequency: '30m' } });

    const run = await app(req('POST', `/api/workspaces/${ws}/runs`, ana));
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ watches: 1 });
    expect((run.body as { investigations: number }).investigations).toBeGreaterThan(0);

    const snap = (await app(req('GET', `/api/workspaces/${ws}/snapshot`, ana))).body as WorkspaceSnapshot;
    expect(snap.workspace).toMatchObject({ id: ws, name: 'Acme', mode: 'connected' });
    expect(snap.membership).toEqual({ role: 'owner', canApprove: true });
    expect(snap.connections.map((c) => [c.provider, c.health])).toEqual([['jira', 'healthy']]);
    expect(snap.investigations.length).toBeGreaterThan(0);
    const text = JSON.stringify(snap);
    expect(text).not.toMatch(/secretRef|ATATT-test-token|svc@acme\.test|jo@acme\.test/);

    // Approvals go through the same gate as the engine.
    const inv = snap.investigations[0];
    const action = inv.actions.find((a) => a.status !== 'executed') ?? inv.actions[0];
    const d = await app(req('POST', `/api/workspaces/${ws}/decisions`, ana, { actionId: action.id, status: 'approved' }));
    expect(d.status).toBe(200);
    const after = (await app(req('GET', `/api/workspaces/${ws}/snapshot`, ana))).body as WorkspaceSnapshot;
    expect(after.decisions).toEqual([expect.objectContaining({ actionId: action.id, status: 'approved', decidedBy: 'Ana' })]);

    // The browser maps it onto the same state shape as a browser-local workspace.
    const local = productStateFromSnapshot(after, { emailFrom: 'jagr@test' });
    expect(local.connections.map((c) => [c.provider, c.state])).toEqual([['jira', 'connected'], ['email', 'simulated']]);
    expect(local.result?.investigations.map((i) => i.id)).toEqual(after.investigations.map((i) => i.id));
    expect(local.decisions[action.id].status).toBe('approved');
    expect(local.result?.actions.length).toBeGreaterThan(0);
    // Never labelled simulated: the data came from a connected source.
    expect(local.result?.planner).toMatchObject({ data: 'live', mode: 'deterministic' });

    // Pause / resume a watch.
    expect(((await app(req('PATCH', `/api/workspaces/${ws}/watches/${watch.id}`, ana, { status: 'paused' }))).body as { watch: { status: string } }).watch.status).toBe('paused');
    expect((await app(req('PATCH', `/api/workspaces/${ws}/watches/${watch.id}`, ana, { status: 'bogus' }))).status).toBe(400);
  });

  it('settings: owners change them (optimistic), members cannot; AI egress off is stored', async () => {
    const { app, rt } = await setup();
    const ana = await signIn(app, 'code-ana');
    const ben = await signIn(app, 'code-ben');
    const ws = ((await app(req('POST', '/api/workspaces', ana, { name: 'Acme' }))).body as { workspace: { id: string } }).workspace.id;
    const r = await app(req('PATCH', `/api/workspaces/${ws}`, ana, { aiEgressAllowed: false, brief: { enabled: true, time: '07:30', timezone: 'Europe/London' } }));
    expect(r.status).toBe(200);
    expect((await rt.repos.workspaces.get(ws))!.settings.aiEgressAllowed).toBe(false);
    const benId = ((await app(req('GET', '/api/me', ben))).body as { user: { id: string } }).user.id;
    await rt.repos.members.add({ workspaceId: ws, userId: benId, role: 'member', canApprove: false });
    const ben2 = await signIn(app, 'code-ben');
    expect((await app(req('PATCH', `/api/workspaces/${ws}`, ben2, { name: 'Mine' }))).status).toBe(403);
    // Ben's list shows the shared workspace only as a member.
    expect(((await app(req('GET', '/api/workspaces', ben2))).body as { workspaces: { id: string; role: string }[] }).workspaces).toEqual([expect.objectContaining({ id: ws, role: 'member' })]);
  });

  it('imported server workspace: upload CSVs, create a watch over the imported channels, run, investigate', async () => {
    const { app } = await setup();
    const ana = await signIn(app, 'code-ana');
    const ws = ((await app(req('POST', '/api/workspaces', ana, { name: 'Files', mode: 'imported' }))).body as { workspace: { id: string } }).workspace.id;
    for (const kind of ['metrics', 'issues', 'releases'] as const) {
      const r = await app(req('POST', `/api/workspaces/${ws}/imports`, ana, { kind, filename: `${kind}.csv`, text: readFileSync(`public/samples/${kind}.csv`, 'utf8') }));
      expect(r.status).toBe(201);
    }
    expect((await app(req('POST', `/api/workspaces/${ws}/imports`, ana, { kind: 'metrics', filename: 'x.json', text: '{not json' }))).status).toBe(422);
    const snap0 = (await app(req('GET', `/api/workspaces/${ws}/snapshot`, ana))).body as WorkspaceSnapshot;
    expect(snap0.imports.map((i) => i.kind).sort()).toEqual(['issues', 'metrics', 'releases']);
    const w = await app(req('POST', `/api/workspaces/${ws}/watches`, ana, { templateId: 'checkout_health' }));
    expect(w.status).toBe(201);
    expect((await app(req('POST', `/api/workspaces/${ws}/runs`, ana))).status).toBe(200);
    const snap = (await app(req('GET', `/api/workspaces/${ws}/snapshot`, ana))).body as WorkspaceSnapshot;
    expect(snap.investigations.length).toBeGreaterThan(0);
    // Imported data is never presented as connected.
    expect(snap.connections).toEqual([]);
    // Live connections are refused here.
    expect((await app(req('PUT', `/api/workspaces/${ws}/connections`, ana, { provider: 'jira', config: {}, credential: {} }))).status).toBe(409);
  });
});
