import type { BriefSchedule, ISO, MonitoringFrequency, ScheduledJob, Watch } from './types.js';

/**
 * Deterministic scheduler.
 *
 * Monitoring and briefing are separate schedules: a watch can run every 15 minutes while the
 * brief goes out once at 08:00, and critical findings notify immediately from whichever run
 * found them. `planJobs` is pure, so the same plan maps directly onto cron entries or queue jobs later.
 */

export const FREQUENCY_MINUTES: Record<Exclude<MonitoringFrequency, 'daily'>, number> = { '15m': 15, '30m': 30, '1h': 60, '4h': 240 };

export const FREQUENCY_LABEL: Record<MonitoringFrequency, string> = {
  '15m': 'Every 15 minutes',
  '30m': 'Every 30 minutes',
  '1h': 'Every hour',
  '4h': 'Every 4 hours',
  daily: 'Daily',
};

/** Cron equivalent — what this schedule becomes on real infrastructure. */
export function toCron(watch: Pick<Watch, 'schedule'>): string {
  switch (watch.schedule.frequency) {
    case '15m':
      return '*/15 * * * *';
    case '30m':
      return '*/30 * * * *';
    case '1h':
      return '0 * * * *';
    case '4h':
      return '0 */4 * * *';
    case 'daily': {
      const [h, m] = watch.schedule.dailyAt.split(':').map(Number);
      return `${m} ${h} * * *`;
    }
  }
}

// ── Timezones ────────────────────────────────────────────────

/** Offset of `tz` from UTC at instant `ts`, in milliseconds. */
export function tzOffsetMs(ts: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ts));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** Wall-clock HH:MM on a calendar day in `tz` → UTC ISO. */
export function zonedTimeToUtc(ymd: { y: number; m: number; d: number }, hhmm: string, tz: string): ISO {
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(ymd.y, ymd.m - 1, ymd.d, h, mi);
  let ts = guess - tzOffsetMs(guess, tz);
  ts = guess - tzOffsetMs(ts, tz); // second pass handles DST boundaries
  return new Date(ts).toISOString();
}

/** Every occurrence of a daily wall-clock time within [start, end]. */
export function dailyOccurrences(hhmm: string, tz: string, start: ISO, end: ISO): ISO[] {
  const out: ISO[] = [];
  const s = Date.parse(start);
  const e = Date.parse(end);
  for (let day = s - 2 * 86_400_000; day <= e + 86_400_000; day += 86_400_000) {
    const d = new Date(day);
    const at = zonedTimeToUtc({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }, hhmm, tz);
    const ts = Date.parse(at);
    if (ts >= s && ts <= e && !out.includes(at)) out.push(at);
  }
  return out.sort();
}

// ── Planning ─────────────────────────────────────────────────

export function watchRunTimes(watch: Watch, start: ISO, end: ISO): ISO[] {
  if (watch.status !== 'active') return [];
  if (watch.schedule.frequency === 'daily') return dailyOccurrences(watch.schedule.dailyAt, watch.timezone, start, end);
  const step = FREQUENCY_MINUTES[watch.schedule.frequency] * 60_000;
  const out: ISO[] = [];
  for (let ts = Date.parse(start); ts <= Date.parse(end); ts += step) out.push(new Date(ts).toISOString());
  return out;
}

export function planJobs(watches: Watch[], window: { start: ISO; end: ISO }, brief: BriefSchedule): ScheduledJob[] {
  const jobs: ScheduledJob[] = [];
  watches.forEach((w) => {
    for (const at of watchRunTimes(w, window.start, window.end)) jobs.push({ id: `run:${w.id}:${at}`, type: 'watch_run', at, watchId: w.id });
  });
  if (brief.enabled) {
    for (const at of dailyOccurrences(brief.time, brief.timezone, window.start, window.end)) jobs.push({ id: `brief:${at}`, type: 'morning_brief', at });
  }
  const order = (j: ScheduledJob) => (j.type === 'morning_brief' ? 1 : 0);
  const watchIndex = (j: ScheduledJob) => watches.findIndex((w) => w.id === j.watchId);
  return jobs.sort((a, b) => a.at.localeCompare(b.at) || order(a) - order(b) || watchIndex(a) - watchIndex(b));
}

/** Next time this watch will run after `after` (for "When will Jagr check again?"). */
export function nextRunAt(watch: Watch, after: ISO, anchor: ISO): ISO | undefined {
  if (watch.status !== 'active') return undefined;
  if (watch.schedule.frequency === 'daily') {
    return dailyOccurrences(watch.schedule.dailyAt, watch.timezone, new Date(Date.parse(after) + 60_000).toISOString(), new Date(Date.parse(after) + 2 * 86_400_000).toISOString())[0];
  }
  const step = FREQUENCY_MINUTES[watch.schedule.frequency] * 60_000;
  const a = Date.parse(anchor);
  const k = Math.floor((Date.parse(after) - a) / step) + 1;
  return new Date(a + k * step).toISOString();
}

export function nextBriefAt(brief: BriefSchedule, after: ISO): ISO | undefined {
  if (!brief.enabled) return undefined;
  return dailyOccurrences(brief.time, brief.timezone, new Date(Date.parse(after) + 60_000).toISOString(), new Date(Date.parse(after) + 2 * 86_400_000).toISOString())[0];
}
