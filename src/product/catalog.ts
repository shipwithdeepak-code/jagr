import type { Area, BriefSchedule, ProviderId, SignalKey, Watch, WatchSignal, WatchTemplateId } from './types.js';
import type { Role, SourceId } from './roles/types.js';
import { isSourceId } from './roles/types.js';

export const AREA_LABEL: Record<Area, string> = { checkout: 'Checkout', signup: 'Signup', search: 'Search', stability: 'App stability', general: 'General' };

/** Keywords used to classify feedback and work-item text into product areas. Order = priority. */
export const AREA_KEYWORDS: [Area, string[]][] = [
  ['checkout', ['checkout', 'payment', 'purchase', 'subscription', 'subscribe', 'annual plan', 'charged', 'upgrade', 'promo code', "can't pay", 'pay '] ],
  ['signup', ['sign up', 'signup', 'register', 'create an account', 'onboarding']],
  ['search', ['search']],
  ['stability', ['crash', 'freezes', 'closes', 'force close']],
];

export function classifyText(text: string): Area[] {
  const lower = ` ${text.toLowerCase()} `;
  return AREA_KEYWORDS.filter(([, kws]) => kws.some((k) => lower.includes(k))).map(([a]) => a);
}

// ─────────────────────────────────────────────────────────────
// Metrics and signals — by role, never by vendor
// ─────────────────────────────────────────────────────────────

/** What a metric measures. The investigator uses this to choose checks, never a metric's source. */
export type MetricPurpose = 'funnel' | 'revenue' | 'traffic' | 'stability' | 'usage';

export interface MetricMeta {
  label: string;
  /** Lower = more important when choosing an investigation's primary signal. */
  priority: number;
  coreFunnel?: boolean;
  purpose: MetricPurpose;
}

/** Metrics Jagr knows how to reason about. A connected source may serve others; they get defaults. */
export const METRIC_META: Record<string, MetricMeta> = {
  checkout_conversion: { label: 'Checkout conversion', priority: 0, coreFunnel: true, purpose: 'funnel' },
  signup_conversion: { label: 'Signup conversion', priority: 0, coreFunnel: true, purpose: 'funnel' },
  purchase_revenue: { label: 'Purchase revenue', priority: 1, coreFunnel: true, purpose: 'revenue' },
  crash_free_sessions_ios: { label: 'Crash-free sessions (iOS)', priority: 2, purpose: 'stability' },
  crash_free_sessions_android: { label: 'Crash-free sessions (Android)', priority: 2, purpose: 'stability' },
  search_usage: { label: 'Search usage', priority: 5, purpose: 'usage' },
  sessions: { label: 'Sessions', priority: 6, purpose: 'traffic' },
};

export function metricMeta(key: string): MetricMeta {
  return METRIC_META[key] ?? { label: key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), priority: 5, purpose: 'usage' };
}

export const metricSignal = (key: string): SignalKey => `metric:${key}`;

/** The metric key of a metric signal ("metric:checkout_conversion" → "checkout_conversion"). */
export function metricKeyOf(signal: string): string | undefined {
  return signal.startsWith('metric:') ? signal.slice('metric:'.length) : undefined;
}

export interface SignalMeta {
  key: SignalKey;
  label: string;
  kind: 'metric' | 'work_items' | 'feedback' | 'changes';
  /** Lower = more important when choosing an investigation's primary signal. */
  priority: number;
  coreFunnel?: boolean;
  /** Metric signals only. */
  metric?: string;
  purpose?: MetricPurpose;
}

export function signalMeta(key: SignalKey): SignalMeta {
  const metric = metricKeyOf(key);
  if (metric) {
    const m = metricMeta(metric);
    return { key, label: m.label, kind: 'metric', priority: m.priority, coreFunnel: m.coreFunnel, metric, purpose: m.purpose };
  }
  if (key === 'work_items') return { key, label: 'Issues', kind: 'work_items', priority: 3 };
  if (key === 'feedback') return { key, label: 'Customer feedback', kind: 'feedback', priority: 4 };
  return { key, label: 'Releases and changes', kind: 'changes', priority: 9 };
}

/** Metrics to consult when investigating an area (the area's funnel metric first). */
export const AREA_METRICS: Record<Area, string[]> = {
  checkout: ['checkout_conversion', 'purchase_revenue'],
  signup: ['signup_conversion'],
  search: ['search_usage'],
  stability: ['checkout_conversion'],
  general: [],
};

