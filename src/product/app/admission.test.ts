import { describe, expect, it } from 'vitest';
import { manualClock } from '../ports/clock';
import { planEntitlements } from '../ports/entitlements';
import { createMemoryPersistence } from '../ports/memory';
import type { Workspace } from '../ports/persistence';
import { AdmissionDenied, createAdmissionService, usagePeriod } from './admission';
import { watchFromTemplate } from '../catalog';

const NOW = '2026-09-29T08:00:00.000Z';
const workspace = (id: string): Workspace => ({ id, organizationId: 'org-1', name: id, mode: 'connected', createdAt: NOW, settings: { planner: 'deterministic', aiEgressAllowed: false, timezone: 'UTC' }, brief: { enabled: false, time: '08:00', timezone: 'UTC' }, importedExportIds: [], version: 1 });

async function setup(limits: Parameters<typeof planEntitlements>[0]['free']) {
  const { repos, tx } = createMemoryPersistence();
  const clock = manualClock(NOW);
  await repos.organizations.create({ id: 'org-1', name: 'Acme', createdAt: NOW });
  await repos.organizations.create({ id: 'org-2', name: 'Other', createdAt: NOW });
  await repos.subscriptions.save({ organizationId: 'org-1', planId: 'free', status: 'active', createdAt: NOW, updatedAt: NOW });
  const admission = createAdmissionService({ repos, tx, clock, entitlements: planEntitlements({ free: limits }) });
  return { repos, tx, clock, admission };
}

describe('SaaS admission control', () => {
  it('serializes simultaneous resource creation so a numeric workspace limit cannot be exceeded', async () => {
    const { repos, admission } = await setup({ maxWorkspaces: 1 });
    const create = (id: string) => admission.withResource('workspace', { organizationId: 'org-1', userId: 'u1' }, (r) => r.workspaces.create(workspace(id)));
    const results = await Promise.allSettled([create('ws-1'), create('ws-2')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected' && result.reason instanceof AdmissionDenied)).toHaveLength(1);
    expect(await repos.workspaces.countForOrganization('org-1')).toBe(1);
  });

  it('enforces watch and source limits from the same policy boundary', async () => {
    const { repos, admission } = await setup({ maxWatches: 1, maxSources: 1 });
    await repos.workspaces.create(workspace('ws-1'));
    await repos.connections.save('ws-1', { id: 'c1', workspaceId: 'ws-1', source: 'github', provider: 'github', roles: ['changes'], authKind: 'api_key', state: 'connected', detail: '', config: {}, updatedAt: NOW });
    const subject = { organizationId: 'org-1', workspaceId: 'ws-1' };
    await admission.withResource('source', subject, (r) => r.sourceTargets.save('ws-1', { id: 't1', organizationId: 'org-1', workspaceId: 'ws-1', connectionId: 'c1', provider: 'github', externalId: 'one', displayName: 'one', configuration: {}, status: 'active', createdAt: NOW, updatedAt: NOW }));
    await expect(admission.withResource('source', subject, (r) => r.sourceTargets.save('ws-1', { id: 't2', organizationId: 'org-1', workspaceId: 'ws-1', connectionId: 'c1', provider: 'github', externalId: 'two', displayName: 'two', configuration: {}, status: 'active', createdAt: NOW, updatedAt: NOW }))).rejects.toBeInstanceOf(AdmissionDenied);
    await admission.withResource('watch', subject, (r) => r.watches.save('ws-1', { ...watchFromTemplate('w1', 'github_changes', {}, NOW), sourceTargetIds: ['t1'] }));
    await expect(admission.withResource('watch', subject, async () => undefined)).rejects.toBeInstanceOf(AdmissionDenied);
  });

  it('records the first execution, deduplicates its retry, and counts distinct identities', async () => {
    const { repos, admission } = await setup({ investigationExecutionsPerPeriod: 2 });
    await repos.workspaces.create(workspace('ws-1'));
    const subject = { organizationId: 'org-1', workspaceId: 'ws-1' };
    expect(await admission.execution('investigation_execution', subject, 'job-1')).toMatchObject({ allowed: true, usageRecorded: true });
    expect(await admission.execution('investigation_execution', subject, 'job-1')).toMatchObject({ allowed: true, code: 'duplicate', usageRecorded: false });
    expect(await admission.execution('investigation_execution', subject, 'job-2')).toMatchObject({ allowed: true, usageRecorded: true });
    expect(await admission.execution('investigation_execution', subject, 'job-3')).toMatchObject({ allowed: false, code: 'limit_reached' });
    const period = usagePeriod(NOW);
    expect(await repos.usage.sum('org-1', 'investigation_execution', period.start, period.end)).toBe(2);
  });

  it('isolates usage by tenant and uses deterministic calendar periods', async () => {
    const { repos, admission, clock } = await setup({ sourceChecksPerPeriod: 1 });
    await repos.workspaces.create(workspace('ws-1'));
    await repos.workspaces.create({ ...workspace('ws-2'), organizationId: 'org-2' });
    await repos.subscriptions.save({ organizationId: 'org-2', planId: 'free', status: 'active', createdAt: NOW, updatedAt: NOW });
    expect(await admission.execution('source_check', { organizationId: 'org-1', workspaceId: 'ws-1' }, 'same')).toMatchObject({ allowed: true });
    expect(await admission.execution('source_check', { organizationId: 'org-2', workspaceId: 'ws-2' }, 'same')).toMatchObject({ allowed: true });
    clock.set('2026-10-01T00:00:00.000Z');
    expect(await admission.execution('source_check', { organizationId: 'org-1', workspaceId: 'ws-1' }, 'next-month')).toMatchObject({ allowed: true });
  });

  it('keeps planner capability explicit and denies mismatched organization/workspace scope', async () => {
    const { repos, admission } = await setup({ plannerAllowed: false });
    await repos.workspaces.create(workspace('ws-1'));
    expect(await admission.execution('planner_execution', { organizationId: 'org-1', workspaceId: 'ws-1' }, 'plan-1')).toMatchObject({ allowed: false, code: 'capability_denied' });
    expect(await admission.execution('source_check', { organizationId: 'org-2', workspaceId: 'ws-1' }, 'check-1')).toMatchObject({ allowed: false, code: 'invalid_scope' });
  });
});
