import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveSurface, type SurfaceSession, type SurfaceWorkspace } from './surface';

/**
 * PUBLIC · RESOLVING · CHOOSE · CREATE · NO-WORKSPACE · APP. The landing and the workspace gate are
 * their own surfaces, outside the application shell. These tests pin the rule for every state a person
 * can arrive in, and the one place it is applied.
 */

const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

// Defaults: first check finished, signed out, no workspaces, no choice, browser workspace not set up.
const S = (o: Partial<SurfaceSession> = {}): SurfaceSession => ({ checked: true, signedIn: false, workspaceIds: [], choice: 'none', signingIn: false, ...o });
const LOCAL_NONE: SurfaceWorkspace = { location: 'browser' };
const LOCAL_SAMPLE: SurfaceWorkspace = { location: 'browser', mode: 'sample' };
const SERVER_LOADING: SurfaceWorkspace = { location: 'server' };
const SERVER_READY: SurfaceWorkspace = { location: 'server', mode: 'connected' };
const at = (path: string, s: SurfaceSession, ws: SurfaceWorkspace, search = '') => resolveSurface(path, search, s, ws);
const APP_ROUTES = ['/overview', '/watches', '/sources', '/investigations', '/briefs', '/settings'];

describe('surface resolution', () => {
  it('1 · signed out `/` is the public landing', () => {
    expect(at('/', S(), LOCAL_NONE)).toEqual({ surface: 'public' });
  });

  it('2 · while the first check runs, `/` stays public unless a workspace may be restored', () => {
    expect(at('/', S({ checked: false }), LOCAL_NONE).surface).toBe('public');
    expect(at('/', S({ checked: false, choice: 'server' }), LOCAL_NONE).surface).toBe('resolving'); // remembered workspace
    expect(at('/', S({ checked: false, signingIn: true }), LOCAL_NONE).surface).toBe('resolving'); // back from Google
    // An app route never shows sample data while the check runs.
    for (const p of APP_ROUTES) expect(at(p, S({ checked: false }), LOCAL_NONE).surface).toBe('resolving');
  });

  it('3 · a remembered workspace never shows the landing, the local workspace or sample data first', () => {
    // Local sample workspace exists too — it must not flash before the server one.
    expect(at('/', S({ checked: false, choice: 'server' }), LOCAL_SAMPLE).surface).toBe('resolving');
    expect(at('/watches', S({ checked: false, choice: 'server' }), LOCAL_SAMPLE).surface).toBe('resolving');
    // Confirmed, snapshot still loading → still resolving; loaded → the application.
    expect(at('/watches', S({ signedIn: true, workspaceIds: ['a'], activeId: 'a', choice: 'server' }), SERVER_LOADING).surface).toBe('resolving');
    expect(at('/watches', S({ signedIn: true, workspaceIds: ['a'], activeId: 'a', choice: 'server' }), SERVER_READY).surface).toBe('app');
    // Loading failed → the application with its error, not a spinner forever.
    expect(at('/', S({ signedIn: true, workspaceIds: ['a'], activeId: 'a', choice: 'server' }), { location: 'server', serverFailed: true }).surface).toBe('app');
  });

  it('4 · signed in with ONE workspace (after Google, or a fresh browser) opens it on the requested route', () => {
    expect(at('/', S({ signedIn: true, workspaceIds: ['a'], signingIn: true }), LOCAL_NONE)).toEqual({ surface: 'resolving', autoOpen: 'a' });
    expect(at('/', S({ signedIn: true, workspaceIds: ['a'] }), LOCAL_NONE)).toEqual({ surface: 'resolving', autoOpen: 'a' });
    expect(at('/sources', S({ signedIn: true, workspaceIds: ['a'] }), LOCAL_NONE)).toEqual({ surface: 'resolving', autoOpen: 'a' });
  });

  it('5 · signed in with several workspaces → choose; with none → create', () => {
    expect(at('/', S({ signedIn: true, workspaceIds: ['a', 'b'], signingIn: true }), LOCAL_NONE)).toEqual({ surface: 'choose' });
    expect(at('/watches', S({ signedIn: true, workspaceIds: ['a', 'b'] }), LOCAL_NONE)).toEqual({ surface: 'choose' });
    expect(at('/', S({ signedIn: true, signingIn: true }), LOCAL_NONE)).toEqual({ surface: 'create' });
  });

  it('6 · an explicit "this browser" choice is respected — no automatic reopening', () => {
    const left = S({ signedIn: true, workspaceIds: ['a'], choice: 'local' });
    expect(at('/', left, LOCAL_NONE)).toEqual({ surface: 'public' }); // Start over / Switch / Sign out
    expect(at('/watches', left, LOCAL_NONE)).toEqual({ surface: 'no-workspace' });
    expect(at('/', left, LOCAL_SAMPLE)).toEqual({ surface: 'app' }); // Explore locally
  });

  it('7 · a local workspace is the application; signing in takes precedence over it', () => {
    expect(at('/', S(), LOCAL_SAMPLE).surface).toBe('app');
    expect(at('/', S({ checked: false }), LOCAL_SAMPLE).surface).toBe('app');
    expect(at('/', S({ signedIn: true, workspaceIds: ['a'] }), LOCAL_SAMPLE).surface).toBe('app'); // didn't just sign in
    expect(at('/', S({ signedIn: true, workspaceIds: ['a'], signingIn: true }), LOCAL_SAMPLE)).toEqual({ surface: 'resolving', autoOpen: 'a' });
  });

  it('8 · signed-out deep links show the no-workspace screen, never sample data', () => {
    for (const p of APP_ROUTES) expect(at(p, S(), LOCAL_NONE)).toEqual({ surface: 'no-workspace' });
  });

  it('9 · a deleted remembered workspace falls back to the person’s other workspaces or setup', () => {
    // The check clears the stale id (choice → none): one other → opens it; none → create.
    expect(at('/', S({ signedIn: true, workspaceIds: ['b'] }), LOCAL_NONE)).toEqual({ surface: 'resolving', autoOpen: 'b' });
    expect(at('/watches', S({ signedIn: true }), LOCAL_NONE)).toEqual({ surface: 'create' });
  });

  it('10 · a failed check is not "no workspaces"', () => {
    expect(at('/', S({ choice: 'server', failed: true }), LOCAL_NONE)).toEqual({ surface: 'no-workspace' });
    expect(at('/', S({ signedIn: true, failed: true }), LOCAL_NONE)).toEqual({ surface: 'no-workspace' });
    // …unless they chose this browser's workspace, which needs no server.
    expect(at('/', S({ signedIn: true, failed: true, choice: 'local' }), LOCAL_SAMPLE)).toEqual({ surface: 'app' });
  });

  it('11 · no Jagr server: landing at `/`, local workspace when explored, no-workspace elsewhere', () => {
    expect(at('/', S(), LOCAL_NONE).surface).toBe('public');
    expect(at('/', S(), LOCAL_SAMPLE).surface).toBe('app');
    expect(at('/sources', S(), LOCAL_NONE).surface).toBe('no-workspace');
  });

  it('12 · Demo night and workspace-free pages are never gated', () => {
    for (const s of [S(), S({ checked: false, choice: 'server' }), S({ signedIn: true, workspaceIds: ['a', 'b'] })]) {
      for (const p of ['/demo', '/demo/settings', '/signals', '/integrations', '/investigations/inv-1', '/about', '/evaluations']) expect(at(p, s, LOCAL_NONE)).toEqual({ surface: 'app' });
      expect(at('/approvals', s, LOCAL_NONE, '?env=demo')).toEqual({ surface: 'app' });
    }
    // The same shared page without the demo marker is the workspace, so it is gated.
    expect(at('/approvals', S(), LOCAL_NONE).surface).toBe('no-workspace');
  });
});

