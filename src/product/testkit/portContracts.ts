import { describe, expect, it } from 'vitest';
import type { Clock } from '../ports/clock';
import { manualClock } from '../ports/clock';
import type { JobQueue } from '../ports/jobs';
import { LeaseLost } from '../ports/jobs';
import type { Connection, Repositories, Transactor, Workspace } from '../ports/persistence';
import { WriteConflict } from '../ports/persistence';
import type { SecretStore } from '../ports/secrets';
import { SecretVersionConflict } from '../ports/secrets';
import { watchFromTemplate } from '../catalog';
import type { WatchInvestigation } from '../types';
import type { ImportedDataset } from '../imports/schemas';
import type { HistoryPage, HistoryQuery, HistoryScope } from '../ports/history';

/**
 * Port contract suites. Every implementation of a port — the in-memory reference and each real
 * adapter (Postgres, …) — must pass the same suite. Test support (vitest); excluded from the core build.
 */

export const workspaceFixture = (id: string, patch: Partial<Workspace> = {}): Workspace => ({
  id,
  name: `Workspace ${id}`,
  mode: 'connected',
  createdAt: '2026-09-24T08:00:00.000Z',
  settings: { planner: 'deterministic', aiEgressAllowed: true, timezone: 'UTC' },
  brief: { enabled: true, time: '08:00', timezone: 'UTC' },
  importedExportIds: [],
  version: 1,
  ...patch,
});

const connection = (workspaceId: string, id = 'conn-1'): Connection => ({ id, workspaceId, source: 'github', provider: 'github', roles: ['changes'], authKind: 'app_install', state: 'connected', detail: 'acme/checkout', config: { repos: ['acme/checkout'] }, updatedAt: '2026-09-24T08:00:00.000Z' });

