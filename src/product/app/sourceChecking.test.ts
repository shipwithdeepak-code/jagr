import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchFromTemplate } from '../catalog';
import { manualClock } from '../ports/clock';
import type { JobQueue } from '../ports/jobs';
import { createMemoryJobQueue, createMemoryPersistence, createMemorySecretStore } from '../ports/memory';
import type { SourceCheckResult } from '../ports/sourceCheck';
import type { HttpClient } from '../ports/http';
import { response } from '../testkit/connectorContract';
import { runOneJob } from './monitoring';
import { runSourceCheckJob, SourceCheckBusy } from './sourceChecking';

const NOW = '2026-09-28T10:00:00.000Z';
const CHECKPOINT = '2026-09-28T09:00:00.000Z';

async function setup(result: () => Promise<SourceCheckResult>) {
  const { repos, tx } = createMemoryPersistence();
  const clock = manualClock(NOW);
  const queue = createMemoryJobQueue(clock);
  const secrets = createMemorySecretStore();
  await repos.organizations.create({ id: 'org-1', name: 'Acme', createdAt: NOW });
  await repos.workspaces.create({ id: 'ws-1', organizationId: 'org-1', name: 'Acme', mode: 'connected', createdAt: NOW, settings: { planner: 'deterministic', aiEgressAllowed: false, timezone: 'UTC' }, brief: { enabled: false, time: '08:00', timezone: 'UTC' }, importedExportIds: [], version: 1 });
  const secretRef = await secrets.put({ workspaceId: 'ws-1', connectionId: 'conn-sentry' }, { kind: 'api_key', fields: { authToken: 'not-real' } });
  await repos.connections.save('ws-1', { id: 'conn-sentry', workspaceId: 'ws-1', source: 'sentry', provider: 'sentry', roles: ['metrics', 'changes', 'work_items'], authKind: 'api_key', state: 'connected', detail: 'Sentry', config: {}, secretRef, updatedAt: NOW });
  await repos.sourceTargets.save('ws-1', { id: 'target-a', organizationId: 'org-1', workspaceId: 'ws-1', connectionId: 'conn-sentry', provider: 'sentry', externalId: 'acme:42', displayName: 'Acme / 42', configuration: {}, status: 'active', createdAt: NOW, updatedAt: NOW });
  const connectors = { sentry: { build: () => { throw new Error('not used'); }, check: async () => ({ state: 'connected' as const, detail: 'ok' }), sourceChecker: () => ({ check: result }) } };
  return { repos, tx, clock, queue, secrets, connectors, http: (async () => response({})) as HttpClient };
}

const changed = async (): Promise<SourceCheckResult> => ({
  outcome: 'changed', checkedAt: NOW, checkpoint: NOW, version: 'v1', events: [
    { type: 'sentry.issue', occurredAt: '2026-09-28T09:30:00.000Z', dedupeKey: 'issue:WEB-1:2026-09-28T09:30:00.000Z', provenance: { externalId: 'WEB-1' }, payload: { id: 'WEB-1', area: 'stability' } },
  ],
});

const job = (workspaceId = 'ws-1', organizationId = 'org-1') => ({ workspaceId, payload: { organizationId, sourceTargetId: 'target-a' } });
const slotJob = (watchId: string, runAt = NOW) => `ws-1:source-slot:${watchId}:${runAt}`;
const eventScope = { organizationId: 'org-1', workspaceId: 'ws-1' };

afterEach(() => vi.useRealTimers());