describe('surface boundary in the app', () => {
  it('13 · App renders the landing and the gate outside the one AppShell, and auto-opens with no navigation', () => {
    const app = src('App.tsx');
    expect(app.match(/<AppShell>/g)).toHaveLength(1);
    const split = app.slice(app.indexOf('function Surfaces'));
    expect(split).toContain("surface === 'app' ?");
    expect(split.indexOf('<AppShell>')).toBeLessThan(split.indexOf('<LandingPage />'));
    expect(split).toContain('<WorkspaceGate surface={surface} />');
    // Opening the only workspace changes state, not the URL: no navigate/redirect in the switch.
    expect(split.slice(0, split.indexOf('return ('))).not.toMatch(/navigate\(|location\.(href|assign|replace)/);
    // /overview is the Overview page, not a redirect or a second implementation.
    expect(app).toContain('<Route path="/overview" element={<ProductOverviewPage />} />');
    expect(app).not.toContain("?? 'Investigation'");
  });

  it('14 · the landing and gate bring no sidebar, and sign-in is the existing Google flow', () => {
    for (const f of ['pages/Landing.tsx', 'components/WorkspaceGate.tsx']) {
      const code = src(f);
      expect(code).not.toMatch(/AppShell|Sidebar|WorkspaceSwitcher/);
      expect(code).toContain('serverApi.signInUrl(');
      expect(code).toContain('onClick={markSigningIn}');
      expect(code).not.toMatch(/fetch\(|'\/api\//);
    }
    // The gate's sign-in returns to the route that was asked for.
    expect(src('components/WorkspaceGate.tsx')).toContain("serverApi.signInUrl('google', `${pathname}${search}${hash}`)");
  });

  it('15 · the landing never shows a disabled sign-in while the session is checked', () => {
    const landing = src('pages/Landing.tsx');
    expect(landing).not.toContain('aria-disabled');
    expect(landing).not.toContain('cursor-wait');
  });

  it('16 · every figure on the landing is labelled illustrative', () => {
    const landing = src('pages/Landing.tsx');
    expect(landing).toContain('Figures on this page are illustrative.');
    expect(landing).toContain('An illustrative night');
    expect(landing).toContain('An illustrative investigation');
    expect(landing).toContain('example workspace');
  });
});
