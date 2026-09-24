import type { Integration, Task, Team, WorkspaceSettings } from './types';

export const TEAMS: Team[] = [
  { id: 'payments-eng', name: 'Payments Engineering', keyPrefix: 'PAY', onCall: 'payments-oncall' },
  { id: 'growth', name: 'Growth', keyPrefix: 'GRO', onCall: 'growth-oncall' },
  { id: 'product', name: 'Product', keyPrefix: 'PRD', onCall: 'product-oncall' },
  { id: 'cx', name: 'CX', keyPrefix: 'CX', onCall: 'cx-escalations' },
  { id: 'platform', name: 'Platform Engineering', keyPrefix: 'PLAT', onCall: 'platform-oncall' },
];

export const AREA_LABELS: Record<string, string> = {
  payments: 'Payments',
  growth: 'Growth',
  activation: 'Activation',
  support: 'Support',
  platform: 'Platform',
  engagement: 'Engagement',
};

export function defaultSettings(): WorkspaceSettings {
  return {
    watch: {
      activation: true,
      conversion: true,
      retention: true,
      revenue: true,
      payment_failures: true,
      support_volume: true,
      engagement: true,
      reliability: true,
      releases: true,
      experiments: true,
    },
    thresholds: {
      activation: 4,
      conversion: 5,
      retention: 5,
      revenue: 10,
      payments: 15,
      support: 25,
      engagement: 8,
      reliability: 20,
    },
    owners: [
      { area: 'payments', teamId: 'payments-eng' },
      { area: 'growth', teamId: 'growth' },
      { area: 'activation', teamId: 'product' },
      { area: 'support', teamId: 'cx' },
      { area: 'platform', teamId: 'platform' },
      { area: 'engagement', teamId: 'product' },
    ],
    autonomy: {
      observe: true,
      investigate: true,
      recommend: true,
      createTasks: true,
      autoFileMinSeverity: 'critical',
      createIncidents: true,
      gates: {
        production_changes: 'require_approval',
        customer_communications: 'require_approval',
        payments: 'require_approval',
        pricing: 'require_approval',
        refunds: 'require_approval',
      },
    },
    escalation: {
      critical: 'immediate',
      high: 'morning_brief',
      medium: 'daily_digest',
      low: 'none',
    },
    schedule: { start: '18:00', end: '08:00', briefAt: '08:00' },
    criticalEscalation: true,
    integrations: {
      analytics: 'connected',
      payments: 'connected',
      github: 'connected',
      support: 'connected',
      experiments: 'connected',
      issue_tracker: 'connected',
      notifications: 'connected',
    },
  };
}

export const INTEGRATIONS: Omit<Integration, 'status'>[] = [
  { kind: 'analytics', name: 'Product Analytics', adapter: 'AnalyticsAdapter', mode: 'simulation', capabilities: ['42 metric series, 30-min buckets', '28-night historical baselines', 'Metric tree (drivers)'], productionCandidates: ['Amplitude', 'Mixpanel', 'PostHog'] },
  { kind: 'payments', name: 'Payments', adapter: 'PaymentsAdapter', mode: 'simulation', capabilities: ['Per-provider attempts & failures', 'Error-code breakdown', 'Provider status pages'], productionCandidates: ['Stripe', 'Adyen'] },
  { kind: 'github', name: 'GitHub', adapter: 'GitHubAdapter', mode: 'simulation', capabilities: ['Production deployments', 'Merged pull requests & changed files'], productionCandidates: ['GitHub'] },
  { kind: 'support', name: 'Support', adapter: 'SupportAdapter', mode: 'simulation', capabilities: ['Ticket search by time window', 'Subject & body text'], productionCandidates: ['Zendesk', 'Intercom'] },
  { kind: 'experiments', name: 'Experiments', adapter: 'ExperimentAdapter', mode: 'simulation', capabilities: ['Active experiments', 'Allocation changes', 'Variant results'], productionCandidates: ['Statsig', 'LaunchDarkly'] },
  { kind: 'issue_tracker', name: 'Issue Tracker', adapter: 'IssueTrackerAdapter', mode: 'simulation', capabilities: ['Create issues & incident drafts', 'De-duplicate by fingerprint', 'Append evidence as comments'], productionCandidates: ['Linear', 'Jira'] },
  { kind: 'notifications', name: 'On-call notifications', adapter: 'NotificationAdapter', mode: 'simulation', capabilities: ['Notify on-call rotation for critical findings'], productionCandidates: ['Slack', 'PagerDuty'] },
];

export const SOURCE_LABELS: Record<string, string> = {
  analytics: 'Analytics',
  payments: 'Payments',
  github: 'GitHub',
  support: 'Support',
  experiments: 'Experiments',
  issue_tracker: 'Issue tracker',
  notifications: 'Notifications',
};

