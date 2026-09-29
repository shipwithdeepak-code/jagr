import type { Clock } from './clock';
import type { JobQueue, JobSpec, JobState, LeasedJob } from './jobs';
import { LeaseLost } from './jobs';
import type { AuditEntry, Connection, Decision, MetricDefinitionRecord, Membership, NotificationRecord, Organization, OrganizationMembership, Repositories, Session, SourceState, SourceTarget, Transactor, User, Workspace } from './persistence';
import { NORMALIZED_EVENT_READ_LIMIT, NotFound, WriteConflict } from './persistence';
import { decodeHistoryCursor, historyPage, pageSize, type HistoryQuery, type HistoryScope } from './history';
import type { SecretPayload, SecretRef, SecretStore } from './secrets';
import { SecretNotFound, SecretVersionConflict } from './secrets';
import type { MorningBriefDoc, Watch, WatchInvestigation } from '../types';
import type { ImportedDataset } from '../imports/schemas';
import type { NormalizedEvent } from '../events';
import type { Subscription, UsageEvent } from './controlPlane';

/**
 * In-memory implementations of the ports. Pure TypeScript, no I/O: used by tests, by the contract
 * suites as the reference behaviour, and wherever a process-local store is enough. Not a production
 * secret store — secrets here live in process memory, unencrypted.
 */

const clone = <T>(x: T): T => (x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T));

interface WsData {
  connections: Map<string, Connection>;
  sourceTargets: Map<string, SourceTarget>;
  sourceStates: Map<string, SourceState>;
  events: Map<string, NormalizedEvent>;
  metricDefs: Map<string, MetricDefinitionRecord>;
  watches: Map<string, Watch>;
  imports: Map<string, ImportedDataset>;
  investigations: Map<string, WatchInvestigation>;
  decisions: Map<string, Decision>;
  notifications: Map<string, NotificationRecord>;
  briefs: Map<string, MorningBriefDoc>;
  locks: Map<string, { owner: string; until: string }>;
  cursors: Map<string, string>;
  audit: AuditEntry[];
}

interface State {
  organizations: Map<string, Organization>;
  organizationMembers: OrganizationMembership[];
  workspaces: Map<string, Workspace>;
  users: Map<string, User>;
  identities: Map<string, string>;
  members: Membership[];
  sessions: Map<string, Session>;
  subscriptions: Map<string, Subscription>;
  usage: Map<string, UsageEvent>;
  data: Map<string, WsData>;
}

const emptyWs = (): WsData => ({ connections: new Map(), sourceTargets: new Map(), sourceStates: new Map(), events: new Map(), metricDefs: new Map(), watches: new Map(), imports: new Map(), investigations: new Map(), decisions: new Map(), notifications: new Map(), briefs: new Map(), locks: new Map(), cursors: new Map(), audit: [] });
const emptyState = (): State => ({ organizations: new Map(), organizationMembers: [], workspaces: new Map(), users: new Map(), identities: new Map(), members: [], sessions: new Map(), subscriptions: new Map(), usage: new Map(), data: new Map() });

function copyState(s: State): State {
  const ws = new Map<string, WsData>();
  for (const [k, d] of s.data) {
    ws.set(k, {
      connections: new Map(clone([...d.connections])),
      sourceTargets: new Map(clone([...d.sourceTargets])),
      sourceStates: new Map(clone([...d.sourceStates])),
      events: new Map(clone([...d.events])),
      metricDefs: new Map(clone([...d.metricDefs])),
      watches: new Map(clone([...d.watches])),
      imports: new Map(clone([...d.imports])),
      investigations: new Map(clone([...d.investigations])),
      decisions: new Map(clone([...d.decisions])),
      notifications: new Map(clone([...d.notifications])),
      briefs: new Map(clone([...d.briefs])),
      locks: new Map(clone([...d.locks])),
      cursors: new Map(d.cursors),
      audit: clone(d.audit),
    });
  }
  return { organizations: new Map(clone([...s.organizations])), organizationMembers: clone(s.organizationMembers), workspaces: new Map(clone([...s.workspaces])), users: new Map(clone([...s.users])), identities: new Map(s.identities), members: clone(s.members), sessions: new Map(clone([...s.sessions])), subscriptions: new Map(clone([...s.subscriptions])), usage: new Map(clone([...s.usage])), data: ws };
}

