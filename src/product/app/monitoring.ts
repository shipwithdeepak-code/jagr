import type { EmailNotification, MonitoringResult, ScheduledJob, SourceConnection } from '../types';
import type { Clock } from '../ports/clock';
import type { HttpClient } from '../ports/http';
import type { JobQueue, LeasedJob } from '../ports/jobs';
import type { AuditEntry, Connection, Repositories, Transactor, Workspace } from '../ports/persistence';
import type { SecretPayload, SecretStore } from '../ports/secrets';
import type { ImportedDataset } from '../imports/schemas';
import type { RegisteredSource } from '../roles/types';
import { SourceRegistry } from '../roles/registry';
import type { World } from '../integrations/world';
import { defaultWorld } from '../integrations/world';
import { createRegistry } from '../integrations/adapters';
import { buildImportedWorld, watchesForImportedData } from '../imports/world';
import { runMonitoring } from '../engine/monitor';
import { composeBrief } from '../engine/brief';
import type { InvestigationPlanner } from '../agent/planner';

/**
 * Server-side monitoring — the same engine the browser runs, driven by the job queue and persisted
 * through the Repositories port. Provider-agnostic: a workspace's sources are built from its
 * connections by connector factories registered at the composition root.
 */

/** Builds one source from a connection. Registered per connector provider ('amplitude', 'github', …). */
export type ConnectorFactory = (conn: Connection, ctx: { secret?: SecretPayload; http: HttpClient; clock: Clock }) => RegisteredSource;

export interface MonitoringDeps {
  repos: Repositories;
  tx: Transactor;
  clock: Clock;
  secrets: SecretStore;
  http: HttpClient;
  connectors: Record<string, ConnectorFactory>;
  planner?: InvestigationPlanner;
  appBaseUrl?: string;
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
    const factory = c.provider in deps.connectors ? deps.connectors[c.provider] : undefined;
    const readable = !!factory && c.state !== 'needs_reconnect' && c.state !== 'not_configured';
    const secret = readable && c.secretRef ? (await deps.secrets.get(c.secretRef)).secret : undefined;
    if (readable && factory) sources.push(factory(c, { secret, http: deps.http, clock: deps.clock }));
    const hasConnector = c.provider in deps.connectors;
    connections.push(readable ? toSourceConnection(c) : { ...toSourceConnection(c), state: c.state === 'needs_reconnect' ? 'needs_reconnect' : 'not_configured', detail: hasConnector ? c.detail : `No connector for “${c.provider}” in this deployment.` });
  }
  // Live sources are read "as of" the run; a day of history gives detection its baseline window.
  const world: World = { id: `live-${ws.id}`, name: ws.name, start: new Date(Date.parse(at) - 24 * 3_600_000).toISOString(), end: at, metrics: [], issues: [], releases: [], reviews: [] };
  return { registry: new SourceRegistry(sources), world, connections };
}

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
    const audit: AuditEntry = { id: `audit-${kind}-${at}`, workspaceId: ws.id, at, actor: { ref: 'system', displayName: 'Jagr' }, action: kind, detail: `${r.investigations.length} investigation(s), ${r.emails.length} notification(s) · ${r.log.map((l) => l.outcome).join(' | ').slice(0, 400)}` };
    await repos.audit.append(audit);
    return { workspaceId: ws.id, investigations: r.investigations.length, touched: [...new Set(r.log.flatMap((l) => l.investigationIds))], notifications };
  });
}