/** Typical volume per 3 hours, from the previous 28 nights — used to judge whether a count is unusual. */
export const ISSUE_BASELINE_PER_3H: Record<Area, number> = { checkout: 0.2, signup: 0.2, search: 0.1, stability: 0.2, general: 0.6 };
export const NEGATIVE_REVIEW_BASELINE_PER_6H: Record<Area, number> = { checkout: 0.3, signup: 0.2, search: 0.2, stability: 0.4, general: 0.8 };

// ─────────────────────────────────────────────────────────────
// Built-in source channels (Sample workspace and imports)
//
// Configuration, not logic: which roles and metrics the built-in channels serve, so templates can
// offer only signals a watch's sources can answer. Connected sources are described by the registry.
// ─────────────────────────────────────────────────────────────

export const BUILTIN_SOURCE_ROLES: Record<SourceId, Role[]> = {
  jira: ['work_items', 'changes'],
  ga4: ['metrics'],
  app_store: ['metrics', 'changes', 'feedback'],
  google_play: ['metrics', 'changes', 'feedback'],
  github: ['changes'],
  amplitude: ['metrics', 'changes'],
  intercom: ['feedback'],
  sentry: ['metrics', 'changes', 'work_items'],
};

export const BUILTIN_METRIC_SOURCE: Record<string, SourceId> = {
  checkout_conversion: 'ga4',
  signup_conversion: 'ga4',
  purchase_revenue: 'ga4',
  search_usage: 'ga4',
  sessions: 'ga4',
  crash_free_sessions_ios: 'app_store',
  crash_free_sessions_android: 'google_play',
};

/**
 * Keep only the signals a set of sources can answer ('changes' is context and always kept).
 * `metricKeys`: the metrics those sources actually serve (connected workspaces configure their own);
 * without it, the built-in channels' metrics are assumed.
 */
export function signalsForSources(signals: WatchSignal[], sources: readonly ProviderId[], metricKeys?: readonly string[]): WatchSignal[] {
  return signals.filter((sig) => {
    if (sig.key === 'changes') return true;
    const metric = metricKeyOf(sig.key);
    if (metric) return metricKeys ? metricKeys.includes(metric) : sources.includes(BUILTIN_METRIC_SOURCE[metric]);
    const role: Role = sig.key === 'work_items' ? 'work_items' : 'feedback';
    return sources.some((p) => isSourceId(p) && BUILTIN_SOURCE_ROLES[p].includes(role));
  });
}

export interface WatchTemplate {
  id: WatchTemplateId;
  name: string;
  description: string;
  area: Area | '*';
  sources: ProviderId[];
  signals: WatchSignal[];
  example: string;
}

const s = (key: SignalKey, area?: Area | '*'): WatchSignal => ({ key, area });

