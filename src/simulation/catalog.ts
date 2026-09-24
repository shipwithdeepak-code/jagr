import type { MetricDefinition } from '@/domain/types';

/**
 * The simulated product: "Tempo", a subscription productivity app (web + iOS + Android)
 * that sells monthly/annual plans through a checkout with four payment methods.
 *
 * `base` is the historical mean for the overnight window; `cv` is the coefficient of variation
 * observed night-to-night. Both feed the simulated analytics warehouse.
 */
export interface CatalogMetric extends MetricDefinition {
  base: number;
  cv: number;
}

export const METRIC_CATALOG: CatalogMetric[] = [
  // ── Engagement ──
  { id: 'dau', name: 'Active users', description: 'Unique active users per 30-minute bucket', category: 'engagement', unit: 'count', badDirection: 'down', tier: 1, area: 'engagement', surface: 'core', base: 18400, cv: 0.012 },
  { id: 'sessions', name: 'Sessions', description: 'Sessions started per 30-minute bucket', category: 'engagement', unit: 'count', badDirection: 'down', tier: 2, area: 'engagement', surface: 'core', base: 26100, cv: 0.012 },
  { id: 'session_length', name: 'Avg. session length', description: 'Mean session duration', category: 'engagement', unit: 'minutes', badDirection: 'down', tier: 3, area: 'engagement', surface: 'core', base: 7.4, cv: 0.012 },
  { id: 'feature_search', name: 'Feature usage — Search', description: 'Users running at least one search', category: 'engagement', unit: 'count', badDirection: 'down', tier: 3, area: 'engagement', surface: 'core', base: 4210, cv: 0.014 },
  { id: 'feature_export', name: 'Feature usage — Report export', description: 'Users exporting a report (PDF/CSV)', category: 'engagement', unit: 'count', badDirection: 'down', tier: 3, area: 'engagement', surface: 'reports', base: 1380, cv: 0.014 },
  { id: 'feature_collections', name: 'Feature usage — Collections', description: 'Users creating or editing a collection', category: 'engagement', unit: 'count', badDirection: 'down', tier: 3, area: 'engagement', surface: 'core', base: 2940, cv: 0.014 },
  { id: 'feature_shared', name: 'Feature usage — Shared workspaces', description: 'Users active in a shared workspace', category: 'engagement', unit: 'count', badDirection: 'down', tier: 3, area: 'engagement', surface: 'core', base: 1720, cv: 0.014 },

  // ── Activation ──
  { id: 'activation_rate', name: 'Activation rate', description: 'New users reaching the "first project created" milestone within 24h', category: 'activation', unit: 'percent', badDirection: 'down', tier: 1, area: 'activation', surface: 'onboarding', drivers: ['activation_ios', 'activation_android', 'activation_web', 'onboarding_completion'], base: 38.4, cv: 0.008 },
  { id: 'activation_ios', name: 'Activation rate — iOS', description: 'Activation rate for iOS signups', category: 'activation', unit: 'percent', badDirection: 'down', tier: 2, area: 'activation', surface: 'onboarding', platform: 'ios', base: 36.0, cv: 0.008 },
  { id: 'activation_android', name: 'Activation rate — Android', description: 'Activation rate for Android signups', category: 'activation', unit: 'percent', badDirection: 'down', tier: 2, area: 'activation', surface: 'onboarding', platform: 'android', base: 39.1, cv: 0.008 },
  { id: 'activation_web', name: 'Activation rate — Web', description: 'Activation rate for web signups', category: 'activation', unit: 'percent', badDirection: 'down', tier: 2, area: 'activation', surface: 'onboarding', platform: 'web', base: 40.2, cv: 0.008 },
  { id: 'signups', name: 'New signups', description: 'Accounts created per 30-minute bucket', category: 'activation', unit: 'count', badDirection: 'down', tier: 2, area: 'growth', surface: 'onboarding', base: 612, cv: 0.01 },
  { id: 'onboarding_completion', name: 'Onboarding completion', description: 'Signups completing the onboarding checklist', category: 'activation', unit: 'percent', badDirection: 'down', tier: 2, area: 'activation', surface: 'onboarding', base: 71.5, cv: 0.008 },

  // ── Retention ──
  { id: 'd1_retention', name: 'D1 retention', description: 'Users returning the day after signup', category: 'retention', unit: 'percent', badDirection: 'down', tier: 1, area: 'growth', surface: 'core', base: 44.2, cv: 0.01 },
  { id: 'd7_retention', name: 'D7 retention', description: 'Users returning 7 days after signup', category: 'retention', unit: 'percent', badDirection: 'down', tier: 1, area: 'growth', surface: 'core', base: 27.9, cv: 0.01 },
  { id: 'd30_retention', name: 'D30 retention', description: 'Users returning 30 days after signup', category: 'retention', unit: 'percent', badDirection: 'down', tier: 2, area: 'growth', surface: 'core', base: 16.4, cv: 0.01 },
  { id: 'reactivations', name: 'Reactivated users', description: 'Dormant users returning', category: 'retention', unit: 'count', badDirection: 'down', tier: 3, area: 'growth', surface: 'core', base: 342, cv: 0.012 },

  // ── Conversion ──
  { id: 'subscription_conversion', name: 'Subscription conversion', description: 'Visitors to paid plans who complete a subscription', category: 'conversion', unit: 'percent', badDirection: 'down', tier: 1, area: 'growth', surface: 'checkout', drivers: ['checkout_conversion', 'checkout_sessions', 'pricing_to_checkout'], base: 7.71, cv: 0.012 },
  { id: 'checkout_conversion', name: 'Checkout completion', description: 'Checkout sessions that end in a successful payment', category: 'conversion', unit: 'percent', badDirection: 'down', tier: 1, area: 'payments', surface: 'checkout', drivers: ['payment_failure_rate', 'checkout_api_latency'], base: 62.0, cv: 0.01 },
  { id: 'checkout_sessions', name: 'Checkout traffic', description: 'Checkout sessions started per 30-minute bucket', category: 'conversion', unit: 'count', badDirection: 'down', tier: 2, area: 'growth', surface: 'checkout', base: 184, cv: 0.012 },
  { id: 'pricing_to_checkout', name: 'Pricing page → checkout', description: 'Pricing page visitors who start checkout', category: 'conversion', unit: 'percent', badDirection: 'down', tier: 2, area: 'growth', surface: 'checkout', base: 23.6, cv: 0.01 },
  { id: 'trial_start_rate', name: 'Trial start rate', description: 'Signups starting a free trial', category: 'conversion', unit: 'percent', badDirection: 'down', tier: 2, area: 'growth', surface: 'onboarding', base: 12.3, cv: 0.01 },
  { id: 'trial_to_paid', name: 'Trial → paid', description: 'Trials converting to paid', category: 'conversion', unit: 'percent', badDirection: 'down', tier: 2, area: 'growth', surface: 'billing', base: 41.8, cv: 0.01 },
  { id: 'upgrade_rate', name: 'Plan upgrade rate', description: 'Paid users upgrading plan', category: 'conversion', unit: 'percent', badDirection: 'down', tier: 3, area: 'growth', surface: 'billing', base: 2.9, cv: 0.012 },

  // ── Revenue ──
  { id: 'gross_revenue', name: 'Gross revenue', description: 'New subscriptions plus renewals, per 30-minute bucket', category: 'revenue', unit: 'currency', badDirection: 'down', tier: 1, area: 'growth', surface: 'billing', base: 14800, cv: 0.02 },
  { id: 'arpu_new', name: 'ARPU (new subscribers)', description: 'Average first-month revenue per new subscriber', category: 'revenue', unit: 'currency', badDirection: 'down', tier: 2, area: 'growth', surface: 'billing', base: 11.9, cv: 0.012 },
  { id: 'refund_rate', name: 'Refund rate', description: 'Share of payments refunded', category: 'revenue', unit: 'percent', badDirection: 'up', tier: 2, area: 'payments', surface: 'billing', base: 0.8, cv: 0.03 },
  { id: 'cancellations', name: 'Cancellations', description: 'Subscriptions cancelled per 30-minute bucket', category: 'revenue', unit: 'count', badDirection: 'up', tier: 2, area: 'growth', surface: 'billing', base: 41, cv: 0.03 },

  // ── Payments ──
  { id: 'payment_failure_rate', name: 'Payment failure rate', description: 'Failed payment attempts across all methods', category: 'payments', unit: 'percent', badDirection: 'up', tier: 1, area: 'payments', surface: 'checkout', base: 2.4, cv: 0.03 },
  { id: 'chargeback_rate', name: 'Chargeback rate', description: 'Payments disputed by the cardholder', category: 'payments', unit: 'percent', badDirection: 'up', tier: 3, area: 'payments', surface: 'billing', base: 0.12, cv: 0.03 },
  { id: 'payment_retry_success', name: 'Payment retry success', description: 'Failed payments recovered on retry', category: 'payments', unit: 'percent', badDirection: 'down', tier: 3, area: 'payments', surface: 'billing', base: 58.0, cv: 0.01 },

  // ── Support ──
  { id: 'support_volume', name: 'Support volume', description: 'Tickets opened per 30-minute bucket', category: 'support', unit: 'count', badDirection: 'up', tier: 2, area: 'support', surface: 'support', base: 14, cv: 0.06 },
  { id: 'first_response', name: 'First response time', description: 'Median minutes to first agent response', category: 'support', unit: 'minutes', badDirection: 'up', tier: 3, area: 'support', surface: 'support', base: 42, cv: 0.04 },
  { id: 'csat', name: 'CSAT', description: 'Average satisfaction rating (1–5)', category: 'support', unit: 'score', badDirection: 'down', tier: 3, area: 'support', surface: 'support', base: 4.5, cv: 0.01 },

  // ── Reliability ──
  { id: 'api_error_rate', name: 'API error rate', description: '5xx responses across public API', category: 'reliability', unit: 'percent', badDirection: 'up', tier: 1, area: 'platform', surface: 'platform', base: 0.31, cv: 0.04 },
  { id: 'api_latency_p95', name: 'API latency p95', description: '95th percentile API latency', category: 'reliability', unit: 'ms', badDirection: 'up', tier: 2, area: 'platform', surface: 'platform', base: 420, cv: 0.04 },
  { id: 'checkout_api_latency', name: 'Checkout API latency p95', description: '95th percentile latency of checkout endpoints', category: 'reliability', unit: 'ms', badDirection: 'up', tier: 2, area: 'payments', surface: 'checkout', base: 610, cv: 0.04 },
  { id: 'crash_free_ios', name: 'Crash-free sessions — iOS', description: 'iOS sessions without a crash', category: 'reliability', unit: 'percent', badDirection: 'down', tier: 2, area: 'platform', surface: 'platform', platform: 'ios', base: 99.6, cv: 0.001 },
  { id: 'crash_free_android', name: 'Crash-free sessions — Android', description: 'Android sessions without a crash', category: 'reliability', unit: 'percent', badDirection: 'down', tier: 2, area: 'platform', surface: 'platform', platform: 'android', base: 99.4, cv: 0.001 },
  { id: 'web_lcp', name: 'Web LCP p75', description: 'Largest contentful paint, 75th percentile', category: 'reliability', unit: 'ms', badDirection: 'up', tier: 3, area: 'platform', surface: 'platform', platform: 'web', base: 2100, cv: 0.04 },
  { id: 'email_delivery', name: 'Email delivery rate', description: 'Transactional emails delivered', category: 'reliability', unit: 'percent', badDirection: 'down', tier: 3, area: 'platform', surface: 'platform', base: 99.1, cv: 0.001 },
  { id: 'webhook_success', name: 'Webhook delivery success', description: 'Outbound webhooks delivered on first attempt', category: 'reliability', unit: 'percent', badDirection: 'down', tier: 3, area: 'platform', surface: 'platform', base: 99.7, cv: 0.001 },
];

export function metricDefinition(m: CatalogMetric): MetricDefinition {
  // Strip simulation-only fields so the agent never sees `base`/`cv`.
  const { base: _base, cv: _cv, ...def } = m;
  return def;
}
