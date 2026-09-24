import {
  AdapterUnavailableError,
  type AdapterSet,
  type AnalyticsAdapter,
  type ExperimentAdapter,
  type GitHubAdapter,
  type IssueTrackerAdapter,
  type NotificationAdapter,
  type PaymentsAdapter,
  type ProviderStats,
  type SupportAdapter,
  type TimeWindow,
} from '@/adapters/types';
import type { SourceKind, Task, TaskComment, TaskDraft, IntegrationStatus } from '@/domain/types';
import { addMinutes, BUCKET_MINUTES, isBefore, isWithin } from '@/lib/time';
import type { ScenarioDataset } from './scenario';

/**
 * Simulation adapters. Each one reads the scenario's raw data and behaves like the real API would:
 * windowed queries, only data that exists "as of" the query time, and failures when unavailable.
 */

type Availability = Partial<Record<SourceKind, IntegrationStatus>>;

function guard(availability: Availability, source: SourceKind, name: string) {
  if (availability[source] === 'unavailable') throw new AdapterUnavailableError(name);
}

function bucketEnd(t: string) {
  return addMinutes(t, BUCKET_MINUTES);
}

export function createSimulatedAnalytics(ds: ScenarioDataset, availability: Availability = {}): AnalyticsAdapter {
  const name = 'Product analytics (simulation)';
  return {
    name,
    async listMetrics() {
      guard(availability, 'analytics', name);
      return ds.metrics;
    },
    async getSeries(metricId, window) {
      guard(availability, 'analytics', name);
      const s = ds.series[metricId];
      if (!s) throw new Error(`Unknown metric ${metricId}`);
      // Only completed buckets inside the window.
      return s.filter((p) => !isBefore(p.t, window.start) && !isBefore(window.end, bucketEnd(p.t)));
    },
    async getBaseline(metricId) {
      guard(availability, 'analytics', name);
      const b = ds.baselines[metricId];
      if (!b) throw new Error(`No baseline for ${metricId}`);
      return b;
    },
  };
}

export function createSimulatedPayments(ds: ScenarioDataset, availability: Availability = {}): PaymentsAdapter {
  const name = 'Payments (simulation)';
  const sessions = ds.series['checkout_sessions'];
  return {
    name,
    async getProviderBreakdown(window: TimeWindow): Promise<ProviderStats[]> {
      guard(availability, 'payments', name);
      const buckets = sessions
        .map((p, i) => ({ ...p, i }))
        .filter((p) => !isBefore(p.t, window.start) && !isBefore(window.end, bucketEnd(p.t)));
      return ds.providers.map((pr) => {
        let attempts = 0;
        let failures = 0;
        const codes: Record<string, number> = {};
        for (const b of buckets) {
          const effect = pr.effects.find((e) => b.i >= e.from && (e.to === undefined || b.i <= e.to));
          const rate = effect ? effect.errorRate : pr.baselineErrorRate;
          const mix = effect ? effect.errorCodes : pr.baselineErrorCodes;
          const a = b.value * pr.share;
          const f = (a * rate) / 100;
          attempts += a;
          failures += f;
          for (const [code, pct] of Object.entries(mix)) codes[code] = (codes[code] ?? 0) + (f * pct) / 100;
        }
        const errorCodes: Record<string, number> = {};
        for (const [code, n] of Object.entries(codes)) errorCodes[code] = failures ? Math.round((n / failures) * 100) : 0;
        return {
          provider: pr.provider,
          label: pr.label,
          attempts: Math.round(attempts),
          failures: Math.round(failures),
          errorRate: attempts ? (failures / attempts) * 100 : 0,
          baselineErrorRate: pr.baselineErrorRate,
          baselineStdDev: pr.baselineStdDev,
          errorCodes,
          baselineErrorCodes: pr.baselineErrorCodes,
        };
      });
    },
    async getProviderStatus(provider, asOf) {
      guard(availability, 'payments', name);
      const pr = ds.providers.find((p) => p.provider === provider);
      const msg = pr?.statusMessages?.filter((m) => !isBefore(asOf, m.from)).at(-1);
      return msg
        ? { provider, status: msg.status, checkedAt: asOf, message: msg.message }
        : { provider, status: 'operational', checkedAt: asOf, message: 'All systems operational' };
    },
  };
}

export function createSimulatedGitHub(ds: ScenarioDataset, availability: Availability = {}): GitHubAdapter {
  const name = 'GitHub (simulation)';
  return {
    name,
    async listDeployments(window) {
      guard(availability, 'github', name);
      return ds.deployments.filter((d) => isWithin(d.deployedAt, window.start, window.end));
    },
    async getPullRequests(numbers) {
      guard(availability, 'github', name);
      return ds.pullRequests.filter((p) => numbers.includes(p.number));
    },
  };
}

export function createSimulatedSupport(ds: ScenarioDataset, availability: Availability = {}): SupportAdapter {
  const name = 'Support (simulation)';
  return {
    name,
    async searchTickets(window) {
      guard(availability, 'support', name);
      return ds.tickets.filter((t) => isWithin(t.createdAt, window.start, window.end));
    },
  };
}

