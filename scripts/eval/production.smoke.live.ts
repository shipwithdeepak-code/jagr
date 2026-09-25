import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { IdentityProvider } from '../../src/product/ports/identity';
import type { HttpClient, HttpRequest } from '../../src/product/ports/http';
import { manualClock } from '../../src/product/ports/clock';
import { response } from '../../src/product/testkit/connectorContract';
import { createRuntime } from '../../server/runtime';
import { createApp } from '../../server/app';
import { serveApi } from '../../server/http/api';
import { pgClient } from '../../server/postgres/sql';

/**
 * MANUAL production smoke test — never part of `npm test`.
 *
 * Part 1 · the deployed backend (JAGR_SMOKE_URL, e.g. https://jagr.vercel.app): public checks only —
 *   health, planner, auth redirect, 401s, cron refusal, and the client bundle for secrets. Needs nothing.
 *
 * Part 2 · the Vercel function itself (api/[...route].ts, the production runtime from the environment)
 *   against a real Postgres (JAGR_SMOKE_DATABASE_URL — not DATABASE_URL, which the Vite config also reads): starts, migrates, answers health and refuses cron without the secret.
 *
 * Part 3 · the full lifecycle on that Postgres over real HTTP with real cookies, reading GitHub LIVE, through
 *   the same runtime and app the function composes. Two stand-ins, both named
 *   in the output: sign-in (an OAuth provider needs a person at a browser) and the Jira signal (GitHub is a
 *   change source; an investigation starts from a signal such as issues).
 *
 *   JAGR_LIVE_EVAL=1 JAGR_SMOKE_URL=https://jagr.vercel.app JAGR_SMOKE_DATABASE_URL=postgres://… DATABASE_SSL=disable \
 *   JAGR_SMOKE_GITHUB_REPO=owner/repo JAGR_SMOKE_GITHUB_ENV=Production JAGR_GITHUB_TOKEN=… \
 *     npx vitest run scripts/eval/production.smoke.live.ts --reporter=verbose --silent=false
 *
 * The GitHub token is read from the environment and never printed.
 */

const log = (s: string) => console.log(s);

describe.runIf(!!process.env.JAGR_SMOKE_URL)('deployed backend (public checks)', () => {
  const base = (process.env.JAGR_SMOKE_URL ?? '').replace(/\/$/, '');
  const get = (p: string, init?: RequestInit) => fetch(`${base}${p}`, { redirect: 'manual', ...init });

  it('health, planner, auth redirect, authentication, cron, client bundle', { timeout: 120_000 }, async () => {
    const health = await get('/api/health');
    const hBody = await health.text();
    log(`health ${health.status} ${hBody.slice(0, 160)}`);
    expect(health.status).toBe(200);
    const h = JSON.parse(hBody) as { ok: boolean; mode: string; signIn: string[] };
    expect(h.ok).toBe(true);
    expect(h.signIn.length).toBeGreaterThan(0);

    const planner = await get('/api/planner/health');
    log(`planner ${planner.status} ${(await planner.text()).slice(0, 160)}`);
    expect(planner.status).toBe(200);

    for (const p of ['/api/me', '/api/workspaces', '/api/connection-types', '/api/workspaces/x/snapshot', '/api/workspaces/x/connections']) {
      const r = await get(p);
      log(`${p} ${r.status} (no session)`);
      expect(r.status).toBe(401);
    }
    const cron = await get('/api/cron/tick');
    log(`/api/cron/tick ${cron.status} (no secret)`);
    expect(cron.status).toBe(401);
    const wrongCron = await get('/api/cron/tick', { headers: { authorization: 'Bearer not-the-secret' } });
    expect(wrongCron.status).toBe(401);

    for (const provider of h.signIn) {
      const start = await get(`/api/auth/${provider}/start?returnTo=/settings`);
      const loc = start.headers.get('location') ?? '';
      const setCookie = start.headers.get('set-cookie') ?? '';
      log(`auth ${provider}: ${start.status} → ${new URL(loc).origin} · state cookie ${/HttpOnly/i.test(setCookie) ? 'HttpOnly' : 'NOT HttpOnly'}${/Secure/i.test(setCookie) ? ' Secure' : ''}`);
      expect(start.status).toBe(302);
      expect(new URL(loc).searchParams.get('state')).toBeTruthy();
      expect(new URL(loc).searchParams.get('redirect_uri')).toBe(`${base}/api/auth/${provider}/callback`);
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/Secure/i);
    }

    // The client bundle carries no secret material.
    const html = await (await get('/')).text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
    expect(assets.length).toBeGreaterThan(0);
    const SECRET = /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bp]-[0-9A-Za-z-]{10,}|sk-ant-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{32,}|ATATT[A-Za-z0-9_-]{20,}|postgres(?:ql)?:\/\/[^\s"'`]*@|-----BEGIN [A-Z ]*PRIVATE KEY-----|JAGR_SESSION_SECRET|JAGR_SECRET_KEY|CRON_SECRET|GOOGLE_CLIENT_SECRET|GITHUB_OAUTH_CLIENT_SECRET)/;
    for (const a of assets) {
      const js = await (await get(a)).text();
      const hit = js.match(SECRET);
      log(`bundle ${a} ${Math.round(js.length / 1024)} KB · ${hit ? `SECRET-LIKE: ${hit[0].slice(0, 12)}…` : 'no secrets'}`);
      expect(hit).toBeNull();
    }
  });
});

