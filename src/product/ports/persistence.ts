import type { ActionDecision, BriefSchedule, ConnectionState, EmailNotification, ISO, MorningBriefDoc, ProviderId, Watch, WatchInvestigation } from '../types.js';
import type { ImportedDataset } from '../imports/schemas.js';
import type { Role } from '../roles/types.js';
import type { SecretRef } from './secrets.js';
import type { NormalizedEvent } from '../events.js';
import type { Subscription, UsageEvent, UsageKind } from './controlPlane.js';
import type { HistoryPage, HistoryQuery, HistoryScope } from './history.js';
import type { ExecutionReceipt } from '../app/executionStatus.js';

/**
 * Persistence port — the workspace's durable state, as domain records.
 *
 * Every method that touches workspace data takes the workspace id: tenant scoping is part of the
 * contract, not a convention. Implementations: in-memory (tests, reference for the contract suite)
 * and Postgres (server/). Nothing here is shaped like a table.
 */

export interface Actor {
  /** Stable, opaque reference to a person within this workspace. Never an email address. */
  ref: string;
  displayName: string;
}

export interface Workspace {
  id: string;
  /** Commercial/security owner. Optional only while reading pre-Phase-0A documents. */
  organizationId?: string;
  name: string;
  mode: 'imported' | 'sample' | 'connected';
  createdAt: ISO;
  settings: { planner: 'deterministic' | 'llm'; aiEgressAllowed: boolean; timezone: string };
  brief: BriefSchedule;
  /** Where this workspace came from, when it was created from a Jagr export. */
  importedFrom?: { exportId: string; workspaceId: string; origin: 'browser-local' | 'server' };
  /** Export ids already imported into this workspace — importing one twice is refused. */
  importedExportIds: string[];
  /** Optimistic concurrency. */
  version: number;
}

export interface Organization {
  id: string;
  name: string;
  createdAt: ISO;
}

export interface OrganizationMembership {
  organizationId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member';
}

export interface User {
  id: string;
  displayName: string;
  createdAt: ISO;
}

export interface Membership {
  workspaceId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member';
  canApprove: boolean;
}

export interface Session {
  id: string;
  userId: string;
  createdAt: ISO;
  expiresAt: ISO;
}

/** A source connection's configuration. Holds a SecretRef — never a secret. */
export interface Connection {
  id: string;
  workspaceId: string;
  /** The source id (or, for an outbound channel such as Slack, the channel id). */
  source: ProviderId;
  /** What implements it: 'simulated', 'import', or a connector id ('amplitude', 'github', …). */
  provider: string;
  roles: Role[];
  authKind: 'oauth' | 'app_install' | 'api_key' | 'import' | 'simulated' | 'owner_env';
  state: ConnectionState;
  detail: string;
  label?: { name: string; short: string };
  /** Non-secret settings: projects, repos, metric bindings, area mappings, channel ids. */
  config: Record<string, unknown>;
  /** A non-secret label for the provider-side account: project, org, site or workspace name. */
  externalAccount?: string;
  secretRef?: SecretRef;
  freshAsOf?: ISO;
  lastSyncAt?: ISO;
  lastError?: string;
  /** When a credential check last succeeded. */
  lastSuccessfulCheckAt?: ISO;
  /** When the last error was recorded (so health can tell an old error from a current one). */
  lastErrorAt?: ISO;
  /** Provider-side capabilities / scopes the connection was granted, as reported by the provider (non-secret). */
  capabilities?: string[];
  /** Absent on connections stored before connections carried it (see connections/model.ts upgradeConnection). */
  createdAt?: ISO;
  updatedAt: ISO;
}

/** A stable monitored resource below a credential-bearing connection. */
export interface SourceTarget {
  id: string;
  organizationId: string;
  workspaceId: string;
  connectionId: string;
  provider: string;
  externalId: string;
  displayName: string;
  configuration: Record<string, unknown>;
  /** Neutral polling cadence; absent means this target is not source-check scheduled yet. */
  checkIntervalMinutes?: number;
  status: 'active' | 'paused' | 'disconnected';
  createdAt: ISO;
  updatedAt: ISO;
}

/** Durable observation progress belongs to a source target, never to a watch. */
export interface SourceState {
  organizationId: string;
  workspaceId: string;
  sourceTargetId: string;
  provider: string;
  status: 'scheduled' | 'unchanged' | 'changed' | 'provider_error' | 'auth_error' | 'rate_limited' | 'timeout' | 'invalid_target' | 'internal_error';
  version: number;
  lastCheckedAt?: ISO;
  lastObservedAt?: ISO;
  lastSuccessfulCheckAt?: ISO;
  nextCheckAt?: ISO;
  checkpoint?: string;
  lastObservedVersion?: string;
  lastObservedHash?: string;
  lastChangeAt?: ISO;
  lastError?: string;
  updatedAt: ISO;
}

