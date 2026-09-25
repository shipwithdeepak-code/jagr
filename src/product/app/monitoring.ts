import type { EmailNotification, MonitoringResult, ScheduledJob, SourceConnection } from '../types.js';
import type { Clock } from '../ports/clock.js';
import type { HttpClient } from '../ports/http.js';
import type { JobQueue, LeasedJob } from '../ports/jobs.js';
import type { AuditEntry, Connection, Repositories, Transactor, Workspace } from '../ports/persistence.js';
import type { SecretPayload, SecretStore } from '../ports/secrets.js';
import { SecretNotFound } from '../ports/secrets.js';
import type { ConnectorCheck } from '../integrations/connectors/types.js';
import type { ImportedDataset } from '../imports/schemas.js';
import type { RegisteredSource } from '../roles/types.js';
import { SourceRegistry } from '../roles/registry.js';
import type { World } from '../integrations/world.js';
import { defaultWorld } from '../integrations/world.js';
import { createRegistry } from '../integrations/adapters.js';
import { buildImportedWorld, watchesForImportedData } from '../imports/world.js';
import { runMonitoring } from '../engine/monitor.js';
import { composeBrief } from '../engine/brief.js';
import type { InvestigationPlanner } from '../agent/planner.js';
import { alertMessage, briefMessage, deliver, type ChannelFactory } from './notifications.js';
import { uniqueId } from './ids.js';
import { LeaseLost } from '../ports/jobs.js';

/**
 * Server-side monitoring — the same engine the browser runs, driven by the job queue and persisted
 * through the Repositories port. Provider-agnostic: a workspace's sources are built from its
 * connections by connector factories registered at the composition root.
 */

/** Builds one source from a connection. Registered per connector provider ('amplitude', 'github', …). */
export type ConnectorFactory = (conn: Connection, ctx: { secret?: SecretPayload; http: HttpClient; clock: Clock }) => RegisteredSource;

/** A registered connector: builds a source from a connection, and probes its credential. */
export interface Connector {
  build: ConnectorFactory;
  check(conn: Connection, ctx: { secret?: SecretPayload; http: HttpClient; clock: Clock }): Promise<ConnectorCheck>;
}

export interface MonitoringDeps {
  repos: Repositories;
  tx: Transactor;
  clock: Clock;
  secrets: SecretStore;
  http: HttpClient;
  connectors: Record<string, Connector>;
  planner?: InvestigationPlanner;
  appBaseUrl?: string;
  /** Outbound notification channels, per provider (e.g. a chat tool). Connected workspaces only. */
  channels?: Record<string, ChannelFactory>;
}

const toSourceConnection = (c: Connection): SourceConnection => ({ provider: c.source, state: c.state, detail: c.detail, updatedAt: c.updatedAt, label: c.label, freshAsOf: c.freshAsOf });

/**
 * The sources for one run of a workspace, and the data window they cover.
 *   sample    — the simulated sample night (labelled SIMULATED)
 *   imported  — the workspace's stored imports (labelled USER IMPORT)
 *   connected — one source per connection, from its connector; a connection whose connector is not
 *               registered, or that needs reconnecting, is present but not readable (a gap, never data)
 */