export function repositoriesContract(name: string, make: () => Promise<{ repos: Repositories; tx: Transactor }> | { repos: Repositories; tx: Transactor }) {
  describe(`Repositories contract: ${name}`, () => {
    it('isolates workspaces: nothing written in one is visible from another', async () => {
      const { repos } = await make();
      await repos.workspaces.create(workspaceFixture('ws-a'));
      await repos.workspaces.create(workspaceFixture('ws-b'));
      await repos.watches.save('ws-a', watchFromTemplate('w1', 'checkout_health'));
      await repos.connections.save('ws-a', connection('ws-a'));
      await repos.cursors.set('ws-a', 'k', 'v');
      expect(await repos.watches.list('ws-b')).toEqual([]);
      expect(await repos.connections.list('ws-b')).toEqual([]);
      expect(await repos.watches.get('ws-b', 'w1')).toBeNull();
      expect(await repos.cursors.get('ws-b', 'k')).toBeNull();
      expect((await repos.watches.list('ws-a')).map((w) => w.id)).toEqual(['w1']);
    });

    it('selects connected scheduler workspaces by oldest attempt with a repository bound', async () => {
      const { repos } = await make();
      await repos.workspaces.create(workspaceFixture('ws-a'));
      await repos.workspaces.create(workspaceFixture('ws-b'));
      await repos.workspaces.create(workspaceFixture('ws-c', { mode: 'imported' }));
      await repos.cursors.set('ws-a', 'scheduler.last_attempt', '2026-09-24T08:00:00.000Z');
      expect((await repos.workspaces.listForScheduler(1)).map((workspace) => workspace.id)).toEqual(['ws-b']);
      expect((await repos.workspaces.listForScheduler(2)).map((workspace) => workspace.id)).toEqual(['ws-b', 'ws-a']);
    });

    it('refuses a connection saved under another workspace', async () => {
      const { repos } = await make();
      await expect(repos.connections.save('ws-b', connection('ws-a'))).rejects.toBeInstanceOf(WriteConflict);
    });

    it('source targets, source state and normalized events enforce tenant scope and event dedupe', async () => {
      const { repos } = await make();
      const at = '2026-09-24T08:00:00.000Z';
      await repos.organizations.create({ id: 'org-a', name: 'A', createdAt: at });
      await repos.organizations.create({ id: 'org-b', name: 'B', createdAt: at });
      await repos.workspaces.create(workspaceFixture('ws-a', { organizationId: 'org-a' }));
      await repos.workspaces.create(workspaceFixture('ws-b', { organizationId: 'org-b' }));
      await repos.connections.save('ws-a', connection('ws-a'));
      const target = { id: 'target-a', organizationId: 'org-a', workspaceId: 'ws-a', connectionId: 'conn-1', provider: 'github', externalId: 'acme/repo', displayName: 'acme/repo', configuration: {}, status: 'active' as const, createdAt: at, updatedAt: at };
      await repos.sourceTargets.save('ws-a', target);
      await repos.connections.save('ws-b', connection('ws-b'));
      const otherTarget = { ...target, id: 'target-b', organizationId: 'org-b', workspaceId: 'ws-b', connectionId: 'conn-1', externalId: 'other/repo' };
      await repos.sourceTargets.save('ws-b', otherTarget);
      expect(await repos.sourceTargets.get('ws-b', target.id)).toBeNull();
      await repos.sourceStates.save('ws-a', { organizationId: 'org-a', workspaceId: 'ws-a', sourceTargetId: target.id, provider: 'github', status: 'unchanged', version: 1, updatedAt: at });
      await expect(repos.sourceStates.save('ws-b', { organizationId: 'org-b', workspaceId: 'ws-b', sourceTargetId: target.id, provider: 'github', status: 'unchanged', version: 1, updatedAt: at })).rejects.toThrow('Source target');
      const event = { eventId: 'evt-1', schemaVersion: 1 as const, organizationId: 'org-a', workspaceId: 'ws-a', connectionId: 'conn-1', sourceTargetId: target.id, provider: 'github', type: 'release', occurredAt: at, observedAt: at, dedupeKey: 'release:1', provenance: { externalId: '1' } };
      expect(await repos.events.add('ws-a', event)).toBe(true);
      expect(await repos.events.add('ws-a', event)).toBe(false);
      const scope = { organizationId: 'org-a', workspaceId: 'ws-a' };
      expect(await repos.events.get(scope, event.eventId)).toEqual(event);
      expect(await repos.events.get({ organizationId: 'org-b', workspaceId: 'ws-b' }, event.eventId)).toBeNull();
      expect(await repos.events.get({ organizationId: 'org-b', workspaceId: 'ws-a' }, event.eventId)).toBeNull();
      await expect(repos.events.add('ws-b', { ...event, workspaceId: 'ws-b', organizationId: 'org-b' })).rejects.toThrow('Source target');
      expect(await repos.events.list(scope, { sourceTargetId: target.id })).toEqual([event]);
      expect(await repos.events.list({ organizationId: 'org-b', workspaceId: 'ws-b' })).toEqual([]);
      const localWatch = { ...watchFromTemplate('local', 'github_changes'), sourceTargetIds: [target.id] };
      await expect(repos.watches.save('ws-a', localWatch)).resolves.toBeUndefined();
      await expect(repos.watches.save('ws-a', { ...localWatch, id: 'foreign', sourceTargetIds: [otherTarget.id] })).rejects.toThrow('Source target');
    });

    it('counts tenant resources and stores subscriptions and retry-safe usage by organization', async () => {
      const { repos } = await make();
      const at = '2026-09-24T08:00:00.000Z';
      const end = '2026-10-01T00:00:00.000Z';
      await repos.organizations.create({ id: 'org-a', name: 'A', createdAt: at });
      await repos.organizations.create({ id: 'org-b', name: 'B', createdAt: at });
      expect(await repos.subscriptions.get('org-a')).toMatchObject({ organizationId: 'org-a', planId: 'legacy', status: 'active' });
      expect(await repos.subscriptions.get('org-b')).toMatchObject({ organizationId: 'org-b', planId: 'legacy', status: 'active' });
      await repos.workspaces.create(workspaceFixture('ws-a', { organizationId: 'org-a' }));
      await repos.workspaces.create(workspaceFixture('ws-b', { organizationId: 'org-b' }));
      expect(await repos.workspaces.countForOrganization('org-a')).toBe(1);
      expect((await repos.workspaces.listForOrganization('org-a')).map((workspace) => workspace.id)).toEqual(['ws-a']);
      await repos.connections.save('ws-a', connection('ws-a'));
      await repos.sourceTargets.save('ws-a', { id: 'target-a', organizationId: 'org-a', workspaceId: 'ws-a', connectionId: 'conn-1', provider: 'github', externalId: 'acme/repo', displayName: 'Acme', configuration: {}, status: 'active', createdAt: at, updatedAt: at });
      await repos.watches.save('ws-a', { ...watchFromTemplate('w1', 'github_changes'), sourceTargetIds: ['target-a'] });
      expect(await repos.sourceTargets.countForOrganization('org-a')).toBe(1);
      expect(await repos.sourceTargets.countForOrganization('org-b')).toBe(0);
      expect(await repos.watches.countForOrganization('org-a')).toBe(1);
      const legacy = await repos.subscriptions.lock('org-a', at);
      expect(legacy).toMatchObject({ organizationId: 'org-a', planId: 'legacy', status: 'active' });
      await repos.subscriptions.save({ ...legacy, planId: 'paid', updatedAt: at });
      expect(await repos.subscriptions.get('org-a')).toMatchObject({ planId: 'paid' });
      const usage = { id: 'job-1', organizationId: 'org-a', workspaceId: 'ws-a', kind: 'investigation_execution' as const, amount: 1, periodStart: '2026-09-01T00:00:00.000Z', periodEnd: end, occurredAt: at };
      expect(await repos.usage.add(usage)).toBe(true);
      expect(await repos.usage.add(usage)).toBe(false);
      expect(await repos.usage.sum('org-a', usage.kind, usage.periodStart, usage.periodEnd)).toBe(1);
      expect(await repos.usage.sum('org-b', usage.kind, usage.periodStart, usage.periodEnd)).toBe(0);
      expect(await repos.usage.get('org-b', usage.id)).toBeNull();
    });

    it('normalized event reads are bounded, ordered, filterable, and tied to a watch cadence slot', async () => {
      const { repos } = await make();
      const at = '2026-09-24T08:00:00.000Z';
      await repos.organizations.create({ id: 'org-a', name: 'A', createdAt: at });
      await repos.workspaces.create(workspaceFixture('ws-a', { organizationId: 'org-a' }));
      await repos.connections.save('ws-a', connection('ws-a'));
      const target = { id: 'target-a', organizationId: 'org-a', workspaceId: 'ws-a', connectionId: 'conn-1', provider: 'github', externalId: 'acme/repo', displayName: 'acme/repo', configuration: {}, status: 'active' as const, createdAt: at, updatedAt: at };
      await repos.sourceTargets.save('ws-a', target);
      const scope = { organizationId: 'org-a', workspaceId: 'ws-a' };
      const slot = '2026-09-24T09:00:00.000Z';
      for (let i = 104; i >= 0; i--) {
        const occurredAt = new Date(Date.parse(at) + i * 1000).toISOString();
        const event = { eventId: `evt-${String(i).padStart(3, '0')}`, schemaVersion: 1 as const, organizationId: 'org-a', workspaceId: 'ws-a', connectionId: 'conn-1', sourceTargetId: target.id, provider: 'github', type: i % 2 ? 'release' : 'issue', occurredAt, observedAt: at, dedupeKey: `event:${i}`, provenance: { externalId: String(i) } };
        await repos.events.add('ws-a', event);
        await repos.cursors.set('ws-a', `source-event:${event.eventId}:watch:w1`, slot);
      }
      expect((await repos.events.list(scope)).map((event) => event.eventId)).toHaveLength(100);
      expect((await repos.events.list(scope, { type: 'release', limit: 2 })).map((event) => event.eventId)).toEqual(['evt-001', 'evt-003']);
      expect((await repos.events.forWatchSlot(scope, 'w1', slot, 2)).map((event) => event.eventId)).toEqual(['evt-000', 'evt-001']);
      expect(await repos.events.forWatchSlot({ organizationId: 'org-other', workspaceId: 'ws-a' }, 'w1', slot)).toEqual([]);
    });

    it('pages histories deterministically without cross-tenant or cross-workspace cursors', async () => {
      const { repos } = await make();
      const at = '2026-09-24T08:00:00.000Z';
      await repos.organizations.create({ id: 'org-history-a', name: 'A', createdAt: at });
      await repos.organizations.create({ id: 'org-history-b', name: 'B', createdAt: at });
      await repos.workspaces.create(workspaceFixture('history-a', { organizationId: 'org-history-a' }));
      await repos.workspaces.create(workspaceFixture('history-a2', { organizationId: 'org-history-a' }));
      await repos.workspaces.create(workspaceFixture('history-b', { organizationId: 'org-history-b' }));
      const scope = { organizationId: 'org-history-a', workspaceId: 'history-a' };
      for (let i = 0; i < 105; i++) {
        const id = `h-${String(i).padStart(3, '0')}`;
        await repos.audit.append({ id, workspaceId: scope.workspaceId, at, actor: { ref: 'system', displayName: 'Jagr' }, action: 'test' });
        await repos.notifications.add(scope.workspaceId, { id, channel: 'chat', dedupeKey: id, deliveredAt: at, status: 'delivered' });
        await repos.investigations.save(scope.workspaceId, { id, startedAt: at, updatedAt: at } as WatchInvestigation);
        await repos.imports.save(scope.workspaceId, { id } as ImportedDataset);
      }
      const methods: Array<(scope: HistoryScope, query?: HistoryQuery) => Promise<HistoryPage<{ id: string }>>> = [repos.audit.page, repos.notifications.page, repos.investigations.page, repos.imports.page];
      for (const method of methods) {
        const first = await method(scope, { limit: 2 });
        expect(first.items.map((item) => item.id)).toEqual(['h-104', 'h-103']);
        expect(first.nextCursor).toBeTruthy();
        const second = await method(scope, { limit: 2, cursor: first.nextCursor! });
        expect(second.items.map((item) => item.id)).toEqual(['h-102', 'h-101']);
        await expect(method({ organizationId: 'org-history-b', workspaceId: 'history-b' }, { cursor: first.nextCursor! })).rejects.toThrow('Invalid history cursor');
        await expect(method({ organizationId: 'org-history-a', workspaceId: 'history-a2' }, { cursor: first.nextCursor! })).rejects.toThrow('Invalid history cursor');
        await expect(method({ organizationId: 'org-history-b', workspaceId: 'history-a' })).rejects.toThrow('Workspace');
        expect((await method(scope, { limit: 1000 })).items).toHaveLength(100);
        const ids: string[] = [];
        let cursor: string | null = null;
        do {
          const next = await method(scope, { limit: 17, ...(cursor ? { cursor } : {}) });
          ids.push(...next.items.map((item) => item.id));
          cursor = next.nextCursor;
        } while (cursor);
        expect(ids).toEqual(Array.from({ length: 105 }, (_, i) => `h-${String(104 - i).padStart(3, '0')}`));
      }
      const beforeInsert = await repos.audit.page(scope, { limit: 2 });
      await repos.audit.append({ id: 'h-new', workspaceId: scope.workspaceId, at: '2026-09-25T08:00:00.000Z', actor: { ref: 'system', displayName: 'Jagr' }, action: 'test' });
      expect((await repos.audit.page(scope, { limit: 2, cursor: beforeInsert.nextCursor! })).items.map((entry) => entry.id)).toEqual(['h-102', 'h-101']);
      await expect(repos.notifications.page(scope, { cursor: beforeInsert.nextCursor! })).rejects.toThrow('Invalid history cursor');
    });

    it('uses scoped window pages and point lookups for briefs and decisions', async () => {
      const { repos } = await make();
      const at = '2026-09-25T08:00:00.000Z';
      const since = '2026-09-24T08:00:00.000Z';
      await repos.organizations.create({ id: 'org-window', name: 'A', createdAt: since });
      await repos.workspaces.create(workspaceFixture('ws-window', { organizationId: 'org-window' }));
      const scope = { organizationId: 'org-window', workspaceId: 'ws-window' };
      await repos.investigations.save(scope.workspaceId, { id: 'old', startedAt: '2026-09-01T08:00:00.000Z', updatedAt: since, actions: [{ id: 'action-old' }] } as WatchInvestigation);
      await repos.investigations.save(scope.workspaceId, { id: 'irrelevant', startedAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-02T08:00:00.000Z', actions: [] } as unknown as WatchInvestigation);
      expect((await repos.investigations.pageForBriefWindow(scope, since, at, { limit: 1 })).items.map((item) => item.id)).toEqual(['old']);
      expect((await repos.investigations.findByActionId(scope.workspaceId, 'action-old'))?.id).toBe('old');
      expect(await repos.investigations.findByActionId('another-workspace', 'action-old')).toBeNull();
      await repos.notifications.add(scope.workspaceId, { id: 'email', channel: 'in_app', dedupeKey: 'email', deliveredAt: at, status: 'delivered', investigationId: 'old', email: { sentAt: at } as never });
      await repos.notifications.add(scope.workspaceId, { id: 'chat', channel: 'chat', dedupeKey: 'chat', deliveredAt: at, status: 'delivered' });
      expect((await repos.notifications.pageForBriefWindow(scope, since, at)).items.map((item) => item.id)).toEqual(['email']);
      expect((await repos.notifications.firstEmailForInvestigation(scope.workspaceId, 'old'))?.id).toBe('email');
      expect(await repos.notifications.firstEmailForInvestigation('another-workspace', 'old')).toBeNull();
      await expect(repos.notifications.pageForBriefWindow({ organizationId: 'wrong', workspaceId: scope.workspaceId }, since, at)).rejects.toThrow('Workspace');
      const brief = { id: 'brief-latest', generatedAt: at, window: { start: since, end: at }, headline: 'One', items: [], quiet: { watchCount: 0, watchNames: [], note: '' }, deduplicated: [], stats: { watchRuns: 0, sourcesChecked: 0, emailsSent: 0, dismissed: 0 } };
      await repos.briefs.save(scope.workspaceId, brief);
      expect((await repos.briefs.page(scope, { limit: 1 })).items).toEqual([brief]);
    });

    it('returns copies: mutating a result never changes stored state', async () => {
      const { repos } = await make();
      await repos.workspaces.create(workspaceFixture('ws-a'));
      const w = (await repos.workspaces.get('ws-a'))!;
      w.name = 'mutated';
      expect((await repos.workspaces.get('ws-a'))!.name).toBe('Workspace ws-a');
    });

    it('workspace updates are optimistic: a stale version is refused', async () => {
      const { repos } = await make();
      await repos.workspaces.create(workspaceFixture('ws-a'));
      const w = (await repos.workspaces.get('ws-a'))!;
      await repos.workspaces.update({ ...w, name: 'first' }, 1);
      await expect(repos.workspaces.update({ ...w, name: 'second' }, 1)).rejects.toBeInstanceOf(WriteConflict);
      expect((await repos.workspaces.get('ws-a'))!).toMatchObject({ name: 'first', version: 2 });
    });

    it('decisions are optimistic when the caller says what it read', async () => {
      const { repos } = await make();
      const d = { actionId: 'act-1', status: 'approved' as const, at: '2026-09-24T08:10:00.000Z' };
      await repos.decisions.put('ws-a', d, null);
      await expect(repos.decisions.put('ws-a', { ...d, status: 'rejected' }, null)).rejects.toBeInstanceOf(WriteConflict);
      await repos.decisions.put('ws-a', { ...d, status: 'rejected' }, d);
      expect((await repos.decisions.list('ws-a'))[0].status).toBe('rejected');
    });

    it('identities link users by (provider, subject) — once', async () => {
      const { repos } = await make();
      await repos.users.create({ id: 'u1', displayName: 'Deepak', createdAt: '2026-09-24T08:00:00.000Z' }, { provider: 'google', subject: '123' });
      expect((await repos.users.byIdentity('google', '123'))?.id).toBe('u1');
      expect(await repos.users.byIdentity('github', '123')).toBeNull();
      await expect(repos.users.create({ id: 'u2', displayName: 'X', createdAt: '2026-09-24T08:00:00.000Z' }, { provider: 'google', subject: '123' })).rejects.toBeInstanceOf(WriteConflict);
    });

    it('briefs are stored per workspace, replaced by id, listed oldest first', async () => {
      const { repos } = await make();
      const b = (id: string, at: string, headline: string) => ({ id, generatedAt: at, window: { start: at, end: at }, headline, items: [], quiet: { watchCount: 0, watchNames: [], note: '' }, deduplicated: [], stats: { watchRuns: 0, sourcesChecked: 0, emailsSent: 0, dismissed: 0 } });
      await repos.briefs.save('ws-a', b('b2', '2026-09-25T08:00:00.000Z', 'second'));
      await repos.briefs.save('ws-a', b('b1', '2026-09-24T08:00:00.000Z', 'first'));
      await repos.briefs.save('ws-a', b('b2', '2026-09-25T08:00:00.000Z', 'second, recomposed'));
      expect((await repos.briefs.list('ws-a')).map((x) => x.headline)).toEqual(['first', 'second, recomposed']);
      expect(await repos.briefs.list('ws-b')).toEqual([]);
    });

    it('locks: exclusive until expiry, re-entrant for the same owner, released only by the owner', async () => {
      const { repos } = await make();
      const t0 = '2026-09-25T10:00:00.000Z';
      const until = '2026-09-25T10:15:00.000Z';
      expect(await repos.locks.acquire('ws-a', 'run', 'A', until, t0)).toBe(true);
      expect(await repos.locks.acquire('ws-a', 'run', 'B', until, t0)).toBe(false);
      expect(await repos.locks.acquire('ws-b', 'run', 'B', until, t0)).toBe(true);
      expect(await repos.locks.renew('ws-a', 'run', 'B', '2026-09-25T10:30:00.000Z', t0)).toBe(false);
      expect(await repos.locks.renew('ws-a', 'run', 'A', '2026-09-25T10:30:00.000Z', t0)).toBe(true);
      expect(await repos.locks.acquire('ws-a', 'run', 'A', until, t0)).toBe(true);
      await repos.locks.release('ws-a', 'run', 'B');
      expect(await repos.locks.acquire('ws-a', 'run', 'B', until, t0)).toBe(false);
      // Expired: anyone may take it.
      expect(await repos.locks.acquire('ws-a', 'run', 'B', '2026-09-25T10:30:00.000Z', '2026-09-25T10:16:00.000Z')).toBe(true);
      expect(await repos.locks.renew('ws-a', 'run', 'A', '2026-09-25T10:45:00.000Z', '2026-09-25T10:16:00.000Z')).toBe(false);
      await repos.locks.release('ws-a', 'run', 'B');
      expect(await repos.locks.acquire('ws-a', 'run', 'C', until, t0)).toBe(true);
    });

    it('notification claims: settle replaces the record; releasing the dedupe key lets it be claimed again', async () => {
      const { repos } = await make();
      const claim = { id: 'c1', channel: 'chat', dedupeKey: 'k', deliveredAt: '2026-09-25T10:00:00.000Z', status: 'sending' as const };
      expect(await repos.notifications.add('ws-a', claim)).toBe(true);
      expect(await repos.notifications.byDedupe('ws-a', 'chat', 'k')).toEqual(claim);
      expect(await repos.notifications.byDedupe('ws-b', 'chat', 'k')).toBeNull();
      expect(await repos.notifications.add('ws-a', { ...claim, id: 'c2' })).toBe(false);
      await repos.notifications.settle('ws-a', { ...claim, status: 'failed', dedupeKey: 'k#failed' });
      expect(await repos.notifications.byDedupe('ws-a', 'chat', 'k')).toBeNull();
      expect((await repos.notifications.list('ws-a')).map((n) => [n.id, n.status, n.dedupeKey])).toEqual([['c1', 'failed', 'k#failed']]);
      expect(await repos.notifications.add('ws-a', { ...claim, id: 'c2' })).toBe(true);
    });

    it('notifications are deduplicated per channel', async () => {
      const { repos } = await make();
      const n = { id: 'n1', channel: 'chat', dedupeKey: 'inv-1:HIGH', deliveredAt: '2026-09-24T08:00:00.000Z', status: 'delivered' as const };
      expect(await repos.notifications.add('ws-a', n)).toBe(true);
      expect(await repos.notifications.add('ws-a', { ...n, id: 'n2' })).toBe(false);
      expect(await repos.notifications.add('ws-a', { ...n, id: 'n3', channel: 'in_app' })).toBe(true);
    });

    it('a failed transaction leaves no partial writes', async () => {
      const { repos, tx } = await make();
      await repos.workspaces.create(workspaceFixture('ws-a'));
      await expect(
        tx.run(async (r) => {
          await r.watches.save('ws-a', watchFromTemplate('w1', 'checkout_health'));
          await r.audit.append({ id: 'a1', workspaceId: 'ws-a', at: '2026-09-24T08:00:00.000Z', actor: { ref: 'system', displayName: 'Jagr' }, action: 'watch.created' });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await repos.watches.list('ws-a')).toEqual([]);
      expect(await repos.audit.list('ws-a')).toEqual([]);
      await tx.run(async (r) => r.watches.save('ws-a', watchFromTemplate('w1', 'checkout_health')));
      expect(await repos.watches.list('ws-a')).toHaveLength(1);
    });
  });
}

export function jobQueueContract(name: string, make: (clock: Clock) => Promise<JobQueue> | JobQueue) {
  describe(`JobQueue contract: ${name}`, () => {
    const spec = (key: string, runAt = '2026-09-24T08:00:00.000Z') => ({ kind: 'monitor.watch' as const, workspaceId: 'ws-a', payload: { watchId: 'w1' }, runAt, idempotencyKey: key });

    it('enqueue is idempotent by key', async () => {
      const clock = manualClock('2026-09-24T08:00:00.000Z');
      const q = await make(clock);
      expect(await q.enqueue(spec('k1'))).toBe(true);
      expect(await q.enqueue(spec('k1'))).toBe(false);
      expect(await q.inspect('k1')).toMatchObject({ state: 'queued', attempts: 0, createdAt: '2026-09-24T08:00:00.000Z' });
      expect(await q.claim({ workerId: 'w', limit: 10, leaseMs: 60_000 })).toHaveLength(1);
    });

    it('only due jobs are claimed, oldest first; a leased job is not handed out twice', async () => {
      const clock = manualClock('2026-09-24T08:00:00.000Z');
      const q = await make(clock);
      await q.enqueue(spec('later', '2026-09-24T09:00:00.000Z'));
      await q.enqueue(spec('b', '2026-09-24T07:59:00.000Z'));
      await q.enqueue(spec('a', '2026-09-24T07:58:00.000Z'));
      const got = await q.claim({ workerId: 'w1', limit: 10, leaseMs: 60_000 });
      expect(got.map((j) => j.idempotencyKey)).toEqual(['a', 'b']);
      expect(await q.claim({ workerId: 'w2', limit: 10, leaseMs: 60_000 })).toEqual([]);
    });

    it('lets another workspace make progress despite one older backlog', async () => {
      const clock = manualClock('2026-09-24T08:00:00.000Z');
      const q = await make(clock);
      for (const key of ['hot-a', 'hot-b', 'hot-c']) await q.enqueue(spec(key, '2026-09-24T07:00:00.000Z'));
      await q.enqueue({ ...spec('other', '2026-09-24T07:59:00.000Z'), workspaceId: 'ws-b' });
      const claimed = (await q.claim({ workerId: 'w', limit: 2, leaseMs: 60_000 })).map((job) => job.idempotencyKey);
      expect(claimed[0]).toMatch(/^hot-/);
      expect(claimed[1]).toBe('other');
    });

    it('an expired lease is claimable again, and the old holder can no longer complete it', async () => {
      const clock = manualClock('2026-09-24T08:00:00.000Z');
      const q = await make(clock);
      await q.enqueue(spec('k'));
      const [first] = await q.claim({ workerId: 'w1', limit: 1, leaseMs: 60_000 });
      expect(await q.inspect('k')).toMatchObject({ firstAttemptedAt: '2026-09-24T08:00:00.000Z', lastAttemptedAt: '2026-09-24T08:00:00.000Z' });
      clock.advance(61_000);
      const [second] = await q.claim({ workerId: 'w2', limit: 1, leaseMs: 60_000 });
      expect(second.id).toBe(first.id);
      expect(second.attempts).toBe(2);
      await expect(q.complete(first.id, first.leaseToken)).rejects.toBeInstanceOf(LeaseLost);
      await q.complete(second.id, second.leaseToken);
      expect(await q.inspect('k')).toMatchObject({ state: 'done', completedAt: '2026-09-24T08:01:01.000Z' });
    });

    it('failures retry until attempts run out, then dead-letter with the error', async () => {
      const clock = manualClock('2026-09-24T08:00:00.000Z');
      const q = await make(clock);
      await q.enqueue({ ...spec('k'), maxAttempts: 2 });
      const [a] = await q.claim({ workerId: 'w', limit: 1, leaseMs: 60_000 });
      await q.fail(a.id, a.leaseToken, 'timeout', '2026-09-24T08:05:00.000Z');
      expect(await q.inspect('k')).toMatchObject({ state: 'queued', runAt: '2026-09-24T08:05:00.000Z', lastFailedAt: '2026-09-24T08:00:00.000Z' });
      expect(await q.claim({ workerId: 'w', limit: 1, leaseMs: 60_000 })).toEqual([]);
      clock.set('2026-09-24T08:05:00.000Z');
      const [b] = await q.claim({ workerId: 'w', limit: 1, leaseMs: 60_000 });
      await q.fail(b.id, b.leaseToken, 'timeout again', '2026-09-24T08:10:00.000Z');
      expect(await q.inspect('k')).toMatchObject({ state: 'dead', attempts: 2, lastError: 'timeout again' });
    });

    it('reports bounded queue health without payloads or error text', async () => {
      const clock = manualClock('2026-09-24T08:00:00.000Z');
      const q = await make(clock);
      await q.enqueue({ ...spec('dead'), kind: 'source.check', payload: { secret: 'must-not-leak', sourceTargetId: 'target-a' }, maxAttempts: 1 });
      await q.enqueue(spec('waiting', '2026-09-24T09:00:00.000Z'));
      const [job] = await q.claim({ workerId: 'w', limit: 1, leaseMs: 60_000 });
      await q.fail(job.id, job.leaseToken, 'credential must-not-leak');
      const status = await q.status();
      expect(status).toMatchObject({ queued: 1, leased: 0, dead: 1, expiredLeases: 0, oldestQueuedAt: '2026-09-24T09:00:00.000Z' });
      expect(status.recentDead).toHaveLength(1);
      expect(status.recentDead[0]).toMatchObject({ jobId: job.id, workspaceId: 'ws-a', sourceTargetId: 'target-a', attempts: 1 });
      expect(JSON.stringify(status)).not.toContain('must-not-leak');
    });

    it('a lease that expired but was not taken over is still the holder’s: it can extend and complete', async () => {
      const clock = manualClock('2026-09-24T08:00:00.000Z');
      const q = await make(clock);
      await q.enqueue({ kind: 'monitor.watch', workspaceId: 'ws-a', payload: {}, idempotencyKey: 'slow' });
      const [j] = await q.claim({ workerId: 'w1', limit: 1, leaseMs: 60_000 });
      clock.advance(5 * 60_000);
      await q.extend(j.id, j.leaseToken, 60_000);
      await q.complete(j.id, j.leaseToken);
      expect(await q.inspect('slow')).toMatchObject({ state: 'done' });
    });

    it('extending a lease keeps the job', async () => {
      const clock = manualClock('2026-09-24T08:00:00.000Z');
      const q = await make(clock);
      await q.enqueue(spec('k'));
      const [j] = await q.claim({ workerId: 'w', limit: 1, leaseMs: 60_000 });
      clock.advance(50_000);
      await q.extend(j.id, j.leaseToken, 60_000);
      clock.advance(50_000);
      expect(await q.claim({ workerId: 'x', limit: 1, leaseMs: 60_000 })).toEqual([]);
      await q.complete(j.id, j.leaseToken);
    });
  });
}

export function secretStoreContract(name: string, make: () => Promise<SecretStore> | SecretStore) {
  describe(`SecretStore contract: ${name}`, () => {
    const owner = { workspaceId: 'ws-a', connectionId: 'c1' };
    it('stores and returns a secret behind an opaque ref that does not contain it', async () => {
      const s = await make();
      const ref = await s.put(owner, { kind: 'api_key', fields: { apiKey: 'AK-123', secretKey: 'SK-456' } });
      expect(String(ref)).not.toMatch(/AK-123|SK-456/);
      expect(await s.get(ref, owner)).toEqual({ secret: { kind: 'api_key', fields: { apiKey: 'AK-123', secretKey: 'SK-456' } }, version: 1 });
      await expect(s.get(ref, { workspaceId: 'ws-b', connectionId: 'c1' })).rejects.toThrow('Secret not found');
      await expect(s.get(ref, { workspaceId: 'ws-a', connectionId: 'c2' })).rejects.toThrow('Secret not found');
    });

    it('replace is compare-and-swap: two refreshes racing cannot both win', async () => {
      const s = await make();
      const ref = await s.put(owner, { kind: 'oauth', accessToken: 'a1', refreshToken: 'r1', scopes: [] });
      await s.replace(ref, owner, 1, { kind: 'oauth', accessToken: 'a2', refreshToken: 'r2', scopes: [] });
      await expect(s.replace(ref, owner, 1, { kind: 'oauth', accessToken: 'a3', refreshToken: 'r3', scopes: [] })).rejects.toBeInstanceOf(SecretVersionConflict);
      expect((await s.get(ref, owner)).secret).toMatchObject({ refreshToken: 'r2' });
    });

    it('delete removes it', async () => {
      const s = await make();
      const ref = await s.put(owner, { kind: 'app_installation', installationId: '42' });
      await expect(s.delete(ref, { workspaceId: 'ws-b', connectionId: 'c1' })).rejects.toThrow('Secret not found');
      await s.delete(ref, owner);
      await expect(s.get(ref, owner)).rejects.toThrow();
    });
  });
}
