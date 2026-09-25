import type { Clock } from './clock';
import type { JobQueue, JobSpec, JobState, LeasedJob } from './jobs';
import { LeaseLost } from './jobs';
import type { AuditEntry, Connection, Decision, MetricDefinitionRecord, Membership, NotificationRecord, Repositories, Session, Transactor, User, Workspace } from './persistence';
import { WriteConflict } from './persistence';
import type { SecretPayload, SecretRef, SecretStore } from './secrets';
import { SecretNotFound, SecretVersionConflict } from './secrets';
import type { MorningBriefDoc, Watch, WatchInvestigation } from '../types';
import type { ImportedDataset } from '../imports/schemas';

/**
 * In-memory implementations of the ports. Pure TypeScript, no I/O: used by tests, by the contract
 * suites as the reference behaviour, and wherever a process-local store is enough. Not a production
 * secret store — secrets here live in process memory, unencrypted.
 */

const clone = <T>(x: T): T => (x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T));

interface WsData {
  connections: Map<string, Connection>;
  metricDefs: Map<string, MetricDefinitionRecord>;
  watches: Map<string, Watch>;
  imports: Map<string, ImportedDataset>;
  investigations: Map<string, WatchInvestigation>;
  decisions: Map<string, Decision>;
  notifications: Map<string, NotificationRecord>;
  briefs: Map<string, MorningBriefDoc>;
  cursors: Map<string, string>;
  audit: AuditEntry[];
}

interface State {
  workspaces: Map<string, Workspace>;
  users: Map<string, User>;
  identities: Map<string, string>;
  members: Membership[];
  sessions: Map<string, Session>;
  data: Map<string, WsData>;
}

const emptyWs = (): WsData => ({ connections: new Map(), metricDefs: new Map(), watches: new Map(), imports: new Map(), investigations: new Map(), decisions: new Map(), notifications: new Map(), briefs: new Map(), cursors: new Map(), audit: [] });
const emptyState = (): State => ({ workspaces: new Map(), users: new Map(), identities: new Map(), members: [], sessions: new Map(), data: new Map() });

function copyState(s: State): State {
  const ws = new Map<string, WsData>();
  for (const [k, d] of s.data) {
    ws.set(k, {
      connections: new Map(clone([...d.connections])),
      metricDefs: new Map(clone([...d.metricDefs])),
      watches: new Map(clone([...d.watches])),
      imports: new Map(clone([...d.imports])),
      investigations: new Map(clone([...d.investigations])),
      decisions: new Map(clone([...d.decisions])),
      notifications: new Map(clone([...d.notifications])),
      briefs: new Map(clone([...d.briefs])),
      cursors: new Map(d.cursors),
      audit: clone(d.audit),
    });
  }
  return { workspaces: new Map(clone([...s.workspaces])), users: new Map(clone([...s.users])), identities: new Map(s.identities), members: clone(s.members), sessions: new Map(clone([...s.sessions])), data: ws };
}