export async function sourcesForRun(deps: MonitoringDeps, ws: Workspace, at: string): Promise<{ registry: SourceRegistry; world: World; connections: SourceConnection[]; imports?: ImportedDataset[] }> {
  const conns = await deps.repos.connections.list(ws.id);
  if (ws.mode === 'sample') {
    const connections = conns.map(toSourceConnection);
    return { registry: createRegistry(defaultWorld(), connections).registry, world: defaultWorld(), connections };
  }
  if (ws.mode === 'imported') {
    const imports = await deps.repos.imports.list(ws.id);
    const iw = buildImportedWorld(imports, at);
    const world = iw.world ?? { id: 'empty', name: 'No imported data', start: at, end: at, metrics: [], issues: [], releases: [], reviews: [] };
    return { registry: createRegistry(world, iw.connections).registry, world, connections: iw.connections, imports };
  }
  const sources: RegisteredSource[] = [];
  const connections: SourceConnection[] = [];
  for (const c of conns) {
    // Channels (notification targets) are not evidence sources.
    if (!c.roles.length) continue;
    const connector = Object.prototype.hasOwnProperty.call(deps.connectors, c.provider) ? deps.connectors[c.provider] : undefined;
    if (!connector) {
      connections.push({ ...toSourceConnection(c), state: c.state === 'needs_reconnect' ? 'needs_reconnect' : 'not_configured', detail: `No connector for “${c.provider}” in this deployment.` });
      continue;
    }
    if (c.state === 'needs_reconnect' || c.state === 'not_configured') {
      connections.push(toSourceConnection(c));
      continue;
    }
    // A connection that cannot be set up (missing credential, invalid config) is a gap for this run —
    // one broken connection never stops the others.
    try {
      const secret = c.secretRef ? (await deps.secrets.get(c.secretRef)).secret : undefined;
      const src = connector.build(c, { secret, http: deps.http, clock: deps.clock });
      sources.push(src);
      connections.push(src.connection);
    } catch (e) {
      const missing = e instanceof SecretNotFound;
      connections.push({ ...toSourceConnection(c), state: missing ? 'needs_reconnect' : 'error', detail: missing ? 'The stored credential is missing; reconnect this source.' : (e as Error).message.slice(0, 300) });
    }
  }
  // Live sources are read "as of" the run; a day of history gives detection its baseline window.
  const world: World = { id: `live-${ws.id}`, name: ws.name, start: new Date(Date.parse(at) - 24 * 3_600_000).toISOString(), end: at, metrics: [], issues: [], releases: [], reviews: [] };
  return { registry: new SourceRegistry(sources), world, connections };
}

/** The AI planner, only for workspaces that allow evidence to be sent to an AI provider. */
const plannerFor = (deps: MonitoringDeps, ws: Workspace) => (ws.settings.aiEgressAllowed ? deps.planner : undefined);

export interface RunSummary {
  workspaceId: string;
  investigations: number;
  touched: string[];
  notifications: number;
}

async function persistRun(deps: MonitoringDeps, ws: Workspace, r: MonitoringResult, kind: string, at: string): Promise<RunSummary> {
  return deps.tx.run(async (repos) => {
    for (const inv of r.investigations) await repos.investigations.save(ws.id, inv);
    let notifications = 0;
    for (const e of r.emails) {
      const { to: _to, from: _from, ...email } = e as EmailNotification;
      void _to;
      void _from;
      if (await repos.notifications.add(ws.id, { id: e.id, channel: 'in_app', dedupeKey: e.id, deliveredAt: e.sentAt, status: 'delivered', investigationId: e.investigationId, email })) notifications++;
    }
    const audit: AuditEntry = { id: uniqueId(`audit-${kind}`, at), workspaceId: ws.id, at, actor: { ref: 'system', displayName: 'Jagr' }, action: kind, detail: `${r.investigations.length} investigation(s), ${r.emails.length} notification(s) · ${r.log.map((l) => l.outcome).join(' | ').slice(0, 400)}` };
    await repos.audit.append(audit);
    return { workspaceId: ws.id, investigations: r.investigations.length, touched: [...new Set(r.log.flatMap((l) => l.investigationIds))], notifications };
  });
}

/** Another monitoring run holds this workspace; retry later. */
export class WorkspaceBusy extends Error {
  constructor() {
    super('A monitoring run is already in progress for this workspace.');
    this.name = 'WorkspaceBusy';
  }
}

/** A run lock outlives any single run; a crashed run's lock expires on its own. */
export const RUN_LOCK_MS = 15 * 60_000;

/**
 * One monitoring run per workspace at a time. Runs read the stored investigations and write them back
 * whole, so two concurrent runs (a scheduled job and a "run now", or two workers) would lose a pass.
 */
async function withRunLock<T>(deps: MonitoringDeps, workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const now = deps.clock.now();
  const owner = uniqueId('run', now);
  if (!(await deps.repos.locks.acquire(workspaceId, 'run', owner, new Date(Date.parse(now) + RUN_LOCK_MS).toISOString(), now))) throw new WorkspaceBusy();
  try {
    return await fn();
  } finally {
    await deps.repos.locks.release(workspaceId, 'run', owner);
  }
}

/** A scheduled watch run (job kind 'monitor.watch'): continue the workspace's investigations at the job's due time. */
export function runWatchJob(deps: MonitoringDeps, job: Pick<LeasedJob, 'workspaceId' | 'payload'>): Promise<RunSummary> {
  return withRunLock(deps, job.workspaceId, () => runWatchJobLocked(deps, job));
}

