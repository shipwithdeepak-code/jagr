import { defineNormalizedEvent, type NormalizedEvent } from '../events.js';
import type { JobQueue, LeasedJob } from '../ports/jobs.js';
import type { SourceState, SourceTarget } from '../ports/persistence.js';
import { sourceTargetIdsForWatch } from '../sourceIdentity.js';
import { dailyOccurrences, nextRunAt } from '../scheduler.js';
import { uniqueId } from './ids.js';
import type { MonitoringDeps } from './monitoring.js';

const CHECK_LOCK_MS = 2 * 60_000;

function lockHeartbeat(everyMs: number, renew: () => Promise<boolean>) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void> | undefined;
  let error: Error | undefined;
  const schedule = () => {
    timer = setTimeout(() => {
      if (stopped) return;
      current = renew().then((ok) => {
        if (!ok) error = new Error('The source-check lock was lost.');
      }).catch((e) => {
        error = e as Error;
      }).finally(() => {
        current = undefined;
        if (!stopped && !error) schedule();
      });
    }, everyMs);
  };
  schedule();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await current;
    if (error) throw error;
  };
}

export class SourceCheckBusy extends Error {
  constructor() {
    super('A source check is already running for this target.');
    this.name = 'SourceCheckBusy';
  }
}

const nextCheck = (target: SourceTarget, at: string) => new Date(Date.parse(at) + (target.checkIntervalMinutes ?? 15) * 60_000).toISOString();
const eventId = (targetId: string, dedupeKey: string) => `evt:${encodeURIComponent(targetId)}:${encodeURIComponent(dedupeKey)}`;

function failureStatus(error: Error): SourceState['status'] {
  if (error.name === 'ConnectorAuthError') return 'auth_error';
  if (error.name === 'ConnectorRateLimited') return 'rate_limited';
  if (error.name === 'TimeoutError' || error.name === 'AbortError' || /did not answer within/i.test(error.message)) return 'timeout';
  if (error.name === 'ConnectorConfigError') return 'invalid_target';
  if (error.name === 'ProviderUnavailableError') return 'provider_error';
  return 'internal_error';
}

function relevant(target: SourceTarget, event: NormalizedEvent, watch: Awaited<ReturnType<MonitoringDeps['repos']['watches']['list']>>[number]) {
  if (!sourceTargetIdsForWatch(watch, [target]).includes(target.id)) return false;
  if (event.type === 'sentry.release') return watch.signals.some((signal) => signal.key === 'changes');
  if (event.type === 'sentry.issue') {
    const area = (event.payload as { area?: string } | undefined)?.area;
    return watch.signals.some((signal) => signal.key === 'work_items' && (!signal.area || signal.area === '*' || signal.area === area));
  }
  if (event.type === 'sentry.metric') {
    const metric = (event.payload as { metric?: string } | undefined)?.metric;
    return watch.signals.some((signal) => signal.key === `metric:${metric}`);
  }
  return false;
}

/** Source checks may run more often than watches; investigation work waits for the watch's next schedule slot. */
const nextWatchRun = (watch: Parameters<typeof nextRunAt>[0], observedAt: string) =>
  watch.schedule.frequency === 'daily'
    ? dailyOccurrences(watch.schedule.dailyAt, watch.timezone, observedAt, new Date(Date.parse(observedAt) + 2 * 86_400_000).toISOString())[0] ?? observedAt
    : nextRunAt(watch, new Date(Date.parse(observedAt) - 1).toISOString(), watch.createdAt) ?? observedAt;

