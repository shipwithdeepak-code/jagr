import type { Clock } from '../ports/clock';
import type { JobQueue } from '../ports/jobs';
import type { Repositories } from '../ports/persistence';
import { dailyOccurrences, nextRunAt } from '../scheduler';

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
}

const CURSOR = 'scheduler.last_tick';
/** On a workspace's first tick, look back this far (so a run due "just now" is not missed). */
const FIRST_LOOKBACK_MS = 5 * 60_000;

export async function schedulerTick(deps: { repos: Repositories; queue: JobQueue; clock: Clock }): Promise<TickReport> {
  const now = deps.clock.now();
  const report: TickReport = { at: now, workspaces: 0, enqueued: 0, duplicates: 0, superseded: 0 };
  for (const ws of await deps.repos.workspaces.list()) {
    report.workspaces++;
    const last = (await deps.repos.cursors.get(ws.id, CURSOR)) ?? new Date(Date.parse(now) - FIRST_LOOKBACK_MS).toISOString();
    if (last >= now) continue;
    const enqueue = async (kind: 'monitor.watch' | 'brief.compose', key: string, at: string, payload: Record<string, unknown>) => {
      const added = await deps.queue.enqueue({ kind, workspaceId: ws.id, payload, runAt: at, idempotencyKey: `${ws.id}:${key}` });
      if (added) report.enqueued++;
      else report.duplicates++;
    };
    for (const w of await deps.repos.watches.list(ws.id)) {
      if (w.status !== 'active') continue;
      const due: string[] = [];
      for (let t = nextRunAt(w, last, w.createdAt); t && t <= now; t = nextRunAt(w, t, w.createdAt)) {
        due.push(t);
        if (due.length > 10_000) break;
      }
      if (!due.length) continue;
      report.superseded += due.length - 1;
      const at = due[due.length - 1];
      await enqueue('monitor.watch', `run:${w.id}:${at}`, at, { watchId: w.id, dueAt: at });
    }
    // Briefs due in (last, now] — computed directly so a brief a few seconds after the last tick is not skipped.
    const briefs = ws.brief.enabled ? dailyOccurrences(ws.brief.time, ws.brief.timezone, new Date(Date.parse(last) + 1).toISOString(), now) : [];
    const brief = briefs.at(-1);
    if (brief) await enqueue('brief.compose', `brief:${brief}`, brief, { dueAt: brief });
    await deps.repos.cursors.set(ws.id, CURSOR, now);
  }
  return report;
}