/** A scheduled watch run (job kind 'monitor.watch'): continue the workspace's investigations at the job's due time. */
export async function runWatchJob(deps: MonitoringDeps, job: Pick<LeasedJob, 'workspaceId' | 'payload'>): Promise<RunSummary> {
  const ws = await deps.repos.workspaces.get(job.workspaceId);
  if (!ws) throw new Error(`Workspace ${job.workspaceId} not found.`);
  const watchId = String(job.payload.watchId);
  const at = String(job.payload.dueAt);
  const watches = await deps.repos.watches.list(ws.id);
  if (!watches.some((w) => w.id === watchId && w.status === 'active')) return { workspaceId: ws.id, investigations: 0, touched: [], notifications: 0 };
  const { registry, world, connections } = await sourcesForRun(deps, ws, at);
  const scheduled: ScheduledJob = { id: `run:${watchId}:${at}`, type: 'watch_run', at, watchId };
  const r = await runMonitoring({ world, registry, watches, connections, brief: ws.brief, window: { start: at, end: at }, jobs: [scheduled], investigations: await deps.repos.investigations.list(ws.id), planner: deps.planner, appBaseUrl: deps.appBaseUrl });
  return persistRun(deps, ws, r, 'monitor.watch', at);
}

/**
 * Run monitoring over the whole data window now — how imported and sample workspaces run (their data
 * has its own time range, like the browser build). Replaces the workspace's investigations.
 */
export async function runWorkspaceNow(deps: MonitoringDeps, workspaceId: string): Promise<RunSummary> {
  const ws = await deps.repos.workspaces.get(workspaceId);
  if (!ws) throw new Error(`Workspace ${workspaceId} not found.`);
  const at = deps.clock.now();
  const { registry, world, connections } = await sourcesForRun(deps, ws, at);
  const stored = await deps.repos.watches.list(ws.id);
  const watches = ws.mode === 'imported' ? watchesForImportedData(stored, connections) : stored;
  const brief = ws.mode === 'imported' ? { ...ws.brief, time: world.end.slice(11, 16), timezone: 'UTC' } : ws.brief;
  const r = await runMonitoring({ world, registry, watches, connections, brief, planner: deps.planner, appBaseUrl: deps.appBaseUrl });
  return persistRun(deps, ws, r, 'monitor.run_now', at);
}

/** A morning brief (job kind 'brief.compose'): composed from the workspace's investigations, recorded as an in-app notification. */
export async function composeBriefJob(deps: MonitoringDeps, job: Pick<LeasedJob, 'workspaceId' | 'payload'>): Promise<void> {
  const ws = await deps.repos.workspaces.get(job.workspaceId);
  if (!ws) throw new Error(`Workspace ${job.workspaceId} not found.`);
  const at = String(job.payload.dueAt);
  const since = new Date(Date.parse(at) - 24 * 3_600_000).toISOString();
  const brief = composeBrief({ at, since, watches: await deps.repos.watches.list(ws.id), investigations: await deps.repos.investigations.list(ws.id), emails: [], log: [] });
  await deps.repos.notifications.add(ws.id, { id: brief.id, channel: 'in_app', dedupeKey: `brief:${at}`, deliveredAt: at, status: 'delivered', detail: `${brief.headline} (${brief.items.length} item(s))` });
}

/** Work through due jobs until the budget runs out. Failures retry with backoff, then dead-letter. */
export async function drainJobs(deps: MonitoringDeps & { queue: JobQueue }, opts: { workerId: string; limit: number; leaseMs: number }): Promise<{ done: number; failed: number }> {
  let done = 0;
  let failed = 0;
  const jobs = await deps.queue.claim({ workerId: opts.workerId, limit: opts.limit, leaseMs: opts.leaseMs });
  for (const job of jobs) {
    try {
      if (job.kind === 'monitor.watch') await runWatchJob(deps, job);
      else if (job.kind === 'brief.compose') await composeBriefJob(deps, job);
      else throw new Error(`No handler for job kind ${job.kind}.`);
      await deps.queue.complete(job.id, job.leaseToken);
      done++;
    } catch (e) {
      const backoff = Math.min(60, 2 ** job.attempts) * 60_000;
      await deps.queue.fail(job.id, job.leaseToken, (e as Error).message.slice(0, 500), new Date(Date.parse(deps.clock.now()) + backoff).toISOString());
      failed++;
    }
  }
  return { done, failed };
}