export function createMemoryPersistence(initialState: State = emptyState()): { repos: Repositories; tx: Transactor } {
  let state = initialState;
  const ws = (id: string) => {
    let d = state.data.get(id);
    if (!d) state.data.set(id, (d = emptyWs()));
    return d;
  };
  const values = <T>(m: Map<string, T>) => clone([...m.values()]);
  const page = <T>(scope: HistoryScope, collection: string, items: T[], keyOf: (item: T) => string, idOf: (item: T) => string, query: HistoryQuery = {}) => {
    if (state.workspaces.get(scope.workspaceId)?.organizationId !== scope.organizationId) throw new NotFound('Workspace');
    const position = decodeHistoryCursor(query.cursor, scope, collection);
    const ordered = items.filter((item) => {
      const key = keyOf(item);
      return !position || key < position.key || (key === position.key && idOf(item) < position.id);
    }).sort((a, b) => keyOf(b).localeCompare(keyOf(a)) || idOf(b).localeCompare(idOf(a)));
    return historyPage(clone(ordered.slice(0, pageSize(query.limit) + 1)), scope, collection, keyOf, idOf, query.limit);
  };

  const repos: Repositories = {
    organizations: {
      get: async (id) => clone(state.organizations.get(id) ?? null),
      create: async (o) => {
        if (state.organizations.has(o.id)) throw new WriteConflict(`Organization ${o.id}`);
        state.organizations.set(o.id, clone(o));
        state.subscriptions.set(o.id, { organizationId: o.id, planId: 'legacy', status: 'active', createdAt: o.createdAt, updatedAt: o.createdAt });
      },
    },
    organizationMembers: {
      forUser: async (userId) => clone(state.organizationMembers.filter((m) => m.userId === userId)),
      get: async (organizationId, userId) => clone(state.organizationMembers.find((m) => m.organizationId === organizationId && m.userId === userId) ?? null),
      add: async (m) => {
        state.organizationMembers = [...state.organizationMembers.filter((x) => !(x.organizationId === m.organizationId && x.userId === m.userId)), clone(m)];
      },
    },
    workspaces: {
      get: async (id) => clone(state.workspaces.get(id) ?? null),
      list: async () => values(state.workspaces),
      listForScheduler: async (limit) => values(state.workspaces).filter((w) => w.mode === 'connected')
        .sort((a, b) => (ws(a.id).cursors.get('scheduler.last_attempt') ?? '').localeCompare(ws(b.id).cursors.get('scheduler.last_attempt') ?? '') || a.id.localeCompare(b.id))
        .slice(0, Math.max(0, Math.min(limit, 100))),
      listForOrganization: async (organizationId) => clone([...state.workspaces.values()].filter((w) => w.organizationId === organizationId)),
      countForOrganization: async (organizationId) => [...state.workspaces.values()].filter((w) => w.organizationId === organizationId).length,
      create: async (w) => {
        if (state.workspaces.has(w.id)) throw new WriteConflict(`Workspace ${w.id}`);
        state.workspaces.set(w.id, clone(w));
      },
      update: async (w, expectedVersion) => {
        const cur = state.workspaces.get(w.id);
        if (!cur || cur.version !== expectedVersion) throw new WriteConflict(`Workspace ${w.id}`);
        state.workspaces.set(w.id, clone({ ...w, version: expectedVersion + 1 }));
      },
    },
    users: {
      get: async (id) => clone(state.users.get(id) ?? null),
      byIdentity: async (provider, subject) => {
        const id = state.identities.get(`${provider}:${subject}`);
        return id ? clone(state.users.get(id) ?? null) : null;
      },
      create: async (u, identity) => {
        const key = `${identity.provider}:${identity.subject}`;
        if (state.identities.has(key)) throw new WriteConflict('Identity');
        state.users.set(u.id, clone(u));
        state.identities.set(key, u.id);
      },
    },
    members: {
      forUser: async (userId) => clone(state.members.filter((m) => m.userId === userId)),
      forWorkspace: async (workspaceId) => clone(state.members.filter((m) => m.workspaceId === workspaceId)),
      add: async (m) => {
        state.members = [...state.members.filter((x) => !(x.userId === m.userId && x.workspaceId === m.workspaceId)), clone(m)];
        const organizationId = state.workspaces.get(m.workspaceId)?.organizationId;
        if (organizationId) {
          const role = m.role === 'owner' || m.role === 'admin' ? m.role : 'member';
          const orgMember = { organizationId, userId: m.userId, role } as OrganizationMembership;
          state.organizationMembers = [...state.organizationMembers.filter((x) => !(x.organizationId === organizationId && x.userId === m.userId)), orgMember];
        }
      },
    },
    sessions: {
      create: async (s) => void state.sessions.set(s.id, clone(s)),
      get: async (id) => clone(state.sessions.get(id) ?? null),
      revoke: async (id) => void state.sessions.delete(id),
    },
    connections: {
      list: async (w) => values(ws(w).connections),
      get: async (w, id) => clone(ws(w).connections.get(id) ?? null),
      save: async (w, c) => {
        if (c.workspaceId !== w) throw new WriteConflict('Connection workspace');
        ws(w).connections.set(c.id, clone(c));
      },
      remove: async (w, id) => void ws(w).connections.delete(id),
    },
    sourceTargets: {
      list: async (w) => values(ws(w).sourceTargets),
      get: async (w, id) => clone(ws(w).sourceTargets.get(id) ?? null),
      save: async (w, target) => {
        const workspace = state.workspaces.get(w);
        const connection = ws(w).connections.get(target.connectionId);
        if (target.workspaceId !== w || !workspace?.organizationId || target.organizationId !== workspace.organizationId || connection?.workspaceId !== w) throw new WriteConflict('Source target scope');
        ws(w).sourceTargets.set(target.id, clone(target));
      },
      countForOrganization: async (organizationId) => [...state.workspaces.values()].filter((w) => w.organizationId === organizationId).reduce((n, w) => n + ws(w.id).sourceTargets.size, 0),
    },
    sourceStates: {
      get: async (w, id) => clone(ws(w).sourceStates.get(id) ?? null),
      save: async (w, sourceState) => {
        const target = ws(w).sourceTargets.get(sourceState.sourceTargetId);
        if (!target || sourceState.workspaceId !== w || sourceState.organizationId !== target.organizationId || sourceState.provider !== target.provider) throw new NotFound('Source target');
        ws(w).sourceStates.set(sourceState.sourceTargetId, clone(sourceState));
      },
    },
    events: {
      list: async (scope, query = {}) => {
        const workspace = state.workspaces.get(scope.workspaceId);
        if (!workspace || workspace.organizationId !== scope.organizationId) return [];
        const limit = Math.max(1, Math.min(query.limit ?? NORMALIZED_EVENT_READ_LIMIT, NORMALIZED_EVENT_READ_LIMIT));
        return values(new Map([...ws(scope.workspaceId).events].filter(([, event]) =>
          event.organizationId === scope.organizationId &&
          (!query.sourceTargetId || event.sourceTargetId === query.sourceTargetId) &&
          (!query.type || event.type === query.type) &&
          (!query.from || event.occurredAt >= query.from) &&
          (!query.to || event.occurredAt <= query.to),
        ))).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId)).slice(0, limit);
      },
      get: async (scope, id) => {
        const workspace = state.workspaces.get(scope.workspaceId);
        const event = workspace?.organizationId === scope.organizationId ? ws(scope.workspaceId).events.get(id) : undefined;
        return event?.organizationId === scope.organizationId ? clone(event) : null;
      },
      forWatchSlot: async (scope, watchId, runAt, requestedLimit) => {
        const workspace = state.workspaces.get(scope.workspaceId);
        if (!workspace || workspace.organizationId !== scope.organizationId) return [];
        const limit = Math.max(1, Math.min(requestedLimit ?? NORMALIZED_EVENT_READ_LIMIT, NORMALIZED_EVENT_READ_LIMIT));
        return values(new Map([...ws(scope.workspaceId).events].filter(([, event]) =>
          event.organizationId === scope.organizationId && ws(scope.workspaceId).cursors.get(`source-event:${event.eventId}:watch:${watchId}`) === runAt,
        ))).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId)).slice(0, limit);
      },
      add: async (w, event) => {
        const target = ws(w).sourceTargets.get(event.sourceTargetId);
        if (!target || event.workspaceId !== w || event.organizationId !== target.organizationId || event.connectionId !== target.connectionId || event.provider !== target.provider) throw new NotFound('Source target');
        if (ws(w).events.has(event.eventId)) return false;
        ws(w).events.set(event.eventId, clone(event));
        return true;
      },
    },
    metricDefs: {
      list: async (w) => values(ws(w).metricDefs),
      save: async (w, d) => void ws(w).metricDefs.set(d.key, clone(d)),
    },
    watches: {
      list: async (w) => values(ws(w).watches),
      get: async (w, id) => clone(ws(w).watches.get(id) ?? null),
      save: async (w, x) => {
        const workspace = state.workspaces.get(w);
        for (const id of x.sourceTargetIds ?? []) {
          const target = ws(w).sourceTargets.get(id);
          if (!target || target.workspaceId !== w || !workspace?.organizationId || target.organizationId !== workspace.organizationId) throw new NotFound('Source target');
        }
        ws(w).watches.set(x.id, clone(x));
      },
      remove: async (w, id) => void ws(w).watches.delete(id),
      countForOrganization: async (organizationId) => [...state.workspaces.values()].filter((w) => w.organizationId === organizationId).reduce((n, w) => n + ws(w.id).watches.size, 0),
    },
    subscriptions: {
      get: async (organizationId) => clone(state.subscriptions.get(organizationId) ?? null),
      lock: async (organizationId, at) => {
        if (!state.organizations.has(organizationId)) throw new NotFound('Organization');
        let subscription = state.subscriptions.get(organizationId);
        if (!subscription) {
          subscription = { organizationId, planId: 'legacy', status: 'active', createdAt: at, updatedAt: at };
          state.subscriptions.set(organizationId, subscription);
        }
        return clone(subscription);
      },
      save: async (subscription) => {
        if (!state.organizations.has(subscription.organizationId)) throw new NotFound('Organization');
        state.subscriptions.set(subscription.organizationId, clone(subscription));
      },
    },
    usage: {
      get: async (organizationId, id) => clone(state.usage.get(`${organizationId}:${id}`) ?? null),
      add: async (event) => {
        const key = `${event.organizationId}:${event.id}`;
        if (state.usage.has(key)) return false;
        const workspace = event.workspaceId ? state.workspaces.get(event.workspaceId) : undefined;
        if (!state.organizations.has(event.organizationId) || (event.workspaceId && workspace?.organizationId !== event.organizationId)) throw new NotFound('Usage scope');
        state.usage.set(key, clone(event));
        return true;
      },
      sum: async (organizationId, kind, periodStart, periodEnd, workspaceId) => [...state.usage.values()].filter((event) => event.organizationId === organizationId && event.kind === kind && event.periodStart === periodStart && event.periodEnd === periodEnd && (!workspaceId || event.workspaceId === workspaceId)).reduce((n, event) => n + event.amount, 0),
    },
    imports: {
      list: async (w) => values(ws(w).imports),
      page: async (scope, query) => page(scope, 'imports', values(ws(scope.workspaceId).imports), (item) => item.id, (item) => item.id, query),
      save: async (w, d) => void ws(w).imports.set(d.id, clone(d)),
      remove: async (w, id) => void ws(w).imports.delete(id),
    },
    investigations: {
      list: async (w) => values(ws(w).investigations),
      page: async (scope, query) => page(scope, 'investigations', values(ws(scope.workspaceId).investigations), (item) => item.startedAt, (item) => item.id, query),
      pageForBriefWindow: async (scope, since, at, query) => page(scope, `brief-investigations:${since}:${at}`, values(ws(scope.workspaceId).investigations).filter((item) => (item.updatedAt >= since && item.updatedAt <= at) || (item.startedAt >= since && item.startedAt <= at)), (item) => item.startedAt, (item) => item.id, query),
      findByActionId: async (w, actionId) => clone([...ws(w).investigations.values()].find((item) => item.actions.some((action) => action.id === actionId)) ?? null),
      get: async (w, id) => clone(ws(w).investigations.get(id) ?? null),
      save: async (w, inv) => void ws(w).investigations.set(inv.id, clone(inv)),
    },
    decisions: {
      list: async (w) => values(ws(w).decisions),
      page: async (scope, query) => page(scope, 'decisions', values(ws(scope.workspaceId).decisions), (item) => item.actionId, (item) => item.actionId, query),
      get: async (w, id) => clone(ws(w).decisions.get(id) ?? null),
      put: async (w, d, expected) => {
        const cur = ws(w).decisions.get(d.actionId) ?? null;
        if (expected !== undefined && JSON.stringify(cur) !== JSON.stringify(expected ?? null)) throw new WriteConflict(`Decision on ${d.actionId}`);
        ws(w).decisions.set(d.actionId, clone(d));
      },
    },
    notifications: {
      list: async (w) => values(ws(w).notifications),
      page: async (scope, query) => page(scope, 'notifications', values(ws(scope.workspaceId).notifications), (item) => item.deliveredAt, (item) => item.id, query),
      pageForBriefWindow: async (scope, since, at, query) => page(scope, `brief-notifications:${since}:${at}`, values(ws(scope.workspaceId).notifications).filter((item) => item.channel === 'in_app' && !!item.email && item.deliveredAt >= since && item.deliveredAt <= at), (item) => item.deliveredAt, (item) => item.id, query),
      firstEmailForInvestigation: async (w, investigationId) => clone([...ws(w).notifications.values()].filter((item) => item.channel === 'in_app' && !!item.email && item.investigationId === investigationId).sort((a, b) => a.id.localeCompare(b.id))[0] ?? null),
      byDedupe: async (w, channel, dedupeKey) => clone([...ws(w).notifications.values()].find((n) => n.channel === channel && n.dedupeKey === dedupeKey) ?? null),
      add: async (w, n) => {
        const m = ws(w).notifications;
        if ([...m.values()].some((x) => x.dedupeKey === n.dedupeKey && x.channel === n.channel)) return false;
        m.set(n.id, clone(n));
        return true;
      },
      settle: async (w, n) => void ws(w).notifications.set(n.id, clone(n)),
    },
    locks: {
      acquire: async (w, key, owner, until, now) => {
        const cur = ws(w).locks.get(key);
        if (cur && cur.until > now && cur.owner !== owner) return false;
        ws(w).locks.set(key, { owner, until });
        return true;
      },
      renew: async (w, key, owner, until, now) => {
        const cur = ws(w).locks.get(key);
        if (!cur || cur.owner !== owner || cur.until <= now) return false;
        ws(w).locks.set(key, { owner, until });
        return true;
      },
      release: async (w, key, owner) => {
        if (ws(w).locks.get(key)?.owner === owner) ws(w).locks.delete(key);
      },
    },
    briefs: {
      list: async (w) => values(ws(w).briefs).sort((a, b) => a.generatedAt.localeCompare(b.generatedAt)),
      page: async (scope, query) => page(scope, 'briefs', values(ws(scope.workspaceId).briefs), (item) => item.generatedAt, (item) => item.id, query),
      save: async (w, b) => void ws(w).briefs.set(b.id, clone(b)),
    },
    cursors: {
      get: async (w, key) => ws(w).cursors.get(key) ?? null,
      set: async (w, key, value) => void ws(w).cursors.set(key, value),
    },
    audit: {
      append: async (e) => void ws(e.workspaceId).audit.push(clone(e)),
      list: async (w) => clone(ws(w).audit),
      page: async (scope, query) => page(scope, 'audit', clone(ws(scope.workspaceId).audit), (item) => item.at, (item) => item.id, query),
      recentWatchRuns: async (scope, limit) => page(scope, 'audit', clone(ws(scope.workspaceId).audit).filter((item) => item.action === 'monitor.watch' && item.target), (item) => item.at, (item) => item.id, { limit }).items.reverse(),
    },
  };

  // One transaction at a time; a failure restores the state from before it started.
  let chain: Promise<unknown> = Promise.resolve();
  const tx: Transactor = {
    run: <T>(fn: (r: Repositories) => Promise<T>) => {
      const next = chain.then(async () => {
        const backup = copyState(state);
        try {
          return await fn(repos);
        } catch (e) {
          state = backup;
          throw e;
        }
      });
      chain = next.catch(() => undefined);
      return next;
    },
    readSnapshot: <T>(fn: (r: Repositories) => Promise<T>) => {
      const next = chain.then(() => fn(createMemoryPersistence(copyState(state)).repos));
      chain = next.catch(() => undefined);
      return next;
    },
  };
  return { repos, tx };
}

