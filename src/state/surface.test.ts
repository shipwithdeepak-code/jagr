import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { surfaceFor } from './surface';

/**
 * PUBLIC vs APP. The public landing is its own surface, outside the application shell — not the
 * shell with its sidebar hidden. These tests pin both the rule and the one place it is applied.
 */

const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

describe('surface boundary', () => {
  it('1 · `/` before any workspace is entered is the public landing', () => {
    expect(surfaceFor('/', { location: 'browser' })).toBe('public');
    expect(surfaceFor('/', { mode: undefined, location: 'browser', restoring: false })).toBe('public');
  });

  it('2 · entering a workspace moves `/` into the application', () => {
    expect(surfaceFor('/', { mode: 'sample', location: 'browser' })).toBe('app'); // Explore locally
    expect(surfaceFor('/', { mode: 'imported', location: 'browser' })).toBe('app'); // own data
    expect(surfaceFor('/', { location: 'server' })).toBe('app'); // server workspace, still loading
    expect(surfaceFor('/', { mode: 'connected', location: 'server' })).toBe('app');
  });

  it('3 · a remembered server workspace does not flash the landing while it is confirmed', () => {
    expect(surfaceFor('/', { location: 'browser', restoring: true })).toBe('app');
  });

  it('4 · every other route is the application, workspace or not — including Demo night', () => {
    for (const p of ['/demo', '/demo/settings', '/watches', '/investigations', '/settings', '/about', '/signals', '/nope']) {
      expect(surfaceFor(p, { location: 'browser' })).toBe('app');
    }
  });

  it('5 · App renders the landing outside the one AppShell', () => {
    const app = src('App.tsx');
    expect(app.match(/<AppShell>/g)).toHaveLength(1);
    const split = app.slice(app.indexOf('function Surfaces'));
    const landingAt = split.indexOf('<LandingPage />');
    const shellAt = split.indexOf('<AppShell>');
    expect(landingAt).toBeGreaterThan(-1);
    // The landing is the public branch of the ternary, before (and not inside) the shell branch.
    expect(split.slice(0, landingAt)).toContain("surface === 'public' ?");
    expect(landingAt).toBeLessThan(shellAt);
  });

  it('6 · the landing brings no sidebar or workspace navigation of its own', () => {
    const landing = src('pages/Landing.tsx');
    expect(landing).not.toMatch(/AppShell|Sidebar|NAV_|WorkspaceSwitcher/);
    // Sign-in is the existing Google flow, not a new one.
    expect(landing).toContain("serverApi.signInUrl('google', '/')");
    expect(landing).not.toMatch(/fetch\(|\/api\//);
  });

  it('7 · every figure on the landing is labelled illustrative', () => {
    const landing = src('pages/Landing.tsx');
    expect(landing).toContain('Figures on this page are illustrative.');
    expect(landing).toContain('An illustrative night');
    expect(landing).toContain('An illustrative investigation');
    expect(landing).toContain('example workspace');
  });
});
