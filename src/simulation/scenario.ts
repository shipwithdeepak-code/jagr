import type { Deployment, Experiment, PaymentProvider, PullRequest, SupportTicket } from '@/adapters/types';
import type { MetricBaseline, MetricDefinition, SeriesPoint } from '@/domain/types';
import { createRng, hashString } from '@/lib/rng';
import { addMinutes, BUCKET_MINUTES } from '@/lib/time';
import { METRIC_CATALOG, metricDefinition } from './catalog';

/**
 * A scenario is raw source data for one night — metric series, provider logs, deploys,
 * PRs, tickets, experiments. It never contains conclusions: the agent has to find them.
 */
export interface MetricEffect {
  /** Inclusive bucket index where the effect starts (0 = 18:00). */
  from: number;
  /** Inclusive bucket index where it ends; omitted = rest of night. */
  to?: number;
  /** Relative change applied to the metric, e.g. -11.8 for −11.8%. */
  changePct: number;
}

export interface ProviderEffect {
  from: number;
  to?: number;
  errorRate: number;
  errorCodes: Record<string, number>;
}

export interface ProviderScenario {
  provider: PaymentProvider;
  label: string;
  share: number;
  baselineErrorRate: number;
  baselineStdDev: number;
  baselineErrorCodes: Record<string, number>;
  effects: ProviderEffect[];
  statusMessages?: { from: string; status: 'operational' | 'degraded' | 'outage'; message: string }[];
}

export interface ScenarioDataset {
  id: string;
  name: string;
  nightStart: string;
  buckets: number;
  metrics: MetricDefinition[];
  series: Record<string, SeriesPoint[]>;
  baselines: Record<string, MetricBaseline>;
  providers: ProviderScenario[];
  deployments: Deployment[];
  pullRequests: PullRequest[];
  tickets: SupportTicket[];
  experiments: Experiment[];
}

export interface ScenarioSpec {
  id: string;
  name: string;
  seed: number;
  nightStart?: string;
  effects?: Record<string, MetricEffect[]>;
  providerEffects?: Partial<Record<PaymentProvider, ProviderEffect[]>>;
  providerStatus?: Partial<Record<PaymentProvider, ProviderScenario['statusMessages']>>;
  deployments?: Deployment[];
  pullRequests?: PullRequest[];
  tickets?: SupportTicket[];
  experiments?: Experiment[];
}

export const DEMO_NIGHT_START = '2026-09-23T18:00:00.000Z';
export const NIGHT_BUCKETS = 28; // 18:00 → 08:00

export const BASE_PROVIDERS: Omit<ProviderScenario, 'effects'>[] = [
  { provider: 'card', label: 'Cards', share: 0.35, baselineErrorRate: 3.1, baselineStdDev: 0.12, baselineErrorCodes: { card_declined: 71, insufficient_funds: 18, timeout: 11 } },
  { provider: 'klarna', label: 'Klarna', share: 0.31, baselineErrorRate: 2.4, baselineStdDev: 0.15, baselineErrorCodes: { timeout: 45, upstream_5xx: 30, declined: 25 } },
  { provider: 'paypal', label: 'PayPal', share: 0.24, baselineErrorRate: 1.8, baselineStdDev: 0.1, baselineErrorCodes: { buyer_cancelled: 64, timeout: 21, declined: 15 } },
  { provider: 'apple_pay', label: 'Apple Pay', share: 0.1, baselineErrorRate: 1.2, baselineStdDev: 0.08, baselineErrorCodes: { auth_failed: 58, timeout: 42 } },
];

function effectMultiplier(effects: MetricEffect[] | undefined, bucket: number): number {
  if (!effects) return 1;
  let m = 1;
  for (const e of effects) {
    if (bucket >= e.from && (e.to === undefined || bucket <= e.to)) m *= 1 + e.changePct / 100;
  }
  return m;
}

/** Build the full dataset: 28 nights of history + tonight's 30-minute buckets. */
export function buildScenario(spec: ScenarioSpec): ScenarioDataset {
  const nightStart = spec.nightStart ?? DEMO_NIGHT_START;
  const series: Record<string, SeriesPoint[]> = {};
  const baselines: Record<string, MetricBaseline> = {};

  for (const m of METRIC_CATALOG) {
    const rng = createRng(spec.seed ^ hashString(m.id));

    // Historical baseline: the mean of the same overnight window on each of the previous 28 nights.
    const history = Array.from({ length: 28 }, () => m.base * (1 + rng.normal() * m.cv));
    const histMean = history.reduce((a, b) => a + b, 0) / history.length;
    const centred = history.map((v) => v - histMean + m.base);
    const variance = centred.reduce((a, v) => a + (v - m.base) ** 2, 0) / (centred.length - 1);
    baselines[m.id] = { mean: m.base, stdDev: Math.sqrt(variance), window: 'Same hours, previous 28 nights', samples: 28 };

    // Tonight: per-bucket noise (smaller than night-to-night variation), then scenario effects.
    const noise = Array.from({ length: NIGHT_BUCKETS }, () => rng.normal() * m.cv * 0.6);
    // For metrics a scenario moves on purpose, centre the final 90-minute window so the headline
    // numbers are exact and reproducible. Untouched metrics keep their natural noise.
    if (spec.effects?.[m.id]) {
      const tail = noise.slice(-3);
      const tailMean = tail.reduce((a, b) => a + b, 0) / 3;
      for (let i = NIGHT_BUCKETS - 3; i < NIGHT_BUCKETS; i++) noise[i] -= tailMean;
    }

    series[m.id] = noise.map((n, i) => ({
      t: addMinutes(nightStart, i * BUCKET_MINUTES),
      value: m.base * (1 + n) * effectMultiplier(spec.effects?.[m.id], i),
    }));
  }

  const providers: ProviderScenario[] = BASE_PROVIDERS.map((p) => ({
    ...p,
    effects: spec.providerEffects?.[p.provider] ?? [],
    statusMessages: spec.providerStatus?.[p.provider],
  }));

  return {
    id: spec.id,
    name: spec.name,
    nightStart,
    buckets: NIGHT_BUCKETS,
    metrics: METRIC_CATALOG.map(metricDefinition),
    series,
    baselines,
    providers,
    deployments: spec.deployments ?? [],
    pullRequests: spec.pullRequests ?? [],
    tickets: spec.tickets ?? [],
    experiments: spec.experiments ?? [],
  };
}

