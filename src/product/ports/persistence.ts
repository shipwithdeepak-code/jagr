import type { ActionDecision, BriefSchedule, ConnectionState, EmailNotification, ISO, ProviderId, Watch, WatchInvestigation } from '../types';
import type { ImportedDataset } from '../imports/schemas';
import type { Role } from '../roles/types';
import type { SecretRef } from './secrets';

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
  status: 'delivered' | 'failed';
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
}

export interface Repositories {
  workspaces: {
    get(id: string): Promise<Workspace | null>;
    create(w: Workspace): Promise<void>;
    update(w: Workspace, expectedVersion: number): Promise<void>;
    list(): Promise<Workspace[]>;
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
  metricDefs: {
    list(workspaceId: string): Promise<MetricDefinitionRecord[]>;
    save(workspaceId: string, d: MetricDefinitionRecord): Promise<void>;
  };
  watches: {
    list(workspaceId: string): Promise<Watch[]>;
    get(workspaceId: string, id: string): Promise<Watch | null>;
    save(workspaceId: string, w: Watch): Promise<void>;
    remove(workspaceId: string, id: string): Promise<void>;
  };
  imports: {
    list(workspaceId: string): Promise<ImportedDataset[]>;
    save(workspaceId: string, d: ImportedDataset): Promise<void>;
    remove(workspaceId: string, id: string): Promise<void>;
  };
  investigations: {
    list(workspaceId: string): Promise<WatchInvestigation[]>;
    get(workspaceId: string, id: string): Promise<WatchInvestigation | null>;
    /** The investigation as the engine left it: evidence (its snapshot of what it saw), trace, actions. */
    save(workspaceId: string, inv: WatchInvestigation): Promise<void>;
  };
  decisions: {
    list(workspaceId: string): Promise<Decision[]>;
    /** Optimistic: fails with WriteConflict when a decision already exists and `expected` differs. */
    put(workspaceId: string, d: Decision, expected?: Decision | null): Promise<void>;
  };
  notifications: {
    list(workspaceId: string): Promise<NotificationRecord[]>;
    add(workspaceId: string, n: NotificationRecord): Promise<boolean>;
  };
  cursors: {
    get(workspaceId: string, key: string): Promise<string | null>;
    set(workspaceId: string, key: string, value: string): Promise<void>;
  };
  audit: {
    append(e: AuditEntry): Promise<void>;
    list(workspaceId: string): Promise<AuditEntry[]>;
  };
}

/** Runs `fn` atomically: every write inside commits together or not at all. */
export interface Transactor {
  run<T>(fn: (repos: Repositories) => Promise<T>): Promise<T>;
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
