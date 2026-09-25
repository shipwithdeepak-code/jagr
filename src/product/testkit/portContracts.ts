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

    it('refuses a connection saved under another workspace', async () => {
      const { repos } = await make();
      await expect(repos.connections.save('ws-b', connection('ws-a'))).rejects.toBeInstanceOf(WriteConflict);
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

    it('an expired lease is claimable again, and the old holder can no longer complete it', async () => {
      const clock = manualClock('2026-09-24T08:00:00.000Z');
      const q = await make(clock);
      await q.enqueue(spec('k'));
      const [first] = await q.claim({ workerId: 'w1', limit: 1, leaseMs: 60_000 });
      clock.advance(61_000);
      const [second] = await q.claim({ workerId: 'w2', limit: 1, leaseMs: 60_000 });
      expect(second.id).toBe(first.id);
      expect(second.attempts).toBe(2);
      await expect(q.complete(first.id, first.leaseToken)).rejects.toBeInstanceOf(LeaseLost);
      await q.complete(second.id, second.leaseToken);
      expect((await q.inspect('k'))?.state).toBe('done');
    });

    it('failures retry until attempts run out, then dead-letter with the error', async () => {
      const clock = manualClock('2026-09-24T08:00:00.000Z');
      const q = await make(clock);
      await q.enqueue({ ...spec('k'), maxAttempts: 2 });
      const [a] = await q.claim({ workerId: 'w', limit: 1, leaseMs: 60_000 });
      await q.fail(a.id, a.leaseToken, 'timeout', '2026-09-24T08:05:00.000Z');
      expect(await q.claim({ workerId: 'w', limit: 1, leaseMs: 60_000 })).toEqual([]);
      clock.set('2026-09-24T08:05:00.000Z');
      const [b] = await q.claim({ workerId: 'w', limit: 1, leaseMs: 60_000 });
      await q.fail(b.id, b.leaseToken, 'timeout again', '2026-09-24T08:10:00.000Z');
      expect(await q.inspect('k')).toMatchObject({ state: 'dead', attempts: 2, lastError: 'timeout again' });
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
    it('stores and returns a secret behind an opaque ref that does not contain it', async () => {
      const s = await make();
      const ref = await s.put({ workspaceId: 'ws-a', connectionId: 'c1' }, { kind: 'api_key', fields: { apiKey: 'AK-123', secretKey: 'SK-456' } });
      expect(String(ref)).not.toMatch(/AK-123|SK-456/);
      expect(await s.get(ref)).toEqual({ secret: { kind: 'api_key', fields: { apiKey: 'AK-123', secretKey: 'SK-456' } }, version: 1 });
    });

    it('replace is compare-and-swap: two refreshes racing cannot both win', async () => {
      const s = await make();
      const ref = await s.put({ workspaceId: 'ws-a', connectionId: 'c1' }, { kind: 'oauth', accessToken: 'a1', refreshToken: 'r1', scopes: [] });
      await s.replace(ref, 1, { kind: 'oauth', accessToken: 'a2', refreshToken: 'r2', scopes: [] });
      await expect(s.replace(ref, 1, { kind: 'oauth', accessToken: 'a3', refreshToken: 'r3', scopes: [] })).rejects.toBeInstanceOf(SecretVersionConflict);
      expect((await s.get(ref)).secret).toMatchObject({ refreshToken: 'r2' });
    });

    it('delete removes it', async () => {
      const s = await make();
      const ref = await s.put({ workspaceId: 'ws-a', connectionId: 'c1' }, { kind: 'app_installation', installationId: '42' });
      await s.delete(ref);
      await expect(s.get(ref)).rejects.toThrow();
    });
  });
}
