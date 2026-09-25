import type { ConnectionState, ISO } from '../types';
import type { Connection } from '../ports/persistence';
import type { Role } from '../roles/types';
import { findSensitive } from '../export/scan';

/**
 * The connections domain — what a workspace knows about each of its connections, as the product
 * shows it. Provider-agnostic: nothing here knows how a provider authenticates.
 *
 * A Connection (ports/persistence.ts) is the stored record; it holds an opaque SecretRef, never a
 * secret. A ConnectionView is what leaves the server: no SecretRef, no credential, no config value that
 * looks like one, and a derived health that answers "can Jagr read this right now, and how fresh is it?".
 */

export type ConnectionHealth =
  /** Credential verified and nothing has failed since. */
  | 'healthy'
  /** Credential not verified yet (a new connection that has not been checked or read). */
  | 'unverified'
  /** Readable, but its data stops well before now. */
  | 'stale'
  /** The last attempt failed for a reason other than the credential (outage, rate limit). */
  | 'degraded'
  /** The provider rejected the credential, or it is missing: reads stop until reconnected. */
  | 'needs_reconnect'
  /** The configuration is not usable. */
  | 'error'
  /** Not set up (or disconnected). */
  | 'not_configured'
  /** Simulated or imported data — health does not apply. */
  | 'not_applicable';

export interface ConnectionView {
  id: string;
  provider: string;
  source: string;
  displayName: string;
  /** Provider-side account / project / site label. Never an email address or a credential. */
  account?: string;
  roles: Role[];
  kind: 'source' | 'channel';
  /** Who manages the credential: the deployment environment (single-tenant) or the workspace (API). */
  managedBy: 'environment' | 'workspace' | 'none';
  authKind: Connection['authKind'];
  status: ConnectionState;
  health: ConnectionHealth;
  healthDetail: string;
  needsReconnect: boolean;
  freshAsOf?: ISO;
  capabilities: string[];
  /** Non-secret configuration (anything that looks like a credential is withheld). */
  config: Record<string, unknown>;
  createdAt: ISO;
  updatedAt: ISO;
  lastSuccessfulCheckAt?: ISO;
  lastSyncAt?: ISO;
  lastError?: string;
  lastErrorAt?: ISO;
}

/** Data older than this, for a connected source, is stale. */
export const STALE_AFTER_MS = 6 * 3_600_000;

/** Records stored before the connections domain carried every field. Idempotent. */
export function upgradeConnection(c: Connection): Connection & { createdAt: ISO } {
  return { ...c, createdAt: c.createdAt ?? c.updatedAt };
}

/** Configuration safe to show: drops any key or value the export scanner would flag as a credential or an email. */
const CREDENTIAL_KEY = /token|secret|passw|credential|auth|key$|apikey|private|cookie|session|bearer/i;
export function publicConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) if (!CREDENTIAL_KEY.test(k) && !findSensitive({ [k]: v }).length) out[k] = v;
  return out;
}

export function connectionHealth(c: Connection, now: ISO): { health: ConnectionHealth; detail: string } {
  switch (c.state) {
    case 'simulated':
    case 'imported':
      return { health: 'not_applicable', detail: c.state === 'simulated' ? 'Simulated data' : 'Imported data' };
    case 'not_configured':
      return { health: 'not_configured', detail: c.detail || 'Not configured' };
    case 'needs_reconnect':
      return { health: 'needs_reconnect', detail: c.detail || 'Reconnect this source to read it again' };
    case 'error':
      return { health: 'error', detail: c.lastError ?? c.detail ?? 'Configuration error' };
    case 'unavailable':
      return { health: 'degraded', detail: c.lastError ?? c.detail ?? 'Unavailable' };
  }
  // connected
  const lastOk = c.lastSuccessfulCheckAt ?? c.lastSyncAt;
  if (c.lastError && (!lastOk || (c.lastErrorAt ?? c.updatedAt) > lastOk)) return { health: 'degraded', detail: c.lastError };
  if (c.freshAsOf && Date.parse(now) - Date.parse(c.freshAsOf) > STALE_AFTER_MS) return { health: 'stale', detail: `Data complete only up to ${c.freshAsOf}` };
  if (!lastOk) return { health: 'unverified', detail: 'Not checked yet' };
  return { health: 'healthy', detail: `Verified ${lastOk}` };
}

export function connectionView(raw: Connection, now: ISO): ConnectionView {
  const c = upgradeConnection(raw);
  const { health, detail } = connectionHealth(c, now);
  return {
    id: c.id,
    provider: c.provider,
    source: c.source,
    displayName: c.label?.name ?? c.source,
    account: c.externalAccount && !findSensitive(c.externalAccount).length ? c.externalAccount : undefined,
    roles: c.roles,
    kind: c.roles.length ? 'source' : 'channel',
    managedBy: c.authKind === 'owner_env' ? 'environment' : c.authKind === 'simulated' || c.authKind === 'import' ? 'none' : 'workspace',
    authKind: c.authKind,
    status: c.state,
    health,
    healthDetail: detail,
    needsReconnect: c.state === 'needs_reconnect',
    freshAsOf: c.freshAsOf,
    capabilities: c.capabilities ?? c.roles,
    config: publicConfig(c.config),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    lastSuccessfulCheckAt: c.lastSuccessfulCheckAt,
    lastSyncAt: c.lastSyncAt,
    lastError: c.lastError,
    lastErrorAt: c.lastErrorAt,
  };
}
