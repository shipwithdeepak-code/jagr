import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });
import type { IdentityProvider } from '../src/product/ports/identity';
import type { HttpClient, HttpRequest } from '../src/product/ports/http';
import { manualClock } from '../src/product/ports/clock';
import type { InvestigationReplay } from '../src/product/app/replay';
import type { WorkspaceSnapshot } from '../src/product/app/workspaceSnapshot';
import { response, type Reply } from '../src/product/testkit/connectorContract';
import { freshPglite } from './postgres/pglite';
import { createRuntime } from './runtime';
import { createApp } from './app';
import type { ApiRequest, ApiResponse } from './http/types';

/** Replay is built from the stored investigation only: it works — and calls nothing — when every provider is down. */

const NOW = '2026-09-25T10:00:00.000Z';
const issues = ['09:05', '09:15', '09:25', '09:40', '09:50'].map((t, i) => ({ key: `SHOP-${500 + i}`, fields: { summary: `Checkout payment fails on submit (${i + 1})`, created: `2026-09-25T${t}:00.000+0000`, issuetype: { name: 'Bug' }, priority: { name: 'High' }, components: [{ name: 'Checkout' }], labels: [], versions: [] } }));
const jira = (u: URL, init?: HttpRequest): Reply | undefined => {
  if (u.hostname !== 'acme.atlassian.net') return undefined;
  if (u.pathname === '/rest/api/3/project/SHOP') return { body: { key: 'SHOP' } };
  if (u.pathname === '/rest/api/3/search/jql' && init?.method === 'POST') return { body: { issues, isLast: true } };
  if (u.pathname === '/rest/api/3/project/SHOP/versions') return { body: [] };
  return undefined;
};

async function setup() {
  let up = true;
  const calls: string[] = [];
  const http: HttpClient = async (url, init) => {
    calls.push(url);
    if (!up) throw new TypeError('fetch failed: provider unreachable');
    return response(jira(new URL(url), init) ?? { status: 404, body: {} });
  };
  const idp: IdentityProvider = { id: 'fake', authorizationUrl: ({ state }) => `https://idp.example/a?state=${state}`, exchange: async () => ({ provider: 'fake', subject: 'ana-1', emailVerified: true, displayName: 'Ana' }) };
  const clock = manualClock(NOW);
  const rt = await createRuntime({ JAGR_SESSION_SECRET: randomBytes(32).toString('hex'), JAGR_SECRET_KEY: randomBytes(32).toString('base64'), JAGR_APP_URL: 'https://jagr.test' }, { sql: await freshPglite(), clock, identity: { fake: idp }, http });
  const app = createApp(rt);
  const req = (method: string, path: string, s?: { cookie: string; csrf: string }, body?: unknown, extra: Record<string, string> = {}): ApiRequest => {
    const [p, q] = path.split('?');
    return { method, path: p, query: Object.fromEntries(new URLSearchParams(q ?? '')), headers: { ...(s ? { cookie: s.cookie, 'x-jagr-csrf': s.csrf } : {}), ...extra }, body };
  };
  const cookiesOf = (r: ApiResponse) => Object.fromEntries((r.cookies ?? []).map((c) => c.split(';')[0].split('=')).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  const start = await app(req('GET', '/api/auth/fake/start'));
  const state = new URL(start.headers!.location).searchParams.get('state')!;
  const cb = await app(req('GET', `/api/auth/fake/callback?code=x&state=${state}`, undefined, undefined, { cookie: `jagr_oauth=${encodeURIComponent(cookiesOf(start).jagr_oauth)}` }));
  const c = cookiesOf(cb);
  const s = { cookie: `jagr_session=${c.jagr_session}; jagr_csrf=${c.jagr_csrf}`, csrf: c.jagr_csrf };
  const ws = ((await app(req('POST', '/api/workspaces', s, { name: 'Acme' }))).body as { workspace: { id: string } }).workspace.id;
  await app(req('PUT', `/api/workspaces/${ws}/connections`, s, { provider: 'jira', config: { site: 'https://acme.atlassian.net', project: 'SHOP' }, credential: { email: 'svc@acme.test', apiToken: 'ATATT-replay-test' } }));
  await app(req('POST', `/api/workspaces/${ws}/watches`, s, { templateId: 'customer_issues', sources: ['jira'] }));
  await app(req('POST', `/api/workspaces/${ws}/runs`, s));
  const inv = ((await app(req('GET', `/api/workspaces/${ws}/snapshot`, s))).body as WorkspaceSnapshot).investigations[0];
  return { app, req, s, ws, inv, calls, setUp: (v: boolean) => (up = v), clock };
}

describe('investigation replay', () => {
  it('replays the original investigation from storage, with every provider down and the source disconnected — no calls made', async () => {
    const { app, req, s, ws, inv, calls, setUp } = await setup();
    expect(inv).toBeDefined();
    const before = ((await app(req('GET', `/api/workspaces/${ws}/investigations/${inv.id}/replay`, s))).body as InvestigationReplay);
    setUp(false);
    await app(req('DELETE', `/api/workspaces/${ws}/connections/conn-jira`, s));
    calls.length = 0;
    const r = await app(req('GET', `/api/workspaces/${ws}/investigations/${inv.id}/replay`, s));
    expect(r.status).toBe(200);
    const replay = r.body as InvestigationReplay;
    expect(calls).toEqual([]);
    expect(replay).toMatchObject({ kind: 'original', investigationId: inv.id });
    expect(replay.frames.length).toBeGreaterThan(3);
    // Every frame is a recorded step (or a recorded human decision) — nothing re-enacted.
    const stepIds = new Set(inv.trace.map((t) => t.id));
    for (const f of replay.frames) expect(stepIds.has(f.stepId) || f.stepId.startsWith('decision')).toBe(true);
    // The evidence snapshot is served as recorded, and still says it was read live.
    expect(replay.evidence.find((e) => e.provider === 'jira' && e.direction !== 'gap')!.provenance!.mode).toBe('connected');
    expect(replay).toEqual(before);
  });

  it('"run again" is a separate, new run; the original pass is kept exactly as recorded', async () => {
    const { app, req, s, ws, inv, setUp, clock } = await setup();
    const original = ((await app(req('GET', `/api/workspaces/${ws}/investigations/${inv.id}/replay?pass=1`, s))).body as InvestigationReplay);
    setUp(false);
    clock.set('2026-09-25T10:30:00.000Z');
    const again = await app(req('POST', `/api/workspaces/${ws}/investigations/${inv.id}/rerun`, s));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ kind: 'run_again' });
    const after = ((await app(req('GET', `/api/workspaces/${ws}/investigations/${inv.id}/replay?pass=1`, s))).body as InvestigationReplay);
    expect(after.frames).toEqual(original.frames);
    expect(after.passes.length).toBeGreaterThanOrEqual(original.passes.length);
  });

  it('unknown investigations are 404; other workspaces cannot replay them', async () => {
    const { app, req, s, ws } = await setup();
    expect((await app(req('GET', `/api/workspaces/${ws}/investigations/nope/replay`, s))).status).toBe(404);
    expect((await app(req('GET', `/api/workspaces/ws_other/investigations/nope/replay`, s))).status).toBe(404);
  });
});
