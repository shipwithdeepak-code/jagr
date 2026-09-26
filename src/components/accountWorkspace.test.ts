import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { signOutFlow } from './signOut';
import { workspaceIdentity } from './WorkspaceMenu';
import { workspacePanelNote } from './serverWorkspace';
import { explorePlan } from '@/state/exploreLocally';
import { choiceFrom } from '@/state/serverSession';
import { resolveSurface, type SurfaceSession, type SurfaceWorkspace } from '@/state/surface';

/**
 * PRODUCT NAVIGATION · WORKSPACE CONTEXT · ACCOUNT. Sign out, switching workspace and switching to
 * this browser's workspace are three different actions; these tests pin each one, and the controls
 * that carry them (sidebar, account menu, mobile menu, Settings).
 */

const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const S = (o: Partial<SurfaceSession> = {}): SurfaceSession => ({ checked: true, signedIn: false, workspaceIds: [], choice: 'none', signingIn: false, ...o });
const NONE: SurfaceWorkspace = { location: 'browser' };
const LOCAL: SurfaceWorkspace = { location: 'browser', mode: 'sample' };
const ROUTES = ['/settings', '/overview', '/watches', '/sources', '/investigations', '/briefs'];

describe('sign out', () => {
  it('1 · success: exactly `/`, replacing the current entry — no hash, no query, no old route', async () => {
    const navigate = vi.fn();
    const failed = vi.fn();
    const ok = await signOutFlow({ signOut: async () => undefined, navigate, failed });
    expect(ok).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/', { replace: true });
    expect(failed).not.toHaveBeenCalled();
  });

  it('2 · failure: still signed in — a message, no navigation', async () => {
    const navigate = vi.fn();
    const failed = vi.fn();
    const ok = await signOutFlow({ signOut: async () => Promise.reject(new Error('Missing or invalid CSRF token.')), navigate, failed });
    expect(ok).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith('Missing or invalid CSRF token.');
  });

  it('3 · after sign-out `/` is the landing — with a local workspace, several workspaces, and after a refresh', () => {
    const exit = S({ choice: 'exit' });
    expect(resolveSurface('/', '', exit, NONE)).toEqual({ surface: 'public' });
    expect(resolveSurface('/', '', exit, LOCAL)).toEqual({ surface: 'public' }); // no local takeover
    expect(resolveSurface('/', '', S({ choice: 'exit', checked: false }), LOCAL)).toEqual({ surface: 'public' }); // refresh
    // Never an automatic reopening, however many workspaces the account has.
    expect(resolveSurface('/', '', S({ choice: 'exit', signedIn: true, workspaceIds: ['a'] }), NONE)).toEqual({ surface: 'public' });
    expect(resolveSurface('/', '', S({ choice: 'exit', signedIn: true, workspaceIds: ['a', 'b'] }), NONE)).toEqual({ surface: 'public' });
    // Back to an old app route after signing out: no workspace, not the local one.
    for (const p of ROUTES) expect(resolveSurface(p, '', S({ choice: 'exit' }), LOCAL)).toEqual({ surface: 'no-workspace' });
  });

  it('4 · the exit is remembered, and signing in or exploring locally replaces it', () => {
    expect(choiceFrom(undefined, 'exit')).toBe('exit');
    expect(choiceFrom('ws-a', 'exit')).toBe('server');
    expect(choiceFrom(undefined, 'local')).toBe('local');
    expect(choiceFrom(undefined, undefined)).toBe('none');
    const session = src('state/serverSession.tsx');
    // markSigningIn clears it; useBrowserWorkspace (Explore locally) records "local".
    expect(session.slice(session.indexOf('export function markSigningIn'))).toMatch(/writeStoredChoice\(undefined\)/);
    expect(session).toMatch(/useBrowserWorkspace = useCallback\(\(\) => \{[\s\S]*?remember\('local'\)/);
  });

  it('5 · session.signOut changes nothing unless the server confirmed', () => {
    const session = src('state/serverSession.tsx');
    const body = session.slice(session.indexOf('const signOut = useCallback'), session.indexOf('const sessionLost'));
    expect(body).toContain('await serverApi.signOut();');
    expect(body).not.toContain('.catch(');
    expect(body.indexOf('await serverApi.signOut()')).toBeLessThan(body.indexOf("remember('exit')"));
  });

  it('6 · every Sign out control uses the one shared useSignOut', () => {
    for (const f of ['components/WorkspaceMenu.tsx', 'components/serverWorkspace.tsx', 'components/WorkspaceGate.tsx']) {
      const code = src(f);
      expect(code).toContain('useSignOut()');
      expect(code).not.toMatch(/session\.signOut\(|\{ signOut \} = useServerSession/);
    }
    expect(src('components/signOut.ts')).toContain("navigate('/', { replace: true })");
  });
});

describe('workspace switching', () => {
  const inA = S({ signedIn: true, workspaceIds: ['a', 'b'], activeId: 'b', choice: 'server' });
  it('7 · server → server keeps the application shell while the next workspace loads', () => {
    expect(resolveSurface('/watches', '', inA, { location: 'server', keepShell: true })).toEqual({ surface: 'app' });
    // Arriving (not switching) still shows only the neutral restoring screen.
    expect(resolveSurface('/watches', '', inA, { location: 'server' })).toEqual({ surface: 'resolving' });
  });

  it('8 · server → this browser, and back', () => {
    expect(resolveSurface('/watches', '', S({ signedIn: true, workspaceIds: ['a'], choice: 'local' }), LOCAL)).toEqual({ surface: 'app' });
    expect(resolveSurface('/watches', '', S({ signedIn: true, workspaceIds: ['a'], activeId: 'a', choice: 'server' }), { location: 'server', keepShell: true })).toEqual({ surface: 'app' });
  });

  it('9 · the content waits — nothing from the previous workspace is shown as the new one', () => {
    const shell = src('components/AppShell.tsx');
    expect(shell).toMatch(/const opening = env === 'workspace' && product\.location === 'server' && !product\.mode/);
    expect(shell).toMatch(/\{opening \? .*<LoadingState .*: children\}/);
  });

  it('10 · the switcher offers every workspace, this browser (or Explore locally), and Create', () => {
    const menu = src('components/WorkspaceMenu.tsx');
    expect(menu).toContain('session.workspaces.map');
    expect(menu).toContain("aria-current={current ? 'true' : undefined}");
    expect(menu).toContain("product.localMode ? 'Browser workspace' : 'Explore locally'");
    expect(menu).toContain('<CreateForm onCreated={() => setCreating(false)} />');
    // Switching never signs out.
    const switcher = menu.slice(menu.indexOf('export function WorkspaceSwitcher'), menu.indexOf('// Account'));
    expect(switcher).not.toMatch(/signOut/i);
  });
});

describe('explore locally', () => {
  it('11 · an existing local workspace is reopened as it is; none yet → the sample is created', () => {
    expect(explorePlan(undefined, 'sample')).toEqual({ create: 'sample' });
    expect(explorePlan('sample', 'sample')).toEqual({ create: undefined });
    expect(explorePlan('imported', 'sample')).toEqual({ create: undefined }); // imports preserved
    expect(explorePlan('imported', 'imported')).toEqual({ create: undefined, navigate: '/sources?upload=1' });
    expect(explorePlan(undefined, 'imported')).toEqual({ create: 'imported', navigate: '/sources?upload=1' });
    expect(src('pages/Landing.tsx')).not.toMatch(/createWorkspace\(/);
  });
});

describe('session expiry', () => {
  it('12 · a session that ends mid-use shows the no-workspace screen where the person is — not a local takeover', () => {
    for (const p of ['/', ...ROUTES]) {
      expect(resolveSurface(p, '', S({ expired: true }), NONE)).toEqual({ surface: 'no-workspace' });
      expect(resolveSurface(p, '', S({ expired: true }), LOCAL)).toEqual({ surface: 'no-workspace' });
    }
    // Demo night is never gated.
    expect(resolveSurface('/demo', '', S({ expired: true }), NONE)).toEqual({ surface: 'app' });
  });

  it('13 · a 401 from any workspace call re-checks the session; the gate offers sign-in back to this route', () => {
    const product = src('state/product.tsx');
    expect(product).toMatch(/e instanceof ServerError && e\.status === 401\) void sessionLost\(\)/);
    expect(product.match(/authLost\(e\)/g)?.length).toBeGreaterThanOrEqual(3); // snapshot, actions, runs
    const gate = src('components/WorkspaceGate.tsx');
    expect(gate).toContain('Your session has ended. Sign in again to continue on this page.');
    expect(gate).toContain("serverApi.signInUrl('google', `${pathname}${search}${hash}`)");
  });
});

describe('sidebar, account menu, mobile menu, Settings', () => {
  const shell = src('components/AppShell.tsx');

  it('14 · Settings is a utility row at the bottom, not product navigation', () => {
    const primary = shell.slice(shell.indexOf('const primary: NavItem[]'), shell.indexOf('const review: NavItem[]'));
    expect(primary).not.toContain('/settings');
    const bottom = shell.slice(shell.indexOf('Configuration and the session'));
    expect(bottom.indexOf("to: '/settings'")).toBeLessThan(bottom.indexOf('<AccountMenu'));
    expect(bottom.indexOf('<AccountMenu')).toBeLessThan(bottom.indexOf("'Collapse sidebar'"));
  });

  it('15 · the account menu holds identity, theme and Sign out; the theme has no other control', () => {
    const menu = src('components/WorkspaceMenu.tsx');
    const account = menu.slice(menu.indexOf('export function AccountMenu'));
    expect(account).toContain('Signed in as');
    expect(account).toContain('aria-pressed={theme === t}');
    expect(account).toContain('onClick={() => void signOut()}');
    expect(account).not.toMatch(/text-crit|variant="danger"/); // a session action, not a destructive one
    expect(shell).not.toContain('Toggle theme');
  });

  it('16 · collapsed controls have accessible names, not only a title', () => {
    const menu = src('components/WorkspaceMenu.tsx');
    expect(menu).toContain('const label = `Workspace: ${identity.name}, ${identity.detail}. Switch workspace`;');
    expect(menu).toContain("const label = name ? `Account: ${name}` : 'Account: not signed in';");
    expect(menu.match(/aria-expanded=\{d\.open\}/g)).toHaveLength(2);
    expect(menu.match(/aria-controls=\{panelId\}/g)).toHaveLength(2);
  });

  it('17 · the mobile menu is a modal dialog with the shared focus handling, and the page behind is inert', () => {
    expect(shell).toContain('role="dialog" aria-modal="true" aria-label="Menu"');
    expect(shell).toContain('useDialogFocus(menuOpen, closeMenu, drawer);');
    expect(shell).toContain('inert={menuOpen}');
    // No second focus-trap implementation.
    expect(src('components/WorkspaceMenu.tsx')).not.toMatch(/key === 'Tab'/);
  });

  it('18 · Demo night is its own identity, never a workspace', () => {
    const p = { location: 'browser', mode: undefined } as unknown as Parameters<typeof workspaceIdentity>[0];
    expect(workspaceIdentity(p, 'demo')).toEqual({ name: 'Demo night', detail: 'Scripted replay' });
    expect(workspaceIdentity(p, 'workspace').detail).toBe('This browser · not set up');
    expect(workspaceIdentity({ location: 'server', server: { name: 'Acme Staging' } } as unknown as Parameters<typeof workspaceIdentity>[0], 'workspace')).toEqual({ name: 'Acme Staging', detail: 'Opening…' });
  });

  it('20 · Settings → Workspace only asks someone to sign in when they are signed out', () => {
    expect(workspacePanelNote({ onServer: true, hasServer: true, signedIn: true })).toMatch(/^Stored on this Jagr server/);
    expect(workspacePanelNote({ onServer: false, hasServer: false, signedIn: false })).toMatch(/available where a Jagr server is deployed/);
    expect(workspacePanelNote({ onServer: false, hasServer: true, signedIn: false })).toMatch(/Sign in to use server workspaces/);
    const signedInLocal = workspacePanelNote({ onServer: false, hasServer: true, signedIn: true });
    expect(signedInLocal).not.toMatch(/sign in/i);
    expect(signedInLocal).toMatch(/Open a server workspace/);
  });

  it('19 · Settings: Workspace, Monitoring, Notifications, AI, Data, Account — no switching list, no duplicated navigation', () => {
    const settings = src('pages/Settings.tsx');
    const ids = [...settings.matchAll(/<Section id="([a-z]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['workspace', 'monitoring', 'notifications', 'ai', 'data', 'account']);
    expect(settings).not.toMatch(/AdvancedLink|WorkspaceLocationPanel/);
    const panels = src('components/serverWorkspace.tsx');
    const workspace = panels.slice(panels.indexOf('export function WorkspacePanel'), panels.indexOf('export function AiEgressSetting'));
    expect(workspace).not.toMatch(/session\.open\(|useBrowserWorkspace|Switch/);
  });
});
