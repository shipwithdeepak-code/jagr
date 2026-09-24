import type { Area, ISO, ProviderId, SourceConnection, SourceLink, SourceRef } from '../types';
import type { ChangeKind, ChangeTiming } from '../roles/types';

/**
 * Normalised records. Every provider maps its own API into these shapes, so the watch engine
 * never knows whether data came from Jira, GA4, App Store Connect or Google Play.
 */

export interface TimeWindow {
  start: ISO;
  end: ISO;
}

export interface MetricPoint {
  t: ISO;
  value: number;
}

export interface MetricSeries {
  id: string;
  provider: ProviderId;
  name: string;
  unit: 'percent' | 'count' | 'currency';
  area: Area;
  badDirection: 'down' | 'up';
  /** relative = % change vs baseline; absolute = change in points (e.g. crash-free sessions). */
  mode: 'relative' | 'absolute';
  /** Default detection threshold (% or points, depending on mode). */
  threshold: number;
  baseline: { mean: number; stdDev: number; window: string };
  points: MetricPoint[];
  platform?: 'ios' | 'android' | 'web';
}

export interface IssueRecord {
  id: string;
  provider: 'jira';
  title: string;
  type: 'Bug' | 'Task' | 'Incident';
  priority: 'Highest' | 'High' | 'Medium' | 'Low';
  component: string;
  area: Area;
  labels: string[];
  affectsVersion?: string;
  reporter: string;
  createdAt: ISO;
}

export interface ReleaseRecord {
  id: string;
  provider: 'jira' | 'app_store' | 'google_play' | 'github';
  /** Kind of change (default 'release'). Deploys, flag changes and incidents use the same record. */
  kind?: ChangeKind;
  /** How trustworthy `releasedAt` is (default 'actual'). A tracker's release date is 'planned'. */
  timing?: ChangeTiming;
  /** Title for unversioned changes (deploys, flags); releases use `version`. */
  title?: string;
  status?: 'success' | 'failed' | 'rolled_back' | 'in_progress';
  version: string;
  platform: 'ios' | 'android' | 'web' | 'all';
  releasedAt: ISO;
  notes: string;
  rollout?: string;
}

export interface ReviewRecord {
  id: string;
  provider: 'app_store' | 'google_play';
  /** Absent for unrated feedback (e.g. a support conversation). */
  rating?: 1 | 2 | 3 | 4 | 5;
  /** Where the feedback came from (default 'review'). */
  channel?: 'review' | 'support' | 'survey' | 'request';
  tags?: string[];
  title: string;
  body: string;
  version: string;
  createdAt: ISO;
}

/** Unified timeline entry — a normalised view across issues, releases and reviews. */
export interface SourceEvent {
  at: ISO;
  provider: ProviderId;
  kind: 'issue' | 'release' | 'review';
  title: string;
  ref: SourceRef;
}

/** `rollout`: the source reports staged / phased rollout state for its releases. */
export type Capability = 'metrics' | 'issues' | 'releases' | 'reviews' | 'events' | 'changes' | 'rollout' | 'send_email';

export class ProviderUnavailableError extends Error {
  constructor(public readonly provider: ProviderId, public readonly state: 'unavailable' | 'error', detail: string) {
    super(detail);
    this.name = 'ProviderUnavailableError';
  }
}

/**
 * The NATIVE adapter contract: records shaped like the source's own API. The engine never calls it
 * directly — `roleSourceFromAdapter` (./bridge.ts) turns an adapter into role-based sources.
 *
 * The adapter contract. Operations a provider doesn't support return an empty list,
 * so the engine can call every operation on every source uniformly.
 * A production connector (Jira REST, GA4 Data API, App Store Connect API, Play Developer
 * Reporting API) implements this same interface.
 */
export interface IntegrationAdapter {
  readonly provider: ProviderId;
  readonly name: string;
  readonly capabilities: Capability[];
  connection(): SourceConnection;
  /** Metric series this source can serve (definitions only — no points). */
  listMetrics?(): Omit<MetricSeries, 'points' | 'baseline'>[];
  getMetrics(ids: string[], window: TimeWindow): Promise<MetricSeries[]>;
  getIssues(window: TimeWindow): Promise<IssueRecord[]>;
  getReleases(window: TimeWindow): Promise<ReleaseRecord[]>;
  getReviews(window: TimeWindow): Promise<ReviewRecord[]>;
  getEvents(window: TimeWindow): Promise<SourceEvent[]>;
  /** Changes that could explain a shift: releases, deploys, config changes. */
  getChanges(window: TimeWindow): Promise<ReleaseRecord[]>;
  link(ref: SourceRef, label?: string): SourceLink;
}

/** Outbound channel for notifications. The simulated channel renders emails in-app only. */
export interface EmailChannel {
  readonly provider: 'email';
  connection(): SourceConnection;
  send<T extends { id: string }>(email: T): Promise<T>;
}
