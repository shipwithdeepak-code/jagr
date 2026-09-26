import { describe, expect, it } from 'vitest';
import { watchFromTemplate } from '../catalog';
import type { AuditEntry } from '../ports/persistence';
import type { MonitoringResult } from '../types';
import { productStateFromSnapshot, runAuditDetail, watchRunsFromAudit, type WorkspaceSnapshot } from '../app/workspaceSnapshot';
import { monitoringStatus, watchCardStatus } from './watchCard';

/**
 * Regression: a server workspace's watch showed "Not run yet" / "0 runs" after it had run, and its next
 * check was projected from the sample night, not the server's schedule.
 */

const CREATED = '2026-09-25T09:07:00.000Z';
const SNAPSHOT_AT = '2026-09-25T10:20:00.000Z';
const github = { ...watchFromTemplate('w-gh', 'github_changes', { sources: ['github'], schedule: { frequency: '30m', dailyAt: '07:00' } }, CREATED), id: 'w-gh' };
const checkout = { ...watchFromTemplate('w-co', 'checkout_health', { schedule: { frequency: '15m', dailyAt: '07:00' } }, CREATED), id: 'w-co' };

const run = (watchId: string | undefined, at: string, outcome: string): AuditEntry => ({ id: `a-${at}-${watchId}`, workspaceId: 'ws', at, actor: { ref: 'system', displayName: 'Jagr' }, action: 'monitor.watch', ...(watchId ? { target: watchId } : {}), detail: runAuditDetail(0, 0, outcome) });

function snapshot(audit: AuditEntry[]): WorkspaceSnapshot {
  return {
    workspace: { id: 'ws', name: 'Acme', mode: 'connected', createdAt: CREATED, settings: { planner: 'deterministic', aiEgressAllowed: true } as WorkspaceSnapshot['workspace']['settings'], brief: { enabled: true, time: '07:00', timezone: 'UTC' } as WorkspaceSnapshot['workspace']['brief'], version: 1 },
    membership: { role: 'owner', canApprove: true },
    connections: [],
    watches: [github, checkout],
    investigations: [],
    decisions: [],
    notifications: [],
    imports: [],
    briefs: [],
    runs: watchRunsFromAudit(audit),
    at: SNAPSHOT_AT,
  };
}

describe('server watch run history', () => {
  it('a quiet server watch after a successful run: a result exists, the card shows the last run and its outcome — not "Not run yet"', () => {
    const state = productStateFromSnapshot(snapshot([run('w-gh', '2026-09-25T10:07:00.000Z', 'GitHub: 0 deployments, 0 releases in the last 6h')]), { emailFrom: 'jagr@test' });
    expect(state.result).toBeDefined();
    const card = watchCardStatus(github, { location: 'server', result: state.result, clock: state.clock, snapshotAt: SNAPSHOT_AT });
    expect(card.runs).toHaveLength(1);
    expect(card.lastRun).toMatchObject({ scheduledAt: '2026-09-25T10:07:00.000Z', outcome: 'GitHub: 0 deployments, 0 releases in the last 6h' });
    expect(card.quiet).toBe('No open investigations');
    expect(card.quiet).not.toMatch(/last night|Not run yet/);
  });

  it('run history is mapped to the watch that ran, most recent last; unattributed older entries are not counted', () => {
    const audit = [
      run(undefined, '2026-09-25T09:30:00.000Z', 'All signals within normal range'),
      run('w-gh', '2026-09-25T09:37:00.000Z', 'GitHub: 1 deployment, 0 releases in the last 6h'),
      run('w-co', '2026-09-25T09:52:00.000Z', '1 signal outside normal range'),
      run('w-gh', '2026-09-25T10:07:00.000Z', 'GitHub: 2 deployments, 0 releases in the last 6h · 1 failed deployment reported'),
      { id: 'other', workspaceId: 'ws', at: '2026-09-25T10:08:00.000Z', actor: { ref: 'u1', displayName: 'Ana' }, action: 'monitor.requested', detail: '2 watch(es)' },
    ];
    const state = productStateFromSnapshot(snapshot(audit), { emailFrom: 'jagr@test' });
    const gh = watchCardStatus(github, { location: 'server', result: state.result, clock: state.clock, snapshotAt: SNAPSHOT_AT });
    const co = watchCardStatus(checkout, { location: 'server', result: state.result, clock: state.clock, snapshotAt: SNAPSHOT_AT });
    expect(gh.runs.map((l) => l.scheduledAt)).toEqual(['2026-09-25T09:37:00.000Z', '2026-09-25T10:07:00.000Z']);
    expect(gh.lastRun?.outcome).toBe('GitHub: 2 deployments, 0 releases in the last 6h · 1 failed deployment reported');
    expect(co.runs.map((l) => l.outcome)).toEqual(['1 signal outside normal range']);
    expect(state.result!.log.every((l) => l.type === 'watch_run' && !!l.watchId)).toBe(true);
  });

  it('a server watch that has never run says so', () => {
    const state = productStateFromSnapshot(snapshot([]), { emailFrom: 'jagr@test' });
    expect(state.result).toBeUndefined();
    const card = watchCardStatus(github, { location: 'server', result: state.result, clock: state.clock, snapshotAt: SNAPSHOT_AT });
    expect(card).toMatchObject({ runs: [], lastRun: undefined, quiet: 'Not run yet' });
  });

  it('server next check: the scheduler slot anchored at the watch creation, after the snapshot time — not the sample night', () => {
    const card = watchCardStatus(github, { location: 'server', clock: '2026-09-24T23:00:00.000Z', snapshotAt: SNAPSHOT_AT });
    // Created 09:07, every 30 min → 09:37, 10:07, 10:37 …; read at 10:20 → next is 10:37.
    expect(card.nextRun).toBe('2026-09-25T10:37:00.000Z');
    expect(watchCardStatus(checkout, { location: 'server', clock: SNAPSHOT_AT, snapshotAt: SNAPSHOT_AT }).nextRun).toBe('2026-09-25T10:22:00.000Z');
    expect(watchCardStatus({ ...github, status: 'paused' }, { location: 'server', clock: SNAPSHOT_AT, snapshotAt: SNAPSHOT_AT }).nextRun).toBeUndefined();
  });

  it('browser-local / sample workspaces are unchanged', () => {
    const sample = watchFromTemplate('w-checkout', 'checkout_health', { schedule: { frequency: '30m', dailyAt: '07:00' } });
    // Before a run: the sample night's anchor, "Not run yet".
    expect(watchCardStatus(sample, { location: 'browser', clock: '2026-09-23T18:10:00.000Z' })).toEqual({ runs: [], nextRun: '2026-09-23T18:30:00.000Z', quiet: 'Not run yet' });
    // After a run: the window's log and anchor, and the sample wording.
    const result = { window: { start: '2026-09-23T18:00:00.000Z', end: '2026-09-24T08:05:00.000Z' }, investigations: [], emails: [], briefs: [], connections: [], actions: [], log: [{ jobId: 'j1', type: 'watch_run', watchId: 'w-checkout', scheduledAt: '2026-09-23T18:30:00.000Z', outcome: 'All signals within normal range', investigationIds: [], emailIds: [] }] } as MonitoringResult;
    const card = watchCardStatus(sample, { location: 'browser', result, clock: '2026-09-24T08:05:00.000Z' });
    expect(card).toEqual({ runs: result.log, nextRun: '2026-09-24T08:30:00.000Z', quiet: 'No meaningful changes last night' });
  });
});

