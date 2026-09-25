import type { ConnectionState, ISO, SourceConnection } from '../types';
import { BUILTIN_SOURCE_ROLES } from '../catalog';
import { PROVIDERS } from '../integrations/adapters';
import { healthOf, isSourceId, type Role, type SourceId } from '../roles/types';
import type { ConnectionHealth, ConnectionView } from '../connections/model';

/**
 * Presentation view-models for the Sources page. Read-only derivations over the connection model —
 * no behaviour, no invented data. Anything the browser build cannot know (a server connection's
 * account, verified health, last successful check) comes from the server's ConnectionView
 * (connections/model.ts) through `server` below, and is simply absent otherwise.
 */

/** How the Sources page groups a source, in display order. STALE is a connected-looking source whose data stops early. */
export const SOURCE_GROUPS = ['connected', 'stale', 'needs_reconnect', 'unavailable', 'error', 'not_configured', 'imported', 'simulated'] as const;
export type SourceGroup = (typeof SOURCE_GROUPS)[number];

export const SOURCE_GROUP_LABEL: Record<SourceGroup, string> = {
  connected: 'Connected',
  stale: 'Stale',
  needs_reconnect: 'Needs reconnect',
  unavailable: 'Unavailable',
  error: 'Error',
  not_configured: 'Not configured',
  imported: 'User import',
  simulated: 'Simulated',
};

export const ROLE_LABEL: Record<Role, string> = {
  metrics: 'Metrics',
  changes: 'Changes',
  work_items: 'Work items',
  feedback: 'Feedback',
  conversations: 'Conversations',
  context: 'Context',
};

export type SourceActionId = 'connect' | 'test' | 'reconnect' | 'disconnect';

export interface SourceAction {
  id: SourceActionId;
  label: string;
  available: boolean;
  /** Why it is (un)available — always shown, so a disabled control is never a mystery. */
  reason: string;
}

export interface SourceView {
  id: SourceId;
  name: string;
  short: string;
  group: SourceGroup;
  state: ConnectionState;
  roles: Role[];
  detail: string;
  /** Health in the connections domain's vocabulary (healthy, stale, degraded, not_applicable, …). */
  health: ConnectionHealth;
  healthDetail: string;
  /** External account / project, when a server connection reports one. */
  account?: string;
  /** Data is complete up to here (last successful sync). */
  freshAsOf?: ISO;
  /** How far behind the data is, in minutes, when stale. */
  behindMinutes?: number;
  /** Last successful check / sync / import, when known. */
  lastCheck?: ISO;
  lastCheckLabel?: string;
  /** What this state means for investigations. */
  impact: string;
  actions: SourceAction[];
}

export interface SourceViewOptions {
  /** The time investigations need data up to (the run window's end). Decides staleness. */
  asOf: ISO;
  /** Latest import time per source, for user imports. */
  lastImport?: (id: SourceId) => ISO | undefined;
  /**
   * Server-backed workspaces: the ConnectionView the API returns (GET /api/workspaces/:id). When
   * present it is authoritative for account, health and last check, and Test maps to
   * POST /api/workspaces/:id/connections/:id/check. The browser-local workspace passes nothing.
   */
  server?: Partial<Record<SourceId, ConnectionView>>;
}

const NO_OAUTH = 'Connecting from this page (OAuth) isn’t built yet. Live connectors run on a Jagr server, with credentials the workspace owner configures there.';
const NO_ENDPOINT = 'There is no endpoint for this yet. The workspace owner changes it in the server configuration.';
const BROWSER_ONLY = 'Testing runs on the Jagr server. This workspace lives in your browser, so there is no server connection to test.';

function groupOf(conn: SourceConnection, stale: boolean, view?: ConnectionView): SourceGroup {
  if (view) return view.health === 'stale' ? 'stale' : view.health === 'needs_reconnect' ? 'needs_reconnect' : view.status;
  if (stale) return 'stale';
  return conn.state;
}

/**
 * Browser-local health, in the connections domain's vocabulary. Browser connections are never
 * verified credentials, so there is no "healthy" here — only what the state and freshness say.
 */
function browserHealth(conn: SourceConnection, stale: boolean): { health: ConnectionHealth; detail: string } {
  if (stale) return { health: 'stale', detail: `Data complete only up to ${conn.freshAsOf}` };
  switch (conn.state) {
    case 'simulated':
      return { health: 'not_applicable', detail: 'Simulated data' };
    case 'imported':
      return { health: 'not_applicable', detail: 'Imported data' };
    case 'unavailable':
      return { health: 'degraded', detail: conn.detail };
    case 'error':
      return { health: 'error', detail: conn.detail };
    case 'needs_reconnect':
      return { health: 'needs_reconnect', detail: conn.detail };
    case 'not_configured':
      return { health: 'not_configured', detail: conn.detail };
    case 'connected':
      return { health: 'unverified', detail: 'Not verified from this browser' };
  }
}