export const WATCH_TEMPLATES: WatchTemplate[] = [
  {
    id: 'checkout_health',
    name: 'Checkout health',
    description: 'Checkout conversion, crashes, checkout bugs and reviews that mention paying.',
    area: 'checkout',
    sources: ['ga4', 'jira', 'app_store', 'google_play'],
    signals: [s('metric:checkout_conversion'), s('metric:purchase_revenue'), s('metric:crash_free_sessions_ios'), s('metric:crash_free_sessions_android'), s('work_items', 'checkout'), s('feedback', 'checkout'), s('changes')],
    example: 'Conversion, errors, releases, crash-free sessions, reviews',
  },
  {
    id: 'app_stability',
    name: 'App stability',
    description: 'Crash-free sessions on iOS and Android, crash bugs and reviews that mention crashes.',
    area: 'stability',
    sources: ['app_store', 'google_play', 'jira'],
    signals: [s('metric:crash_free_sessions_ios'), s('metric:crash_free_sessions_android'), s('work_items', 'stability'), s('feedback', 'stability'), s('changes')],
    example: 'Crash-free sessions, crash bugs, releases',
  },
  {
    id: 'conversion',
    name: 'Conversion',
    description: 'Checkout and signup conversion in GA4, with releases as context.',
    area: '*',
    sources: ['ga4', 'jira', 'app_store', 'google_play'],
    signals: [s('metric:checkout_conversion'), s('metric:signup_conversion'), s('changes')],
    example: 'Checkout & signup conversion, releases',
  },
  {
    id: 'revenue',
    name: 'Revenue',
    description: 'Purchase revenue and checkout conversion.',
    area: 'checkout',
    sources: ['ga4', 'jira'],
    signals: [s('metric:purchase_revenue'), s('metric:checkout_conversion'), s('changes')],
    example: 'Purchase revenue, checkout conversion',
  },
  {
    id: 'customer_issues',
    name: 'Customer issues',
    description: 'New Jira bugs and negative app reviews across every product area.',
    area: '*',
    sources: ['jira', 'app_store', 'google_play'],
    signals: [s('work_items', '*'), s('feedback', '*')],
    example: 'Jira bugs, 1–2★ reviews',
  },
  {
    id: 'release_health',
    name: 'Release health',
    description: 'What changes after a release: crashes, reviews and new bugs.',
    area: 'stability',
    sources: ['app_store', 'google_play', 'jira'],
    signals: [s('changes'), s('metric:crash_free_sessions_ios'), s('metric:crash_free_sessions_android'), s('work_items', '*'), s('feedback', '*')],
    example: 'Releases, crashes, reviews, bugs',
  },
  {
    id: 'signup_funnel',
    name: 'Signup funnel',
    description: 'Signup conversion and signup-related bugs.',
    area: 'signup',
    sources: ['ga4', 'jira'],
    signals: [s('metric:signup_conversion'), s('work_items', 'signup'), s('changes')],
    example: 'Signup conversion, signup bugs',
  },
  {
    id: 'search_discovery',
    name: 'Search & discovery',
    description: 'Search usage and search bugs.',
    area: 'search',
    sources: ['ga4', 'jira'],
    signals: [s('metric:search_usage'), s('work_items', 'search')],
    example: 'Search usage, search bugs',
  },
  {
    // Changes only: a failed deployment is a finding; successful deployments and releases are brief context.
    id: 'github_changes',
    name: 'GitHub production changes',
    description: 'Production releases and changes in GitHub.',
    area: 'general',
    sources: ['github'],
    signals: [s('changes')],
    example: 'Deployments and releases',
  },
];

/** The templates offered in "What should I watch?" (spec order). */
export const WIZARD_TEMPLATES: WatchTemplateId[] = ['checkout_health', 'app_stability', 'conversion', 'revenue', 'customer_issues', 'release_health', 'github_changes'];

export function watchFromTemplate(
  id: string,
  templateId: WatchTemplateId,
  overrides: Partial<Pick<Watch, 'name' | 'sources' | 'schedule' | 'notificationPolicy' | 'timezone' | 'severityThreshold' | 'thresholds'>> & { metricKeys?: readonly string[] } = {},
  now = '2026-09-23T17:00:00.000Z',
): Watch {
  const tpl = WATCH_TEMPLATES.find((x) => x.id === templateId)!;
  const sources = overrides.sources ?? tpl.sources;
  return {
    id,
    name: overrides.name ?? tpl.name,
    description: tpl.description,
    template: tpl.id,
    area: tpl.area,
    sources,
    signals: signalsForSources(tpl.signals, sources, overrides.metricKeys),
    schedule: overrides.schedule ?? { frequency: '30m', dailyAt: '07:00' },
    timezone: overrides.timezone ?? 'UTC',
    severityThreshold: overrides.severityThreshold ?? 'LOW',
    ...(overrides.thresholds && Object.keys(overrides.thresholds).length ? { thresholds: overrides.thresholds } : {}),
    notificationPolicy: overrides.notificationPolicy ?? { interruptAt: 'HIGH', briefMin: 'MEDIUM', morningBrief: true },
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

export function defaultWatches(): Watch[] {
  return [
    watchFromTemplate('w-checkout', 'checkout_health', { schedule: { frequency: '30m', dailyAt: '07:00' } }),
    watchFromTemplate('w-signup', 'signup_funnel', { schedule: { frequency: '1h', dailyAt: '07:00' } }),
    watchFromTemplate('w-customer', 'customer_issues', { schedule: { frequency: '1h', dailyAt: '07:00' } }),
    watchFromTemplate('w-search', 'search_discovery', { schedule: { frequency: '4h', dailyAt: '07:00' } }),
  ];
}

export function defaultBriefSchedule(): BriefSchedule {
  return { enabled: true, time: '08:00', timezone: 'UTC' };
}

export const DEMO_RECIPIENT = 'pm@tempo.example';
export const EMAIL_FROM = 'Jagr <alerts@jagr.example>';
