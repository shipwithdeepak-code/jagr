import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { IdentityProvider } from '../src/product/ports/identity';
import { manualClock } from '../src/product/ports/clock';
import { freshPglite } from './postgres/pglite';
import { createRuntime } from './runtime';
import { createApp } from './app';
import { serveApi } from './http/api';
import { REWRITE_PATH_PARAM, REWRITE_SENTINEL, restoreApiUrl } from './http/vercelRewrite';

vi.setConfig({ testTimeout: 30_000 });

/**
 * Production regression: GET /api/auth/google/start answered Vercel's own NOT_FOUND.
 *
 * Outside Next.js, Vercel compiles `api/[...route].ts` to a ONE-segment route and 404s every deeper
 * /api/* path. The routes below were produced by Vercel's own code (vercel CLI 60: fs-detectors
 * `detectBuilders` for our api/ folder, routing-utils `convertRewrites` for vercel.json), so this test
 * replays production routing without a deployment. If vercel.json changes, recompile its rules with
 * `convertRewrites` and update COMPILED below — the first test fails until you do.
 */

const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { rewrites: { source: string; destination: string }[] };

/** Each vercel.json rewrite source, as Vercel compiles it (routing-utils convertRewrites). */
const COMPILED: Record<string, { src: string; dest: string }> = {
  '/api/planner/:path*': { src: '^\\/api\\/planner(?:\\/((?:[^\\/]+?)(?:\\/(?:[^\\/]+?))*))?$', dest: '/api/planner?path=$1' },
  '/api/:jagrPath((?!planner(?:/|$))[^/]+/.+)': { src: '^\\/api(?:\\/((?!planner(?:\\/|$))[^/]+\\/.+))$', dest: '/api/_route?jagrPath=$1' },
  '/((?!api/).*)': { src: '^(?:\\/((?!api\\/).*))$', dest: '/index.html' },
};

/** The route table for the vercel.json in the repo — so removing or editing a rule changes the result. */
const REWRITES = vercel.rewrites.map((r) => {
  const c = COMPILED[r.source];
  if (!c) throw new Error(`Recompile "${r.source}" with Vercel's convertRewrites and add it to COMPILED.`);
  return c;
});

/** What Vercel generates for api/[...route].ts + api/planner.ts after user rewrites. */
const FILESYSTEM = [
  { src: '^/api/([^/]+)$', fn: 'api/[...route]' },
  { src: '^/api(/.*)?$', fn: 'NOT_FOUND' },
];

type Target = 'api/[...route]' | 'api/planner' | 'index.html' | 'NOT_FOUND';

function route(path: string): { target: Target; url: string } {
  let url = path;
  for (const r of REWRITES) {
    const m = new RegExp(r.src).exec(path);
    if (m) {
      url = r.dest.replace('$1', m[1] ?? '');
      break;
    }
  }
  const pathname = url.split('?')[0];
  if (pathname === '/index.html') return { target: 'index.html', url };
  if (pathname === '/api/planner') return { target: 'api/planner', url };
  for (const f of FILESYSTEM) if (new RegExp(f.src).test(pathname)) return { target: f.fn as Target, url };
  return { target: 'NOT_FOUND', url };
}

// Every route shape the Jagr API serves (server/app.ts), plus the ones that used to break.
const JAGR_PATHS = [
  '/api/health',
  '/api/me',
  '/api/workspaces',
  '/api/connection-types',
  '/api/auth/google/start',
  '/api/auth/google/callback',
  '/api/auth/github/start',
  '/api/auth/logout',
  '/api/cron/tick',
  '/api/workspaces/ws1',
  '/api/workspaces/ws1/snapshot',
  '/api/workspaces/ws1/connections',
  '/api/workspaces/ws1/connections/c1',
  '/api/workspaces/ws1/connections/c1/check',
  '/api/workspaces/ws1/connections/c1/reconnect',
  '/api/workspaces/ws1/investigations/inv-1',
  '/api/plannerx/y',
];

describe('Vercel routing (production regression)', () => {
  it('vercel.json has the planner rule, then the multi-segment /api rule, then the SPA fallback', () => {
    expect(vercel.rewrites).toEqual([
      { source: '/api/planner/:path*', destination: '/api/planner?path=:path*' },
      { source: '/api/:jagrPath((?!planner(?:/|$))[^/]+/.+)', destination: REWRITE_SENTINEL },
      { source: '/((?!api/).*)', destination: '/index.html' },
    ]);
    expect(REWRITES[1].dest).toBe(`${REWRITE_SENTINEL}?${REWRITE_PATH_PARAM}=$1`);
  });

  it('without the rule, every multi-segment /api path is Vercel NOT_FOUND — the bug', () => {
    const before = (p: string) => (new RegExp(FILESYSTEM[0].src).test(p) ? 'api/[...route]' : 'NOT_FOUND');
    expect(before('/api/health')).toBe('api/[...route]');
    expect(before('/api/auth/google/start')).toBe('NOT_FOUND');
    expect(before('/api/workspaces/ws1/connections')).toBe('NOT_FOUND');
  });

  it('every Jagr API path reaches the Jagr function', () => {
    for (const p of JAGR_PATHS) expect([p, route(p).target]).toEqual([p, 'api/[...route]']);
  });

  it('the planner and the app shell keep their own routes', () => {
    expect(route('/api/planner').target).toBe('api/planner');
    expect(route('/api/planner/health').target).toBe('api/planner');
    expect(route('/api/planner/health').url).toBe('/api/planner?path=health');
    for (const p of ['/', '/settings', '/investigations/w/wi-1', '/sources']) expect(route(p).target).toBe('index.html');
  });

  it('the function recovers the original path — whichever URL Vercel hands it', () => {
    const rewritten = `${route('/api/auth/google/start').url}&returnTo=%2FSettings`;
    expect(rewritten).toBe('/api/_route?jagrPath=auth/google/start&returnTo=%2FSettings');
    expect(restoreApiUrl(rewritten)).toBe('/api/auth/google/start?returnTo=%2FSettings');
    expect(restoreApiUrl('/api/_route?jagrPath=auth%2Fgoogle%2Fcallback&code=4%2F0Ab&state=s.t')).toBe('/api/auth/google/callback?code=4%2F0Ab&state=s.t');
    // The original URL (with the helper parameter merged in) routes as itself.
    expect(restoreApiUrl('/api/auth/google/start?returnTo=%2FSettings&jagrPath=auth%2Fgoogle%2Fstart')).toBe('/api/auth/google/start?returnTo=%2FSettings');
    // One-segment paths never went through the rewrite and are untouched.
    expect(restoreApiUrl('/api/health')).toBe('/api/health');
    expect(restoreApiUrl('/api/test?x=1')).toBe('/api/test?x=1');
  });
});

