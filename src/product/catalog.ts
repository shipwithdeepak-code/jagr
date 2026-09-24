import type { Area, BriefSchedule, ProviderId, SignalKey, Watch, WatchSignal, WatchTemplateId } from './types';

export const AREA_LABEL: Record<Area, string> = { checkout: 'Checkout', signup: 'Signup', search: 'Search', stability: 'App stability', general: 'General' };

/** Keywords used to classify reviews (and Jira issue text) into product areas. Order = priority. */
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

export interface SignalMeta {
  key: SignalKey;
  provider: ProviderId | 'multi';
  label: string;
  kind: 'metric' | 'issues' | 'reviews' | 'releases';
  /** Lower = more important when choosing an investigation's primary signal. */
  priority: number;
  coreFunnel?: boolean;
}

export const SIGNALS: Record<SignalKey, SignalMeta> = {
  'ga4.checkout_conversion': { key: 'ga4.checkout_conversion', provider: 'ga4', label: 'Checkout conversion', kind: 'metric', priority: 0, coreFunnel: true },
  'ga4.signup_conversion': { key: 'ga4.signup_conversion', provider: 'ga4', label: 'Signup conversion', kind: 'metric', priority: 0, coreFunnel: true },
  'ga4.purchase_revenue': { key: 'ga4.purchase_revenue', provider: 'ga4', label: 'Purchase revenue', kind: 'metric', priority: 1, coreFunnel: true },
  'app_store.crash_free_sessions': { key: 'app_store.crash_free_sessions', provider: 'app_store', label: 'Crash-free sessions (iOS)', kind: 'metric', priority: 2 },
  'google_play.crash_free_sessions': { key: 'google_play.crash_free_sessions', provider: 'google_play', label: 'Crash-free sessions (Android)', kind: 'metric', priority: 2 },
  'jira.issues': { key: 'jira.issues', provider: 'jira', label: 'Jira issues', kind: 'issues', priority: 3 },
  'app_store.reviews': { key: 'app_store.reviews', provider: 'app_store', label: 'App Store reviews', kind: 'reviews', priority: 4 },
  'google_play.reviews': { key: 'google_play.reviews', provider: 'google_play', label: 'Google Play reviews', kind: 'reviews', priority: 4 },
  'ga4.search_usage': { key: 'ga4.search_usage', provider: 'ga4', label: 'Search usage', kind: 'metric', priority: 5 },
  releases: { key: 'releases', provider: 'multi', label: 'Releases', kind: 'releases', priority: 9 },
};

/** GA4 metrics to consult when investigating an area (the area's funnel metric first). */
export const AREA_METRICS: Record<Area, string[]> = {
  checkout: ['ga4.checkout_conversion', 'ga4.purchase_revenue'],
  signup: ['ga4.signup_conversion'],
  search: ['ga4.search_usage'],
  stability: ['ga4.checkout_conversion'],
  general: [],
};

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
    signals: [s('ga4.checkout_conversion'), s('ga4.purchase_revenue'), s('app_store.crash_free_sessions'), s('google_play.crash_free_sessions'), s('jira.issues', 'checkout'), s('app_store.reviews', 'checkout'), s('google_play.reviews', 'checkout'), s('releases')],
    example: 'Conversion, errors, releases, crash-free sessions, reviews',
  },
  {
    id: 'app_stability',
    name: 'App stability',
    description: 'Crash-free sessions on iOS and Android, crash bugs and reviews that mention crashes.',
    area: 'stability',
    sources: ['app_store', 'google_play', 'jira'],
    signals: [s('app_store.crash_free_sessions'), s('google_play.crash_free_sessions'), s('jira.issues', 'stability'), s('app_store.reviews', 'stability'), s('google_play.reviews', 'stability'), s('releases')],
    example: 'Crash-free sessions, crash bugs, releases',
  },
  {
    id: 'conversion',
    name: 'Conversion',
    description: 'Checkout and signup conversion in GA4, with releases as context.',
    area: '*',
    sources: ['ga4', 'jira', 'app_store', 'google_play'],
    signals: [s('ga4.checkout_conversion'), s('ga4.signup_conversion'), s('releases')],
    example: 'Checkout & signup conversion, releases',
  },
  {
    id: 'revenue',
    name: 'Revenue',
    description: 'Purchase revenue and checkout conversion.',
    area: 'checkout',
    sources: ['ga4', 'jira'],
    signals: [s('ga4.purchase_revenue'), s('ga4.checkout_conversion'), s('releases')],
    example: 'Purchase revenue, checkout conversion',
  },
  {
    id: 'customer_issues',
    name: 'Customer issues',
    description: 'New Jira bugs and negative app reviews across every product area.',
    area: '*',
    sources: ['jira', 'app_store', 'google_play'],
    signals: [s('jira.issues', '*'), s('app_store.reviews', '*'), s('google_play.reviews', '*')],
    example: 'Jira bugs, 1–2★ reviews',
  },
  {
    id: 'release_health',
    name: 'Release health',
    description: 'What changes after a release: crashes, reviews and new bugs.',
    area: 'stability',
    sources: ['app_store', 'google_play', 'jira'],
    signals: [s('releases'), s('app_store.crash_free_sessions'), s('google_play.crash_free_sessions'), s('jira.issues', '*'), s('app_store.reviews', '*'), s('google_play.reviews', '*')],
    example: 'Releases, crashes, reviews, bugs',
  },
  {
    id: 'signup_funnel',
    name: 'Signup funnel',
    description: 'Signup conversion and signup-related bugs.',
    area: 'signup',
    sources: ['ga4', 'jira'],
    signals: [s('ga4.signup_conversion'), s('jira.issues', 'signup'), s('releases')],
    example: 'Signup conversion, signup bugs',
  },
  {
    id: 'search_discovery',
    name: 'Search & discovery',
    description: 'Search usage and search bugs.',
    area: 'search',
    sources: ['ga4', 'jira'],
    signals: [s('ga4.search_usage'), s('jira.issues', 'search')],
    example: 'Search usage, search bugs',
  },
];

/** The templates offered in "What should I watch?" (spec order). */
export const WIZARD_TEMPLATES: WatchTemplateId[] = ['checkout_health', 'app_stability', 'conversion', 'revenue', 'customer_issues', 'release_health'];

export function watchFromTemplate(
  id: string,
  templateId: WatchTemplateId,
  overrides: Partial<Pick<Watch, 'name' | 'sources' | 'schedule' | 'notificationPolicy' | 'timezone' | 'severityThreshold'>> = {},
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
    signals: tpl.signals.filter((sig) => sig.key === 'releases' || sources.includes(SIGNALS[sig.key].provider as ProviderId)),
    schedule: overrides.schedule ?? { frequency: '30m', dailyAt: '07:00' },
    timezone: overrides.timezone ?? 'UTC',
    severityThreshold: overrides.severityThreshold ?? 'LOW',
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
