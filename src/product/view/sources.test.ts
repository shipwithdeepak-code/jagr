import { describe, expect, it } from 'vitest';
import { defaultConnections } from '../integrations/adapters';
import type { SourceConnection } from '../types';
import type { Connection } from '../ports/persistence';
import { connectionView } from '../connections/model';
import { groupSources, sourceViews } from './sources';

const ASOF = '2026-09-24T08:05:00.000Z';

describe('Sources view-model', () => {
  it('shows every evidence source, never an outbound channel', () => {
    const v = sourceViews(defaultConnections(), { asOf: ASOF });
    expect(v.map((s) => s.id).sort()).toEqual(['app_store', 'ga4', 'google_play', 'jira']);
    expect(v.every((s) => s.group === 'simulated' && s.actions.length === 0)).toBe(true);
  });

  it('a source whose data stops before the run window ends is STALE, with how far behind and the impact', () => {
    const conns: SourceConnection[] = defaultConnections().map((c) => (c.provider === 'jira' ? { ...c, state: 'connected', freshAsOf: '2026-09-24T04:53:00.000Z' } : c));
    const jira = sourceViews(conns, { asOf: ASOF }).find((s) => s.id === 'jira')!;
    expect(jira.group).toBe('stale');
    expect(jira.behindMinutes).toBe(192);
    expect(jira.lastCheck).toBe('2026-09-24T04:53:00.000Z');
    expect(jira.lastCheckLabel).toBe('Last successful sync');
    expect(jira.roles).toEqual(['work_items', 'changes']);
    expect(jira.impact).toMatch(/will not treat missing records/);
  });

  it('a source that is current is not stale', () => {
    const conns: SourceConnection[] = defaultConnections().map((c) => (c.provider === 'ga4' ? { ...c, state: 'connected', freshAsOf: ASOF } : c));
    expect(sourceViews(conns, { asOf: ASOF }).find((s) => s.id === 'ga4')!.group).toBe('connected');
  });

  it('actions are never offered when the build cannot perform them — each says why', () => {
    const conns: SourceConnection[] = [
      { provider: 'amplitude', state: 'not_configured', detail: '', updatedAt: ASOF },
      { provider: 'github', state: 'needs_reconnect', detail: '', updatedAt: ASOF },
      { provider: 'jira', state: 'connected', detail: '', updatedAt: ASOF },
    ];
    const views = sourceViews(conns, { asOf: ASOF });
    for (const a of views.flatMap((v) => v.actions)) {
      expect(a.available).toBe(false);
      expect(a.reason.length).toBeGreaterThan(20);
    }
    expect(views.find((v) => v.id === 'amplitude')!.actions.map((a) => a.id)).toEqual(['connect']);
    expect(views.find((v) => v.id === 'github')!.actions.map((a) => a.id)).toEqual(['reconnect', 'test', 'disconnect']);
  });

  it('a server ConnectionView is authoritative: account, verified health, last check, and Test', () => {
    const conns: SourceConnection[] = [{ provider: 'jira', state: 'connected', detail: '', updatedAt: ASOF }];
    const record: Connection = {
      id: 'conn-jira', workspaceId: 'ws1', source: 'jira', provider: 'jira', roles: ['work_items', 'changes'], authKind: 'owner_env',
      state: 'connected', detail: 'Connected', config: {}, externalAccount: 'acme.atlassian.net · PAY', updatedAt: ASOF,
      lastSuccessfulCheckAt: '2026-09-24T08:00:00.000Z',
    };
    const v = sourceViews(conns, { asOf: ASOF, server: { jira: connectionView(record, ASOF) } })[0];
    expect(v.group).toBe('connected');
    expect(v.health).toBe('healthy');
    expect(v.account).toBe('acme.atlassian.net · PAY');
    expect(v.lastCheck).toBe('2026-09-24T08:00:00.000Z');
    expect(v.lastCheckLabel).toBe('Last successful check');
    expect(v.actions.find((a) => a.id === 'test')!.available).toBe(true);
    // Environment-managed: tested, never changed — whatever the member's role.
    expect(v.actions.find((a) => a.id === 'disconnect')!.available).toBe(false);
    expect(v.actions.find((a) => a.id === 'disconnect')!.reason).toMatch(/deployment environment/);
  });

  it('workspace-managed server connections: owners and admins may change them, members may only test', () => {
    const conns: SourceConnection[] = [{ provider: 'github', state: 'needs_reconnect', detail: '', updatedAt: ASOF }];
    const record: Connection = { id: 'conn-gh', workspaceId: 'ws1', source: 'github', provider: 'github', roles: ['changes'], authKind: 'api_key', state: 'needs_reconnect', detail: 'Token rejected', config: {}, updatedAt: ASOF };
    const server = { github: connectionView(record, ASOF) };
    const member = sourceViews(conns, { asOf: ASOF, server })[0];
    expect(member.actions.map((a) => [a.id, a.available])).toEqual([['reconnect', false], ['test', true], ['disconnect', false]]);
    expect(member.actions[0].reason).toMatch(/owners and admins/);
    const owner = sourceViews(conns, { asOf: ASOF, server, canManage: true })[0];
    expect(owner.actions.every((a) => a.available)).toBe(true);
  });

  it('a server view that reports stale groups the source as STALE', () => {
    const conns: SourceConnection[] = [{ provider: 'github', state: 'connected', detail: '', updatedAt: ASOF }];
    const record: Connection = { id: 'conn-gh', workspaceId: 'ws1', source: 'github', provider: 'github', roles: ['changes'], authKind: 'owner_env', state: 'connected', detail: '', config: {}, updatedAt: ASOF, lastSyncAt: '2026-09-23T20:00:00.000Z', freshAsOf: '2026-09-23T20:00:00.000Z', lastSuccessfulCheckAt: '2026-09-23T20:00:00.000Z' };
    const v = sourceViews(conns, { asOf: ASOF, server: { github: connectionView(record, ASOF) } })[0];
    expect(v.group).toBe('stale');
    expect(v.health).toBe('stale');
  });

  it('browser sources are never shown as verified-healthy', () => {
    const v = sourceViews(defaultConnections(), { asOf: ASOF });
    expect(v.every((x) => x.health === 'not_applicable')).toBe(true);
  });

  it('groups in a fixed order and drops empty groups', () => {
    const conns: SourceConnection[] = [
      { provider: 'ga4', state: 'simulated', detail: '', updatedAt: ASOF },
      { provider: 'jira', state: 'error', detail: '', updatedAt: ASOF },
      { provider: 'github', state: 'connected', detail: '', updatedAt: ASOF },
    ];
    expect(groupSources(sourceViews(conns, { asOf: ASOF })).map((g) => g.group)).toEqual(['connected', 'error', 'simulated']);
  });

  it('server workspace: owners/admins get real connect / reconnect / disconnect; environment-managed and members do not', () => {
    const mk = (over: Partial<Connection>): Connection => ({ id: 'conn-jira', workspaceId: 'ws1', source: 'jira', provider: 'jira', roles: ['work_items', 'changes'], authKind: 'api_key', state: 'needs_reconnect', detail: '', config: {}, updatedAt: ASOF, ...over });
    const conns: SourceConnection[] = [{ provider: 'jira', state: 'needs_reconnect', detail: '', updatedAt: ASOF }];
    const avail = (c: Connection, manage: boolean) => Object.fromEntries(sourceViews(conns, { asOf: ASOF, server: { jira: connectionView(c, ASOF) }, canManage: manage })[0].actions.map((a) => [a.id, a.available]));
    expect(avail(mk({}), true)).toEqual({ reconnect: true, test: true, disconnect: true });
    expect(avail(mk({}), false)).toEqual({ reconnect: false, test: true, disconnect: false });
    expect(avail(mk({ authKind: 'owner_env' }), true)).toEqual({ reconnect: false, test: true, disconnect: false });
    const off: SourceConnection[] = [{ provider: 'jira', state: 'not_configured', detail: '', updatedAt: ASOF }];
    const v = sourceViews(off, { asOf: ASOF, server: { jira: connectionView(mk({ state: 'not_configured' }), ASOF) }, canManage: true })[0];
    expect(v.actions.map((a) => [a.id, a.available])).toEqual([['connect', true]]);
  });
});
