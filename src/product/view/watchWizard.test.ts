import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WATCH_TEMPLATES, WIZARD_TEMPLATES, watchFromTemplate } from '../catalog';
import { defaultConnections } from '../integrations/adapters';
import type { ProviderId, SourceConnection } from '../types';
import { canLeaveSourceStep, connectionsPending, initialWizardSources, sourceStepBlocker, templateAvailability, wizardSourceRows } from './watchWizard';

/**
 * Regression: production Create Watch crashed on "Where should I look?" with
 * "Cannot read properties of undefined (reading 'state')" in a server workspace.
 */

const AT = '2026-09-25T10:00:00.000Z';
const checkout = WATCH_TEMPLATES.find((t) => t.id === 'checkout_health')!.sources;
const server = { location: 'server' as const };
const browser = { location: 'browser' as const };

/** A loaded server workspace lists only what it connected, plus its built-in alert channel. */
const githubOnly: SourceConnection[] = [
  { provider: 'github', state: 'connected', detail: 'GitHub', updatedAt: AT },
  { provider: 'email', state: 'simulated', detail: 'Alerts are shown in Jagr', updatedAt: AT },
];

describe('Create Watch — sources step', () => {
  it('server workspace still loading (connections: []) — no crash, nothing selectable, Next blocked', () => {
    expect(connectionsPending([], server)).toBe(true);
    const rows = wizardSourceRows(checkout, [], server);
    expect(rows.every((r) => r.status === 'loading')).toBe(true);
    expect(initialWizardSources(checkout, [], { ...server, mode: 'connected' })).toEqual([]);
    expect(canLeaveSourceStep([], rows)).toBe(false);
    // Even a stale selection cannot leave the step before the records arrive.
    expect(canLeaveSourceStep(['jira'], rows)).toBe(false);
  });

  it('the old lookup is exactly what crashed; the rows never dereference a missing record', () => {
    const find = (p: ProviderId) => ([] as SourceConnection[]).find((c) => c.provider === p);
    expect(() => find('jira')!.state).toThrow(TypeError);
    expect(() => wizardSourceRows(checkout, [], server)).not.toThrow();
  });

  it('loaded server workspace with only GitHub — template sources are "missing", not a crash, and cannot be picked', () => {
    expect(connectionsPending(githubOnly, server)).toBe(false);
    const rows = wizardSourceRows(checkout, githubOnly, server);
    expect(rows.map((r) => r.status)).toEqual(checkout.map(() => 'missing'));
    expect(initialWizardSources(checkout, githubOnly, { ...server, mode: 'connected' })).toEqual([]);
    expect(canLeaveSourceStep(['jira'], rows)).toBe(false);
  });

  it('loaded server workspace with a connected template source — it is selected and Next is allowed', () => {
    const conns: SourceConnection[] = [...githubOnly, { provider: 'jira', state: 'connected', detail: 'Jira', updatedAt: AT }];
    const rows = wizardSourceRows(checkout, conns, server);
    expect(rows.find((r) => r.provider === 'jira')).toEqual({ provider: 'jira', status: 'ready', state: 'connected' });
    const picked = initialWizardSources(checkout, conns, { ...server, mode: 'connected' });
    expect(picked).toEqual(['jira']);
    expect(canLeaveSourceStep(picked, rows)).toBe(true);
    // A connected-but-unselected missing source does not block; a selected missing one does.
    expect(canLeaveSourceStep(['jira', 'ga4'], rows)).toBe(false);
  });

  it('sample workspace — unchanged: every template source is present and selected', () => {
    const conns = defaultConnections();
    const rows = wizardSourceRows(checkout, conns, browser);
    expect(rows.every((r) => r.status === 'ready')).toBe(true);
    expect(initialWizardSources(checkout, conns, { ...browser, mode: 'sample' })).toEqual([...checkout]);
    expect(canLeaveSourceStep([...checkout], rows)).toBe(true);
    expect(canLeaveSourceStep([], rows)).toBe(false);
  });

  it('imported workspace — unchanged: sources with nothing imported start unticked but stay listed', () => {
    const conns: SourceConnection[] = defaultConnections().map((c) => (c.provider === 'google_play' || c.provider === 'app_store' ? { ...c, state: 'not_configured' as const } : { ...c, state: 'imported' as const }));
    const rows = wizardSourceRows(checkout, conns, browser);
    expect(rows.every((r) => r.status === 'ready')).toBe(true);
    expect(initialWizardSources(checkout, conns, { ...browser, mode: 'imported' })).toEqual(checkout.filter((p) => p !== 'app_store' && p !== 'google_play'));
  });

  it('GitHub-only connected server workspace: the GitHub production changes template is offered, selectable, and Next is enabled', () => {
    expect(WIZARD_TEMPLATES).toContain('github_changes');
    const tpl = WATCH_TEMPLATES.find((x) => x.id === 'github_changes')!;
    const rows = wizardSourceRows(tpl.sources, githubOnly, server);
    expect(rows).toEqual([{ provider: 'github', status: 'ready', state: 'connected' }]);
    const picked = initialWizardSources(tpl.sources, githubOnly, { ...server, mode: 'connected' });
    expect(picked).toEqual(['github']);
    expect(canLeaveSourceStep(picked, rows)).toBe(true);
    // The watch it creates monitors GitHub's change signal and nothing else — no invented metrics.
    const w = watchFromTemplate('w-gh', 'github_changes', { sources: picked });
    expect(w.sources).toEqual(['github']);
    expect(w.signals.map((x) => x.key)).toEqual(['changes']);
  });

  it('the GitHub template is not selectable where GitHub is not connected (sample workspace)', () => {
    const tpl = WATCH_TEMPLATES.find((x) => x.id === 'github_changes')!;
    const rows = wizardSourceRows(tpl.sources, defaultConnections(), browser);
    expect(rows).toEqual([{ provider: 'github', status: 'missing' }]);
    expect(canLeaveSourceStep(['github'], rows)).toBe(false);
  });

  it('existing templates are unchanged', () => {
    expect(WIZARD_TEMPLATES.slice(0, 6)).toEqual(['checkout_health', 'app_stability', 'conversion', 'revenue', 'customer_issues', 'release_health']);
    for (const tpl of WATCH_TEMPLATES.filter((x) => x.id !== 'github_changes')) expect(tpl.sources).not.toContain('github');
  });

  it('the wizard no longer asserts a connection record exists', () => {
    const src = readFileSync('src/pages/Watches.tsx', 'utf8');
    expect(src).not.toMatch(/connections\.find\([^)]*\)!/);
    expect(src).toMatch(/wizardSourceRows\(/);
  });
});

describe('Create Watch never dead-ends', () => {
  const gh = WATCH_TEMPLATES.find((t) => t.id === 'github_changes')!.sources;

  it('a template whose sources are all missing is reported on the first step, naming what it needs', () => {
    expect(templateAvailability(gh, defaultConnections(), browser)).toEqual({ status: 'unavailable', missing: ['github'] });
    expect(templateAvailability(gh, githubOnly, server)).toEqual({ status: 'ready' });
    expect(templateAvailability(gh, [], server)).toEqual({ status: 'loading' });
  });

  it('the sources step always says why it cannot be left', () => {
    expect(sourceStepBlocker(['github'], wizardSourceRows(gh, githubOnly, server))).toBeUndefined();
    expect(sourceStepBlocker([], wizardSourceRows(gh, [], server))).toMatch(/loading|load/i);
    expect(sourceStepBlocker([], wizardSourceRows(gh, defaultConnections(), browser))).toMatch(/None of this watch’s sources is connected/);
    expect(sourceStepBlocker([], wizardSourceRows(checkout, defaultConnections(), browser))).toBe('Choose at least one source.');
  });
});
