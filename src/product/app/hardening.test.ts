import { describe, expect, it } from 'vitest';
import type { Connection, Workspace } from '../ports/persistence';
import type { HttpClient } from '../ports/http';
import { manualClock } from '../ports/clock';
import { createMemoryJobQueue, createMemoryPersistence, createMemorySecretStore } from '../ports/memory';
import type { NotificationMessage } from '../ports/notify';
import { response } from '../testkit/connectorContract';
import { CHANNELS } from '../integrations/channels/index';
import { deliver, STUCK_CLAIM_MS } from './notifications';
import { drainJobs, runWatchJob, WorkspaceBusy } from './monitoring';
import { watchFromTemplate } from '../catalog';

/** Production hardening: duplicate delivery, concurrent runs, audit completeness, job leases. */

const NOW = '2026-09-25T10:00:00.000Z';
const msg: NotificationMessage = { kind: 'investigation_confirmed', workspaceId: 'ws-1', dedupeKey: 'alert:e1', title: 'Checkout conversion declined', attention: 'HIGH', summary: 's', observed: [], inferred: [], unknown: [], links: [] };
const ws: Workspace = { id: 'ws-1', name: 'Acme', mode: 'connected', createdAt: NOW, settings: { planner: 'deterministic', aiEgressAllowed: false, timezone: 'UTC' }, brief: { enabled: true, time: '08:00', timezone: 'UTC' }, importedExportIds: [], version: 1 };

async function workspaceWithSlack() {
  const { repos, tx } = createMemoryPersistence();
  const secrets = createMemorySecretStore();
  await repos.workspaces.create(ws);
  const secretRef = await secrets.put({ workspaceId: 'ws-1', connectionId: 'conn-slack' }, { kind: 'api_key', fields: { botToken: 'xoxb-not-a-real-token' } });
  const slack: Connection = { id: 'conn-slack', workspaceId: 'ws-1', source: 'slack', provider: 'slack', roles: [], authKind: 'api_key', state: 'connected', detail: '', config: { channel: 'C0123456789' }, secretRef, updatedAt: NOW };
  await repos.connections.save('ws-1', slack);
  return { repos, tx, secrets };
}

describe('Slack duplicate delivery', () => {
  it('two deliverers racing on the same message send it once', async () => {
    const { repos, secrets } = await workspaceWithSlack();
    let posts = 0;
    const http: HttpClient = async () => {
      posts++;
      await new Promise((r) => setTimeout(r, 20)); // a slow send, so both deliverers overlap
      return response({ body: { ok: true, ts: '1.1' } });
    };
    const deps = { repos, secrets, http, clock: manualClock(NOW), channels: CHANNELS };
    const [a, b] = await Promise.all([deliver(deps, ws, [msg]), deliver(deps, ws, [msg])]);
    expect(posts).toBe(1);
    expect(a.delivered + b.delivered).toBe(1);
    expect(a.duplicates + b.duplicates).toBe(1);
    // And never again afterwards.
    await deliver(deps, ws, [msg]);
    expect(posts).toBe(1);
    expect((await repos.notifications.list('ws-1')).map((n) => n.status)).toEqual(['delivered']);
  });

  it('an interrupted attempt (claimed, never settled) is retried after it goes stale — and recorded as unknown', async () => {
    const { repos, secrets } = await workspaceWithSlack();
    const clock = manualClock(NOW);
    await repos.notifications.add('ws-1', { id: 'stuck', channel: 'slack', dedupeKey: 'conn-slack:alert:e1', deliveredAt: NOW, status: 'sending' });
    let posts = 0;
    const deps = { repos, secrets, http: (async () => (posts++, response({ body: { ok: true, ts: '2.2' } }))) as HttpClient, clock, channels: CHANNELS };
    // Still fresh: it may be in flight elsewhere — not sent again.
    expect(await deliver(deps, ws, [msg])).toMatchObject({ delivered: 0, duplicates: 1 });
    clock.advance(STUCK_CLAIM_MS + 60_000);
    expect(await deliver(deps, ws, [msg])).toMatchObject({ delivered: 1 });
    expect(posts).toBe(1);
    const log = await repos.notifications.list('ws-1');
    expect(log.find((n) => n.id === 'stuck')).toMatchObject({ status: 'failed', detail: expect.stringMatching(/did not finish; delivery unknown/) });
  });
});

