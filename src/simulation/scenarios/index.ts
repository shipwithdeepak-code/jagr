import type { Experiment, SupportTicket } from '@/adapters/types';
import { addMinutes } from '@/lib/time';
import {
  at,
  backgroundReleases,
  backgroundTickets,
  buildScenario,
  checkoutCopyExperiment,
  DEMO_NIGHT_START,
  type ScenarioDataset,
} from '../scenario';

/*
 * Bucket indexes: 0 = 18:00, 1 = 18:30, 2 = 19:00 … 8 = 22:00 … 12 = 00:00 … 16 = 02:00 … 27 = 07:30.
 */

const S = DEMO_NIGHT_START;

function onboardingExperiment(rampAt: string | null): Experiment {
  const started = addMinutes(S, -3 * 24 * 60);
  return {
    id: 'exp-onboarding-v3',
    name: 'onboarding_v3',
    surface: 'onboarding',
    platform: 'ios',
    status: 'running',
    startedAt: started,
    owner: 'Growth',
    changes: [
      { at: started, description: 'Launched variant B to 10% of iOS signups', allocation: 10 },
      ...(rampAt ? [{ at: rampAt, description: 'Ramped variant B from 10% to 50% (scheduled ramp)', allocation: 50 }] : []),
    ],
    results: rampAt
      ? [
          { variant: 'control', users: 2310, metricId: 'activation_ios', value: 36.0 },
          { variant: 'variant_b', users: 2284, metricId: 'activation_ios', value: 31.4 },
        ]
      : [
          { variant: 'control', users: 4150, metricId: 'activation_ios', value: 36.1 },
          { variant: 'variant_b', users: 460, metricId: 'activation_ios', value: 35.4 },
        ],
  };
}

const CHECKOUT_TICKETS: SupportTicket[] = [
  { id: 'T-8812', createdAt: at('19:05'), subject: 'Klarna payment keeps failing at checkout', body: 'Tried to subscribe to the annual plan with Klarna three times, it errors every time.', channel: 'chat', plan: 'Free' },
  { id: 'T-8815', createdAt: at('19:40'), subject: "Can't complete purchase with Pay Later", body: 'After choosing Pay later the page says something went wrong. Card works I guess but I wanted to split it.', channel: 'in_app', plan: 'Free' },
  { id: 'T-8819', createdAt: at('21:12'), subject: 'Checkout error "something went wrong"', body: 'Checkout fails right at the end. Tried twice.', channel: 'email', plan: 'Trial' },
  { id: 'T-8826', createdAt: at('23:48'), subject: 'Klarna declined but my bank says fine', body: 'Klarna option shows an error, my bank sees no attempt at all.', channel: 'email', plan: 'Trial' },
  { id: 'T-8834', createdAt: at('02:15'), subject: 'Payment failed twice while trying to subscribe', body: 'Both attempts failed at the payment step.', channel: 'chat', plan: 'Free' },
  { id: 'T-8841', createdAt: at('06:02'), subject: 'Is the Klarna option broken?', body: 'Klarna checkout just spins and then errors.', channel: 'in_app', plan: 'Trial' },
  { id: 'T-8847', createdAt: at('07:21'), subject: 'Klarna checkout error on annual plan', body: 'Cannot buy the annual plan with Klarna, error on the last step.', channel: 'email', plan: 'Free' },
];

/** The demo night. Release v4.8.1 ships at 18:42 with a Klarna serialization change. */
export function checkoutRegressionScenario(): ScenarioDataset {
  const bg = backgroundReleases(S);
  return buildScenario({
    id: 'checkout-regression',
    name: 'Checkout regression after release',
    seed: 4811,
    effects: {
      subscription_conversion: [{ from: 1, to: 1, changePct: -4 }, { from: 2, changePct: -11.8 }],
      checkout_conversion: [{ from: 1, to: 1, changePct: -5 }, { from: 2, changePct: -14 }],
      payment_failure_rate: [{ from: 1, to: 1, changePct: 120 }, { from: 2, changePct: 400 }],
      gross_revenue: [{ from: 2, changePct: -1.3 }],
      activation_ios: [{ from: 8, changePct: -6.4 }],
      activation_rate: [{ from: 8, changePct: -2.1 }],
      feature_export: [{ from: 12, changePct: -9.2 }],
      dau: [{ from: 16, to: 16, changePct: -12 }],
    },
    providerEffects: {
      klarna: [
        { from: 1, to: 1, errorRate: 11.8, errorCodes: { invalid_order_lines: 79, timeout: 12, declined: 9 } },
        { from: 2, errorRate: 34.2, errorCodes: { invalid_order_lines: 88, timeout: 6, declined: 6 } },
      ],
    },
    deployments: [
      ...bg.deployments,
      { id: 'dep-481', version: 'v4.8.1', services: ['web-app', 'payments-service'], environment: 'production', deployedAt: at('18:42'), pullRequests: [4127, 4129, 4131], platform: 'web' },
    ],
    pullRequests: [
      ...bg.pullRequests,
      { number: 4127, title: 'Refactor Klarna order-line serialization for multi-currency', mergedAt: at('17:58'), author: 'd.moreau', files: ['src/payments/klarna/orderLines.ts', 'src/payments/klarna/session.ts', 'src/payments/klarna/orderLines.test.ts'], labels: ['payments', 'klarna'] },
      { number: 4129, title: 'Bump analytics SDK to 3.4.2', mergedAt: at('17:31'), author: 's.ito', files: ['package.json', 'src/analytics/client.ts'], labels: ['dependencies'] },
      { number: 4131, title: 'Pricing page: annual plan badge copy', mergedAt: at('18:05'), author: 'l.haddad', files: ['src/marketing/pricing/PlanCard.tsx'], labels: ['marketing'] },
    ],
    tickets: [...backgroundTickets(S), ...CHECKOUT_TICKETS],
    experiments: [checkoutCopyExperiment(S), onboardingExperiment(at('22:00'))],
  });
}