describe('shell monitoring status', () => {
  it('server: the next scheduled check across active watches', () => {
    expect(monitoringStatus([github, checkout], { location: 'server', clock: SNAPSHOT_AT, snapshotAt: SNAPSHOT_AT })).toEqual({ tone: 'active', text: 'Scheduled · next check 10:22 UTC' });
  });

  it('local: says it runs on demand — a browser workspace has no scheduler', () => {
    expect(monitoringStatus([github, checkout], { location: 'browser', clock: SNAPSHOT_AT })).toEqual({ tone: 'idle', text: 'Local · runs on demand' });
  });

  it('running, paused and empty states', () => {
    expect(monitoringStatus([github], { location: 'server', clock: SNAPSHOT_AT, running: true })).toEqual({ tone: 'running', text: 'Checking watches…' });
    expect(monitoringStatus([{ ...github, status: 'paused' }], { location: 'server', clock: SNAPSHOT_AT })).toEqual({ tone: 'idle', text: 'All watches paused' });
    expect(monitoringStatus([], { location: 'server', clock: SNAPSHOT_AT })).toEqual({ tone: 'idle', text: 'No watches yet' });
  });
});

describe('historical runs are never attributed to a watch', () => {
  it('audit entries recorded before per-watch runs (no target) stay out of every watch’s history', () => {
    const legacy = [run(undefined, '2026-09-25T08:00:00.000Z', '1 signal outside normal range'), run(undefined, '2026-09-25T08:30:00.000Z', 'All signals within normal range')];
    const state = productStateFromSnapshot(snapshot(legacy), { emailFrom: 'jagr@test' });
    expect(state.result).toBeUndefined();
    for (const w of [github, checkout]) expect(watchCardStatus(w, { location: 'server', result: state.result, clock: state.clock, snapshotAt: SNAPSHOT_AT })).toMatchObject({ runs: [], lastRun: undefined, quiet: 'Not run yet' });
  });

  it('a new run alongside legacy entries is attributed only to its own watch', () => {
    const state = productStateFromSnapshot(snapshot([run(undefined, '2026-09-25T08:00:00.000Z', 'legacy'), run('w-gh', '2026-09-25T10:07:00.000Z', 'GitHub: 0 deployments, 0 releases in the last 6h')]), { emailFrom: 'jagr@test' });
    expect(watchCardStatus(github, { location: 'server', result: state.result, clock: state.clock, snapshotAt: SNAPSHOT_AT }).runs.map((l) => l.outcome)).toEqual(['GitHub: 0 deployments, 0 releases in the last 6h']);
    expect(watchCardStatus(checkout, { location: 'server', result: state.result, clock: state.clock, snapshotAt: SNAPSHOT_AT }).runs).toEqual([]);
  });
});