// ─────────────────────────────────────────────────────────────
// Job queue
// ─────────────────────────────────────────────────────────────

interface StoredJob extends LeasedJob {
  state: JobState;
  createdAt: string;
  firstAttemptedAt?: string;
  lastAttemptedAt?: string;
  completedAt?: string;
  lastFailedAt?: string;
  lastError?: string;
}

export function createMemoryJobQueue(clock: Clock, tenantForWorkspace: (workspaceId: string) => string = (workspaceId) => workspaceId): JobQueue {
  const jobs: StoredJob[] = [];
  let seq = 0;
  let turn = 0;
  const tenantTurns = new Map<string, number>();
  const leased = (id: string, token: string) => {
    const j = jobs.find((x) => x.id === id);
    // Ownership is the lease token: an expired lease nobody else claimed is still the holder's.
    if (!j || j.state !== 'leased' || j.leaseToken !== token) throw new LeaseLost();
    return j;
  };
  const plus = (ms: number) => new Date(Date.parse(clock.now()) + ms).toISOString();
  return {
    async enqueue(spec: JobSpec) {
      if (jobs.some((j) => j.idempotencyKey === spec.idempotencyKey)) return false;
      jobs.push({ id: `job_${++seq}`, kind: spec.kind, workspaceId: spec.workspaceId, payload: clone(spec.payload), idempotencyKey: spec.idempotencyKey, runAt: spec.runAt ?? clock.now(), attempts: 0, maxAttempts: spec.maxAttempts ?? 5, leaseToken: '', leaseUntil: '', state: 'queued', createdAt: clock.now() });
      return true;
    },
    async claim({ workerId, kinds, limit, leaseMs }) {
      const now = clock.now();
      const claimed: LeasedJob[] = [];
      for (let i = 0; i < Math.min(Math.max(limit, 0), 100); i++) {
        const j = jobs
          .filter((candidate) => (!kinds || kinds.includes(candidate.kind)) && candidate.runAt <= now && (candidate.state === 'queued' || (candidate.state === 'leased' && candidate.leaseUntil <= now)))
          .sort((a, b) => (tenantTurns.get(tenantForWorkspace(a.workspaceId)) ?? -1) - (tenantTurns.get(tenantForWorkspace(b.workspaceId)) ?? -1) || a.runAt.localeCompare(b.runAt) || a.id.localeCompare(b.id))[0];
        if (!j) break;
        j.state = 'leased';
        j.attempts += 1;
        j.firstAttemptedAt ??= now;
        j.lastAttemptedAt = now;
        j.leaseToken = `${workerId}:${++seq}`;
        j.leaseUntil = plus(leaseMs);
        const { state: _s, lastError: _e, createdAt: _c, firstAttemptedAt: _f, lastAttemptedAt: _a, completedAt: _d, lastFailedAt: _l, ...out } = j;
        void _s;
        void _e;
        claimed.push(clone(out));
        tenantTurns.set(tenantForWorkspace(j.workspaceId), ++turn);
      }
      return claimed;
    },
    async complete(id, token) {
      const j = leased(id, token);
      j.state = 'done';
      j.completedAt = clock.now();
    },
    async fail(id, token, error, retryAt) {
      const j = leased(id, token);
      j.lastError = error;
      j.lastFailedAt = clock.now();
      if (retryAt && j.attempts < j.maxAttempts) {
        j.state = 'queued';
        j.runAt = retryAt;
      } else j.state = 'dead';
    },
    async extend(id, token, leaseMs) {
      leased(id, token).leaseUntil = plus(leaseMs);
    },
    async inspect(key) {
      const j = jobs.find((x) => x.idempotencyKey === key);
      return j ? { state: j.state, attempts: j.attempts, runAt: j.runAt, createdAt: j.createdAt, firstAttemptedAt: j.firstAttemptedAt, lastAttemptedAt: j.lastAttemptedAt, completedAt: j.completedAt, lastFailedAt: j.lastFailedAt, leaseUntil: j.leaseUntil || undefined, lastError: j.lastError } : null;
    },
    async status() {
      const queued = jobs.filter((j) => j.state === 'queued');
      return {
        queued: queued.length,
        leased: jobs.filter((j) => j.state === 'leased').length,
        dead: jobs.filter((j) => j.state === 'dead').length,
        expiredLeases: jobs.filter((j) => j.state === 'leased' && j.leaseUntil <= clock.now()).length,
        oldestQueuedAt: queued.map((j) => j.runAt).sort()[0],
        recentDead: jobs.filter((j) => j.state === 'dead').sort((a, b) => (b.lastFailedAt ?? '').localeCompare(a.lastFailedAt ?? '') || b.id.localeCompare(a.id)).slice(0, 20)
          .map((j) => ({ jobId: j.id, workspaceId: j.workspaceId, ...(j.kind === 'source.check' && typeof j.payload.sourceTargetId === 'string' ? { sourceTargetId: j.payload.sourceTargetId } : {}), kind: j.kind, attempts: j.attempts, failedAt: j.lastFailedAt })),
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Secret store (tests only — unencrypted, process memory)
// ─────────────────────────────────────────────────────────────

export function createMemorySecretStore(): SecretStore {
  const m = new Map<string, { secret: SecretPayload; version: number; owner: string }>();
  let seq = 0;
  return {
    async put(owner, secret) {
      const ref = `sec_mem_${++seq}` as SecretRef;
      m.set(ref, { secret: clone(secret), version: 1, owner: `${owner.workspaceId}/${owner.connectionId}` });
      return ref;
    },
    async get(ref, owner) {
      const e = m.get(ref);
      if (!e || e.owner !== `${owner.workspaceId}/${owner.connectionId}`) throw new SecretNotFound();
      return { secret: clone(e.secret), version: e.version };
    },
    async replace(ref, owner, expectedVersion, secret) {
      const e = m.get(ref);
      if (!e || e.owner !== `${owner.workspaceId}/${owner.connectionId}`) throw new SecretNotFound();
      if (e.version !== expectedVersion) throw new SecretVersionConflict();
      m.set(ref, { ...e, secret: clone(secret), version: e.version + 1 });
    },
    async delete(ref, owner) {
      const e = m.get(ref);
      if (!e || e.owner !== `${owner.workspaceId}/${owner.connectionId}`) throw new SecretNotFound();
      m.delete(ref);
    },
  };
}
