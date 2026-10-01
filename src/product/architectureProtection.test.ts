import { describe, expect, it } from 'vitest';
import { defineNormalizedEvent } from './events';
import { createMemoryPersistence } from './ports/memory';
import { permissiveEntitlements } from './ports/entitlements';
import { sourceTargetIdsForWatch } from './sourceIdentity';
import { watchFromTemplate } from './catalog';

const NOW = '2026-09-28T00:00:00.000Z';
async function sourceScope(repos: ReturnType<typeof createMemoryPersistence>['repos'], connectionId: string, provider: 'github' | 'sentry') {
  await repos.organizations.create({ id: 'org-1', name: 'Acme', createdAt: NOW });
  await repos.workspaces.create({ id: 'ws-1', organizationId: 'org-1', name: 'Acme', mode: 'connected', createdAt: NOW, settings: { planner: 'deterministic', aiEgressAllowed: false, timezone: 'UTC' }, brief: { enabled: false, time: '08:00', timezone: 'UTC' }, importedExportIds: [], version: 1 });
  await repos.connections.save('ws-1', { id: connectionId, workspaceId: 'ws-1', source: provider, provider, roles: [], authKind: 'api_key', state: 'connected', detail: provider, config: {}, updatedAt: NOW });
}

describe('Phase 0A architecture boundaries', () => {
  it('one connection can own multiple stable source targets and watches resolve new and legacy identity', async () => {
    const { repos } = createMemoryPersistence();
    await sourceScope(repos, 'conn-github', 'github');
    const base = { organizationId: 'org-1', workspaceId: 'ws-1', connectionId: 'conn-github', provider: 'github', configuration: {}, status: 'active' as const, createdAt: NOW, updatedAt: NOW };
    await repos.sourceTargets.save('ws-1', { ...base, id: 'target-web', externalId: 'acme/web', displayName: 'acme/web' });
    await repos.sourceTargets.save('ws-1', { ...base, id: 'target-api', externalId: 'acme/api', displayName: 'acme/api' });
    const targets = await repos.sourceTargets.list('ws-1');
    expect(targets.map((t) => t.id).sort()).toEqual(['target-api', 'target-web']);
    const legacy = watchFromTemplate('w-legacy', 'github_changes', { sources: ['github'] });
    expect(sourceTargetIdsForWatch(legacy, targets).sort()).toEqual(['target-api', 'target-web']);
    expect(sourceTargetIdsForWatch({ ...legacy, sourceTargetIds: ['target-web'] }, targets)).toEqual(['target-web']);
  });

  it('source state is keyed by an existing source target, never by a watch', async () => {
    const { repos } = createMemoryPersistence();
    await sourceScope(repos, 'conn-1', 'sentry');
    await expect(repos.sourceStates.save('ws-1', { organizationId: 'org-1', workspaceId: 'ws-1', sourceTargetId: 'watch-1', provider: 'sentry', status: 'unchanged', version: 1, updatedAt: NOW })).rejects.toThrow('Source target');
    await repos.sourceTargets.save('ws-1', { id: 'target-1', organizationId: 'org-1', workspaceId: 'ws-1', connectionId: 'conn-1', provider: 'sentry', externalId: '123', displayName: 'Project', configuration: {}, status: 'active', createdAt: NOW, updatedAt: NOW });
    await repos.sourceStates.save('ws-1', { organizationId: 'org-1', workspaceId: 'ws-1', sourceTargetId: 'target-1', provider: 'sentry', status: 'unchanged', version: 1, lastCheckedAt: '2026-09-28T00:05:00.000Z', updatedAt: '2026-09-28T00:05:00.000Z' });
    expect(await repos.sourceStates.get('ws-1', 'target-1')).toMatchObject({ sourceTargetId: 'target-1' });
  });

  it('normalized events require tenant, target, version, and dedupe identity', () => {
    const event = defineNormalizedEvent({ eventId: 'evt-1', schemaVersion: 1, organizationId: 'org-1', workspaceId: 'ws-1', connectionId: 'conn-1', sourceTargetId: 'target-1', provider: 'github', type: 'release_published', occurredAt: '2026-09-28T00:00:00.000Z', observedAt: '2026-09-28T00:01:00.000Z', dedupeKey: 'github:release:1', provenance: { externalId: '1' } });
    expect(event).toMatchObject({ schemaVersion: 1, sourceTargetId: 'target-1', dedupeKey: 'github:release:1' });
    expect(() => defineNormalizedEvent({ ...event, organizationId: '' })).toThrow(/organizationId/);
  });

  it('validation entitlements remain permissive behind the central policy', async () => {
    const subject = { userId: 'u1', organizationId: 'org-1', workspaceId: 'ws-1' };
    expect(await permissiveEntitlements.canCreateWorkspace(subject)).toBe(true);
    expect(await permissiveEntitlements.canCreateWatch(subject)).toBe(true);
    expect(await permissiveEntitlements.canConnectSource(subject)).toBe(true);
    expect(await permissiveEntitlements.canRunInvestigation(subject)).toBe(true);
    expect(await permissiveEntitlements.canUsePlanner(subject)).toBe(true);
  });
});