export function createMemoryPersistence(): { repos: Repositories; tx: Transactor } {
  let state = emptyState();
  const ws = (id: string) => {
    let d = state.data.get(id);
    if (!d) state.data.set(id, (d = emptyWs()));
    return d;
  };
  const values = <T>(m: Map<string, T>) => clone([...m.values()]);

  const repos: Repositories = {
    workspaces: {
      get: async (id) => clone(state.workspaces.get(id) ?? null),
      list: async () => values(state.workspaces),
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
    metricDefs: {
      list: async (w) => values(ws(w).metricDefs),
      save: async (w, d) => void ws(w).metricDefs.set(d.key, clone(d)),
    },
    watches: {
      list: async (w) => values(ws(w).watches),
      get: async (w, id) => clone(ws(w).watches.get(id) ?? null),
      save: async (w, x) => void ws(w).watches.set(x.id, clone(x)),
      remove: async (w, id) => void ws(w).watches.delete(id),
    },
    imports: {
      list: async (w) => values(ws(w).imports),
      save: async (w, d) => void ws(w).imports.set(d.id, clone(d)),
      remove: async (w, id) => void ws(w).imports.delete(id),
    },
    investigations: {
      list: async (w) => values(ws(w).investigations),
      get: async (w, id) => clone(ws(w).investigations.get(id) ?? null),
      save: async (w, inv) => void ws(w).investigations.set(inv.id, clone(inv)),
    },
    decisions: {
      list: async (w) => values(ws(w).decisions),
      put: async (w, d, expected) => {
        const cur = ws(w).decisions.get(d.actionId) ?? null;
        if (expected !== undefined && JSON.stringify(cur) !== JSON.stringify(expected ?? null)) throw new WriteConflict(`Decision on ${d.actionId}`);
        ws(w).decisions.set(d.actionId, clone(d));
      },
    },
    notifications: {
      list: async (w) => values(ws(w).notifications),
      add: async (w, n) => {
        const m = ws(w).notifications;
        if ([...m.values()].some((x) => x.dedupeKey === n.dedupeKey && x.channel === n.channel)) return false;
        m.set(n.id, clone(n));
        return true;
      },
    },
    briefs: {
      list: async (w) => values(ws(w).briefs).sort((a, b) => a.generatedAt.localeCompare(b.generatedAt)),
      save: async (w, b) => void ws(w).briefs.set(b.id, clone(b)),
    },
    cursors: {
      get: async (w, key) => ws(w).cursors.get(key) ?? null,
      set: async (w, key, value) => void ws(w).cursors.set(key, value),
    },
    audit: {
      append: async (e) => void ws(e.workspaceId).audit.push(clone(e)),
      list: async (w) => clone(ws(w).audit),
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
  };
  return { repos, tx };
}

// ─────────────────────────────────────────────────────────────
// Job queue
// ─────────────────────────────────────────────────────────────

interface StoredJob extends LeasedJob {
  state: JobState;
  lastError?: string;
}

export function createMemoryJobQueue(clock: Clock): JobQueue {
  const jobs: StoredJob[] = [];
  let seq = 0;
  const leased = (id: string, token: string) => {
    const j = jobs.find((x) => x.id === id);
    if (!j || j.state !== 'leased' || j.leaseToken !== token || j.leaseUntil <= clock.now()) throw new LeaseLost();
    return j;
  };
  const plus = (ms: number) => new Date(Date.parse(clock.now()) + ms).toISOString();
  return {
    async enqueue(spec: JobSpec) {
      if (jobs.some((j) => j.idempotencyKey === spec.idempotencyKey)) return false;
      jobs.push({ id: `job_${++seq}`, kind: spec.kind, workspaceId: spec.workspaceId, payload: clone(spec.payload), idempotencyKey: spec.idempotencyKey, runAt: spec.runAt ?? clock.now(), attempts: 0, maxAttempts: spec.maxAttempts ?? 5, leaseToken: '', leaseUntil: '', state: 'queued' });
      return true;
    },
    async claim({ workerId, kinds, limit, leaseMs }) {
      const now = clock.now();
      const due = jobs
        .filter((j) => (!kinds || kinds.includes(j.kind)) && j.runAt <= now && (j.state === 'queued' || (j.state === 'leased' && j.leaseUntil <= now)))
        .sort((a, b) => a.runAt.localeCompare(b.runAt) || a.id.localeCompare(b.id))
        .slice(0, limit);
      return due.map((j) => {
        j.state = 'leased';
        j.attempts += 1;
        j.leaseToken = `${workerId}:${++seq}`;
        j.leaseUntil = plus(leaseMs);
        const { state: _s, lastError: _e, ...out } = j;
        void _s;
        void _e;
        return clone(out);
      });
    },
    async complete(id, token) {
      leased(id, token).state = 'done';
    },
    async fail(id, token, error, retryAt) {
      const j = leased(id, token);
      j.lastError = error;
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
      return j ? { state: j.state, attempts: j.attempts, lastError: j.lastError } : null;
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
    async get(ref) {
      const e = m.get(ref);
      if (!e) throw new SecretNotFound();
      return { secret: clone(e.secret), version: e.version };
    },
    async replace(ref, expectedVersion, secret) {
      const e = m.get(ref);
      if (!e) throw new SecretNotFound();
      if (e.version !== expectedVersion) throw new SecretVersionConflict();
      m.set(ref, { ...e, secret: clone(secret), version: e.version + 1 });
    },
    async delete(ref) {
      m.delete(ref);
    },
  };
}
