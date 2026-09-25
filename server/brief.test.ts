import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });
import type { IdentityProvider } from '../src/product/ports/identity';
import type { HttpRequest } from '../src/product/ports/http';
import { manualClock } from '../src/product/ports/clock';
import { composeBriefJob } from '../src/product/app/monitoring';
import type { BriefView } from '../src/product/view/brief';
import type { WorkspaceSnapshot } from '../src/product/app/workspaceSnapshot';
import { productStateFromSnapshot } from '../src/product/app/workspaceSnapshot';
import { scriptedHttp, type Reply } from '../src/product/testkit/connectorContract';
import { freshPglite } from './postgres/pglite';
import { createRuntime } from './runtime';
import { createApp } from './app';
import type { ApiRequest, ApiResponse } from './http/types';

/** The morning brief on a server workspace: composed from the same investigations and attention model, stored, served, and sent to Slack. */

const NOW = '2026-09-25T10:00:00.000Z';
const issues = ['09:05', '09:15', '09:25', '09:40', '09:50'].map((t, i) => ({ key: `SHOP-${600 + i}`, fields: { summary: `Checkout payment fails on submit (${i + 1})`, created: `2026-09-25T${t}:00.000+0000`, issuetype: { name: 'Bug' }, priority: { name: 'High' }, components: [{ name: 'Checkout' }], labels: [], versions: [] } }));
const posts: { text: string; blocks: unknown[] }[] = [];
const route = (u: URL, init?: HttpRequest): Reply | undefined => {
  if (u.hostname === 'slack.com' && u.pathname === '/api/auth.test') return { body: { ok: true, team: 'Acme' } };
  if (u.hostname === 'slack.com' && u.pathname === '/api/chat.postMessage') {
    posts.push(JSON.parse(String(init?.body)));
    return { body: { ok: true, ts: '1.1' } };
  }
  if (u.hostname !== 'acme.atlassian.net') return undefined;
  if (u.pathname === '/rest/api/3/project/SHOP') return { body: { key: 'SHOP' } };
  if (u.pathname === '/rest/api/3/search/jql' && init?.method === 'POST') return { body: { issues, isLast: true } };
  if (u.pathname === '/rest/api/3/project/SHOP/versions') return { body: [] };
  return undefined;
};

async function setup(briefMin: 'MEDIUM' | 'HIGH') {
  posts.length = 0;
  const idp: IdentityProvider = { id: 'fake', authorizationUrl: ({ state }) => `https://idp.example/a?state=${state}`, exchange: async () => ({ provider: 'fake', subject: 'ana-1', emailVerified: true, displayName: 'Ana' }) };
  const clock = manualClock(NOW);
  const rt = await createRuntime({ JAGR_SESSION_SECRET: randomBytes(32).toString('hex'), JAGR_SECRET_KEY: randomBytes(32).toString('base64'), JAGR_APP_URL: 'https://jagr.test' }, { sql: await freshPglite(), clock, identity: { fake: idp }, http: scriptedHttp(route).http });
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
  await app(req('PUT', `/api/workspaces/${ws}/connections`, s, { provider: 'jira', config: { site: 'https://acme.atlassian.net', project: 'SHOP' }, credential: { email: 'svc@acme.test', apiToken: 'ATATT-brief-test' } }));
  await app(req('PUT', `/api/workspaces/${ws}/connections`, s, { provider: 'slack', config: { channel: 'C0123456789' }, credential: { botToken: 'xoxb-brief-test' } }));
  await app(req('POST', `/api/workspaces/${ws}/watches`, s, { templateId: 'customer_issues', sources: ['jira'], notificationPolicy: { interruptAt: 'HIGH', briefMin, morningBrief: true } }));
  await app(req('POST', `/api/workspaces/${ws}/runs`, s));
  clock.set('2026-09-25T10:05:00.000Z');
  await composeBriefJob(rt, { workspaceId: ws, payload: { dueAt: '2026-09-25T10:05:00.000Z' } });
  return { app, req, s, ws };
}

describe('morning brief (server workspace)', () => {
  it('is composed, stored and served from the same investigations and attention; the Slack brief says the same things', async () => {
    const { app, req, s, ws } = await setup('MEDIUM');
    const snap = (await app(req('GET', `/api/workspaces/${ws}/snapshot`, s))).body as WorkspaceSnapshot;
    expect(snap.briefs).toHaveLength(1);
    const inv = snap.investigations[0];
    const r = await app(req('GET', `/api/workspaces/${ws}/briefs/latest`, s));
    expect(r.status).toBe(200);
    const v = r.body as BriefView;
    expect(v.headline).toBe('1 thing needs your attention.');
    expect(v.items).toHaveLength(1);
    expect(v.items[0]).toMatchObject({ investigationId: inv.id, attention: inv.attention, uncertainty: inv.uncertainty, next: inv.recommendedNextStep });
    expect(v.items[0].whatChanged).toMatch(/since \d{2}:\d{2} UTC/);
    // One Slack brief, with the same item, a deep link to it, and the same uncertainty.
    const brief = posts.filter((p) => /Good morning/.test(p.text));
    expect(brief).toHaveLength(1);
    const text = JSON.stringify(brief[0].blocks);
    expect(text).toContain(`https://jagr.test${inv.jagrPath}`);
    expect(text).toContain(inv.recommendedNextStep.slice(0, 30));
    expect(text).toContain(inv.uncertainty.slice(0, 30));
    // The browser renders the brief from the snapshot.
    const local = productStateFromSnapshot(snap, { emailFrom: 'x' });
    expect(local.result?.briefs).toHaveLength(1);
  });

  it('does not create noise: items below the watch’s brief level stay out; quiet signals are counted', async () => {
    const { app, req, s, ws } = await setup('HIGH');
    const v = (await app(req('GET', `/api/workspaces/${ws}/briefs/latest`, s))).body as BriefView;
    expect(v.headline).toBe('Nothing needs your attention.');
    expect(v.items).toEqual([]);
    expect(v.quiet.signals).toBeGreaterThanOrEqual(0);
    expect(posts.filter((p) => /Good morning/.test(p.text))).toHaveLength(1);
  });

  it('a workspace with no brief yet says so', async () => {
    const { app, req, s } = await setup('MEDIUM');
    const other = ((await app(req('POST', '/api/workspaces', s, { name: 'Empty' }))).body as { workspace: { id: string } }).workspace.id;
    expect((await app(req('GET', `/api/workspaces/${other}/briefs/latest`, s))).status).toBe(404);
  });
});
