import type { ISO, MonitoringResult, SchedulerLogEntry, Watch } from '../types.js';
import { nextRunAt } from '../scheduler.js';
import { truthfulNotificationText } from '../presentation.js';

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
  // Run outcomes (stored ones included) say what was recorded, never that an email was sent.
  const runs = (r?.log.filter((l) => l.watchId === w.id) ?? []).map((l) => ({ ...l, outcome: truthfulNotificationText(l.outcome) }));
  if (ctx.location === 'server') {
    const ordered = [...runs].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    const lastRun = ordered.at(-1);
    return { runs: ordered, lastRun, nextRun: nextRunAt(w, ctx.snapshotAt ?? ctx.clock, w.createdAt), quiet: lastRun ? 'No open investigations' : 'Not run yet' };
  }
  return { runs, nextRun: nextRunAt(w, ctx.clock, r?.window.start ?? SAMPLE_ANCHOR), quiet: r ? 'No meaningful changes last night' : 'Not run yet' };
}

/**
 * The shell's one line of monitoring state — what the Overview does not already say (it shows when Jagr
 * last checked): whether monitoring is running, scheduled, or only on demand.
 *   server   watches run on the server's schedule → the next scheduled check
 *   browser  a local workspace has no scheduler → it runs when asked
 */
export interface MonitoringStatus {
  tone: 'active' | 'idle' | 'running';
  text: string;
}

export function monitoringStatus(watches: Watch[], ctx: WatchCardContext & { running?: boolean }): MonitoringStatus {
  if (ctx.running) return { tone: 'running', text: 'Checking watches…' };
  const active = watches.filter((w) => w.status === 'active');
  if (!active.length) return { tone: 'idle', text: watches.length ? 'All watches paused' : 'No watches yet' };
  if (ctx.location !== 'server') return { tone: 'idle', text: 'Local · runs on demand' };
  const next = active
    .map((w) => watchCardStatus(w, ctx).nextRun)
    .filter((t): t is ISO => !!t)
    .sort()[0];
  return { tone: 'active', text: next ? `Scheduled · next check ${next.slice(11, 16)} UTC` : 'Scheduled' };
}
