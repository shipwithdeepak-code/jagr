import type { ProviderId } from '../types.js';
import type { Actor, Connection, Workspace } from '../ports/persistence.js';
import type { SecretPayload } from '../ports/secrets.js';
import type { Role } from '../roles/types.js';
import { SecretNotFound } from '../ports/secrets.js';
import { connectionView, type ConnectionView } from '../connections/model.js';
import { checkConnection, type MonitoringDeps } from './monitoring.js';
import { uniqueId } from './ids.js';

/**
 * Connection lifecycle — connect / configure, test, reconnect, disconnect — for credentials a workspace
 * member enters (API keys and tokens). Provider-agnostic: each provider contributes a ConnectionType
 * (its roles, the credential fields it needs, and its own config validation) from the composition root.
 *
 * Rules:
 *   - one connection per provider per workspace (the current source-id model)
 *   - credentials go straight into the SecretStore; the connection holds an opaque ref
 *   - connections managed by the deployment environment (single-tenant owner credentials) can be
 *     tested but not changed here
 *   - only connected workspaces take connections (sample and imported data are never mixed with live)
 *   - every change is audited — by field name, never by value
 */

export interface ConnectionType {
  provider: string;
  source: ProviderId;
  name: string;
  roles: Role[];
  kind: 'source' | 'channel';
  /** The credential fields a member supplies (stored as one api_key secret). */
  credentialFields: { key: string; label: string }[];
  /** A starting configuration to edit (placeholders, never real values). */
  configExample: Record<string, unknown>;
  /** The provider's own config validation. */
  parseConfig(config: unknown): { ok: true; config: Record<string, unknown> } | { ok: false; errors: string[] };
}

export type ConnectionTypeInfo = Omit<ConnectionType, 'parseConfig'>;
export const typeInfo = ({ parseConfig: _p, ...rest }: ConnectionType): ConnectionTypeInfo => (void _p, rest);

export class ConnectionError extends Error {
  constructor(
    readonly code: 'unknown_provider' | 'invalid_config' | 'invalid_credential' | 'managed_by_environment' | 'not_found' | 'wrong_workspace_mode',
    message: string,
  ) {
    super(message);
    this.name = 'ConnectionError';
  }
}

export interface ConnectionDeps extends MonitoringDeps {
  types: Record<string, ConnectionType>;
}

const MAX_FIELD = 8192;

function credentialFrom(type: ConnectionType, credential: Record<string, unknown> | undefined): SecretPayload {
  const fields: Record<string, string> = {};
  const missing: string[] = [];
  for (const f of type.credentialFields) {
    const v = credential?.[f.key];
    if (typeof v !== 'string' || !v.trim() || v.length > MAX_FIELD) missing.push(f.label);
    else fields[f.key] = v.trim();
  }
  if (missing.length) throw new ConnectionError('invalid_credential', `${type.name} needs: ${missing.join(', ')}.`);
  const extra = Object.keys(credential ?? {}).filter((k) => !type.credentialFields.some((f) => f.key === k));
  if (extra.length) throw new ConnectionError('invalid_credential', `${type.name} does not take: ${extra.join(', ')}.`);
  return { kind: 'api_key', fields };
}

function typeFor(deps: ConnectionDeps, provider: string): ConnectionType {
  const t = Object.prototype.hasOwnProperty.call(deps.types, provider) ? deps.types[provider] : undefined;
  if (!t) throw new ConnectionError('unknown_provider', `No connector for “${provider}” in this deployment.`);
  return t;
}

async function audit(deps: ConnectionDeps, ws: Workspace, actor: Actor, action: string, target: string, detail: string) {
  const at = deps.clock.now();
  await deps.repos.audit.append({ id: uniqueId(`audit-${action}-${target}`, at), workspaceId: ws.id, at, actor, action, target, detail });
}

async function viewAfterCheck(deps: ConnectionDeps, ws: Workspace, id: string) {
  const check = await checkConnection(deps, ws.id, id);
  return { connection: connectionView((await deps.repos.connections.get(ws.id, id))!, deps.clock.now()), check };
}

export async function listConnections(deps: Pick<ConnectionDeps, 'repos' | 'clock'>, workspaceId: string): Promise<ConnectionView[]> {
  return (await deps.repos.connections.list(workspaceId)).map((c) => connectionView(c, deps.clock.now()));
}