describe('source-aware checking', () => {
  it('unchanged advances the checkpoint without creating an event or investigation job', async () => {
    const deps = await setup(async () => ({ outcome: 'unchanged', checkedAt: NOW, checkpoint: NOW, version: 'quiet' }));
    expect(await runSourceCheckJob(deps, job())).toEqual({ outcome: 'unchanged', events: 0, jobs: 0 });
    expect(await deps.repos.events.list(eventScope)).toEqual([]);
    expect(await deps.repos.sourceStates.get('ws-1', 'target-a')).toMatchObject({ status: 'unchanged', checkpoint: NOW, lastSuccessfulCheckAt: NOW });
  });

  it('one changed target fans out only to relevant watches and repeated observation is idempotent', async () => {
    const deps = await setup(changed);
    await deps.repos.sourceTargets.save('ws-1', { id: 'target-other', organizationId: 'org-1', workspaceId: 'ws-1', connectionId: 'conn-sentry', provider: 'sentry', externalId: 'acme:43', displayName: 'Acme / 43', configuration: {}, status: 'active', createdAt: NOW, updatedAt: NOW });
    for (const [id, target, area] of [['w1', 'target-a', 'stability'], ['w2', 'target-a', '*'], ['w3', 'target-other', '*']] as const) {
      const watch = watchFromTemplate(id, 'customer_issues', { sources: ['sentry'] }, NOW);
      await deps.repos.watches.save('ws-1', { ...watch, sourceTargetIds: [target], area });
    }
    expect(await runSourceCheckJob(deps, job())).toMatchObject({ outcome: 'changed', events: 1, jobs: 2 });
    expect(await deps.repos.events.list(eventScope, { sourceTargetId: 'target-a' })).toHaveLength(1);
    expect(await deps.queue.inspect(slotJob('w1'))).toMatchObject({ state: 'queued' });
    expect(await deps.queue.inspect(slotJob('w2'))).toMatchObject({ state: 'queued' });
    expect(await deps.queue.inspect(slotJob('w3'))).toBeNull();
    expect(await runSourceCheckJob(deps, job())).toMatchObject({ outcome: 'unchanged', events: 0, jobs: 0 });
    expect(await deps.repos.events.list(eventScope, { sourceTargetId: 'target-a' })).toHaveLength(1);
  });

  it('coalesces overlap and new events by watch cadence slot, while allowing the next slot', async () => {
    let pass = 0;
    const old = { type: 'sentry.issue', occurredAt: '2026-09-28T09:30:00.000Z', dedupeKey: 'issue:WEB-1:2026-09-28T09:30:00.000Z', provenance: { externalId: 'WEB-1' }, payload: { id: 'WEB-1', area: 'stability' } } as const;
    const fresh = { ...old, occurredAt: '2026-09-28T09:45:00.000Z', dedupeKey: 'issue:WEB-2:2026-09-28T09:45:00.000Z', provenance: { externalId: 'WEB-2' }, payload: { id: 'WEB-2', area: 'stability' } } as const;
    const later = { ...fresh, occurredAt: '2026-09-28T10:31:00.000Z', dedupeKey: 'issue:WEB-3:2026-09-28T10:31:00.000Z', provenance: { externalId: 'WEB-3' }, payload: { id: 'WEB-3', area: 'stability' } } as const;
    const deps = await setup(async () => {
      pass++;
      const checkedAt = pass === 4 ? '2026-09-28T10:31:00.000Z' : NOW;
      return { outcome: 'changed', checkedAt, checkpoint: checkedAt, version: `response-${pass}`, events: pass === 1 ? [old] : pass === 2 ? [old] : pass === 3 ? [old, fresh] : [later] };
    });
    const watch = watchFromTemplate('w1', 'customer_issues', { sources: ['sentry'] }, NOW);
    await deps.repos.watches.save('ws-1', { ...watch, sourceTargetIds: ['target-a'], area: '*' });

    expect(await runSourceCheckJob(deps, job())).toMatchObject({ events: 1, jobs: 1 });
    expect(await runSourceCheckJob(deps, job())).toMatchObject({ events: 0, jobs: 0 });
    expect(await runSourceCheckJob(deps, job())).toMatchObject({ events: 1, jobs: 0 });
    expect(await runSourceCheckJob(deps, job())).toMatchObject({ events: 1, jobs: 1 });
    expect(await deps.repos.events.list(eventScope)).toHaveLength(3);
    expect(await deps.repos.cursors.get('ws-1', `source-event:evt:target-a:${encodeURIComponent(old.dedupeKey)}:watch:w1`)).toBe(NOW);
    expect(await deps.queue.inspect(slotJob('w1'))).toBeTruthy();
    expect(await deps.queue.inspect(slotJob('w1', '2026-09-28T11:00:00.000Z'))).toBeTruthy();
  });

  it('many relevant events create one investigation job for the watch cadence slot', async () => {
    const deps = await setup(async () => ({ outcome: 'changed', checkedAt: NOW, checkpoint: NOW, version: 'many', events: Array.from({ length: 30 }, (_, i) => ({ type: 'sentry.issue', occurredAt: `2026-09-28T09:${String(i).padStart(2, '0')}:00.000Z`, dedupeKey: `issue:WEB-${i}:2026-09-28T09:${String(i).padStart(2, '0')}:00.000Z`, provenance: { externalId: `WEB-${i}` }, payload: { id: `WEB-${i}`, area: 'stability' } })) }));
    const watch = watchFromTemplate('w1', 'customer_issues', { sources: ['sentry'] }, NOW);
    await deps.repos.watches.save('ws-1', { ...watch, sourceTargetIds: ['target-a'], area: '*' });
    expect(await runSourceCheckJob(deps, job())).toMatchObject({ events: 30, jobs: 1 });
    expect(await deps.repos.events.list(eventScope)).toHaveLength(30);
    expect(await deps.queue.inspect(slotJob('w1'))).toBeTruthy();
  });

  it('coalesces daily watches into their timezone-aware occurrence', async () => {
    const deps = await setup(async () => ({ outcome: 'changed', checkedAt: NOW, checkpoint: NOW, version: 'daily', events: [
      { type: 'sentry.issue', occurredAt: '2026-09-28T09:20:00.000Z', dedupeKey: 'issue:A', provenance: { externalId: 'A' }, payload: { id: 'A', area: 'stability' } },
      { type: 'sentry.issue', occurredAt: '2026-09-28T09:30:00.000Z', dedupeKey: 'issue:B', provenance: { externalId: 'B' }, payload: { id: 'B', area: 'stability' } },
    ] }));
    const watch = watchFromTemplate('daily', 'customer_issues', { sources: ['sentry'], schedule: { frequency: 'daily', dailyAt: '08:00' } }, NOW);
    await deps.repos.watches.save('ws-1', { ...watch, timezone: 'America/New_York', sourceTargetIds: ['target-a'], area: '*' });
    expect(await runSourceCheckJob(deps, job())).toMatchObject({ events: 2, jobs: 1 });
    expect(await deps.queue.inspect(slotJob('daily', '2026-09-28T12:00:00.000Z'))).toMatchObject({ runAt: '2026-09-28T12:00:00.000Z' });
  });

  it('aligns different watches to their own next cadence slot', async () => {
    const checkedAt = '2026-09-28T10:07:00.000Z';
    const deps = await setup(async () => ({ ...(await changed()), checkedAt, checkpoint: checkedAt }));
    const fast = watchFromTemplate('fast', 'customer_issues', { sources: ['sentry'], schedule: { frequency: '15m', dailyAt: '07:00' } }, NOW);
    const slow = watchFromTemplate('slow', 'customer_issues', { sources: ['sentry'], schedule: { frequency: '1h', dailyAt: '07:00' } }, NOW);
    await deps.repos.watches.save('ws-1', { ...fast, sourceTargetIds: ['target-a'], area: '*' });
    await deps.repos.watches.save('ws-1', { ...slow, sourceTargetIds: ['target-a'], area: '*' });

    await runSourceCheckJob(deps, job());
    expect(await deps.queue.inspect(slotJob('fast', '2026-09-28T10:15:00.000Z'))).toMatchObject({ runAt: '2026-09-28T10:15:00.000Z' });
    expect(await deps.queue.inspect(slotJob('slow', '2026-09-28T11:00:00.000Z'))).toMatchObject({ runAt: '2026-09-28T11:00:00.000Z' });
    expect(await runSourceCheckJob(deps, job())).toMatchObject({ jobs: 0 });
  });

  it('provider failure records failure but creates no event and does not advance the checkpoint', async () => {
    const deps = await setup(async () => { const error = new Error('Sentry did not answer within 20 s.'); error.name = 'ProviderUnavailableError'; throw error; });
    await deps.repos.sourceStates.save('ws-1', { organizationId: 'org-1', workspaceId: 'ws-1', sourceTargetId: 'target-a', provider: 'sentry', status: 'unchanged', version: 1, checkpoint: CHECKPOINT, updatedAt: CHECKPOINT });
    await expect(runSourceCheckJob(deps, job())).rejects.toThrow(/did not answer/);
    expect(await deps.repos.events.list(eventScope)).toEqual([]);
    expect(await deps.repos.sourceStates.get('ws-1', 'target-a')).toMatchObject({ status: 'timeout', checkpoint: CHECKPOINT, version: 1 });
  });

  it('a failed enqueue leaves the checkpoint old and retry safely completes processing', async () => {
    const deps = await setup(changed);
    const watch = watchFromTemplate('w1', 'customer_issues', { sources: ['sentry'] }, NOW);
    await deps.repos.watches.save('ws-1', { ...watch, sourceTargetIds: ['target-a'], area: '*' });
    await deps.repos.sourceStates.save('ws-1', { organizationId: 'org-1', workspaceId: 'ws-1', sourceTargetId: 'target-a', provider: 'sentry', status: 'unchanged', version: 1, checkpoint: CHECKPOINT, updatedAt: CHECKPOINT });
    const broken = { ...deps.queue, enqueue: async () => { throw new Error('queue unavailable'); } } satisfies JobQueue;
    await expect(runSourceCheckJob({ ...deps, queue: broken }, job())).rejects.toThrow('queue unavailable');
    expect(await deps.repos.events.list(eventScope)).toHaveLength(1);
    expect(await deps.repos.sourceStates.get('ws-1', 'target-a')).toMatchObject({ checkpoint: CHECKPOINT });
    await expect(runSourceCheckJob(deps, job())).resolves.toMatchObject({ jobs: 1 });
    expect(await deps.repos.sourceStates.get('ws-1', 'target-a')).toMatchObject({ checkpoint: NOW });
  });

  it('recovers a partially completed two-watch fan-out without duplicating the successful enqueue', async () => {
    const deps = await setup(changed);
    for (const id of ['w1', 'w2']) {
      const watch = watchFromTemplate(id, 'customer_issues', { sources: ['sentry'] }, NOW);
      await deps.repos.watches.save('ws-1', { ...watch, sourceTargetIds: ['target-a'], area: '*' });
    }
    let calls = 0;
    const broken = { ...deps.queue, enqueue: async (spec: Parameters<JobQueue['enqueue']>[0]) => {
      if (++calls === 2) throw new Error('queue unavailable');
      return deps.queue.enqueue(spec);
    } } satisfies JobQueue;
    await expect(runSourceCheckJob({ ...deps, queue: broken }, job())).rejects.toThrow('queue unavailable');
    expect(await deps.queue.inspect(slotJob('w1'))).toBeTruthy();
    expect(await deps.queue.inspect(slotJob('w2'))).toBeNull();
    await expect(runSourceCheckJob(deps, job())).resolves.toMatchObject({ jobs: 1 });
    await expect(runSourceCheckJob(deps, job())).resolves.toMatchObject({ jobs: 0 });
    const queued = await deps.queue.claim({ workerId: 'watch-worker', limit: 10, leaseMs: 60_000 });
    expect(queued).toHaveLength(2);
    for (const claimed of queued) await deps.queue.complete(claimed.id, claimed.leaseToken);
    await expect(runSourceCheckJob(deps, job())).resolves.toMatchObject({ jobs: 0 });
    expect(await deps.queue.claim({ workerId: 'watch-worker-2', limit: 10, leaseMs: 60_000 })).toEqual([]);
  });

  it('renews the target lock during execution and releases it on completion', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const deps = await setup(async () => (await gate, { outcome: 'unchanged', checkedAt: NOW, checkpoint: NOW, version: 'quiet' }));
    let renewals = 0;
    const locks = { ...deps.repos.locks, renew: async (...args: Parameters<typeof deps.repos.locks.renew>) => (renewals++, deps.repos.locks.renew(...args)) };
    const running = runSourceCheckJob({ ...deps, repos: { ...deps.repos, locks } }, job());
    for (let i = 0; i < 4; i++) {
      deps.clock.advance(40_000);
      await vi.advanceTimersByTimeAsync(40_000);
    }
    expect(renewals).toBe(4);
    await expect(runSourceCheckJob(deps, job())).rejects.toBeInstanceOf(SourceCheckBusy);
    finish();
    await running;
    await expect(runSourceCheckJob(deps, job())).resolves.toBeDefined();
    const stoppedAt = renewals;
    await vi.advanceTimersByTimeAsync(80_000);
    expect(renewals).toBe(stoppedAt);
  });

  it('keeps renewal active through delayed checkpoint persistence', async () => {
    vi.useFakeTimers();
    const deps = await setup(async () => ({ outcome: 'unchanged', checkedAt: NOW, checkpoint: NOW, version: 'quiet' }));
    let entered!: () => void;
    let finish!: () => void;
    const saving = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const tx = { run: <T>(fn: Parameters<typeof deps.tx.run<T>>[0]) => deps.tx.run((repos) => fn({ ...repos, sourceStates: { ...repos.sourceStates, save: async (...args: Parameters<typeof repos.sourceStates.save>) => { entered(); await gate; return repos.sourceStates.save(...args); } } })) };
    const running = runSourceCheckJob({ ...deps, tx }, job());
    await saving;
    for (let i = 0; i < 4; i++) {
      deps.clock.advance(40_000);
      await vi.advanceTimersByTimeAsync(40_000);
    }
    await expect(runSourceCheckJob(deps, job())).rejects.toBeInstanceOf(SourceCheckBusy);
    finish();
    await running;
    expect(await deps.repos.sourceStates.get('ws-1', 'target-a')).toMatchObject({ checkpoint: NOW, status: 'unchanged' });
  });

  it('does not settle a successful checkpoint after source-lock ownership is lost', async () => {
    const deps = await setup(async () => ({ outcome: 'unchanged', checkedAt: NOW, checkpoint: NOW, version: 'quiet' }));
    const tx = { run: <T>(fn: Parameters<typeof deps.tx.run<T>>[0]) => deps.tx.run((repos) => fn({ ...repos, locks: { ...repos.locks, renew: async () => false } })) };
    await expect(runSourceCheckJob({ ...deps, tx }, job())).rejects.toThrow(/lost before checkpoint/);
    expect(await deps.repos.sourceStates.get('ws-1', 'target-a')).toBeNull();
  });

  it('refuses cross-workspace and cross-organization target execution', async () => {
    const deps = await setup(changed);
    await expect(runSourceCheckJob(deps, job('ws-other'))).rejects.toThrow(/workspace scope/);
    await expect(runSourceCheckJob(deps, job('ws-1', 'org-other'))).rejects.toThrow(/workspace scope/);
  });

  it('one worker request processes one source-check job and leaves the next queued', async () => {
    const deps = await setup(async () => ({ outcome: 'unchanged', checkedAt: NOW, checkpoint: NOW, version: 'quiet' }));
    for (const key of ['check-a', 'check-b']) await deps.queue.enqueue({ kind: 'source.check', workspaceId: 'ws-1', payload: { organizationId: 'org-1', sourceTargetId: 'target-a' }, runAt: NOW, idempotencyKey: key });
    expect(await runOneJob(deps, { workerId: 'worker', leaseMs: 60_000 })).toMatchObject({ state: 'completed', idempotencyKey: 'check-a' });
    expect(await deps.queue.inspect('check-a')).toMatchObject({ state: 'done', attempts: 1 });
    expect(await deps.queue.inspect('check-b')).toMatchObject({ state: 'queued', attempts: 0 });
  });
});