export interface MetricDefinitionRecord {
  key: string;
  name: string;
  unit: 'percent' | 'count' | 'currency';
  area: string;
  badDirection: 'down' | 'up';
  mode: 'relative' | 'absolute';
  threshold: number;
  platform?: 'ios' | 'android' | 'web';
  /** Which connection serves it, and how (a provider-specific query, e.g. an Amplitude chart spec). */
  binding: { connectionId: string; query: unknown };
}

export interface Decision extends ActionDecision {
  actionId: string;
  decidedBy?: Actor;
}

export interface NotificationRecord {
  id: string;
  /** The delivering NotificationChannel's kind (e.g. 'in_app'). Opaque to the core. */
  channel: string;
  dedupeKey: string;
  deliveredAt: ISO;
  /** sending = claimed, delivery in progress (or interrupted: see app/notifications.ts). */
  status: 'sending' | 'delivered' | 'failed';
  investigationId?: string;
  /** Rendered content — never addresses or tokens. */
  email?: Omit<EmailNotification, 'to' | 'from'>;
  detail?: string;
}

export interface AuditEntry {
  id: string;
  workspaceId: string;
  at: ISO;
  actor: Actor | { ref: 'system'; displayName: 'Jagr' };
  action: string;
  target?: string;
  detail?: string;
  executionReceipt?: ExecutionReceipt;
}

