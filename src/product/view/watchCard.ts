import type { ISO, MonitoringResult, SchedulerLogEntry, Watch } from '../types.js';
import { nextRunAt } from '../scheduler.js';

/**
 * A watch card's run status, as data. Browser-local workspaces replay one monitoring window (the
 * sample night or an import), so runs and the next check come from that window. Server workspaces
 * run on the server's schedule: runs come from the server's run history, and the next check is the
 * scheduler's own slot (anchored at the watch's creation) after the time the server was read.
 */

/** The sample night's first scheduled slot, used before a browser workspace has run. */
const SAMPLE_ANCHOR = '2026-09-23T18:00:00.000Z';

export interface WatchCardStatus {
  /** This watch's runs (oldest first). */
  runs: SchedulerLogEntry[];
  /** The most recent run (server workspaces). */
  lastRun?: SchedulerLogEntry;
  nextRun?: ISO;
  /** What the card says when there is no open investigation. */
  quiet: string;
}

export interface WatchCardContext {
  location: 'browser' | 'server';
  result?: MonitoringResult;
  /** The workspace clock (browser: the replayed time). */
  clock: ISO;
  /** Server workspaces: when the server snapshot was read. */
  snapshotAt?: ISO;
}

export function watchCardStatus(w: Watch, ctx: WatchCardContext): WatchCardStatus {
  const r = ctx.result;
  const runs = r?.log.filter((l) => l.watchId === w.id) ?? [];
  if (ctx.location === 'server') {
    const ordered = [...runs].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    const lastRun = ordered.at(-1);
    return { runs: ordered, lastRun, nextRun: nextRunAt(w, ctx.snapshotAt ?? ctx.clock, w.createdAt), quiet: lastRun ? 'No open investigations' : 'Not run yet' };
  }
  return { runs, nextRun: nextRunAt(w, ctx.clock, r?.window.start ?? SAMPLE_ANCHOR), quiet: r ? 'No meaningful changes last night' : 'Not run yet' };
}