// ─────────────────────────────────────────────────────────────
// End to end: the rewritten request through the real Node adapter and app.
// ─────────────────────────────────────────────────────────────

/** Exactly what api/[...route].ts does with a request: restore the URL, then serve it. */
async function vercelFunction(app: ReturnType<typeof createApp>, url: string, headers: Record<string, string> = {}) {
  const req = { method: 'GET', url, headers } as unknown as IncomingMessage;
  const out: { status: number; headers: Record<string, string | string[]>; body?: string } = { status: 0, headers: {} };
  const res = {
    set statusCode(v: number) {
      out.status = v;
    },
    setHeader: (k: string, v: string | string[]) => void (out.headers[k.toLowerCase()] = v),
    end: (b?: string) => void (out.body = b),
  } as unknown as ServerResponse;
  req.url = restoreApiUrl(req.url ?? '/');
  await serveApi(app, req, res);
  return out;
}

const cookieValue = (setCookie: string | string[] | undefined, name: string) =>
  ([] as string[]).concat(setCookie ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));

async function runtime(extra: Record<string, string>, identity?: Record<string, IdentityProvider>) {
  return createRuntime(
    { JAGR_SESSION_SECRET: randomBytes(32).toString('hex'), JAGR_SECRET_KEY: randomBytes(32).toString('base64'), CRON_SECRET: 'cron-secret', JAGR_APP_URL: 'https://jagr.test', ...extra },
    { sql: await freshPglite(), clock: manualClock('2026-09-25T10:00:00.000Z'), identity },
  );
}

describe('OAuth over the Vercel rewrite', () => {
  it('/api/auth/google/start redirects to Google’s authorization URL with the production callback', async () => {
    const app = createApp(await runtime({ GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'not-a-real-secret' }));
    for (const url of [route('/api/auth/google/start').url + '&returnTo=%2FSettings', '/api/auth/google/start?returnTo=%2FSettings']) {
      const r = await vercelFunction(app, url);
      expect(r.status).toBe(302);
      const loc = new URL(String(r.headers.location));
      expect(loc.origin + loc.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(loc.searchParams.get('redirect_uri')).toBe('https://jagr.test/api/auth/google/callback');
      expect(loc.searchParams.get('state')).toBeTruthy();
      expect(cookieValue(r.headers['set-cookie'], 'jagr_oauth')).toBeTruthy();
    }
  });

  it('the callback arrives through the rewrite with code and state intact and signs the person in', async () => {
    const idp: IdentityProvider = {
      id: 'fake',
      authorizationUrl: ({ state }) => `https://idp.example/authorize?state=${state}`,
      exchange: async ({ code }) => (code === 'good-code' ? { provider: 'fake', subject: 'ana-1', email: 'ana@example.com', emailVerified: true, displayName: 'Ana' } : Promise.reject(new Error('bad code'))),
    };
    const app = createApp(await runtime({}, { fake: idp }));
    const start = await vercelFunction(app, `${route('/api/auth/fake/start').url}&returnTo=%2FSettings`);
    expect(start.status).toBe(302);
    const state = new URL(String(start.headers.location)).searchParams.get('state')!;
    const oauth = cookieValue(start.headers['set-cookie'], 'jagr_oauth')!;
    const cb = await vercelFunction(app, `${route('/api/auth/fake/callback').url}&code=good-code&state=${encodeURIComponent(state)}`, { cookie: oauth });
    expect(cb.status).toBe(302);
    expect(String(cb.headers.location)).toMatch(/\/Settings$/);
    expect(cookieValue(cb.headers['set-cookie'], 'jagr_session')).toBeTruthy();
    // A forged state is still refused — the security checks run on the rewritten path too.
    const forged = await vercelFunction(app, `${route('/api/auth/fake/callback').url}&code=good-code&state=forged`, { cookie: oauth });
    expect(forged.status).toBe(400);
  });

  it('a multi-segment workspace route reaches the app and still requires a session', async () => {
    const app = createApp(await runtime({}, {}));
    const r = await vercelFunction(app, route('/api/workspaces/ws1/connections').url);
    expect(r.status).toBe(401);
  });
});
