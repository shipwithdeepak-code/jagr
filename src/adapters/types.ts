/**
 * Adapter contracts. The agent only ever talks to these interfaces.
 *
 * Today every adapter is backed by deterministic simulation data (src/simulation).
 * A production connector (Amplitude, Stripe, Linear, …) implements the same interface
 * and is swapped in via `AdapterSet` — the orchestrator does not change.
 */
import type {
  ISODateTime,
  MetricBaseline,
  MetricDefinition,
  SeriesPoint,
  Task,
  TaskComment,
  TaskDraft,
} from '@/domain/types';

export class AdapterUnavailableError extends Error {
  constructor(public readonly source: string, message = `${source} adapter is unavailable`) {
    super(message);
    this.name = 'AdapterUnavailableError';
  }
}

export interface TimeWindow {
  start: ISODateTime;
  end: ISODateTime;
}

// ── Product analytics (Amplitude / Mixpanel / PostHog) ───────
export interface AnalyticsAdapter {
  readonly name: string;
  listMetrics(): Promise<MetricDefinition[]>;
  /** Series of 30-minute buckets. Only buckets that completed before `asOf` are returned. */
  getSeries(metricId: string, window: TimeWindow): Promise<SeriesPoint[]>;
  /** Historical baseline for the same hours on previous nights. */
  getBaseline(metricId: string): Promise<MetricBaseline>;
}

// ── Payments (Stripe / Adyen / provider dashboards) ──────────
export type PaymentProvider = 'klarna' | 'paypal' | 'card' | 'apple_pay';

export interface ProviderStats {
  provider: PaymentProvider;
  label: string;
  attempts: number;
  failures: number;
  errorRate: number;
  baselineErrorRate: number;
  baselineStdDev: number;
  errorCodes: Record<string, number>;
  baselineErrorCodes: Record<string, number>;
}

export interface ProviderStatus {
  provider: PaymentProvider;
  status: 'operational' | 'degraded' | 'outage';
  checkedAt: ISODateTime;
  message: string;
}

export interface PaymentsAdapter {
  readonly name: string;
  getProviderBreakdown(window: TimeWindow): Promise<ProviderStats[]>;
  getProviderStatus(provider: PaymentProvider, asOf: ISODateTime): Promise<ProviderStatus>;
}

// ── GitHub / deploys ─────────────────────────────────────────
export interface Deployment {
  id: string;
  version: string;
  services: string[];
  environment: 'production';
  deployedAt: ISODateTime;
  pullRequests: number[];
  platform: 'web' | 'ios' | 'android' | 'backend';
}

export interface PullRequest {
  number: number;
  title: string;
  mergedAt: ISODateTime;
  author: string;
  files: string[];
  labels: string[];
}

export interface GitHubAdapter {
  readonly name: string;
  listDeployments(window: TimeWindow): Promise<Deployment[]>;
  getPullRequests(numbers: number[]): Promise<PullRequest[]>;
}

// ── Support (Zendesk / Intercom) ─────────────────────────────
export interface SupportTicket {
  id: string;
  createdAt: ISODateTime;
  subject: string;
  body: string;
  channel: 'email' | 'chat' | 'in_app';
  plan: string;
}

export interface SupportAdapter {
  readonly name: string;
  searchTickets(window: TimeWindow): Promise<SupportTicket[]>;
}

// ── Experiments (Statsig / LaunchDarkly / Optimizely) ────────
export interface ExperimentChange {
  at: ISODateTime;
  description: string;
  allocation: number;
}

export interface ExperimentVariantResult {
  variant: string;
  users: number;
  metricId: string;
  value: number;
}

export interface Experiment {
  id: string;
  name: string;
  surface: MetricDefinition['surface'];
  platform?: 'ios' | 'android' | 'web';
  status: 'running' | 'paused' | 'concluded';
  startedAt: ISODateTime;
  owner: string;
  changes: ExperimentChange[];
  results: ExperimentVariantResult[];
}

export interface ExperimentAdapter {
  readonly name: string;
  listActiveExperiments(asOf: ISODateTime): Promise<Experiment[]>;
}

// ── Issue tracker (Linear / Jira) ────────────────────────────
export interface IssueTrackerAdapter {
  readonly name: string;
  readonly label: string;
  createIssue(draft: TaskDraft, at: ISODateTime): Promise<Task>;
  findOpenByFingerprint(fingerprint: string): Promise<Task | undefined>;
  addComment(issueId: string, comment: TaskComment): Promise<Task>;
  updateDescription(issueId: string, description: TaskDraft['description'], evidenceSourceCount: number): Promise<Task>;
  list(): Promise<Task[]>;
}

// ── Notifications (Slack / PagerDuty) ────────────────────────
export interface NotificationAdapter {
  readonly name: string;
  notifyOnCall(rotation: string, message: string, at: ISODateTime): Promise<{ id: string }>;
}

export interface AdapterSet {
  analytics: AnalyticsAdapter;
  payments: PaymentsAdapter;
  github: GitHubAdapter;
  support: SupportAdapter;
  experiments: ExperimentAdapter;
  issueTracker: IssueTrackerAdapter;
  notifications: NotificationAdapter;
}