/** Helper for scenario authors: "HH:MM" → ISO time. Afternoon/evening = the evening the watch starts; before noon = the next morning. */
export function at(hhmm: string, nightStart = DEMO_NIGHT_START): string {
  const [h, m] = hhmm.split(':').map(Number);
  const startHour = new Date(nightStart).getUTCHours();
  let minutes = (h - startHour) * 60 + m;
  if (h < 12) minutes += 24 * 60;
  return addMinutes(nightStart, minutes);
}

/** Tickets that are always present — ordinary overnight noise unrelated to any incident. */
export function backgroundTickets(nightStart = DEMO_NIGHT_START): SupportTicket[] {
  return [
    { id: 'T-8814', createdAt: at('19:22', nightStart), subject: 'Password reset email not arriving', body: 'I requested a reset twice, nothing in spam either.', channel: 'email', plan: 'Free' },
    { id: 'T-8821', createdAt: at('21:40', nightStart), subject: 'Need a copy of my August invoice', body: 'Our finance team needs the invoice with VAT number.', channel: 'email', plan: 'Team' },
    { id: 'T-8829', createdAt: at('00:30', nightStart), subject: 'Feature request: dark mode on Android', body: 'Would love dark mode in the Android app.', channel: 'in_app', plan: 'Pro' },
    { id: 'T-8838', createdAt: at('04:11', nightStart), subject: 'How do I cancel my plan?', body: 'Moving to a different tool for now, please help me cancel.', channel: 'chat', plan: 'Pro' },
    { id: 'T-8844', createdAt: at('06:40', nightStart), subject: 'Change billing email', body: 'Please update the billing contact on our workspace.', channel: 'email', plan: 'Team' },
  ];
}

/** Deploys and PRs from earlier in the week — context the agent must correctly ignore. */
export function backgroundReleases(nightStart = DEMO_NIGHT_START): { deployments: Deployment[]; pullRequests: PullRequest[] } {
  return {
    deployments: [
      { id: 'dep-ios-712', version: 'iOS 7.12', services: ['ios-app'], environment: 'production', deployedAt: addMinutes(nightStart, -5 * 24 * 60 + 60), pullRequests: [4088], platform: 'ios' },
      { id: 'dep-480', version: 'v4.8.0', services: ['web-app', 'api'], environment: 'production', deployedAt: addMinutes(nightStart, -3 * 24 * 60 - 120), pullRequests: [4101, 4104], platform: 'web' },
    ],
    pullRequests: [
      { number: 4088, title: 'iOS: new widget for today view', mergedAt: addMinutes(nightStart, -6 * 24 * 60), author: 'r.okafor', files: ['ios/Widgets/TodayWidget.swift'], labels: ['ios'] },
      { number: 4101, title: 'Search: typo tolerance', mergedAt: addMinutes(nightStart, -3 * 24 * 60 - 300), author: 'j.lindqvist', files: ['src/search/query.ts'], labels: ['search'] },
      { number: 4104, title: 'Settings page a11y fixes', mergedAt: addMinutes(nightStart, -3 * 24 * 60 - 280), author: 'p.nair', files: ['src/settings/Settings.tsx'], labels: ['a11y'] },
    ],
  };
}

export function checkoutCopyExperiment(nightStart = DEMO_NIGHT_START): Experiment {
  return {
    id: 'exp-checkout-copy',
    name: 'checkout_button_copy',
    surface: 'checkout',
    status: 'running',
    startedAt: addMinutes(nightStart, -9 * 24 * 60),
    owner: 'Growth',
    changes: [{ at: addMinutes(nightStart, -9 * 24 * 60), description: 'Launched at 50/50', allocation: 50 }],
    results: [
      { variant: 'control', users: 4120, metricId: 'checkout_conversion', value: 61.9 },
      { variant: 'treatment', users: 4088, metricId: 'checkout_conversion', value: 62.1 },
    ],
  };
}
