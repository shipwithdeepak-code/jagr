import type { z } from 'zod';
import type { ISO, SourceConnection } from '../../types';
import type { Clock } from '../../ports/clock';
import type { HttpClient } from '../../ports/http';
import type { Connection } from '../../ports/persistence';
import type { SecretPayload } from '../../ports/secrets';
import type { RegisteredSource, Role, SourceId } from '../../roles/types';

/**
 * The connector contract. A connector turns one workspace connection (non-secret config + a
 * credential read from the SecretStore) into a role source. It is pure: all I/O goes through the
 * HttpClient it is given, which is restricted to the hosts the connector declares.
 *
 * Every connector must:
 *   - map provider records into role records with complete provenance (connection, external id, link, times)
 *   - read "as of" the run — nothing after the window end
 *   - throw ProviderUnavailableError when it cannot answer (network, auth, rate limit, 5xx, bad response);
 *     never return an empty list for a failed read — a failure is a gap, never evidence of absence
 *   - never put a credential into a record, an error message or a log line
 *   - touch only its own connection's credential and its declared hosts
 * `testkit/connectorContract.ts` checks all of this against recorded provider responses.
 */

export interface ConnectorContext<C> {
  connection: Connection;
  config: C;
  secret: SecretPayload;
  /** Restricted to `hosts(config)`; https only. */
  http: HttpClient;
  clock: Clock;
}

export interface ConnectorCheck {
  /** connected: credentials work · needs_reconnect: credentials rejected · unavailable: could not reach it · error: misconfigured. */
  state: 'connected' | 'needs_reconnect' | 'unavailable' | 'error';
  detail: string;
  /** A non-secret account label, e.g. the project or org name. */
  account?: string;
  /** Capabilities / scopes the credential was found to have (non-secret), when the provider reports them. */
  capabilities?: string[];
}

export interface ConnectorDescriptor<C = unknown> {
  /** Connector id (Connection.provider). */
  id: string;
  /** The source id records carry. */
  source: SourceId;
  name: string;
  roles: Role[];
  /** Non-secret configuration, validated before anything is built. */
  config: z.ZodType<C>;
  /** Credential kinds the connector accepts. */
  secretKinds: SecretPayload['kind'][];
  /** The api_key credential fields a workspace member enters to connect it. */
  credentialFields: { key: string; label: string }[];
  /** Hosts the connector may call for this config. Anything else is refused. */
  hosts(config: C): string[];
  /** Build the role source. No network calls here. */
  build(ctx: ConnectorContext<C>): Omit<RegisteredSource, 'id' | 'connection'> & { connection?: Partial<SourceConnection> };
  /** A cheap authenticated call that proves the credential works. */
  check(ctx: ConnectorContext<C>): Promise<ConnectorCheck>;
}

/** Common connector bookkeeping, for building provenance. */
export interface ReadStamp {
  connectionId: string;
  provider: string;
  source: SourceId;
  fetchedAt: ISO;
}