/** Nothing happens. The agent should stay quiet. */
export function normalNightScenario(): ScenarioDataset {
  const bg = backgroundReleases(S);
  return buildScenario({
    id: 'normal-night',
    name: 'Normal overnight activity',
    seed: 1207,
    deployments: bg.deployments,
    pullRequests: bg.pullRequests,
    tickets: backgroundTickets(S),
    experiments: [checkoutCopyExperiment(S), onboardingExperiment(null)],
  });
}

/** Checkout completion dips for one hour, then recovers on its own. */
export function temporaryFluctuationScenario(): ScenarioDataset {
  const bg = backgroundReleases(S);
  return buildScenario({
    id: 'temporary-fluctuation',
    name: 'Temporary fluctuation',
    seed: 3302,
    effects: {
      checkout_conversion: [{ from: 10, to: 10, changePct: -9 }],
      subscription_conversion: [{ from: 10, to: 10, changePct: -7 }],
    },
    deployments: bg.deployments,
    pullRequests: bg.pullRequests,
    tickets: backgroundTickets(S),
    experiments: [checkoutCopyExperiment(S), onboardingExperiment(null)],
  });
}

/** v5.0.0 ships at 23:10 and breaks the API for everyone. */
export function majorIncidentScenario(): ScenarioDataset {
  const bg = backgroundReleases(S);
  const incidentTickets: SupportTicket[] = Array.from({ length: 46 }, (_, i) => {
    const subjects = [
      'App shows "server error" everywhere',
      'Cannot load my projects',
      'Checkout fails with error 500',
      'Everything is down?',
      'Payment page not loading',
      'Sync failing on iOS',
    ];
    return {
      id: `T-${9000 + i}`,
      createdAt: addMinutes(at('23:25'), i * 9),
      subject: subjects[i % subjects.length],
      body: 'Getting errors since last night, nothing loads properly.',
      channel: i % 3 === 0 ? 'chat' : 'email',
      plan: i % 2 === 0 ? 'Pro' : 'Free',
    };
  });
  const allProviders = { errorRate: 21, errorCodes: { upstream_5xx: 81, timeout: 17, declined: 2 } };
  return buildScenario({
    id: 'major-incident',
    name: 'Major production incident',
    seed: 5005,
    effects: {
      api_error_rate: [{ from: 10, changePct: 2900 }],
      api_latency_p95: [{ from: 10, changePct: 160 }],
      checkout_api_latency: [{ from: 10, changePct: 140 }],
      checkout_conversion: [{ from: 10, changePct: -38 }],
      subscription_conversion: [{ from: 10, changePct: -35 }],
      payment_failure_rate: [{ from: 10, changePct: 700 }],
      dau: [{ from: 10, changePct: -22 }],
      sessions: [{ from: 10, changePct: -19 }],
      gross_revenue: [{ from: 10, changePct: -24 }],
      support_volume: [{ from: 11, changePct: 180 }],
    },
    providerEffects: {
      card: [{ from: 10, ...allProviders }],
      klarna: [{ from: 10, ...allProviders }],
      paypal: [{ from: 10, ...allProviders }],
      apple_pay: [{ from: 10, ...allProviders }],
    },
    deployments: [
      ...bg.deployments,
      { id: 'dep-500', version: 'v5.0.0', services: ['api', 'web-app', 'payments-service', 'sync-service'], environment: 'production', deployedAt: at('23:10'), pullRequests: [4150, 4152], platform: 'backend' },
    ],
    pullRequests: [
      ...bg.pullRequests,
      { number: 4150, title: 'Migrate API gateway to new connection pool', mergedAt: at('22:31'), author: 'a.varga', files: ['services/api/gateway/pool.ts', 'services/api/gateway/config.ts'], labels: ['platform', 'infra'] },
      { number: 4152, title: 'Drop legacy session table', mergedAt: at('22:48'), author: 'a.varga', files: ['services/api/db/migrations/0412_drop_sessions.sql'], labels: ['platform', 'database'] },
    ],
    tickets: [...backgroundTickets(S), ...incidentTickets],
    experiments: [checkoutCopyExperiment(S), onboardingExperiment(null)],
  });
}

/** Report exports drift down with nothing to explain it — the agent must say so. */
export function insufficientEvidenceScenario(): ScenarioDataset {
  const bg = backgroundReleases(S);
  return buildScenario({
    id: 'insufficient-evidence',
    name: 'Unexplained decline',
    seed: 6161,
    effects: { feature_export: [{ from: 12, changePct: -9.2 }] },
    deployments: bg.deployments,
    pullRequests: bg.pullRequests,
    tickets: backgroundTickets(S),
    experiments: [checkoutCopyExperiment(S), onboardingExperiment(null)],
  });
}

export type ScenarioId = 'checkout-regression' | 'normal-night' | 'temporary-fluctuation' | 'major-incident' | 'insufficient-evidence';

export const SCENARIOS: Record<ScenarioId, () => ScenarioDataset> = {
  'checkout-regression': checkoutRegressionScenario,
  'normal-night': normalNightScenario,
  'temporary-fluctuation': temporaryFluctuationScenario,
  'major-incident': majorIncidentScenario,
  'insufficient-evidence': insufficientEvidenceScenario,
};