describe.runIf(!!process.env.JAGR_SMOKE_DATABASE_URL && process.env.JAGR_LIVE_EVAL === '1')('the Vercel function on Postgres', () => {
  it('starts from the environment, migrates, answers', { timeout: 120_000 }, async () => {
    const env = { DATABASE_URL: process.env.JAGR_SMOKE_DATABASE_URL, JAGR_SESSION_SECRET: randomBytes(32).toString('hex'), JAGR_SECRET_KEY: randomBytes(32).toString('base64'), CRON_SECRET: randomBytes(24).toString('hex'), JAGR_APP_URL: 'https://jagr.example', GOOGLE_CLIENT_ID: 'smoke-client-id', GOOGLE_CLIENT_SECRET: 'smoke-client-secret' };
    Object.assign(process.env, env);
    const { default: handler } = await import('../../api/[...route]');
    const server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const health = await fetch(`${base}/api/health`);
      const body = await health.text();
      log(`function /api/health ${health.status} ${body}`);
      expect(health.status).toBe(200);
      expect(JSON.parse(body)).toMatchObject({ ok: true, mode: 'multi-tenant', signIn: ['google'] });
      expect((await fetch(`${base}/api/cron/tick`)).status).toBe(401);
      const cron = await fetch(`${base}/api/cron/tick`, { headers: { authorization: `Bearer ${env.CRON_SECRET}` } });
      log(`function /api/cron/tick with secret ${cron.status} ${(await cron.text()).slice(0, 160)}`);
      expect(cron.status).toBe(200);
      const start = await fetch(`${base}/api/auth/google/start?returnTo=/settings`, { redirect: 'manual' });
      const loc = new URL(start.headers.get('location') ?? '');
      log(`function google sign-in → ${loc.origin}${loc.pathname} redirect_uri=${loc.searchParams.get('redirect_uri')} · cookie ${start.headers.get('set-cookie')?.replace(/=[^;]+/, '=…')}`);
      expect(loc.origin).toBe('https://accounts.google.com');
      expect(loc.searchParams.get('redirect_uri')).toBe('https://jagr.example/api/auth/google/callback');
    } finally {
      server.close();
    }
  });
});

