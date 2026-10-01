import { describe, expect, it } from 'vitest';
import { createMemoryJobQueue, createMemoryPersistence, createMemorySecretStore } from './ports/memory';
import { manualClock } from './ports/clock';
import { schedulerTick } from './app/scheduler';
import { watchFromTemplate } from './catalog';
import { jobQueueContract, repositoriesContract, secretStoreContract, workspaceFixture } from './testkit/portContracts';

repositoriesContract('in-memory', () => createMemoryPersistence());
jobQueueContract('in-memory', (clock) => createMemoryJobQueue(clock));
secretStoreContract('in-memory', () => createMemorySecretStore());

it('keeps an in-memory read snapshot stable while the live repository changes', async () => {
  const { repos, tx } = createMemoryPersistence();
  await repos.organizations.create({ id: 'org-snapshot', name: 'A', createdAt: '2026-09-25T00:00:00.000Z' });
  await repos.workspaces.create(workspaceFixture('ws-snapshot', { organizationId: 'org-snapshot' }));
  await repos.audit.append({ id: 'a', workspaceId: 'ws-snapshot', at: '2026-09-25T00:00:00.000Z', actor: { ref: 'system', displayName: 'Jagr' }, action: 'test' });
  await tx.readSnapshot(async (snapshot) => {
    expect((await snapshot.audit.page({ organizationId: 'org-snapshot', workspaceId: 'ws-snapshot' })).items).toHaveLength(1);
    await repos.audit.append({ id: 'b', workspaceId: 'ws-snapshot', at: '2026-09-25T00:01:00.000Z', actor: { ref: 'system', displayName: 'Jagr' }, action: 'test' });
    expect((await snapshot.audit.page({ organizationId: 'org-snapshot', workspaceId: 'ws-snapshot' })).items).toHaveLength(1);
  });
  expect(await repos.audit.list('ws-snapshot')).toHaveLength(2);
});