/** Connect a provider, or change its configuration and credential. Tests it before returning. */
export async function configureConnection(deps: ConnectionDeps, ws: Workspace, actor: Actor, input: { provider: string; config: unknown; credential?: Record<string, unknown> }) {
  if (ws.mode !== 'connected') throw new ConnectionError('wrong_workspace_mode', 'Only connected workspaces take live connections; sample and imported data are never mixed with live data.');
  const type = typeFor(deps, input.provider);
  const parsed = type.parseConfig(input.config ?? {});
  if (!parsed.ok) throw new ConnectionError('invalid_config', `${type.name} configuration is invalid: ${parsed.errors.join('; ')}.`);
  const id = `conn-${type.provider}`;
  const existing = (await deps.repos.connections.list(ws.id)).find((c) => c.source === type.source);
  if (existing?.authKind === 'owner_env') throw new ConnectionError('managed_by_environment', `${type.name} is configured by this deployment's environment; change it there.`);
  const now = deps.clock.now();
  // A new connection needs a credential; reconfiguring may keep the stored one.
  let secretRef = existing?.secretRef;
  if (input.credential || !secretRef) {
    const payload = credentialFrom(type, input.credential);
    secretRef = await replaceOrPut(deps, ws.id, existing?.id ?? id, secretRef, payload);
  }
  const conn: Connection = {
    id: existing?.id ?? id,
    workspaceId: ws.id,
    source: type.source,
    provider: type.provider,
    roles: type.roles,
    authKind: 'api_key',
    state: 'connected',
    detail: `${type.name} — not checked yet`,
    label: { name: type.name, short: type.name },
    config: parsed.config,
    secretRef,
    createdAt: existing?.createdAt ?? existing?.updatedAt ?? now,
    updatedAt: now,
  };
  await deps.repos.connections.save(ws.id, conn);
  await audit(deps, ws, actor, existing ? 'connection.configured' : 'connection.connected', conn.id, `${type.name}: configuration${input.credential ? ' and credential' : ''} saved (${[...Object.keys(parsed.config), ...(input.credential ? type.credentialFields.map((f) => f.key) : [])].join(', ')}).`);
  return viewAfterCheck(deps, ws, conn.id);
}

/** New credential for an existing connection (e.g. after "needs reconnect"). Keeps its configuration. */
export async function reconnectConnection(deps: ConnectionDeps, ws: Workspace, actor: Actor, connectionId: string, credential: Record<string, unknown> | undefined) {
  const c = await deps.repos.connections.get(ws.id, connectionId);
  if (!c) throw new ConnectionError('not_found', 'Connection not found.');
  if (c.authKind === 'owner_env') throw new ConnectionError('managed_by_environment', 'This connection is configured by the deployment environment; change it there.');
  const type = typeFor(deps, c.provider);
  const secretRef = await replaceOrPut(deps, ws.id, c.id, c.secretRef, credentialFrom(type, credential));
  await deps.repos.connections.save(ws.id, { ...c, secretRef, state: 'connected', detail: `${type.name} — reconnected, not checked yet`, lastError: undefined, lastErrorAt: undefined, updatedAt: deps.clock.now() });
  await audit(deps, ws, actor, 'connection.reconnected', c.id, `${type.name}: new credential stored (${type.credentialFields.map((f) => f.key).join(', ')}).`);
  return viewAfterCheck(deps, ws, c.id);
}

/** Stop reading a source: the stored credential is deleted; the connection stays (not configured) so history keeps its name. */
export async function disconnectConnection(deps: ConnectionDeps, ws: Workspace, actor: Actor, connectionId: string): Promise<ConnectionView> {
  const c = await deps.repos.connections.get(ws.id, connectionId);
  if (!c) throw new ConnectionError('not_found', 'Connection not found.');
  if (c.authKind === 'owner_env') throw new ConnectionError('managed_by_environment', 'This connection is configured by the deployment environment; remove its variables there.');
  if (c.secretRef) await deps.secrets.delete(c.secretRef).catch((e) => { if (!(e instanceof SecretNotFound)) throw e; });
  const { secretRef: _r, ...rest } = c;
  void _r;
  const next: Connection = { ...rest, state: 'not_configured', detail: 'Disconnected', lastError: undefined, lastErrorAt: undefined, updatedAt: deps.clock.now() };
  await deps.repos.connections.save(ws.id, next);
  await audit(deps, ws, actor, 'connection.disconnected', c.id, `${c.label?.name ?? c.provider}: disconnected; stored credential deleted.`);
  return connectionView(next, deps.clock.now());
}

async function replaceOrPut(deps: ConnectionDeps, workspaceId: string, connectionId: string, ref: Connection['secretRef'], payload: SecretPayload) {
  if (ref) {
    try {
      const cur = await deps.secrets.get(ref);
      await deps.secrets.replace(ref, cur.version, payload);
      return ref;
    } catch (e) {
      if (!(e instanceof SecretNotFound)) throw e;
    }
  }
  return deps.secrets.put({ workspaceId, connectionId }, payload);
}
