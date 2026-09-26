import type { Area, ChannelId, ISO, ProviderId, SourceConnection, SourceRef } from '../types.js';
import { CHANNEL_IDS } from '../types.js';

/**
 * Role-based sources — the only way the investigation engine reaches product evidence.
 *
 * The engine asks for evidence by ROLE ("changes in this window", "work items about checkout"),
 * never by vendor. Each source (a connected tool, a user import, a simulated fixture) implements the
 * roles it can serve and maps its own records into the neutral records below. Every record carries
 * its provenance, so evidence always says exactly where it came from.
 */

export type Role = 'metrics' | 'changes' | 'work_items' | 'feedback' | 'conversations' | 'context';
export const ROLES: Role[] = ['metrics', 'changes', 'work_items', 'feedback', 'conversations', 'context'];

/** Opaque identifier of one source in a workspace. The engine never branches on its value. */
export type SourceId = Exclude<ProviderId, ChannelId>;
/** Delivery channels are notification targets, not evidence sources. */
export const isSourceId = (p: ProviderId): p is SourceId => !(CHANNEL_IDS as readonly string[]).includes(p);

export type SourceMode = 'connected' | 'imported' | 'simulated';

/** Where a record came from. Required on every record a source returns. */
export interface Provenance {
  source: SourceId;
  /** What produced the record: 'simulated', 'import', or a connector id such as 'amplitude'. */
  provider: string;
  connectionId: string;
  mode: SourceMode;
  /** The record's id in the source it came from. */
  externalId: string;
  /** Deep link into the source, when the source has one. */
  url?: string;
  /** When the thing happened (or the last data point, for a series). */
  observedAt: ISO;
  /** When Jagr read it. */
  fetchedAt: ISO;
}

interface RoleRecord {
  source: SourceId;
  /** Reference used for in-app links and the evidence trail. */
  ref: SourceRef;
  provenance: Provenance;
}

// ─────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────

/** Workspace-level metric key, e.g. "checkout_conversion". Not a vendor id. */
export type MetricKey = string;

export interface MetricDefinition {
  key: MetricKey;
  name: string;
  unit: 'percent' | 'count' | 'currency';
  area: Area;
  badDirection: 'down' | 'up';
  /** relative = % change vs baseline; absolute = change in points (e.g. crash-free sessions). */
  mode: 'relative' | 'absolute';
  /** Default detection threshold (% or points, depending on mode). */
  threshold: number;
  platform?: 'ios' | 'android' | 'web';
  /**
   * Error / crash telemetry: `errors` is a count of application errors (bad when it rises), `crash_free`
   * a crash-free rate (bad when it falls). Lets the engine recognise error spikes and crash regressions
   * whichever source reports them.
   */
  telemetry?: 'errors' | 'crash_free';
}

export interface MetricPoint {
  t: ISO;
  value: number;
}

export interface MetricSeries extends MetricDefinition, RoleRecord {
  baseline: { mean: number; stdDev: number; window: string };
  points: MetricPoint[];
}

export interface SegmentSeries {
  dimension: string;
  segment: string;
  series: MetricSeries;
}

// ─────────────────────────────────────────────────────────────
// Changes
// ─────────────────────────────────────────────────────────────

export type ChangeKind = 'deploy' | 'release' | 'flag_change' | 'experiment_change' | 'config_change' | 'annotation' | 'incident';

/**
 * How trustworthy the timestamp is.
 *   actual   — the time the change reached users (a deployment finished, a flag flipped, a store build went live)
 *   planned  — a scheduled or bookkeeping date (a tracker's release date) — weaker evidence of timing
 *   reported — someone wrote down that a change happened (an analytics annotation)
 */
export type ChangeTiming = 'actual' | 'planned' | 'reported';

export interface ChangeRecord extends RoleRecord {
  id: string;
  kind: ChangeKind;
  timing: ChangeTiming;
  title: string;
  at: ISO;
  version?: string;
  platform?: 'ios' | 'android' | 'web' | 'all';
  /** Human-readable rollout state, e.g. "20% staged rollout". */
  rollout?: string;
  status?: 'success' | 'failed' | 'rolled_back' | 'in_progress';
  notes?: string;
  /**
   * The change stream this record belongs to, when the source knows it (e.g. a repository and
   * environment): successive deployments of the same target share it, whatever their version.
   */
  target?: string;
}

// ─────────────────────────────────────────────────────────────
// Work items
// ─────────────────────────────────────────────────────────────

export interface WorkItem extends RoleRecord {
  id: string;
  title: string;
  type: 'bug' | 'incident' | 'task' | 'other';
  priority: 'critical' | 'high' | 'medium' | 'low';
  status?: string;
  component?: string;
  area: Area;
  labels: string[];
  /** Versions the item is reported against. */
  versions: string[];
  createdAt: ISO;
}