async function runWatchJobLocked(deps: MonitoringDeps, job: Pick<LeasedJob, 'workspaceId' | 'payload'>): Promise<RunSummary> {
  const ws = await deps.repos.workspaces.get(job.workspaceId);
  if (!ws) throw new Error(`Workspace ${job.workspaceId} not found.`);
  const watchId = String(job.payload.watchId);
  const at = String(job.payload.dueAt);
  const watches = await deps.repos.watches.list(ws.id);
  if (!watches.some((w) => w.id === watchId && w.status === 'active')) return { workspaceId: ws.id, investigations: 0, touched: [], notifications: 0 };
  const { registry, world, connections } = await sourcesForRun(deps, ws, at);
  const scheduled: ScheduledJob = { id: `run:${watchId}:${at}`, type: 'watch_run', at, watchId };
  const r = await runMonitoring({ world, registry, watches, connections, brief: ws.brief, window: { start: at, end: at }, jobs: [scheduled], investigations: await deps.repos.investigations.list(ws.id), planner: plannerFor(deps, ws), appBaseUrl: deps.appBaseUrl });
  const summary = await persistRun(deps, ws, r, 'monitor.watch', at);
  // Alerts the engine decided to send go to the workspace's outbound channels (after the run is saved).
  const alerts = r.emails.filter((e) => e.kind === 'alert').map((e) => alertMessage(ws.id, e, r.investigations.find((i) => i.id === e.investigationId), deps.appBaseUrl));
  if (ws.mode === 'connected') await deliver(deps, ws, alerts);
  return summary;
}

/**
 * Run monitoring over the whole data window now — how imported and sample workspaces run (their data
 * has its own time range, like the browser build). Replaces the workspace's investigations.
 */
export function runWorkspaceNow(deps: MonitoringDeps, workspaceId: string): Promise<RunSummary> {
  return withRunLock(deps, workspaceId, () => runWorkspaceNowLocked(deps, workspaceId));
}

async function runWorkspaceNowLocked(deps: MonitoringDeps, workspaceId: string): Promise<RunSummary> {
  const ws = await deps.repos.workspaces.get(workspaceId);
  if (!ws) throw new Error(`Workspace ${workspaceId} not found.`);
  const at = deps.clock.now();
  const { registry, world, connections } = await sourcesForRun(deps, ws, at);
  const stored = await deps.repos.watches.list(ws.id);
  const watches = ws.mode === 'imported' ? watchesForImportedData(stored, connections) : stored;
  const brief = ws.mode === 'imported' ? { ...ws.brief, time: world.end.slice(11, 16), timezone: 'UTC' } : ws.brief;
  const r = await runMonitoring({ world, registry, watches, connections, brief, planner: plannerFor(deps, ws), appBaseUrl: deps.appBaseUrl });
  return persistRun(deps, ws, r, 'monitor.run_now', at);
}

/** A morning brief (job kind 'brief.compose'): composed from the workspace's investigations, recorded as an in-app notification. */
export async function composeBriefJob(deps: MonitoringDeps, job: Pick<LeasedJob, 'workspaceId' | 'payload'>): Promise<void> {
  const ws = await deps.repos.workspaces.get(job.workspaceId);
  if (!ws) throw new Error(`Workspace ${job.workspaceId} not found.`);
  const at = String(job.payload.dueAt);
  const since = new Date(Date.parse(at) - 24 * 3_600_000).toISOString();
  const [watches, investigations, notifications, decisions] = await Promise.all([deps.repos.watches.list(ws.id), deps.repos.investigations.list(ws.id), deps.repos.notifications.list(ws.id), deps.repos.decisions.list(ws.id)]);
  // Alerts already shown in Jagr, so the brief can say an item was already sent rather than repeat it as news.
  const emails = notifications.filter((n) => n.channel === 'in_app' && n.email).map((n) => ({ ...(n.email as Omit<EmailNotification, 'to' | 'from'>), to: '', from: '' }));
  const brief = composeBrief({ at, since, watches, investigations, emails, log: [] });
  await deps.repos.briefs.save(ws.id, brief);
  await deps.repos.notifications.add(ws.id, { id: brief.id, channel: 'in_app', dedupeKey: `brief:${at}`, deliveredAt: at, status: 'delivered', detail: `${brief.headline} (${brief.items.length} item(s))` });
  // Sample and imported data are never sent to outbound channels.
  const decided = Object.fromEntries(decisions.map(({ actionId, decidedBy: _d, ...d }) => (void _d, [actionId, d])));
  if (ws.mode === 'connected') await deliver(deps, ws, [briefMessage(ws.id, brief, { investigations, watches, decisions: decided, appBaseUrl: deps.appBaseUrl })]);
}

