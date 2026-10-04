import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { freshPglite } from './postgres/pglite';
import { createRuntime } from './runtime';
import { createApp } from './app';
import { hashToken } from './auth';
import { manualClock } from '../src/product/ports/clock';
import { watchFromTemplate } from '../src/product/catalog';
import { runOneJob, drainJobs } from '../src/product/app/monitoring';
import { captureExecutionReceipt, executionReceiptId, type ManualExecutionStatus } from '../src/product/app/executionStatus';
import type { ChangeRecord } from '../src/product/roles/types';
import type { ApiRequest } from './http/types';
import { ProviderUnavailableError } from '../src/product/integrations/types';

vi.setConfig({ testTimeout: 30_000 });
const NOW = '2026-09-25T10:00:00.000Z';
async function setup() {
  const clock = manualClock(NOW);
  let changes: ChangeRecord[] = [];
  let error: Error | undefined;
  const rt = await createRuntime({ JAGR_SESSION_SECRET: randomBytes(32).toString('hex'), JAGR_SECRET_KEY: randomBytes(32).toString('base64') }, {
    sql: await freshPglite(), clock, identity: {}, connectors: { github: {
      check: async () => ({ state: 'connected', detail: '' }),
      build: () => ({ id: 'github', connection: { provider: 'github', state: 'connected', detail: '', updatedAt: clock.now() }, changes: { tracksRollout: false, getChanges: async () => { if (error) throw error; return changes; } } }),
    } },
  });
  const { repos } = rt;
  await repos.users.create({ id: 'u', displayName: 'PM', createdAt: NOW }, { provider: 'test', subject: 'u' });
  await repos.sessions.create({ id: hashToken('test-session'), userId: 'u', createdAt: NOW, expiresAt: '2027-01-01T00:00:00.000Z' });
  for (const [id, org] of [['w', 'o'], ['other', 'o'], ['foreign', 'other-org']]) {
    if (!(await repos.organizations.get(org))) await repos.organizations.create({ id: org, name: org, createdAt: NOW });
    await repos.workspaces.create({ id, organizationId: org, name: id, mode: 'connected', createdAt: NOW, settings: { planner: 'deterministic', aiEgressAllowed: false, timezone: 'UTC' }, brief: { enabled: false, time: '08:00', timezone: 'UTC' }, importedExportIds: [], version: 1 });
    await repos.members.add({ workspaceId: id, userId: 'u', role: 'owner', canApprove: true });
  }
  await repos.organizationMembers.add({ organizationId: 'o', userId: 'u', role: 'owner' });
  await repos.connections.save('w', { id: 'c', workspaceId: 'w', provider: 'github', source: 'github', roles: ['changes'], authKind: 'simulated', config: {}, state: 'connected', detail: '', updatedAt: NOW });
  await repos.watches.save('w', watchFromTemplate('watch', 'github_changes', { sources: ['github'] }, NOW));
  const app = createApp(rt);
  const request = (method: string, path: string, key?: string, signed = true) => app({ method, path, query: key === undefined ? {} : { key }, headers: signed ? { cookie: 'jagr_session=test-session; jagr_csrf=x', 'x-jagr-csrf': 'x' } : {} } as ApiRequest);
  const enqueue = async () => {
    const response = await request('POST', '/api/workspaces/w/runs');
    expect(response.status).toBe(202);
    return (response.body as { jobs: { idempotencyKey: string }[] }).jobs[0].idempotencyKey;
  };
  const read = (key: string, workspace = 'w') => request('GET', `/api/workspaces/${workspace}/runs/status`, key);
  const status = async (key: string) => (await read(key)).body as ManualExecutionStatus;
  const worker = () => runOneJob(rt, { workerId: 'test', leaseMs: 60_000 });
  return { rt, clock, request, enqueue, read, status, worker, fail: (e?: Error) => { error = e; }, change: () => { changes = [{ id: 'deploy', source: 'github', kind: 'deploy', timing: 'actual', title: 'Failed checkout deploy', at: NOW, status: 'failed', target: 'checkout', ref: { provider: 'github', kind: 'release', id: 'deploy' }, provenance: { source: 'github', provider: 'github', connectionId: 'c', mode: 'connected', externalId: 'deploy', observedAt: NOW, fetchedAt: NOW } }]; } };
}