function impactOf(group: SourceGroup, freshAsOf?: ISO): string {
  switch (group) {
    case 'connected':
      return 'Read on every scheduled check. Records link back to the source.';
    case 'stale':
      return `Data is complete only up to ${freshAsOf ? fmtClock(freshAsOf) : 'its last sync'}. Jagr will not treat missing records after then as evidence that nothing happened — anything later is reported as not seen.`;
    case 'needs_reconnect':
      return 'The configuration exists, but credentials never travel with a workspace. Until it is reconnected, investigations record this source as a gap.';
    case 'unavailable':
      return 'The source cannot be reached. Investigations record a gap for it — never “nothing found”.';
    case 'error':
      return 'The source answered with an error. Investigations record a gap for it until the error is resolved.';
    case 'not_configured':
      return 'Left out of investigations. Watches that use it show it as not checked.';
    case 'imported':
      return 'Your uploaded files. Investigated as imported data and labelled USER IMPORT wherever it appears.';
    case 'simulated':
      return 'Deterministic fixture data, labelled SIMULATED everywhere it appears. Never presented as live.';
  }
}

function actionsFor(group: SourceGroup, view: ConnectionView | undefined): SourceAction[] {
  const test: SourceAction = view && view.managedBy !== 'none'
    ? { id: 'test', label: 'Test', available: true, reason: 'Probes the stored credential now and records the outcome on the connection.' }
    : { id: 'test', label: 'Test', available: false, reason: BROWSER_ONLY };
  const reconnect: SourceAction = { id: 'reconnect', label: 'Reconnect', available: false, reason: NO_ENDPOINT };
  const disconnect: SourceAction = { id: 'disconnect', label: 'Disconnect', available: false, reason: NO_ENDPOINT };
  switch (group) {
    case 'connected':
    case 'stale':
    case 'unavailable':
      return [test, disconnect];
    case 'error':
    case 'needs_reconnect':
      return [reconnect, test, disconnect];
    case 'not_configured':
      return [{ id: 'connect', label: 'Connect', available: false, reason: NO_OAUTH }];
    case 'imported':
    case 'simulated':
      return [];
  }
}

function fmtClock(iso: ISO): string {
  return `${iso.slice(11, 16)} UTC`;
}

export function fmtBehind(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** Every evidence source in the workspace (outbound channels such as email are not sources). */
export function sourceViews(connections: SourceConnection[], opts: SourceViewOptions): SourceView[] {
  const views: SourceView[] = [];
  for (const conn of connections) {
    if (!isSourceId(conn.provider)) continue;
    const id = conn.provider;
    const stale = healthOf(id, conn, opts.asOf).state === 'stale';
    const group = groupOf(conn, stale, opts.server?.[id]);
    const view = opts.server?.[id];
    const health = view ? { health: view.health, detail: view.healthDetail } : browserHealth(conn, stale);
    const imported = group === 'imported' ? opts.lastImport?.(id) : undefined;
    const verified = view?.lastSuccessfulCheckAt ?? view?.lastSyncAt;
    const lastCheck = verified ?? conn.freshAsOf ?? imported ?? (group === 'connected' || group === 'error' || group === 'unavailable' || group === 'needs_reconnect' ? conn.updatedAt : undefined);
    views.push({
      id,
      name: conn.label?.name ?? PROVIDERS[id].name,
      short: conn.label?.short ?? PROVIDERS[id].short,
      group,
      state: conn.state,
      roles: BUILTIN_SOURCE_ROLES[id] ?? [],
      detail: conn.detail,
      health: health.health,
      healthDetail: health.detail,
      account: view?.account,
      freshAsOf: conn.freshAsOf,
      behindMinutes: stale && conn.freshAsOf ? Math.max(0, (Date.parse(opts.asOf) - Date.parse(conn.freshAsOf)) / 60_000) : undefined,
      lastCheck,
      lastCheckLabel: lastCheck ? (group === 'imported' ? 'Last imported' : view?.lastSuccessfulCheckAt ? 'Last successful check' : group === 'stale' || view?.lastSyncAt ? 'Last successful sync' : 'Last status change') : undefined,
      impact: impactOf(group, conn.freshAsOf),
      // Simulated and imported sources have no live connection to test, reconnect or disconnect.
      actions: conn.state === 'simulated' || conn.state === 'imported' ? [] : actionsFor(group, view),
    });
  }
  return views.sort((a, b) => SOURCE_GROUPS.indexOf(a.group) - SOURCE_GROUPS.indexOf(b.group));
}

export function groupSources(views: SourceView[]): { group: SourceGroup; sources: SourceView[] }[] {
  return SOURCE_GROUPS.map((group) => ({ group, sources: views.filter((v) => v.group === group) })).filter((g) => g.sources.length > 0);
}
