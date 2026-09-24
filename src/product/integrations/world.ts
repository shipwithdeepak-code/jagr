import { createRng, hashString } from '../lib/rng';
import { addMinutes } from '../lib/time';
import type { ProviderId } from '../types';
import type { IssueRecord, MetricSeries, ReleaseRecord, ReviewRecord } from './types';

/**
 * A fixture "world": what Jira, GA4, App Store Connect and Google Play would return for one
 * night of the simulated product (Tempo, a subscription app on web, iOS and Android).
 * Worlds hold raw records only — never conclusions. The engine has to find the story.
 */

export const WORLD_START = '2026-09-23T18:00:00.000Z';
export const BUCKET_MIN = 15;
export const WORLD_BUCKETS = 57; // 18:00 → 08:00 inclusive of the 08:00 bucket start

interface MetricDef extends Omit<MetricSeries, 'points' | 'baseline'> {
  base: number;
  /** Night-to-night standard deviation. */
  std: number;
}

export const METRIC_DEFS: MetricDef[] = [
  { id: 'ga4.checkout_conversion', provider: 'ga4', name: 'Checkout conversion', unit: 'percent', area: 'checkout', badDirection: 'down', mode: 'relative', threshold: 5, base: 3.4, std: 0.04 },
  { id: 'ga4.signup_conversion', provider: 'ga4', name: 'Signup conversion', unit: 'percent', area: 'signup', badDirection: 'down', mode: 'relative', threshold: 5, base: 12.0, std: 0.14 },
  { id: 'ga4.search_usage', provider: 'ga4', name: 'Search usage', unit: 'count', area: 'search', badDirection: 'down', mode: 'relative', threshold: 8, base: 5200, std: 80 },
  { id: 'ga4.purchase_revenue', provider: 'ga4', name: 'Purchase revenue', unit: 'currency', area: 'checkout', badDirection: 'down', mode: 'relative', threshold: 10, base: 4800, std: 150 },
  { id: 'ga4.sessions', provider: 'ga4', name: 'Sessions', unit: 'count', area: 'general', badDirection: 'down', mode: 'relative', threshold: 10, base: 21000, std: 260 },
  { id: 'app_store.crash_free_sessions', provider: 'app_store', name: 'Crash-free sessions (iOS)', unit: 'percent', area: 'stability', badDirection: 'down', mode: 'absolute', threshold: 0.3, base: 99.72, std: 0.04, platform: 'ios' },
  { id: 'google_play.crash_free_sessions', provider: 'google_play', name: 'Crash-free sessions (Android)', unit: 'percent', area: 'stability', badDirection: 'down', mode: 'absolute', threshold: 0.3, base: 99.6, std: 0.05, platform: 'android' },
];


export interface MetricEffect {
  from: string; // HH:MM
  to?: string;
  /** % for relative metrics, points for absolute metrics. */
  change: number;
}

export interface WorldSpec {
  id: string;
  name: string;
  seed: number;
  effects?: Partial<Record<string, MetricEffect[]>>;
  issues?: IssueRecord[];
  releases?: ReleaseRecord[];
  reviews?: ReviewRecord[];
}

export interface World {
  id: string;
  name: string;
  start: string;
  end: string;
  /** Spacing of metric points. Simulated nights use 15 minutes; imported data uses its own cadence. */
  bucketMinutes?: number;
  metrics: MetricSeries[];
  /**
   * Metrics the world's sources are configured to serve, including ones with no data yet. Absent →
   * exactly the metrics present. Imported workspaces declare every importable metric, so a missing
   * one is a recorded gap ("no purchase revenue data"), not a silently skipped check.
   */
  metricCatalog?: Omit<MetricSeries, 'points' | 'baseline'>[];
  issues: IssueRecord[];
  releases: ReleaseRecord[];
  reviews: ReviewRecord[];
}

