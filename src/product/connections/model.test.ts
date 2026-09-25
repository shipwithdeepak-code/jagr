import { describe, expect, it } from 'vitest';
import type { Connection } from '../ports/persistence';
import type { SecretRef } from '../ports/secrets';
import { connectionHealth, connectionView, publicConfig, upgradeConnection } from './model';
import { createMemoryPersistence } from '../ports/memory';
import { exportServerWorkspace } from '../export/workspace';
import { WorkspaceExportV1Schema as ExportV1 } from '../export/v1';
import { manualClock } from '../ports/clock';

const NOW = '2026-09-25T12:00:00.000Z';
const base: Connection = {
  id: 'c1',
  workspaceId: 'ws-1',
  source: 'jira',
  provider: 'jira',
  roles: ['work_items', 'changes'],
  authKind: 'api_key',
  state: 'connected',
  detail: 'Jira Cloud · project SHOP',
  label: { name: 'Jira', short: 'Jira' },
  config: { site: 'https://acme.atlassian.net', project: 'SHOP' },
  externalAccount: 'acme.atlassian.net · SHOP',
  secretRef: 'sec_abc' as SecretRef,
  updatedAt: '2026-09-25T10:00:00.000Z',
};

describe('connection health', () => {
  const h = (c: Partial<Connection>) => connectionHealth({ ...base, ...c }, NOW).health;
  it('distinguishes verified, unverified, degraded, stale, reconnect, error, not configured', () => {
    expect(h({})).toBe('unverified');
    expect(h({ lastSuccessfulCheckAt: '2026-09-25T11:00:00.000Z' })).toBe('healthy');
    expect(h({ lastSuccessfulCheckAt: '2026-09-25T09:00:00.000Z', lastError: 'Jira is having problems (503).', lastErrorAt: '2026-09-25T11:00:00.000Z' })).toBe('degraded');
    // An error older than the last success is history, not current health.
    expect(h({ lastSuccessfulCheckAt: '2026-09-25T11:30:00.000Z', lastError: 'old', lastErrorAt: '2026-09-25T11:00:00.000Z' })).toBe('healthy');
    expect(h({ lastSuccessfulCheckAt: '2026-09-25T11:00:00.000Z', freshAsOf: '2026-09-25T01:00:00.000Z' })).toBe('stale');
    expect(h({ state: 'needs_reconnect' })).toBe('needs_reconnect');
    expect(h({ state: 'error' })).toBe('error');
    expect(h({ state: 'not_configured' })).toBe('not_configured');
    expect(h({ state: 'unavailable' })).toBe('degraded');
    expect(h({ state: 'simulated' })).toBe('not_applicable');
  });
});

describe('connection view (what leaves the server)', () => {
  it('never carries the secret ref, a credential-looking config value, or an email', () => {
    const v = connectionView({ ...base, config: { ...base.config, apiToken: 'ATATT3xFfGF0secret', note: 'owner jo@acme.test' }, externalAccount: 'jo@acme.test' }, NOW);
    const json = JSON.stringify(v);
    expect(json).not.toMatch(/secretRef|sec_abc|ATATT3|jo@acme/);
    expect(v.config).toEqual({ site: 'https://acme.atlassian.net', project: 'SHOP' });
    expect(v.account).toBeUndefined();
  });

  it('exposes the product fields', () => {
    const v = connectionView({ ...base, lastSuccessfulCheckAt: '2026-09-25T11:00:00.000Z', capabilities: ['read:jira-work'] }, NOW);
    expect(v).toMatchObject({ id: 'c1', provider: 'jira', displayName: 'Jira', account: 'acme.atlassian.net · SHOP', roles: ['work_items', 'changes'], kind: 'source', managedBy: 'workspace', status: 'connected', health: 'healthy', needsReconnect: false, capabilities: ['read:jira-work'], createdAt: base.updatedAt });
    expect(connectionView({ ...base, roles: [], authKind: 'owner_env' }, NOW)).toMatchObject({ kind: 'channel', managedBy: 'environment' });
  });

  it('upgrades records stored before createdAt existed, idempotently', () => {
    expect(upgradeConnection(base).createdAt).toBe(base.updatedAt);
    expect(upgradeConnection({ ...base, createdAt: '2026-01-01T00:00:00.000Z' }).createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(publicConfig({ secret: 'x', region: 'eu' })).toEqual({ region: 'eu' });
  });
});

describe('export stays independent of the stored connection shape', () => {
  it('connections with the new fields still export as valid Workspace Export v1', async () => {
    const { repos } = createMemoryPersistence();
    await repos.workspaces.create({ id: 'ws-1', name: 'W', mode: 'connected', createdAt: NOW, settings: { planner: 'deterministic', aiEgressAllowed: true, timezone: 'UTC' }, brief: { enabled: true, time: '08:00', timezone: 'UTC' }, importedExportIds: [], version: 1 });
    await repos.connections.save('ws-1', { ...base, createdAt: NOW, lastSuccessfulCheckAt: NOW, lastErrorAt: NOW, lastError: 'x', capabilities: ['read'] });
    const doc = await exportServerWorkspace(repos, 'ws-1', { clock: manualClock(NOW), appVersion: 'test' });
    expect(ExportV1.safeParse(doc).success).toBe(true);
    expect(JSON.stringify(doc.connections)).not.toMatch(/secretRef|lastError|capabilities/);
  });
});