export interface Repositories {
  organizations: {
    get(id: string): Promise<Organization | null>;
    create(o: Organization): Promise<void>;
  };
  organizationMembers: {
    forUser(userId: string): Promise<OrganizationMembership[]>;
    get(organizationId: string, userId: string): Promise<OrganizationMembership | null>;
    add(m: OrganizationMembership): Promise<void>;
  };
  workspaces: {
    get(id: string): Promise<Workspace | null>;
    create(w: Workspace): Promise<void>;
    update(w: Workspace, expectedVersion: number): Promise<void>;
    list(): Promise<Workspace[]>;
    /** Oldest scheduler attempt first; at most `limit` connected workspaces. */
    listForScheduler(limit: number): Promise<Workspace[]>;
    countForOrganization(organizationId: string): Promise<number>;
    listForOrganization(organizationId: string): Promise<Workspace[]>;
  };
  users: {
    get(id: string): Promise<User | null>;
    byIdentity(provider: string, subject: string): Promise<User | null>;
    create(u: User, identity: { provider: string; subject: string }): Promise<void>;
  };
  members: {
    forUser(userId: string): Promise<Membership[]>;
    forWorkspace(workspaceId: string): Promise<Membership[]>;
    add(m: Membership): Promise<void>;
  };
  sessions: {
    create(s: Session): Promise<void>;
    get(id: string): Promise<Session | null>;
    revoke(id: string): Promise<void>;
  };
  connections: {
    list(workspaceId: string): Promise<Connection[]>;
    get(workspaceId: string, id: string): Promise<Connection | null>;
    save(workspaceId: string, c: Connection): Promise<void>;
    remove(workspaceId: string, id: string): Promise<void>;
  };
  sourceTargets: {
    list(workspaceId: string): Promise<SourceTarget[]>;
    get(workspaceId: string, id: string): Promise<SourceTarget | null>;
    save(workspaceId: string, target: SourceTarget): Promise<void>;
    countForOrganization(organizationId: string): Promise<number>;
  };
  sourceStates: {
    get(workspaceId: string, sourceTargetId: string): Promise<SourceState | null>;
    save(workspaceId: string, state: SourceState): Promise<void>;
  };
  events: {
    list(scope: EventReadScope, query?: NormalizedEventQuery): Promise<NormalizedEvent[]>;
    get(scope: EventReadScope, eventId: string): Promise<NormalizedEvent | null>;
    /** Events durably associated with one coalesced watch cadence slot. */
    forWatchSlot(scope: EventReadScope, watchId: string, runAt: ISO, limit?: number): Promise<NormalizedEvent[]>;
    /** False means this logical event was already durably recorded. */
    add(workspaceId: string, event: NormalizedEvent): Promise<boolean>;
  };
  metricDefs: {
    list(workspaceId: string): Promise<MetricDefinitionRecord[]>;
    save(workspaceId: string, d: MetricDefinitionRecord): Promise<void>;
  };
  watches: {
    list(workspaceId: string): Promise<Watch[]>;
    get(workspaceId: string, id: string): Promise<Watch | null>;
    save(workspaceId: string, w: Watch): Promise<void>;
    remove(workspaceId: string, id: string): Promise<void>;
    countForOrganization(organizationId: string): Promise<number>;
  };
  subscriptions: {
    get(organizationId: string): Promise<Subscription | null>;
    /** Creates the compatibility subscription when absent and serializes admission in a transaction. */
    lock(organizationId: string, at: ISO): Promise<Subscription>;
    save(subscription: Subscription): Promise<void>;
  };
  usage: {
    get(organizationId: string, id: string): Promise<UsageEvent | null>;
    /** False means this operation identity was already accounted. */
    add(event: UsageEvent): Promise<boolean>;
    sum(organizationId: string, kind: UsageKind, periodStart: ISO, periodEnd: ISO, workspaceId?: string): Promise<number>;
  };
  imports: {
    list(workspaceId: string): Promise<ImportedDataset[]>;
    page(scope: HistoryScope, query?: HistoryQuery): Promise<HistoryPage<ImportedDataset>>;
    save(workspaceId: string, d: ImportedDataset): Promise<void>;
    remove(workspaceId: string, id: string): Promise<void>;
  };
  investigations: {
    list(workspaceId: string): Promise<WatchInvestigation[]>;
    page(scope: HistoryScope, query?: HistoryQuery): Promise<HistoryPage<WatchInvestigation>>;
    pageForBriefWindow(scope: HistoryScope, since: ISO, at: ISO, query?: HistoryQuery): Promise<HistoryPage<WatchInvestigation>>;
    findByActionId(workspaceId: string, actionId: string): Promise<WatchInvestigation | null>;
    get(workspaceId: string, id: string): Promise<WatchInvestigation | null>;
    /** The investigation as the engine left it: evidence (its snapshot of what it saw), trace, actions. */
    save(workspaceId: string, inv: WatchInvestigation): Promise<void>;
  };
  decisions: {
    list(workspaceId: string): Promise<Decision[]>;
    page(scope: HistoryScope, query?: HistoryQuery): Promise<HistoryPage<Decision>>;
    get(workspaceId: string, actionId: string): Promise<Decision | null>;
    /** Optimistic: fails with WriteConflict when a decision already exists and `expected` differs. */
    put(workspaceId: string, d: Decision, expected?: Decision | null): Promise<void>;
  };
  notifications: {
    list(workspaceId: string): Promise<NotificationRecord[]>;
    page(scope: HistoryScope, query?: HistoryQuery): Promise<HistoryPage<NotificationRecord>>;
    pageForBriefWindow(scope: HistoryScope, since: ISO, at: ISO, query?: HistoryQuery): Promise<HistoryPage<NotificationRecord>>;
    firstEmailForInvestigation(workspaceId: string, investigationId: string): Promise<NotificationRecord | null>;
    /** Point lookup for delivery idempotency; never scan a workspace's full delivery history. */
    byDedupe(workspaceId: string, channel: string, dedupeKey: string): Promise<NotificationRecord | null>;
    /** Atomic: false when (channel, dedupeKey) is already taken — the claim that makes delivery at-most-once. */
    add(workspaceId: string, n: NotificationRecord): Promise<boolean>;
    /** Replace a record by id (settle a claim: delivered, or failed with its dedupe key released). */
    settle(workspaceId: string, n: NotificationRecord): Promise<void>;
  };
  /**
   * Short leases on a workspace-scoped key (e.g. "run": one monitoring run per workspace at a time).
   * `acquire` is atomic; it succeeds when the key is free, expired, or already held by the same owner.
   */
  locks: {
    acquire(workspaceId: string, key: string, owner: string, until: ISO, now: ISO): Promise<boolean>;
    /** Extends an unexpired lock only when `owner` still owns it. */
    renew(workspaceId: string, key: string, owner: string, until: ISO, now: ISO): Promise<boolean>;
    release(workspaceId: string, key: string, owner: string): Promise<void>;
  };
  /** Morning briefs, as composed (the document a PM reads). Keyed by brief id; saving the same id replaces it. */
  briefs: {
    list(workspaceId: string): Promise<MorningBriefDoc[]>;
    page(scope: HistoryScope, query?: HistoryQuery): Promise<HistoryPage<MorningBriefDoc>>;
    save(workspaceId: string, b: MorningBriefDoc): Promise<void>;
  };
  cursors: {
    get(workspaceId: string, key: string): Promise<string | null>;
    set(workspaceId: string, key: string, value: string): Promise<void>;
  };
  audit: {
    append(e: AuditEntry): Promise<void>;
    list(workspaceId: string): Promise<AuditEntry[]>;
    page(scope: HistoryScope, query?: HistoryQuery): Promise<HistoryPage<AuditEntry>>;
    /** Latest watch-run entries only, oldest first, for the workspace snapshot. */
    recentWatchRuns(scope: HistoryScope, limit: number): Promise<AuditEntry[]>;
  };
}

export interface EventReadScope {
  organizationId: string;
  workspaceId: string;
}

export interface NormalizedEventQuery {
  sourceTargetId?: string;
  type?: string;
  from?: ISO;
  to?: ISO;
  limit?: number;
}

export const NORMALIZED_EVENT_READ_LIMIT = 100;

/** Runs `fn` atomically: every write inside commits together or not at all. */
export interface Transactor {
  run<T>(fn: (repos: Repositories) => Promise<T>): Promise<T>;
  /** One consistent read-only logical view across keyset pages. */
  readSnapshot<T>(fn: (repos: Repositories) => Promise<T>): Promise<T>;
}

export class WriteConflict extends Error {
  constructor(what: string) {
    super(`${what} changed since it was read — reload and retry.`);
    this.name = 'WriteConflict';
  }
}

export class NotFound extends Error {
  constructor(what: string) {
    super(`${what} not found.`);
    this.name = 'NotFound';
  }
}