describe.runIf(!!process.env.JAGR_SMOKE_DATABASE_URL && process.env.JAGR_LIVE_EVAL === '1')('full lifecycle on Postgres, GitHub live', () => {
  it('sign in → workspace → GitHub → watch → run → investigation → approvals → cron → disconnect → audit', { timeout: 300_000 }, async () => {
    const repo = process.env.JAGR_SMOKE_GITHUB_REPO ?? 'shipwithdeepak-code/jagr';
    const environment = process.env.JAGR_SMOKE_GITHUB_ENV ?? 'Production';
    const githubToken = process.env.JAGR_GITHUB_TOKEN ?? '';
    expect(githubToken, 'set JAGR_GITHUB_TOKEN (read-only fine-grained token) for the live GitHub step').not.toBe('');

    // ── Real Postgres through the production pool settings ──
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: process.env.JAGR_SMOKE_DATABASE_URL, max: 3, ssl: process.env.DATABASE_SSL === 'disable' ? undefined : { rejectUnauthorized: process.env.DATABASE_SSL !== 'no-verify' } });
    await pool.query('select 1');

    // Every outbound call is real except the scripted Jira host; we record which hosts were really read.
    const live = new Map<string, number>();
    const jiraCalls: string[] = [];
    const now = Date.now();
    const deployments = (await (await fetch(`https://api.github.com/repos/${repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=5`, { headers: { authorization: `Bearer ${githubToken}`, accept: 'application/vnd.github+json' } })).json()) as { id: number; created_at: string }[];
    expect(Array.isArray(deployments) && deployments.length, `${repo} has no "${environment}" deployments to correlate`).toBeTruthy();
    const deployedAt = Date.parse(deployments[0].created_at);
    log(`GitHub (live): latest ${environment} deployment of ${repo} at ${deployments[0].created_at}`);
    // Scripted Jira bugs start just after that deployment, so the investigation has a change to correlate.
    const span = Math.max(10 * 60_000, Math.min(now - deployedAt, 6 * 3600_000));
    const issues = [0.3, 0.45, 0.6, 0.75, 0.9].map((f, i) => ({ key: `SHOP-${500 + i}`, fields: { summary: `Checkout payment fails on submit (${i + 1})`, created: new Date(now - span + f * span).toISOString().replace('Z', '+0000'), issuetype: { name: 'Bug' }, priority: { name: 'High' }, components: [{ name: 'Checkout' }], labels: [], versions: [] } }));
    const http: HttpClient = async (url, init?: HttpRequest) => {
      const u = new URL(url);
      if (u.hostname === 'smoke.atlassian.net') {
        jiraCalls.push(u.pathname);
        if (u.pathname === '/rest/api/3/project/SHOP') return response({ body: { key: 'SHOP' } });
        if (u.pathname === '/rest/api/3/search/jql' && init?.method === 'POST') return response({ body: { issues, isLast: true } });
        if (u.pathname === '/rest/api/3/project/SHOP/versions') return response({ body: [] });
        return response({ status: 404, body: {} });
      }
      live.set(u.hostname, (live.get(u.hostname) ?? 0) + 1);
      return fetch(url, init as RequestInit) as unknown as ReturnType<HttpClient>;
    };

    const clock = manualClock(new Date(now).toISOString());
    let base = '';
    const idp: IdentityProvider = { id: 'smoke', authorizationUrl: ({ state }) => `${base}/api/auth/smoke/callback?code=owner&state=${state}`, exchange: async ({ code }) => ({ provider: 'smoke', subject: `${code}-${now}`, emailVerified: true, displayName: code === 'owner' ? 'Owner' : 'Viewer' }) };
    const cronSecret = randomBytes(24).toString('hex');
    const env = { JAGR_SESSION_SECRET: randomBytes(32).toString('hex'), JAGR_SECRET_KEY: randomBytes(32).toString('base64'), CRON_SECRET: cronSecret, JAGR_APP_URL: 'http://127.0.0.1' };
    const rt = await createRuntime(env, { sql: pgClient(pool), clock, identity: { smoke: idp }, http });
    const app = createApp(rt);
    const server: Server = createServer((req, res) => void serveApi(app, req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    type Jar = { cookie: string; csrf: string };
    const api = async (method: string, path: string, jar?: Jar, body?: unknown, headers: Record<string, string> = {}) => {
      const r = await fetch(`${base}${path}`, { method, redirect: 'manual', headers: { ...(jar ? { cookie: jar.cookie, 'x-jagr-csrf': jar.csrf } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await r.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: r.status, headers: r.headers, text, json: json as Record<string, unknown> };
    };
    const signIn = async (code: string): Promise<Jar> => {
      const start = await api('GET', '/api/auth/smoke/start?returnTo=/settings');
      const oauth = (start.headers.get('set-cookie') ?? '').split(';')[0];
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
      const cb = await api('GET', `/api/auth/smoke/callback?code=${code}&state=${state}`, undefined, undefined, { cookie: oauth });
      expect(cb.status).toBe(302);
      const cookies = cb.headers.getSetCookie().map((c) => c.split(';')[0]);
      for (const c of cb.headers.getSetCookie()) if (c.startsWith('jagr_session=')) expect(c).toMatch(/HttpOnly/i);
      const csrf = decodeURIComponent(cookies.find((c) => c.startsWith('jagr_csrf='))!.slice('jagr_csrf='.length));
      return { cookie: cookies.join('; '), csrf };
    };
    const step = (n: number, s: string) => log(`${String(n).padStart(2)}. ${s}`);

    try {
      // 1. Sign in
      const owner = await signIn('owner');
      const me = await api('GET', '/api/me', owner);
      expect(me.status).toBe(200);
      step(1, `signed in (session cookie HttpOnly) as ${(me.json.user as { displayName: string }).displayName} — sign-in provider is a stand-in`);

      // 2. Create workspace
      const created = await api('POST', '/api/workspaces', owner, { name: 'Smoke — production', mode: 'connected' });
      expect(created.status).toBe(201);
      const ws = (created.json.workspace as { id: string }).id;
      step(2, `workspace ${ws} created (connected)`);

      // 3. Open workspace
      const open = await api('GET', `/api/workspaces/${ws}`, owner);
      expect(open.status).toBe(200);
      step(3, `workspace opened · role ${(open.json.membership as { role: string }).role}`);

      // 4 + 5. Connect GitHub (checked on connect) and test the connection again
      const gh = await api('PUT', `/api/workspaces/${ws}/connections`, owner, { provider: 'github', config: { repos: [repo], environments: [environment] }, credential: { token: githubToken } });
      expect(gh.status, gh.text.slice(0, 300)).toBe(200);
      expect(gh.text).not.toContain(githubToken);
      const ghConn = gh.json.connection as { id: string; status: string };
      step(4, `GitHub connected: ${ghConn.status} · check ${(gh.json.check as { state: string; detail?: string }).state} · ${(gh.json.check as { detail?: string }).detail}`);
      const test = await api('POST', `/api/workspaces/${ws}/connections/${ghConn.id}/check`, owner);
      expect(test.status).toBe(200);
      expect((test.json.check as { state: string }).state, JSON.stringify(test.json.check)).toBe('connected');
      step(5, `GitHub connection test: connected (${live.get('api.github.com') ?? 0} live GitHub calls so far)`);
      const jira = await api('PUT', `/api/workspaces/${ws}/connections`, owner, { provider: 'jira', config: { site: 'https://smoke.atlassian.net', project: 'SHOP' }, credential: { email: 'smoke@example.invalid', apiToken: 'scripted-jira-token' } });
      expect(jira.status).toBe(200);
      log('    (Jira connected against a scripted host — the signal source is a stand-in)');

      // 6. Create watch
      const watch = await api('POST', `/api/workspaces/${ws}/watches`, owner, { templateId: 'customer_issues', sources: ['jira', 'github'], schedule: { frequency: '15m', dailyAt: '07:00' } });
      expect(watch.status, watch.text.slice(0, 300)).toBe(201);
      step(6, `watch ${(watch.json.watch as { id: string }).id} created (every 15 min)`);

      // 7. Run monitoring
      const run = await api('POST', `/api/workspaces/${ws}/runs`, owner);
      expect(run.status, run.text.slice(0, 300)).toBe(200);
      step(7, `run now: ${JSON.stringify(run.json).slice(0, 160)}`);

      // 8. Investigation appears
      const list = await api('GET', `/api/workspaces/${ws}/investigations`, owner);
      const invs = list.json.investigations as { id: string; title: string; attention: string }[];
      expect(invs.length).toBeGreaterThan(0);
      step(8, `${invs.length} investigation(s): ${invs.map((i) => `${i.attention} · ${i.title}`).join(' | ')}`);

      // 9 + 10. Evidence with provenance; agent trace
      const inv = (await api('GET', `/api/workspaces/${ws}/investigations/${invs[0].id}`, owner)).json.investigation as { evidence: { provider: string; kind: string; provenance?: { url?: string; readAt?: string; source?: string } }[]; trace: unknown[]; observed: string[] };
      const githubEvidence = inv.evidence.filter((e) => e.provider === 'github');
      const withProvenance = inv.evidence.filter((e) => e.provenance);
      step(9, `evidence: ${inv.evidence.length} items, ${withProvenance.length} with provenance; GitHub (live): ${githubEvidence.length}${githubEvidence[0]?.provenance?.url ? ` e.g. ${githubEvidence[0].provenance.url}` : ''}`);
      expect(withProvenance.length).toBeGreaterThan(0);
      expect(inv.trace.length).toBeGreaterThan(0);
      step(10, `agent trace: ${inv.trace.length} steps`);
      const replay = await api('GET', `/api/workspaces/${ws}/investigations/${invs[0].id}/replay`, owner);
      expect(replay.status).toBe(200);

      // 11. Approval enforcement (a member without approval rights; the imported sample has a HIGH-risk action)
      // An export imports once per server (replay protection), so each smoke run imports it under a fresh id.
      const fixture = { ...JSON.parse(readFileSync('src/product/export/__fixtures__/export-v1.sample.json', 'utf8')), exportId: `smoke-${now}` };
      const imp = await api('POST', '/api/import/commit', owner, { doc: fixture, confirm: true });
      expect(imp.status).toBe(201);
      const sampleWs = (imp.json.workspace as { id: string }).id;
      const viewer = await signIn('viewer');
      const viewerId = ((await api('GET', '/api/me', viewer)).json.user as { id: string }).id;
      expect((await api('GET', `/api/workspaces/${ws}`, viewer)).status).toBe(404); // isolation
      await rt.repos.members.add({ workspaceId: sampleWs, userId: viewerId, role: 'member', canApprove: false }); // no invite API yet
      const viewer2 = await signIn('viewer');
      const sampleInvs = (await api('GET', `/api/workspaces/${sampleWs}/investigations`, owner)).json.investigations as { id: string; area: string }[];
      const checkout = sampleInvs.find((i) => i.area === 'checkout')!;
      const actions = ((await api('GET', `/api/workspaces/${sampleWs}/investigations/${checkout.id}`, owner)).json.investigation as { actions: { id: string; risk: string; kind: string }[] }).actions;
      const high = actions.find((a) => a.risk === 'HIGH')!;
      const denied = await api('POST', `/api/workspaces/${sampleWs}/decisions`, viewer2, { actionId: high.id, status: 'approved' });
      expect(denied.status).toBe(403);
      const noCsrf = await api('POST', `/api/workspaces/${sampleWs}/decisions`, { cookie: owner.cookie, csrf: '' }, { actionId: high.id, status: 'approved' });
      expect(noCsrf.status).toBe(403);
      const approved = await api('POST', `/api/workspaces/${sampleWs}/decisions`, owner, { actionId: high.id, status: 'approved', optionId: 'android' });
      expect(approved.status, approved.text.slice(0, 200)).toBe(200);
      step(11, `approvals: non-approver 403 · missing CSRF 403 · approver 200 (${high.kind}, ${high.risk}) · other user cannot open the workspace (404)`);

      // 12. "Reload": a new request with only the cookie sees the persisted state; a fresh runtime on the same database too
      const rt2 = await createRuntime(env, { sql: pgClient(pool), clock, identity: { smoke: idp }, http });
      expect((await rt2.repos.investigations.list(ws)).length).toBe(invs.length);
      const snap = await api('GET', `/api/workspaces/${ws}/snapshot`, owner);
      expect(snap.status).toBe(200);
      expect(snap.text).not.toContain(githubToken);
      expect(snap.text).not.toMatch(/secretRef|scripted-jira-token/);
      step(12, `state persists: a second server instance reads ${invs.length} investigation(s) from Postgres; snapshot carries no credential`);

      // 13. No browser: the scheduler runs the watch from the cron endpoint
      expect((await api('GET', '/api/cron/tick')).status).toBe(401);
      await api('GET', '/api/cron/tick', undefined, undefined, { authorization: `Bearer ${cronSecret}` });
      clock.advance(16 * 60_000);
      const tick = await api('GET', '/api/cron/tick', undefined, undefined, { authorization: `Bearer ${cronSecret}` });
      expect(tick.status).toBe(200);
      const t = tick.json as { tick: { enqueued: number }; run: { done: number; failed: number } };
      expect(t.tick.enqueued).toBeGreaterThanOrEqual(1);
      expect(t.run.failed).toBe(0);
      const again = await api('GET', '/api/cron/tick', undefined, undefined, { authorization: `Bearer ${cronSecret}` });
      expect((again.json as { tick: { enqueued: number } }).tick.enqueued).toBe(0); // no duplicate run for the same slot
      step(13, `cron (no session, no browser): enqueued ${t.tick.enqueued}, done ${t.run.done}, failed ${t.run.failed}; repeat tick enqueued 0`);

      // 14. Disconnect
      const disc = await api('DELETE', `/api/workspaces/${ws}/connections/${ghConn.id}`, owner);
      expect(disc.status).toBe(200);
      expect((disc.json.connection as { status: string }).status).toBe('not_configured');
      const secretsLeft = await pool.query(`select count(*)::int as n from secrets where workspace_id = $1 and connection_id = $2`, [ws, ghConn.id]).catch(() => ({ rows: [{ n: -1 }] }));
      step(14, `GitHub disconnected · stored credential rows for it: ${secretsLeft.rows[0].n}`);

      // 15. Audit
      const audit = ((await api('GET', `/api/workspaces/${ws}/audit`, owner)).json.entries as { action: string; detail: string }[]);
      const actions15 = audit.map((e) => e.action);
      for (const a of ['connection.connected', 'connection.disconnected']) expect(actions15).toContain(a);
      expect(JSON.stringify(audit)).not.toContain(githubToken);
      step(15, `audit: ${[...new Set(actions15)].join(', ')}`);

      log(`\nLive hosts read: ${[...live].map(([h, n]) => `${h} ×${n}`).join(', ') || 'none'} · scripted Jira calls: ${jiraCalls.length}`);
      expect(live.get('api.github.com') ?? 0).toBeGreaterThan(0);
    } finally {
      server.close();
      await pool.end();
    }
  });
});
