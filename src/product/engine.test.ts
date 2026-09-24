import { describe, expect, it } from 'vitest';
import { defaultBriefSchedule, defaultWatches, watchFromTemplate } from './catalog';
import { createAdapters, defaultConnections, resolveRef } from './integrations/adapters';
import { ProviderUnavailableError } from './integrations/types';
import { defaultWorld } from './integrations/world';
import { runMonitoring } from './engine/monitor';
import { withWatchThreshold } from './engine/detect';
import { hasCausalOverclaim } from './engine/language';
import { dailyOccurrences, nextRunAt, planJobs, toCron, zonedTimeToUtc } from './scheduler';

describe('scheduler', () => {
  const start = '2026-09-23T18:00:00.000Z';
  const end = '2026-09-24T08:00:00.000Z';

  it('keeps monitoring and briefing schedules separate', () => {
    const jobs = planJobs(defaultWatches(), { start, end }, defaultBriefSchedule());
    expect(jobs.filter((j) => j.type === 'morning_brief').map((j) => j.at)).toEqual([end]);
    expect(jobs.filter((j) => j.watchId === 'w-checkout')).toHaveLength(29);
    expect(jobs.filter((j) => j.watchId === 'w-search')).toHaveLength(4);
    expect(jobs.every((j, i) => i === 0 || jobs[i - 1].at <= j.at)).toBe(true);
  });

  it('handles timezones and DST', () => {
    expect(zonedTimeToUtc({ y: 2026, m: 9, d: 24 }, '08:00', 'America/New_York')).toBe('2026-09-24T12:00:00.000Z');
    expect(zonedTimeToUtc({ y: 2026, m: 12, d: 1 }, '08:00', 'America/New_York')).toBe('2026-12-01T13:00:00.000Z');
    expect(zonedTimeToUtc({ y: 2026, m: 9, d: 24 }, '08:00', 'Asia/Kolkata')).toBe('2026-09-24T02:30:00.000Z');
    expect(dailyOccurrences('07:00', 'UTC', start, end)).toEqual(['2026-09-24T07:00:00.000Z']);
  });

  it('computes the next check and a cron equivalent', () => {
    const w = defaultWatches()[0];
    expect(nextRunAt(w, '2026-09-24T08:05:00.000Z', start)).toBe('2026-09-24T08:30:00.000Z');
    expect(toCron(w)).toBe('*/30 * * * *');
  });
});

describe('adapters', () => {
  it('never fabricates data for unavailable providers', async () => {
    const conns = defaultConnections().map((c) => (c.provider === 'jira' ? { ...c, state: 'unavailable' as const, detail: 'Timed out' } : c));
    const reg = createAdapters(defaultWorld(), conns);
    await expect(reg.sources.jira.getIssues({ start, end })).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(reg.sources.jira.connection().state).toBe('unavailable');
  });

  it('only returns data that exists as of the query time', async () => {
    const reg = createAdapters(defaultWorld(), defaultConnections());
    const [series] = await reg.sources.ga4.getMetrics(['ga4.checkout_conversion'], { start, end: '2026-09-23T19:00:00.000Z' });
    expect(series.points.map((p) => p.t.slice(11, 16))).toEqual(['18:00', '18:15', '18:30', '18:45']);
    expect(await reg.sources.ga4.getIssues({ start, end })).toEqual([]);
  });

  it('resolves deep links to real records', () => {
    expect(resolveRef(defaultWorld(), { provider: 'jira', kind: 'issue', id: 'PAY-512' })).toBeDefined();
    expect(resolveRef(defaultWorld(), { provider: 'jira', kind: 'issue', id: 'PAY-999' })).toBeUndefined();
  });
});
const start = '2026-09-23T18:00:00.000Z';
const end = '2026-09-24T08:00:00.000Z';