describe('scheduler tick', () => {
  async function setup() {
    const clock = manualClock('2026-09-24T08:00:00.000Z');
    const { repos } = createMemoryPersistence();
    const queue = createMemoryJobQueue(clock);
    await repos.workspaces.create(workspaceFixture('ws-a', { brief: { enabled: true, time: '08:30', timezone: 'UTC' } }));
    // Every 30 minutes, anchored at 07:00 → runs at :00 and :30.
    await repos.watches.save('ws-a', watchFromTemplate('w-checkout', 'checkout_health', { schedule: { frequency: '30m', dailyAt: '07:00' } }, '2026-09-24T07:00:00.000Z'));
    return { clock, repos, queue };
  }

  it('enqueues each due run exactly once, aligned to the watch grid, however often it ticks', async () => {
    const { clock, repos, queue } = await setup();
    await schedulerTick({ repos, queue, clock }); // first tick at 08:00 — looks back 5 minutes
    clock.set('2026-09-24T08:29:00.000Z');
    expect((await schedulerTick({ repos, queue, clock })).enqueued).toBe(0);
    clock.set('2026-09-24T08:30:00.000Z');
    const r = await schedulerTick({ repos, queue, clock });
    expect(r.enqueued).toBe(2); // the 08:30 run and the 08:30 brief
    expect(await queue.inspect('ws-a:run:w-checkout:2026-09-24T08:30:00.000Z')).toMatchObject({ state: 'queued' });
    expect(await queue.inspect('ws-a:brief:2026-09-24T08:30:00.000Z')).toMatchObject({ state: 'queued' });
    // A duplicate tick for the same instant (two cron invocations) adds nothing.
    await repos.cursors.set('ws-a', 'scheduler.last_tick', '2026-09-24T08:29:00.000Z');
    const dup = await schedulerTick({ repos, queue, clock });
    expect(dup).toMatchObject({ enqueued: 0, duplicates: 2 });
  });

  it('after a long gap, only the latest missed run is enqueued (a stale check is superseded, not replayed)', async () => {
    const { clock, repos, queue } = await setup();
    await schedulerTick({ repos, queue, clock });
    clock.set('2026-09-24T12:10:00.000Z');
    const r = await schedulerTick({ repos, queue, clock });
    expect(r.superseded).toBe(7);
    expect(await queue.inspect('ws-a:run:w-checkout:2026-09-24T12:00:00.000Z')).toMatchObject({ state: 'queued' });
    expect(await queue.inspect('ws-a:run:w-checkout:2026-09-24T11:30:00.000Z')).toBeNull();
  });

  it('a workspace waiting for its first scheduler batch still gets its latest due watch slot', async () => {
    const { clock, repos, queue } = await setup();
    clock.set('2026-09-24T10:10:00.000Z');
    await schedulerTick({ repos, queue, clock });
    expect(await queue.inspect('ws-a:run:w-checkout:2026-09-24T10:00:00.000Z')).toMatchObject({ state: 'queued' });
    expect(await queue.inspect('ws-a:run:w-checkout:2026-09-24T09:30:00.000Z')).toBeNull();
  });

  it('a very old checkpoint still schedules the latest slot without replaying the full gap', async () => {
    const { clock, repos, queue } = await setup();
    await schedulerTick({ repos, queue, clock });
    clock.set('2027-01-02T10:10:00.000Z');
    const report = await schedulerTick({ repos, queue, clock });
    expect(report.failedWorkspaceIds).toEqual([]);
    expect(await queue.inspect('ws-a:run:w-checkout:2027-01-02T10:00:00.000Z')).toMatchObject({ state: 'queued' });
    expect(report.superseded).toBeLessThan(100);
  });

  it('paused watches are not scheduled', async () => {
    const { clock, repos, queue } = await setup();
    const w = (await repos.watches.get('ws-a', 'w-checkout'))!;
    await repos.watches.save('ws-a', { ...w, status: 'paused' });
    await schedulerTick({ repos, queue, clock });
    clock.set('2026-09-24T09:00:00.000Z');
    const r = await schedulerTick({ repos, queue, clock });
    expect(r.enqueued).toBe(1); // only the brief
  });

  it('schedules one shared Sentry source check instead of one provider-backed run per watch', async () => {
    const clock = manualClock('2026-09-24T08:00:00.000Z');
    const { repos } = createMemoryPersistence();
    const queue = createMemoryJobQueue(clock);
    await repos.organizations.create({ id: 'org-a', name: 'Acme', createdAt: clock.now() });
    await repos.workspaces.create(workspaceFixture('ws-a', { organizationId: 'org-a', brief: { enabled: false, time: '08:30', timezone: 'UTC' } }));
    await repos.connections.save('ws-a', { id: 'conn-sentry', workspaceId: 'ws-a', source: 'sentry', provider: 'sentry', roles: ['metrics'], authKind: 'api_key', state: 'connected', detail: 'Sentry', config: {}, updatedAt: clock.now() });
    await repos.sourceTargets.save('ws-a', { id: 'target-sentry', organizationId: 'org-a', workspaceId: 'ws-a', connectionId: 'conn-sentry', provider: 'sentry', externalId: 'acme:42', displayName: 'Acme / 42', configuration: {}, checkIntervalMinutes: 15, status: 'active', createdAt: clock.now(), updatedAt: clock.now() });
    for (const id of ['w1', 'w2']) {
      const watch = watchFromTemplate(id, 'app_stability', { sources: ['sentry'], schedule: { frequency: '15m', dailyAt: '07:00' } }, '2026-09-24T07:00:00.000Z');
      await repos.watches.save('ws-a', { ...watch, sourceTargetIds: ['target-sentry'] });
    }
    const report = await schedulerTick({ repos, queue, clock });
    expect(report.enqueued).toBe(1);
    expect(await queue.inspect('ws-a:source-check:target-sentry:2026-09-24T08:00:00.000Z')).toMatchObject({ state: 'queued' });
    expect(await queue.inspect('ws-a:run:w1:2026-09-24T08:00:00.000Z')).toBeNull();
    expect(await queue.inspect('ws-a:run:w2:2026-09-24T08:00:00.000Z')).toBeNull();
  });

  it('selects a bounded batch and advances older workspaces on the next tick', async () => {
    const clock = manualClock('2026-09-24T08:00:00.000Z');
    const { repos } = createMemoryPersistence();
    const queue = createMemoryJobQueue(clock);
    for (let i = 0; i < 55; i++) await repos.workspaces.create(workspaceFixture(`ws-${String(i).padStart(2, '0')}`));
    expect((await schedulerTick({ repos, queue, clock })).workspaces).toBe(50);
    expect(await repos.cursors.get('ws-54', 'scheduler.last_tick')).toBeNull();
    await schedulerTick({ repos, queue, clock });
    expect(await repos.cursors.get('ws-54', 'scheduler.last_tick')).toBe(clock.now());
  });

  it('rotates past a failing workspace without advancing its successful checkpoint', async () => {
    const clock = manualClock('2026-09-24T08:00:00.000Z');
    const { repos } = createMemoryPersistence();
    const queue = createMemoryJobQueue(clock);
    for (let i = 0; i < 51; i++) await repos.workspaces.create(workspaceFixture(`ws-${String(i).padStart(2, '0')}`));
    await repos.watches.save('ws-00', watchFromTemplate('broken', 'checkout_health', { schedule: { frequency: '15m', dailyAt: '07:00' } }, '2026-09-24T07:00:00.000Z'));
    const failingQueue = { ...queue, enqueue: async (spec: Parameters<typeof queue.enqueue>[0]) => spec.workspaceId === 'ws-00' ? Promise.reject(new Error('queue unavailable')) : queue.enqueue(spec) };
    const first = await schedulerTick({ repos, queue: failingQueue, clock });
    expect(first.failedWorkspaceIds).toEqual(['ws-00']);
    expect(await repos.cursors.get('ws-00', 'scheduler.last_tick')).toBeNull();
    expect(await repos.cursors.get('ws-50', 'scheduler.last_attempt')).toBeNull();
    await schedulerTick({ repos, queue, clock });
    expect(await repos.cursors.get('ws-50', 'scheduler.last_attempt')).toBe(clock.now());
  });
});

describe('in-memory tenant fairness', () => {
  it('rotates by organization when several workspaces share one owner', async () => {
    const clock = manualClock('2026-09-24T08:00:00.000Z');
    const owners: Record<string, string> = { a1: 'org-a', a2: 'org-a', b1: 'org-b' };
    const queue = createMemoryJobQueue(clock, (workspaceId) => owners[workspaceId] ?? workspaceId);
    for (const [id, workspaceId, runAt] of [
      ['a-old', 'a1', '2026-09-24T07:00:00.000Z'],
      ['a-next', 'a2', '2026-09-24T07:01:00.000Z'],
      ['b', 'b1', '2026-09-24T07:59:00.000Z'],
    ] as const) await queue.enqueue({ kind: 'monitor.watch', workspaceId, payload: {}, runAt, idempotencyKey: id });
    expect((await queue.claim({ workerId: 'fair', limit: 2, leaseMs: 60_000 })).map((job) => job.idempotencyKey)).toEqual(['a-old', 'b']);
  });
});