/** Work through due jobs until the budget runs out. Failures retry with backoff, then dead-letter. */
export async function drainJobs(deps: MonitoringDeps & { queue: JobQueue }, opts: { workerId: string; limit: number; leaseMs: number }): Promise<{ done: number; failed: number }> {
  let done = 0;
  let failed = 0;
  const jobs = await deps.queue.claim({ workerId: opts.workerId, limit: opts.limit, leaseMs: opts.leaseMs });
  for (const job of jobs) {
    // Jobs in a batch run one after another: renew this job's lease before starting it, so a lease that ran
    // down while earlier jobs ran is never taken over by another worker mid-run. Lost it? Someone else has it.
    try {
      await deps.queue.extend(job.id, job.leaseToken, opts.leaseMs);
    } catch (e) {
      if (e instanceof LeaseLost) continue;
      throw e;
    }
    let error: Error | undefined;
    try {
      if (job.kind === 'monitor.watch') await runWatchJob(deps, job);
      else if (job.kind === 'brief.compose') await composeBriefJob(deps, job);
      else throw new Error(`No handler for job kind ${job.kind}.`);
    } catch (e) {
      error = e as Error;
    }
    // Settling can only fail if another worker took the job over meanwhile; then it is theirs to settle,
    // and one lost job never stops the rest of the batch.
    try {
      if (!error) {
        await deps.queue.complete(job.id, job.leaseToken);
        done++;
      } else {
        // A busy workspace (another run holds it) is retried soon; other failures back off exponentially.
        const backoff = error instanceof WorkspaceBusy ? 60_000 : Math.min(60, 2 ** job.attempts) * 60_000;
        await deps.queue.fail(job.id, job.leaseToken, error.message.slice(0, 500), new Date(Date.parse(deps.clock.now()) + backoff).toISOString());
        failed++;
      }
    } catch (e) {
      if (!(e instanceof LeaseLost)) throw e;
    }
  }
  return { done, failed };
}

/**
 * Probe a connection's credential and record the outcome on the connection. A rejected credential
 * marks it needs_reconnect (it will not be read until reconnected); an unreachable provider only
 * records the error — an outage is not a configuration change.
 */
export async function checkConnection(deps: MonitoringDeps, workspaceId: string, connectionId: string): Promise<ConnectorCheck> {
  const c = await deps.repos.connections.get(workspaceId, connectionId);
  if (!c) throw new Error(`Connection ${connectionId} not found.`);
  const connector = Object.prototype.hasOwnProperty.call(deps.connectors, c.provider) ? deps.connectors[c.provider] : undefined;
  const channel = !connector && !c.roles.length && deps.channels && Object.prototype.hasOwnProperty.call(deps.channels, c.provider) ? deps.channels[c.provider] : undefined;
  if (!connector && !channel) return { state: 'error', detail: `No connector for “${c.provider}” in this deployment.` };
  let result: ConnectorCheck;
  try {
    const secret = c.secretRef ? (await deps.secrets.get(c.secretRef)).secret : undefined;
    if (connector) result = await connector.check(c, { secret, http: deps.http, clock: deps.clock });
    else {
      // An outbound channel: verify its credential without sending anything (delivery outcomes are in the delivery log).
      try {
        result = await channel!(c, { secret, http: deps.http, clock: deps.clock }).check();
      } catch (e) {
        if (e instanceof SecretNotFound) throw e;
        result = { state: 'error', detail: (e as Error).message.slice(0, 300) };
      }
    }
  } catch (e) {
    if (!(e instanceof SecretNotFound)) throw e;
    result = { state: 'needs_reconnect', detail: 'The stored credential is missing; reconnect this source.' };
  }
  const now = deps.clock.now();
  const next: Connection =
    result.state === 'unavailable'
      ? { ...c, lastError: result.detail, lastErrorAt: now, updatedAt: now }
      : result.state === 'connected'
        ? { ...c, state: 'connected', detail: result.detail, externalAccount: result.account ?? c.externalAccount, capabilities: result.capabilities ?? c.capabilities, lastError: undefined, lastErrorAt: undefined, lastSuccessfulCheckAt: now, updatedAt: now }
        : { ...c, state: result.state, detail: result.detail, lastError: result.detail, lastErrorAt: now, updatedAt: now };
  await deps.repos.connections.save(workspaceId, next);
  return result;
}