describe('concurrent monitoring runs', () => {
  it('one run per workspace at a time; the other is refused as busy, and the lock is released after', async () => {
    const { repos, tx } = createMemoryPersistence();
    await repos.workspaces.create(ws);
    await repos.watches.save('ws-1', watchFromTemplate('w1', 'checkout_health', { sources: ['jira'] }, NOW));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Hold the first run inside the lock (its read of the workspace's connections waits on the gate).
    const slow = { ...repos, connections: { ...repos.connections, list: async (w: string) => (await gate, repos.connections.list(w)) } };
    const deps = { repos: slow, tx, secrets: createMemorySecretStore(), clock: manualClock(NOW), http: (async () => response({})) as HttpClient, connectors: {} };
    const first = runWatchJob(deps, { workspaceId: 'ws-1', payload: { watchId: 'w1', dueAt: NOW } });
    await new Promise((r) => setTimeout(r, 5));
    await expect(runWatchJob(deps, { workspaceId: 'ws-1', payload: { watchId: 'w1', dueAt: NOW } })).rejects.toBeInstanceOf(WorkspaceBusy);
    release();
    await first;
    await expect(runWatchJob(deps, { workspaceId: 'ws-1', payload: { watchId: 'w1', dueAt: NOW } })).resolves.toBeDefined();
  });

  it('every watch run is audited, even when several run at the same due time', async () => {
    const { repos, tx } = createMemoryPersistence();
    await repos.workspaces.create(ws);
    for (const id of ['w1', 'w2', 'w3']) await repos.watches.save('ws-1', watchFromTemplate(id, 'checkout_health', { sources: ['jira'] }, NOW));
    const deps = { repos, tx, secrets: createMemorySecretStore(), clock: manualClock(NOW), http: (async () => response({})) as HttpClient, connectors: {} };
    for (const id of ['w1', 'w2', 'w3']) await runWatchJob(deps, { workspaceId: 'ws-1', payload: { watchId: id, dueAt: NOW } });
    expect((await repos.audit.list('ws-1')).filter((e) => e.action === 'monitor.watch')).toHaveLength(3);
  });
});

describe('job leases', () => {
  async function twoJobs(onFirstRun: (clock: ReturnType<typeof manualClock>, queue: ReturnType<typeof createMemoryJobQueue>) => Promise<void>) {
    const { repos, tx } = createMemoryPersistence();
    await repos.workspaces.create(ws);
    for (const id of ['w1', 'w2']) await repos.watches.save('ws-1', watchFromTemplate(id, 'checkout_health', { sources: ['jira'] }, NOW));
    const clock = manualClock(NOW);
    const queue = createMemoryJobQueue(clock);
    for (const id of ['w1', 'w2']) await queue.enqueue({ kind: 'monitor.watch', workspaceId: 'ws-1', idempotencyKey: `run:${id}`, payload: { watchId: id, dueAt: NOW }, runAt: NOW, maxAttempts: 3 });
    const ran: string[] = [];
    // Each run reads its watches once; the first run is slow (longer than the lease).
    const slow = { ...repos, watches: { ...repos.watches, list: async (w: string) => (ran.length === 0 && (await onFirstRun(clock, queue)), ran.push(`${ran.length}`), repos.watches.list(w)) } };
    return { deps: { repos: slow, tx, secrets: createMemorySecretStore(), clock, http: (async () => response({})) as HttpClient, connectors: {}, queue }, queue, ran };
  }

  it('a lease that ran out while earlier jobs ran, but that nobody took over, is renewed: each job runs exactly once', async () => {
    const { deps, queue, ran } = await twoJobs(async (clock) => clock.advance(2 * 60_000));
    expect(await drainJobs(deps, { workerId: 'a', limit: 10, leaseMs: 60_000 })).toEqual({ done: 2, failed: 0 });
    expect(ran).toHaveLength(2);
    expect(await queue.inspect('run:w1')).toMatchObject({ state: 'done' });
    expect(await queue.inspect('run:w2')).toMatchObject({ state: 'done' });
    expect(await drainJobs(deps, { workerId: 'b', limit: 10, leaseMs: 60_000 })).toEqual({ done: 0, failed: 0 });
  });

  it('a job another worker took over mid-batch is skipped — never run twice — and the batch does not crash', async () => {
    const taken: { id: string }[] = [];
    const { deps, queue, ran } = await twoJobs(async (clock, q) => {
      clock.advance(2 * 60_000);
      // Worker b claims every expired lease while a is still busy with the first job.
      taken.push(...(await q.claim({ workerId: 'b', limit: 10, leaseMs: 60_000 })));
    });
    const a = await drainJobs(deps, { workerId: 'a', limit: 10, leaseMs: 60_000 });
    // a finished its first job but could not settle it (b owns it now), and skipped the second.
    expect(a).toEqual({ done: 0, failed: 0 });
    expect(ran).toHaveLength(1);
    expect(taken).toHaveLength(2);
    expect(await queue.inspect('run:w2')).toMatchObject({ state: 'leased' });
  });
});