describe('language guard', () => {
  it('flags causal claims and accepts correlation language', () => {
    expect(hasCausalOverclaim('Release 4.8.1 caused the conversion drop.')).toBe(true);
    expect(hasCausalOverclaim('The drop is due to the new payment sheet.')).toBe(true);
    expect(hasCausalOverclaim('The available evidence supports a temporal correlation, but does not establish causation.')).toBe(false);
    expect(hasCausalOverclaim('Whether release 4.8.1 is responsible — timing alone does not establish causation.')).toBe(false);
  });
});

describe('default workspace night', () => {
  it('produces one HIGH checkout investigation, one MEDIUM signup finding, one email and a brief', async () => {
    const r = await runMonitoring({ world: defaultWorld(), watches: defaultWatches(), connections: defaultConnections(), brief: defaultBriefSchedule() });
    const checkout = r.investigations.find((i) => i.area === 'checkout')!;
    expect(checkout.attention).toBe('HIGH');
    expect(checkout.status).toBe('CONFIRMED');
    expect(checkout.watchIds).toEqual(['w-checkout', 'w-customer']);
    expect(checkout.statusHistory.map((h) => h.state)).toEqual(['DETECTED', 'INVESTIGATING', 'CONFIRMED']);
    expect(r.investigations.find((i) => i.area === 'signup')!.attention).toBe('MEDIUM');
    expect(r.emails).toHaveLength(1);
    expect(r.emails[0].subject).toBe('Jagr: Checkout conversion dropped 18%');
    expect(r.emails[0].buttons.map((b) => b.label)).toEqual(['Open investigation', 'Open Jira', 'Open Analytics', 'Open App Store', 'Open Play Store']);
    expect(r.briefs[0].headline).toBe('2 things need your attention.');
    expect(r.briefs[0].quiet.watchNames).toEqual(['Search & discovery']);
    expect(r.briefs[0].deduplicated.map((d) => d.watchName)).toEqual(['Customer issues']);
  });

  it('links an overlapping watch to the existing investigation instead of emailing twice', async () => {
    const watches = [...defaultWatches(), watchFromTemplate('w-stab', 'app_stability')];
    const r = await runMonitoring({ world: defaultWorld(), watches, connections: defaultConnections(), brief: defaultBriefSchedule() });
    expect(r.investigations.filter((i) => i.status !== 'DISMISSED')).toHaveLength(2);
    expect(r.investigations.find((i) => i.area === 'checkout')!.watchIds).toContain('w-stab');
    expect(r.emails).toHaveLength(1);
    expect(r.briefs[0].deduplicated.map((d) => d.watchName)).toContain('App stability');
  });

  it('applies a watch\'s custom metric thresholds (and ignores invalid ones)', async () => {
    const run = (thresholds?: Record<string, number>) =>
      runMonitoring({ world: defaultWorld(), watches: [watchFromTemplate('w-conv', 'conversion', { thresholds })], connections: defaultConnections(), brief: defaultBriefSchedule() });
    expect((await run()).investigations.length).toBeGreaterThan(0);
    // A threshold far above last night's drops means nothing crosses it.
    expect((await run({ 'ga4.checkout_conversion': 90, 'ga4.signup_conversion': 90 })).investigations).toHaveLength(0);
    const series = { ...defaultWorld().metrics[0], threshold: 5 };
    expect(withWatchThreshold(series, { [series.id]: 0 }).threshold).toBe(5);
    expect(withWatchThreshold(series, { [series.id]: Number.NaN }).threshold).toBe(5);
    expect(withWatchThreshold(series, { [series.id]: 12 }).threshold).toBe(12);
  });

  it('only schedules active watches', async () => {
    const paused = { ...watchFromTemplate('w-x', 'checkout_health'), status: 'paused' as const };
    const r = await runMonitoring({ world: defaultWorld(), watches: [paused], connections: defaultConnections(), brief: defaultBriefSchedule() });
    expect(r.log.filter((l) => l.type === 'watch_run')).toHaveLength(0);
    expect(r.investigations).toHaveLength(0);
  });
});