/** Existing work in the simulated tracker, so the Tasks screen reflects a real team's backlog. */
export function seedTasks(): Task[] {
  const base = { tracker: 'simulated' as const, comments: [] };
  return [
    {
      ...base,
      id: 'PAY-279',
      kind: 'task',
      title: 'Retry Apple Pay authorisation on gateway timeout',
      priority: 'P2',
      ownerTeamId: 'payments-eng',
      createdBy: 'human',
      createdAt: '2026-09-21T10:14:00.000Z',
      status: 'in_progress',
      evidenceSourceCount: 1,
      description: {
        problem: 'About 0.4% of Apple Pay attempts time out at the gateway and are not retried.',
        impact: 'Small but persistent loss of Apple Pay conversions.',
        evidence: ['Gateway logs show timeouts clustered at peak hours'],
        hypothesis: 'Missing idempotent retry on gateway timeout.',
        confidence: 'Filed by a human',
        nextStep: 'Add a single idempotent retry with a 2s budget.',
        sources: ['payments'],
      },
    },
    {
      ...base,
      id: 'PLAT-88',
      kind: 'task',
      title: 'Webhook retries elevated for EU customers',
      priority: 'P2',
      ownerTeamId: 'platform',
      createdBy: 'nightwatch',
      createdAt: '2026-09-19T08:00:00.000Z',
      status: 'in_progress',
      evidenceSourceCount: 2,
      description: {
        problem: 'First-attempt webhook delivery fell from 99.7% to 98.9% for EU workspaces.',
        impact: 'Integrations receive events late; no customer tickets yet.',
        evidence: ['Webhook delivery success −0.8 pts (EU only)', 'Latency spike on eu-west egress proxy'],
        hypothesis: 'Egress proxy saturation in eu-west.',
        confidence: '72%',
        nextStep: 'Scale egress proxy pool and confirm recovery.',
        sources: ['analytics', 'github'],
      },
    },
    {
      ...base,
      id: 'PRD-402',
      kind: 'task',
      title: 'Review onboarding checklist copy',
      priority: 'P3',
      ownerTeamId: 'product',
      createdBy: 'human',
      createdAt: '2026-09-22T15:30:00.000Z',
      status: 'todo',
      evidenceSourceCount: 0,
      description: {
        problem: 'Checklist step 3 has the lowest completion of the checklist.',
        impact: 'Minor activation friction.',
        evidence: [],
        hypothesis: 'Copy is unclear about what "connect a calendar" does.',
        confidence: 'Filed by a human',
        nextStep: 'Test two alternative copy options.',
        sources: [],
      },
    },
    {
      ...base,
      id: 'GRO-117',
      kind: 'task',
      title: 'Pricing page → checkout dip after badge test',
      priority: 'P2',
      ownerTeamId: 'growth',
      createdBy: 'nightwatch',
      createdAt: '2026-09-16T08:00:00.000Z',
      status: 'done',
      evidenceSourceCount: 2,
      description: {
        problem: 'Pricing page → checkout fell 6.3% overnight.',
        impact: 'Fewer checkout starts; conversion unchanged downstream.',
        evidence: ['Pricing → checkout −6.3%', 'Experiment pricing_badge ramped to 50% at 21:00'],
        hypothesis: 'pricing_badge variant reduced clicks on the annual plan.',
        confidence: '81%',
        nextStep: 'Growth to review the variant.',
        sources: ['analytics', 'experiments'],
      },
    },
    {
      ...base,
      id: 'PAY-283',
      kind: 'task',
      title: 'Upgrade Klarna SDK to 2.14',
      priority: 'P3',
      ownerTeamId: 'payments-eng',
      createdBy: 'human',
      createdAt: '2026-09-09T11:00:00.000Z',
      status: 'done',
      evidenceSourceCount: 0,
      description: {
        problem: 'Klarna SDK 2.11 is deprecated at the end of the quarter.',
        impact: 'None yet.',
        evidence: [],
        hypothesis: 'n/a',
        confidence: 'Filed by a human',
        nextStep: 'Upgrade and run the payments regression suite.',
        sources: [],
      },
    },
  ];
}

/** Cumulative workspace history before tonight (previous 37 nights in the demo workspace). */
export const HISTORICAL_STATS = {
  runs: 37,
  signalsMonitored: 37 * 42,
  anomaliesDetected: 61,
  investigationsCompleted: 44,
  tasksCreated: 19,
  recommendations: 52,
  actionsExecuted: 63,
  approvalsRequested: 11,
  falseAlerts: 3,
  totalInvestigationSeconds: 44 * 236,
};