// ─────────────────────────────────────────────────────────────
// Feedback
// ─────────────────────────────────────────────────────────────

export interface FeedbackItem extends RoleRecord {
  id: string;
  channel: 'review' | 'support' | 'survey' | 'request';
  rating?: 1 | 2 | 3 | 4 | 5;
  title: string;
  /** The customer's words, with personal data removed before anything is stored. */
  text: string;
  tags: string[];
  version?: string;
  createdAt: ISO;
}

// ─────────────────────────────────────────────────────────────
// Conversations (P1) and context (P2) — interfaces only; nothing implements them yet
// ─────────────────────────────────────────────────────────────

export interface ConversationMessage extends RoleRecord {
  id: string;
  channel: string;
  text: string;
  at: ISO;
}

export interface ContextDocument extends RoleRecord {
  id: string;
  title: string;
  excerpt: string;
  updatedAt: ISO;
}

// ─────────────────────────────────────────────────────────────
// Role interfaces
// ─────────────────────────────────────────────────────────────

export interface TimeWindow {
  start: ISO;
  end: ISO;
}

export interface MetricSource {
  /** Metric definitions this source can serve. Configuration — known without a network call. */
  metricDefinitions(): MetricDefinition[];
  getSeries(q: { metric: MetricKey; window: TimeWindow }): Promise<MetricSeries | null>;
  /** Dimensions a metric can be broken down by (platform, app_version, country…). */
  listDimensions(metric: MetricKey): string[];
  getBreakdown(q: { metric: MetricKey; window: TimeWindow; dimension: string }): Promise<SegmentSeries[]>;
}

export interface ChangeSource {
  /** The source reports rollout state (staged / phased releases), so it can answer "is it still rolling out?". */
  readonly tracksRollout: boolean;
  getChanges(q: { window: TimeWindow }): Promise<ChangeRecord[]>;
}

export interface WorkItemSource {
  getWorkItems(q: { window: TimeWindow }): Promise<WorkItem[]>;
}

export interface FeedbackSource {
  getFeedback(q: { window: TimeWindow }): Promise<FeedbackItem[]>;
}

/** P1 — Slack inbound and similar. Never evidence of an observation on its own. */
export interface ConversationSource {
  searchMessages(q: { window: TimeWindow; channels: string[]; terms: string[] }): Promise<ConversationMessage[]>;
}

/** P2 — product documents. Context for hypotheses, never evidence of a change. */
export interface ContextSource {
  findDocuments(q: { query: string; limit: number }): Promise<ContextDocument[]>;
}

/** One source as the registry knows it: its connection state and the roles it implements. */
export interface RegisteredSource {
  id: SourceId;
  connection: SourceConnection;
  metrics?: MetricSource;
  changes?: ChangeSource;
  work_items?: WorkItemSource;
  feedback?: FeedbackSource;
  conversations?: ConversationSource;
  context?: ContextSource;
}

/** A source's state for a query that needs data up to `asOf`. */
export type SourceHealthState = 'ok' | 'stale' | 'unavailable' | 'error' | 'not_configured';

export interface SourceHealth {
  source: SourceId;
  mode: SourceMode;
  state: SourceHealthState;
  /** Data is complete up to this time (last successful sync), when known. */
  freshAsOf?: ISO;
  detail?: string;
}

/** Health of a source for a read that needs data up to `asOf`. Stale = its data stops before then. */
export function healthOf(id: SourceId, conn: SourceConnection | undefined, asOf: ISO): SourceHealth {
  if (!conn) return { source: id, mode: 'simulated', state: 'not_configured', detail: 'Not part of this workspace' };
  const mode: SourceMode = conn.state === 'connected' ? 'connected' : conn.state === 'imported' ? 'imported' : 'simulated';
  if (conn.state === 'not_configured' || conn.state === 'unavailable' || conn.state === 'error') return { source: id, mode, state: conn.state, detail: conn.detail };
  // Configuration without credentials (e.g. arrived in an export): cannot be read until reconnected.
  if (conn.state === 'needs_reconnect') return { source: id, mode, state: 'not_configured', detail: conn.detail || 'needs to be reconnected' };
  if (conn.freshAsOf && Date.parse(conn.freshAsOf) < Date.parse(asOf)) return { source: id, mode, state: 'stale', freshAsOf: conn.freshAsOf, detail: `data complete only up to ${conn.freshAsOf}` };
  return { source: id, mode, state: 'ok', freshAsOf: conn.freshAsOf };
}

/** Work items and feedback count as "negative" in the same way everywhere. */
export function isNegativeFeedback(f: FeedbackItem): boolean {
  // A rated item is negative at 1–2★. An unrated support contact is a report of a problem.
  return f.rating !== undefined ? f.rating <= 2 : f.channel === 'support';
}