export function createSimulatedExperiments(ds: ScenarioDataset, availability: Availability = {}): ExperimentAdapter {
  const name = 'Experiments (simulation)';
  return {
    name,
    async listActiveExperiments(asOf) {
      guard(availability, 'experiments', name);
      return ds.experiments
        .filter((e) => e.status === 'running' && isBefore(e.startedAt, asOf))
        .map((e) => ({ ...e, changes: e.changes.filter((c) => isBefore(c.at, asOf)) }));
    },
  };
}

export interface TrackerTeam {
  id: string;
  keyPrefix: string;
}

/**
 * Simulated Linear/Jira. Keeps issues in memory; keys continue from the highest existing key per team.
 * A real connector implements the same four methods against the tracker's API.
 */
export function createSimulatedIssueTracker(
  seed: Task[],
  teams: TrackerTeam[],
  availability: Availability = {},
): IssueTrackerAdapter & { snapshot(): Task[] } {
  const name = 'Issue tracker (simulation)';
  let issues: Task[] = seed.map((t) => ({ ...t, comments: [...t.comments] }));
  let incidentCounter = Math.max(230, ...issues.filter((t) => t.kind === 'incident').map((t) => Number(t.id.split('-')[1]) || 0));

  const nextKey = (teamId: string) => {
    const prefix = teams.find((t) => t.id === teamId)?.keyPrefix ?? 'NW';
    const max = Math.max(0, ...issues.filter((i) => i.id.startsWith(`${prefix}-`)).map((i) => Number(i.id.split('-')[1]) || 0));
    return `${prefix}-${max + 1}`;
  };

  return {
    name,
    label: 'Simulated issue tracker',
    async createIssue(draft: TaskDraft, atTime: string) {
      guard(availability, 'issue_tracker', name);
      const id = draft.kind === 'incident' ? `INC-${++incidentCounter}` : nextKey(draft.ownerTeamId);
      const task: Task = {
        id,
        kind: draft.kind,
        title: draft.title,
        priority: draft.priority,
        ownerTeamId: draft.ownerTeamId,
        createdBy: 'nightwatch',
        createdAt: atTime,
        status: 'todo',
        investigationId: draft.investigationId,
        evidenceSourceCount: draft.evidenceSourceCount,
        description: draft.description,
        comments: [],
        fingerprint: draft.fingerprint,
        tracker: 'simulated',
      };
      issues = [...issues, task];
      return task;
    },
    async findOpenByFingerprint(fingerprint) {
      guard(availability, 'issue_tracker', name);
      return issues.find((i) => i.fingerprint === fingerprint && i.status !== 'done');
    },
    async addComment(issueId: string, comment: TaskComment) {
      guard(availability, 'issue_tracker', name);
      const idx = issues.findIndex((i) => i.id === issueId);
      if (idx < 0) throw new Error(`Issue ${issueId} not found`);
      const updated = { ...issues[idx], comments: [...issues[idx].comments, comment] };
      issues = issues.map((i, j) => (j === idx ? updated : i));
      return updated;
    },
    async updateDescription(issueId, description, evidenceSourceCount) {
      guard(availability, 'issue_tracker', name);
      const idx = issues.findIndex((i) => i.id === issueId);
      if (idx < 0) throw new Error(`Issue ${issueId} not found`);
      const updated = { ...issues[idx], description, evidenceSourceCount };
      issues = issues.map((i, j) => (j === idx ? updated : i));
      return updated;
    },
    async list() {
      return issues;
    },
    snapshot() {
      return issues;
    },
  };
}

export function createSimulatedNotifications(availability: Availability = {}): NotificationAdapter & { sent: { rotation: string; message: string; at: string }[] } {
  const name = 'Notifications (simulation)';
  const sent: { rotation: string; message: string; at: string }[] = [];
  return {
    name,
    sent,
    async notifyOnCall(rotation, message, atTime) {
      guard(availability, 'notifications', name);
      sent.push({ rotation, message, at: atTime });
      return { id: `ntf-${sent.length}` };
    },
  };
}

export function createSimulationAdapters(
  ds: ScenarioDataset,
  opts: { availability?: Availability; seedIssues?: Task[]; teams: TrackerTeam[] },
): AdapterSet & { issueTracker: ReturnType<typeof createSimulatedIssueTracker> } {
  const availability = opts.availability ?? {};
  return {
    analytics: createSimulatedAnalytics(ds, availability),
    payments: createSimulatedPayments(ds, availability),
    github: createSimulatedGitHub(ds, availability),
    support: createSimulatedSupport(ds, availability),
    experiments: createSimulatedExperiments(ds, availability),
    issueTracker: createSimulatedIssueTracker(opts.seedIssues ?? [], opts.teams, availability),
    notifications: createSimulatedNotifications(availability),
  };
}