/** "HH:MM" on the simulated night → ISO. Before noon means the next morning. */
export function t(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  let minutes = (h - 18) * 60 + m;
  if (h < 12) minutes += 24 * 60;
  return addMinutes(WORLD_START, minutes);
}

function inEffect(e: MetricEffect, bucketStart: string) {
  const ts = Date.parse(bucketStart);
  return ts >= Date.parse(t(e.from)) && (!e.to || ts < Date.parse(t(e.to)));
}

export function buildWorld(spec: WorldSpec): World {
  const metrics: MetricSeries[] = METRIC_DEFS.map((d) => {
    const rng = createRng(spec.seed ^ hashString(d.id));
    const points = Array.from({ length: WORLD_BUCKETS }, (_, i) => {
      const at = addMinutes(WORLD_START, i * BUCKET_MIN);
      let value = d.base + rng.normal(1.5) * d.std * 0.5;
      for (const e of spec.effects?.[d.id] ?? []) {
        if (!inEffect(e, at)) continue;
        value = d.mode === 'relative' ? value * (1 + e.change / 100) : value + e.change;
      }
      return { t: at, value: Math.round(value * 1000) / 1000 };
    });
    const { base, std, ...rest } = d;
    return { ...rest, baseline: { mean: base, stdDev: std, window: 'Same hours, previous 28 nights' }, points };
  });
  return {
    id: spec.id,
    name: spec.name,
    start: WORLD_START,
    end: addMinutes(WORLD_START, (WORLD_BUCKETS - 1) * BUCKET_MIN),
    metrics,
    issues: [...BACKGROUND_ISSUES, ...(spec.issues ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    releases: [...BACKGROUND_RELEASES, ...(spec.releases ?? [])].sort((a, b) => a.releasedAt.localeCompare(b.releasedAt)),
    reviews: [...BACKGROUND_REVIEWS, ...(spec.reviews ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
}

// ─────────────────────────────────────────────────────────────
// Background records present on every night — noise the engine must ignore.
// ─────────────────────────────────────────────────────────────

const BACKGROUND_ISSUES: IssueRecord[] = [
  { id: 'APP-731', provider: 'jira', title: 'Update help-centre links in settings', type: 'Task', priority: 'Low', component: 'Settings', area: 'general', labels: ['docs'], reporter: 'Product', createdAt: t('18:20') },
  { id: 'APP-733', provider: 'jira', title: 'Dark-mode contrast on share sheet', type: 'Bug', priority: 'Low', component: 'Design system', area: 'general', labels: ['a11y'], reporter: 'Design', createdAt: t('02:40') },
];

const BACKGROUND_RELEASES: ReleaseRecord[] = [
  // A tracker's release date is bookkeeping ("marked released"), not when the build reached users.
  { id: 'jira-rel-4.8.0', provider: 'jira', timing: 'planned', version: '4.8.0', platform: 'all', releasedAt: addMinutes(WORLD_START, -3 * 24 * 60), notes: 'Search typo tolerance, settings accessibility fixes' },
];

const BACKGROUND_REVIEWS: ReviewRecord[] = [
  { id: 'as-r-9001', provider: 'app_store', rating: 5, title: 'Love the widgets', body: 'The new today widget is great.', version: '4.8.0', createdAt: t('19:50') },
  { id: 'gp-r-7001', provider: 'google_play', rating: 4, title: 'Solid app', body: 'Would like dark mode everywhere.', version: '4.8.0', createdAt: t('00:15') },
  { id: 'as-r-9002', provider: 'app_store', rating: 2, title: 'Too many notifications', body: 'Please let me turn off the weekly summary.', version: '4.8.0', createdAt: t('03:30') },
];

// ─────────────────────────────────────────────────────────────
// Scenario building blocks
// ─────────────────────────────────────────────────────────────

export const RELEASES_481: ReleaseRecord[] = [
  { id: 'jira-rel-4.8.1', provider: 'jira', timing: 'planned', version: '4.8.1', platform: 'all', releasedAt: t('18:30'), notes: 'Checkout payment sheet refactor; promo code handling' },
  { id: 'as-rel-4.8.1', provider: 'app_store', version: '4.8.1', platform: 'ios', releasedAt: t('18:40'), notes: 'Phased release started', rollout: 'Phased release' },
  { id: 'gp-rel-4.8.1', provider: 'google_play', version: '4.8.1', platform: 'android', releasedAt: t('18:45'), notes: 'Staged rollout', rollout: '20% staged rollout' },
];

export const CHECKOUT_ISSUES: IssueRecord[] = [
  { id: 'PAY-512', provider: 'jira', title: 'Checkout spinner never completes on iOS 4.8.1', type: 'Bug', priority: 'High', component: 'Checkout', area: 'checkout', labels: ['4.8.1', 'ios'], affectsVersion: '4.8.1', reporter: 'QA', createdAt: t('19:20') },
  { id: 'PAY-513', provider: 'jira', title: 'Payment sheet crashes after selecting annual plan', type: 'Bug', priority: 'High', component: 'Checkout', area: 'checkout', labels: ['4.8.1', 'android', 'crash'], affectsVersion: '4.8.1', reporter: 'QA', createdAt: t('20:05') },
  { id: 'PAY-514', provider: 'jira', title: 'Promo code field resets during checkout', type: 'Bug', priority: 'Medium', component: 'Checkout', area: 'checkout', labels: ['4.8.1'], affectsVersion: '4.8.1', reporter: 'Support', createdAt: t('21:40') },
  { id: 'PAY-516', provider: 'jira', title: 'Customer charged but subscription not activated', type: 'Bug', priority: 'High', component: 'Checkout', area: 'checkout', labels: ['customer-report'], reporter: 'Support', createdAt: t('23:10') },
];

export const CHECKOUT_REVIEWS: ReviewRecord[] = [
  { id: 'as-r-9010', provider: 'app_store', rating: 2, title: 'Checkout keeps crashing', body: 'Tried to upgrade three times, the checkout crashes every time.', version: '4.8.1', createdAt: t('20:12') },
  { id: 'gp-r-7010', provider: 'google_play', rating: 1, title: 'Payment screen crashes', body: 'App closes when I pick the annual plan at checkout.', version: '4.8.1', createdAt: t('21:05') },
  { id: 'as-r-9011', provider: 'app_store', rating: 1, title: "Can't pay", body: 'App freezes at checkout after the update.', version: '4.8.1', createdAt: t('22:40') },
  { id: 'as-r-9012', provider: 'app_store', rating: 1, title: 'Checkout broken since update', body: 'Subscription purchase never finishes.', version: '4.8.1', createdAt: t('05:55') },
  { id: 'gp-r-7011', provider: 'google_play', rating: 2, title: 'Checkout failed twice', body: 'Payment failed at checkout twice this morning.', version: '4.8.1', createdAt: t('06:30') },
];

/** The default workspace night: a checkout degradation after 4.8.1, plus an unrelated signup dip. */
export function defaultWorld(): World {
  return buildWorld({
    id: 'tempo-night',
    name: 'Tempo — night after release 4.8.1',
    seed: 481,
    effects: {
      'ga4.checkout_conversion': [{ from: '19:00', change: -18 }],
      'ga4.purchase_revenue': [{ from: '19:00', change: -16 }],
      'app_store.crash_free_sessions': [{ from: '19:00', change: -0.67 }],
      'google_play.crash_free_sessions': [{ from: '19:15', change: -0.35 }],
      'ga4.signup_conversion': [{ from: '23:00', change: -9 }],
    },
    releases: RELEASES_481,
    issues: CHECKOUT_ISSUES,
    reviews: CHECKOUT_REVIEWS,
  });
}

export function providerOfMetric(id: string): ProviderId {
  return METRIC_DEFS.find((m) => m.id === id)?.provider ?? 'ga4';
}
