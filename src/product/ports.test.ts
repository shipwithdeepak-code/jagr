import { describe, expect, it } from 'vitest';
import { createMemoryJobQueue, createMemoryPersistence, createMemorySecretStore } from './ports/memory';
import { manualClock } from './ports/clock';
import { schedulerTick } from './app/scheduler';
import { watchFromTemplate } from './catalog';
import { jobQueueContract, repositoriesContract, secretStoreContract, workspaceFixture } from './testkit/portContracts';

repositoriesContract('in-memory', () => createMemoryPersistence());
jobQueueContract('in-memory', (clock) => createMemoryJobQueue(clock));
secretStoreContract('in-memory', () => createMemorySecretStore());

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

  it('paused watches are not scheduled', async () => {
    const { clock, repos, queue } = await setup();
    const w = (await repos.watches.get('ws-a', 'w-checkout'))!;
    await repos.watches.save('ws-a', { ...w, status: 'paused' });
    await schedulerTick({ repos, queue, clock });
    clock.set('2026-09-24T09:00:00.000Z');
    const r = await schedulerTick({ repos, queue, clock });
    expect(r.enqueued).toBe(1); // only the brief
  });
});