describe('manual execution contract on Postgres', () => {
  it('completes unavailable evidence without calling it quiet or an execution failure', async () => {
    const t = await setup();
    t.fail(new ProviderUnavailableError('github', 'unavailable', 'provider outage'));
    const key = await t.enqueue();
    expect(await t.worker()).toMatchObject({ state: 'completed' });
    expect(await t.status(key)).toMatchObject({ publicStatus: 'completed', result: { classification: 'inconclusive', coverage: 'incomplete' } });
  });

  it.each([null, 0, 3, 4])('does not infer complete metric coverage from a %s-point response', async (count) => {
    const t = await setup();
    const watch = (await t.rt.repos.watches.list('w'))[0];
    await t.rt.repos.watches.save('w', { ...watch, signals: [{ key: 'metric:checkout_conversion', area: 'checkout' }] });
    const definition = { key: 'checkout_conversion', name: 'Conversion', unit: 'percent', area: 'checkout', badDirection: 'down', mode: 'relative', threshold: 10 } as const;
    const build = t.rt.connectors.github.build;
    t.rt.connectors.github.build = (connection, context) => ({ ...build(connection, context), metrics: {
      metricDefinitions: () => [definition],
      getSeries: async () => count === null ? null : ({ ...definition, source: 'github', ref: { provider: 'github', kind: 'metric', id: 'conversion' }, provenance: { source: 'github', provider: 'test', connectionId: 'c', externalId: 'conversion', mode: 'connected', observedAt: NOW, fetchedAt: NOW }, baseline: { mean: 10, stdDev: 1, window: 'baseline' }, points: Array.from({ length: count }, () => ({ t: NOW, value: 10 })) }),
      listDimensions: () => [],
      getBreakdown: async () => [],
    } });
    const key = await t.enqueue();
    expect(await t.worker()).toMatchObject({ state: 'completed' });
    expect(await t.status(key)).toMatchObject({ publicStatus: 'completed', result: { classification: 'inconclusive', coverage: count === 4 ? 'unknown' : 'incomplete' } });
  });

  it('tracks queued/running/recovering/retrying/quiet with current-attempt gating and duplicate identity', async () => {
    const t = await setup(); const key = await t.enqueue();
    expect(await t.status(key)).toMatchObject({ publicStatus: 'queued', result: null });
    const duplicate = await t.request('POST', '/api/workspaces/w/runs');
    expect(duplicate.body).toMatchObject({ jobs: [{ idempotencyKey: key, enqueued: false }] });
    const [job] = await t.rt.queue.claim({ workerId: 'a', limit: 1, leaseMs: 10 });
    expect(await t.status(key)).toMatchObject({ publicStatus: 'checking', execution: { state: 'running', attempts: 1 } });
    await captureExecutionReceipt(t.rt.repos, job, { disposition: 'checked', classification: 'no_meaningful_change', coverage: 'complete', investigationIds: [], truncated: false }, NOW);
    expect((await t.status(key)).result).toBeNull();
    t.clock.advance(11);
    expect((await t.status(key)).execution.state).toBe('recovering');
    const [taken] = await t.rt.queue.claim({ workerId: 'b', limit: 1, leaseMs: 60_000 });
    await expect(t.rt.queue.complete(job.id, job.leaseToken)).rejects.toThrow();
    await t.rt.queue.fail(taken.id, taken.leaseToken, 'private provider token', t.clock.now());
    expect(await t.status(key)).toMatchObject({ execution: { state: 'retrying', attempts: 2 }, result: null });
    expect(JSON.stringify(await t.status(key))).not.toContain('private provider token');
    expect(await t.worker()).toMatchObject({ state: 'completed', attempts: 3 });
    expect(await t.status(key)).toMatchObject({ publicStatus: 'quiet', execution: { attempts: 3 }, result: { disposition: 'checked', classification: 'no_meaningful_change' } });
    const receipts = (await t.rt.repos.audit.list('w')).filter((e) => e.executionReceipt);
    expect(receipts.map((e) => e.executionReceipt!.attempt)).toEqual([1, 3]);
    const third = receipts.find((e) => e.executionReceipt!.attempt === 3)!;
    await t.rt.repos.audit.append(third);
    expect((await t.rt.repos.audit.list('w')).filter((e) => e.id === third.id)).toHaveLength(1);
    await expect(t.rt.queue.complete(taken.id, taken.leaseToken)).rejects.toThrow();
    expect((await t.status(key)).publicStatus).toBe('quiet');
  });

  it('links meaningful findings to the exact execution and existing investigation', async () => {
    const t = await setup(); t.change(); const key = await t.enqueue();
    expect(await t.worker()).toMatchObject({ state: 'completed' });
    const status = await t.status(key);
    expect(status).toMatchObject({ publicStatus: 'completed', result: { disposition: 'checked', classification: 'findings' } });
    expect(status.result?.disposition === 'checked' && status.result.investigationIds.length).toBe(1);
    if (status.result?.disposition === 'checked') expect(await t.rt.repos.investigations.get('w', status.result.investigationIds[0])).not.toBeNull();
    expect((await t.read(key)).headers).toEqual({ 'cache-control': 'private, no-store' });
  });

  it('records blocked and skipped outcomes without changing done settlement in both workers', async () => {
    const t = await setup(); const key = await t.enqueue();
    const admission = t.rt.admission;
    t.rt.admission = { ...t.rt.admission, execution: async () => ({ allowed: false, code: 'capability_denied', detail: 'private entitlement details' }) } as typeof t.rt.admission;
    expect(await t.worker()).toMatchObject({ state: 'denied' });
    expect(await t.status(key)).toMatchObject({ publicStatus: 'failed', execution: { state: 'settled' }, result: { disposition: 'blocked', reason: 'check_not_permitted' } });
    expect(JSON.stringify(await t.status(key))).not.toContain('private entitlement details');
    t.clock.advance(1);
    const batchKey = `w:manual:watch:${t.clock.now()}`;
    await t.rt.queue.enqueue({ kind: 'monitor.watch', workspaceId: 'w', payload: { watchId: 'watch', dueAt: t.clock.now() }, idempotencyKey: batchKey });
    expect(await drainJobs(t.rt, { workerId: 'batch', leaseMs: 60_000, limit: 1 })).toEqual({ done: 1, failed: 0 });
    expect((await t.status(batchKey)).result).toMatchObject({ disposition: 'blocked' });
    t.rt.admission = admission;
    t.clock.advance(1);
    const skipKey = await t.enqueue();
    const watch = (await t.rt.repos.watches.list('w'))[0];
    await t.rt.repos.watches.save('w', { ...watch, status: 'paused' });
    expect(await t.worker()).toMatchObject({ state: 'completed' });
    expect(await t.status(skipKey)).toMatchObject({ publicStatus: 'completed', result: { disposition: 'skipped' } });
  });

  it('keeps receipt persistence failures separate from worker success and supports historical done', async () => {
    const t = await setup(); const key = await t.enqueue();
    const append = t.rt.repos.audit.append;
    t.rt.repos.audit.append = async (entry) => { if (entry.executionReceipt) throw new Error('audit unavailable'); await append(entry); };
    expect(await t.worker()).toMatchObject({ state: 'completed' });
    expect(await t.status(key)).toMatchObject({ publicStatus: 'completed', resultAvailability: 'unavailable', result: null });
    expect(await t.rt.queue.inspect(key)).toMatchObject({ state: 'done' });
  });

  it('preserves retry/dead behavior and never presents failed attempts as success', async () => {
    const t = await setup(); t.fail(new Error('private failure')); const key = await t.enqueue();
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await t.worker()).toMatchObject({ state: attempt === 5 ? 'dead' : 'retrying', attempts: attempt });
      expect((await t.status(key)).result).toBeNull();
      t.clock.advance(60 * 60_000);
    }
    expect(await t.status(key)).toMatchObject({ publicStatus: 'failed', failure: { code: 'execution_failed', retryable: false } });
  });

  it('returns the successful retry receipt while retaining historical failure timestamps', async () => {
    const t = await setup(); t.fail(new Error('temporary error')); const key = await t.enqueue();
    expect(await t.worker()).toMatchObject({ state: 'retrying', attempts: 1 });
    expect(await t.status(key)).toMatchObject({ result: null, execution: { state: 'retrying' } });
    t.fail(); t.clock.advance(2 * 60_000);
    expect(await t.worker()).toMatchObject({ state: 'completed', attempts: 2 });
    expect(await t.status(key)).toMatchObject({ publicStatus: 'quiet', execution: { attempts: 2, lastFailedAt: NOW } });
    const receipts = (await t.rt.repos.audit.list('w')).filter((entry) => entry.executionReceipt);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].executionReceipt!.attempt).toBe(2);
  });

  it('enforces workspace/organization ownership and rejects unknown, operator and invalid keys', async () => {
    const t = await setup(); const key = await t.enqueue();
    expect((await t.read(key)).status).toBe(200);
    expect((await t.read(key, 'other')).status).toBe(404);
    expect((await t.read(key, 'foreign')).status).toBe(404);
    expect((await t.read('unknown')).status).toBe(404);
    expect((await t.read('')).status).toBe(400);
    expect((await t.read('x'.repeat(1025))).status).toBe(400);
    expect((await t.request('GET', '/api/workspaces/w/runs/status', key, false)).status).toBe(401);
    expect((await t.request('POST', '/api/workspaces/w/runs/status', key)).status).toBe(405);
    await t.rt.queue.enqueue({ kind: 'monitor.watch', workspaceId: 'w', payload: { watchId: 'watch', dueAt: NOW }, idempotencyKey: 'w:run:watch:scheduled' });
    expect((await t.read('w:run:watch:scheduled')).status).toBe(404);
    await t.rt.sql.query('delete from organization_memberships where organization_id = $1 and user_id = $2', ['o', 'u']);
    expect((await t.read(key)).status).toBe(404);
  });

  it('rejects a mismatched receipt and a stale-attempt receipt on done jobs', async () => {
    const t = await setup(); const key = await t.enqueue();
    const [job] = await t.rt.queue.claim({ workerId: 'a', limit: 1, leaseMs: 1 });
    await captureExecutionReceipt(t.rt.repos, job, { disposition: 'checked', classification: 'no_meaningful_change', coverage: 'complete', investigationIds: [], truncated: false }, NOW);
    t.clock.advance(2);
    const [next] = await t.rt.queue.claim({ workerId: 'b', limit: 1, leaseMs: 60_000 });
    await t.rt.queue.complete(next.id, next.leaseToken);
    expect(await t.status(key)).toMatchObject({ result: null, resultAvailability: 'unavailable' });
    await t.rt.repos.audit.append({ id: executionReceiptId(key, next.attempts), workspaceId: 'w', at: NOW, actor: { ref: 'system', displayName: 'Jagr' }, action: 'monitor.execution_result', target: 'watch', executionReceipt: { version: 1, jobId: next.id, executionKey: key, attempt: next.attempts, workspaceId: 'foreign', watchId: 'watch', result: { disposition: 'blocked', reason: 'check_not_permitted' } } });
    expect((await t.status(key)).result).toBeNull();
  });

  it('hides foreign investigation references instead of leaking them through a receipt', async () => {
    const t = await setup(); const key = await t.enqueue();
    const [job] = await t.rt.queue.claim({ workerId: 'a', limit: 1, leaseMs: 60_000 });
    await captureExecutionReceipt(t.rt.repos, job, { disposition: 'checked', classification: 'findings', coverage: 'complete', investigationIds: ['foreign-investigation'], truncated: false }, NOW);
    await t.rt.queue.complete(job.id, job.leaseToken);
    expect(await t.status(key)).toMatchObject({ result: null, resultAvailability: 'unavailable' });
  });

  it('treats malformed or contradictory persisted receipts as unavailable', async () => {
    const t = await setup(); const key = await t.enqueue(); await t.worker();
    const id = executionReceiptId(key, 1);
    await t.rt.sql.query("update audit_log set doc = jsonb_set(doc, '{executionReceipt,result,investigationIds}', '\"invalid\"'::jsonb) where workspace_id = $1 and id = $2", ['w', id]);
    expect(await t.status(key)).toMatchObject({ result: null, resultAvailability: 'unavailable' });
    await t.rt.sql.query("update audit_log set doc = jsonb_set(jsonb_set(doc, '{executionReceipt,result,investigationIds}', '[]'::jsonb), '{executionReceipt,result,coverage}', '\"incomplete\"'::jsonb) where workspace_id = $1 and id = $2", ['w', id]);
    expect(await t.status(key)).toMatchObject({ publicStatus: 'completed', result: null });
  });
});
