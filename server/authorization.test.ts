import { describe, expect, it } from 'vitest';
import { createMemoryPersistence } from '../src/product/ports/memory';
import { resolveWorkspaceContext } from './authorization';

describe('organization-aware authorization context', () => {
  it('resolves user → organization membership → workspace membership without changing workspace access', async () => {
    const { repos } = createMemoryPersistence();
    const now = '2026-09-28T00:00:00.000Z';
    await repos.organizations.create({ id: 'org-1', name: 'Acme', createdAt: now });
    await repos.users.create({ id: 'u1', displayName: 'Ana', createdAt: now }, { provider: 'test', subject: 'ana' });
    await repos.workspaces.create({ id: 'ws-1', organizationId: 'org-1', name: 'Product', mode: 'connected', createdAt: now, settings: { planner: 'deterministic', aiEgressAllowed: true, timezone: 'UTC' }, brief: { enabled: true, time: '08:00', timezone: 'UTC' }, importedExportIds: [], version: 1 });
    await repos.organizationMembers.add({ organizationId: 'org-1', userId: 'u1', role: 'owner' });
    await repos.members.add({ workspaceId: 'ws-1', userId: 'u1', role: 'owner', canApprove: true });
    const principal = { user: (await repos.users.get('u1'))!, session: { id: 's', userId: 'u1', createdAt: now, expiresAt: '2027-09-28T00:00:00.000Z' }, memberships: await repos.members.forUser('u1'), organizationMemberships: await repos.organizationMembers.forUser('u1') };
    expect(await resolveWorkspaceContext(repos, principal, 'ws-1')).toMatchObject({ userId: 'u1', organizationId: 'org-1', workspaceId: 'ws-1', workspaceRole: 'owner', permissions: { manageWorkspace: true, manageConnections: true, approveConsequential: true } });
    expect(await resolveWorkspaceContext(repos, principal, 'ws-other')).toBeNull();
    await repos.users.create({ id: 'u2', displayName: 'Ben', createdAt: now }, { provider: 'test', subject: 'ben' });
    await repos.organizationMembers.add({ organizationId: 'org-1', userId: 'u2', role: 'member' });
    const unauthorized = { user: (await repos.users.get('u2'))!, session: { id: 's2', userId: 'u2', createdAt: now, expiresAt: '2027-09-28T00:00:00.000Z' }, memberships: await repos.members.forUser('u2'), organizationMemberships: await repos.organizationMembers.forUser('u2') };
    expect(await resolveWorkspaceContext(repos, unauthorized, 'ws-1')).toBeNull();
  });
});