/** Observe one target, durably record its delta, fan out watch jobs, then advance its checkpoint. */
export async function runSourceCheckJob(deps: MonitoringDeps & { queue: JobQueue }, job: Pick<LeasedJob, 'workspaceId' | 'payload'>) {
  const workspace = await deps.repos.workspaces.get(job.workspaceId);
  const sourceTargetId = typeof job.payload.sourceTargetId === 'string' ? job.payload.sourceTargetId : '';
  const organizationId = typeof job.payload.organizationId === 'string' ? job.payload.organizationId : '';
  if (!workspace?.organizationId || workspace.organizationId !== organizationId) throw new Error('Invalid source-check workspace scope.');
  const target = await deps.repos.sourceTargets.get(job.workspaceId, sourceTargetId);
  if (!target || target.workspaceId !== workspace.id || target.organizationId !== organizationId) throw new Error('Invalid source-check target scope.');
  if (target.status !== 'active') return { outcome: 'unchanged' as const, events: 0, jobs: 0 };
  const owner = uniqueId('source-check', deps.clock.now());
  const lockKey = `source-check:${target.id}`;
  const now = deps.clock.now();
  if (!(await deps.repos.locks.acquire(workspace.id, lockKey, owner, new Date(Date.parse(now) + CHECK_LOCK_MS).toISOString(), now))) throw new SourceCheckBusy();
  let stopped = false;
  const stopRenewing = lockHeartbeat(Math.floor(CHECK_LOCK_MS / 3), async () => {
    const at = deps.clock.now();
    return deps.repos.locks.renew(workspace.id, lockKey, owner, new Date(Date.parse(at) + CHECK_LOCK_MS).toISOString(), at);
  });
  try {
    const connection = await deps.repos.connections.get(workspace.id, target.connectionId);
    if (!connection || connection.workspaceId !== workspace.id || connection.provider !== target.provider) throw new Error('Invalid source-check connection scope.');
    const connector = Object.prototype.hasOwnProperty.call(deps.connectors, connection.provider) ? deps.connectors[connection.provider] : undefined;
    if (!connector?.sourceChecker) throw new Error(`No source checker for ${connection.provider}.`);
    const secret = connection.secretRef ? (await deps.secrets.get(connection.secretRef, { workspaceId: workspace.id, connectionId: connection.id })).secret : undefined;
    const prior = await deps.repos.sourceStates.get(workspace.id, target.id);
    let observation;
    try {
      observation = await connector.sourceChecker(connection, { secret, http: deps.http, clock: deps.clock }).check(target, prior);
    } catch (e) {
      const error = e as Error;
      const at = deps.clock.now();
      await deps.repos.sourceStates.save(workspace.id, {
        ...(prior ?? { organizationId, workspaceId: workspace.id, sourceTargetId: target.id, provider: target.provider, version: 0 }),
        status: failureStatus(error),
        lastCheckedAt: at,
        nextCheckAt: nextCheck(target, at),
        lastError: error.message.slice(0, 300),
        updatedAt: at,
      });
      throw error;
    }
    const events = observation.outcome === 'changed'
      ? observation.events.map((draft) => defineNormalizedEvent({ ...draft, eventId: eventId(target.id, draft.dedupeKey), schemaVersion: 1, organizationId, workspaceId: workspace.id, connectionId: connection.id, sourceTargetId: target.id, provider: target.provider, observedAt: observation.checkedAt }))
      : [];
    const newEvents: NormalizedEvent[] = [];
    const durableEvents: NormalizedEvent[] = [];
    for (const event of events) {
      if (await deps.repos.events.add(workspace.id, event)) {
        newEvents.push(event);
        durableEvents.push(event);
      } else {
        // The first durable observation time is stable across overlap reads and therefore maps an
        // event/watch pair to the same cadence slot on every retry.
        durableEvents.push((await deps.repos.events.get({ organizationId, workspaceId: workspace.id }, event.eventId)) ?? event);
      }
    }
    const processedOutcome = newEvents.length ? 'changed' as const : 'unchanged' as const;
    // Fan out from the observed delta even when its events were inserted by an earlier partial attempt:
    // deterministic watch-job keys make retry finish the missing enqueue without duplicating completed work.
    const watches = (await deps.repos.watches.list(workspace.id)).filter((watch) => watch.status === 'active');
    const runs = new Map<string, { watchId: string; runAt: string }>();
    for (const event of durableEvents) {
      for (const watch of watches.filter((candidate) => relevant(target, event, candidate))) {
        const triggerKey = `source-event:${event.eventId}:watch:${watch.id}`;
        const recorded = await deps.repos.cursors.get(workspace.id, triggerKey);
        const runAt = recorded || nextWatchRun(watch, event.observedAt);
        if (!recorded) await deps.repos.cursors.set(workspace.id, triggerKey, runAt);
        runs.set(`${watch.id}:${runAt}`, { watchId: watch.id, runAt });
      }
    }
    let jobs = 0;
    for (const run of runs.values()) {
      const idempotencyKey = `${workspace.id}:source-slot:${run.watchId}:${run.runAt}`;
      if (await deps.queue.enqueue({ kind: 'monitor.watch', workspaceId: workspace.id, runAt: run.runAt, payload: { watchId: run.watchId, dueAt: run.runAt, sourceTargetId: target.id }, idempotencyKey })) jobs++;
    }
    await deps.tx.run(async (repos) => {
      const settledAt = deps.clock.now();
      if (!(await repos.locks.renew(workspace.id, lockKey, owner, new Date(Date.parse(settledAt) + CHECK_LOCK_MS).toISOString(), settledAt))) throw new Error('The source-check lock was lost before checkpoint settlement.');
      await repos.sourceStates.save(workspace.id, {
        organizationId,
        workspaceId: workspace.id,
        sourceTargetId: target.id,
        provider: target.provider,
        status: processedOutcome,
        version: (prior?.version ?? 0) + 1,
        checkpoint: observation.checkpoint,
        lastObservedVersion: observation.version,
        lastObservedHash: observation.version,
        lastCheckedAt: observation.checkedAt,
        lastObservedAt: events.map((event) => event.occurredAt).sort().at(-1) ?? prior?.lastObservedAt,
        lastSuccessfulCheckAt: observation.checkedAt,
        lastChangeAt: processedOutcome === 'changed' ? observation.checkedAt : prior?.lastChangeAt,
        nextCheckAt: nextCheck(target, observation.checkedAt),
        updatedAt: observation.checkedAt,
      });
    });
    return { outcome: processedOutcome, events: newEvents.length, jobs };
  } finally {
    try {
      if (!stopped) await stopRenewing();
    } finally {
      await deps.repos.locks.release(workspace.id, lockKey, owner);
    }
  }
}
