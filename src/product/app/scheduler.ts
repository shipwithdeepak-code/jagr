import type { Clock } from '../ports/clock.js';
import type { JobQueue } from '../ports/jobs.js';
import type { Repositories } from '../ports/persistence.js';
import { dailyOccurrences, nextRunAt } from '../scheduler.js';
import { sourceTargetIdsForWatch } from '../sourceIdentity.js';

/**
 * Scheduler tick — the inbound scheduling port.
 *
 * Something outside the core (Vercel Cron, a Node interval, a k8s CronJob) calls this on a cadence.
 * It enqueues the watch runs and morning briefs that fell due since the last tick. Runs are aligned
 * to each watch's own grid (anchored at its creation time), and every job has a deterministic
 * idempotency key — so overlapping, duplicated or late ticks enqueue each run exactly once. After a
 * long gap only the latest missed run per watch is enqueued: a stale check is superseded, not replayed.
 */

export interface TickReport {
  at: string;
  workspaces: number;
  enqueued: number;
  duplicates: number;
  /** Older runs skipped because a later one in the same window supersedes them. */
  superseded: number;
  /** Workspace ids that failed independently; their last successful checkpoint is left untouched. */
  failedWorkspaceIds: string[];
}

const CURSOR = 'scheduler.last_tick';
const ATTEMPT = 'scheduler.last_attempt';
/** The normal first tick looks back briefly; delayed first ticks can cover a daily slot. */
const FIRST_LOOKBACK_MS = 5 * 60_000;
const MAX_REPLAY_LOOKBACK_MS = 48 * 60 * 60_000;
/** Keep one tick within a predictable amount of workspace work; later ticks pick the oldest attempt. */
export const SCHEDULER_WORKSPACE_BATCH = 50;

export async function schedulerTick(deps: { repos: Repositories; queue: JobQueue; clock: Clock }): Promise<TickReport> {
  const now = deps.clock.now();
  const report: TickReport = { at: now, workspaces: 0, enqueued: 0, duplicates: 0, superseded: 0, failedWorkspaceIds: [] };
  for (const ws of await deps.repos.workspaces.listForScheduler(SCHEDULER_WORKSPACE_BATCH)) {
    // Only connected workspaces run on the clock. Sample and imported data have their own time range
    // and run on demand (runWorkspaceNow), like the browser build.
    if (ws.mode !== 'connected') continue;
    report.workspaces++;
    // Rotate a failing workspace too. Its successful cursor remains old so a later tick retries it.
    await deps.repos.cursors.set(ws.id, ATTEMPT, now);
    try {
      const firstLookback = Date.parse(now) - Date.parse(ws.createdAt) > FIRST_LOOKBACK_MS ? MAX_REPLAY_LOOKBACK_MS : FIRST_LOOKBACK_MS;
      const last = (await deps.repos.cursors.get(ws.id, CURSOR)) ?? new Date(Date.parse(now) - firstLookback).toISOString();
      if (last >= now) continue;
      // Every supported cadence has a slot in 48 hours. Skip older history without iterating it.
      const windowStart = new Date(Math.max(Date.parse(last), Date.parse(now) - MAX_REPLAY_LOOKBACK_MS)).toISOString();
      const enqueue = async (kind: 'source.check' | 'monitor.watch' | 'brief.compose', key: string, at: string, payload: Record<string, unknown>) => {
        const added = await deps.queue.enqueue({ kind, workspaceId: ws.id, payload, runAt: at, idempotencyKey: `${ws.id}:${key}` });
        if (added) report.enqueued++;
        else report.duplicates++;
      };
      const targets = await deps.repos.sourceTargets.list(ws.id);
      for (const target of targets.filter((item) => item.status === 'active' && item.checkIntervalMinutes && item.organizationId === ws.organizationId)) {
        const state = await deps.repos.sourceStates.get(ws.id, target.id);
        if (state?.nextCheckAt && state.nextCheckAt > now) continue;
        const intervalMs = target.checkIntervalMinutes! * 60_000;
        const slot = new Date(Math.floor(Date.parse(now) / intervalMs) * intervalMs).toISOString();
        await enqueue('source.check', `source-check:${target.id}:${slot}`, now, { organizationId: ws.organizationId, sourceTargetId: target.id });
      }
      for (const w of await deps.repos.watches.list(ws.id)) {
        if (w.status !== 'active') continue;
        const watchTargetIds = new Set(sourceTargetIdsForWatch(w, targets));
        const watchTargets = targets.filter((target) => watchTargetIds.has(target.id));
        // Sentry-only target-backed watches are triggered by shared source observations, not one provider read per watch.
        if (watchTargets.length && watchTargets.every((target) => target.checkIntervalMinutes)) continue;
        const due: string[] = [];
        for (let t = nextRunAt(w, windowStart, w.createdAt); t && t <= now; t = nextRunAt(w, t, w.createdAt)) {
          due.push(t);
          if (due.length > 10_000) break;
        }
        if (!due.length) continue;
        report.superseded += due.length - 1;
        const at = due[due.length - 1];
        await enqueue('monitor.watch', `run:${w.id}:${at}`, at, { watchId: w.id, dueAt: at });
      }
      // Briefs due in (last, now] — computed directly so a brief a few seconds after the last tick is not skipped.
      const briefs = ws.brief.enabled ? dailyOccurrences(ws.brief.time, ws.brief.timezone, new Date(Date.parse(windowStart) + 1).toISOString(), now) : [];
      const brief = briefs.at(-1);
      if (brief) await enqueue('brief.compose', `brief:${brief}`, brief, { dueAt: brief });
      await deps.repos.cursors.set(ws.id, CURSOR, now);
    } catch {
      report.failedWorkspaceIds.push(ws.id);
    }
  }
  return report;
}
