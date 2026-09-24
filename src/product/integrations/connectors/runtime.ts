import type { SourceConnection } from '../../types';
import type { Connection } from '../../ports/persistence';
import type { RegisteredSource, Provenance, SourceMode } from '../../roles/types';
import type { ConnectorFactory } from '../../app/monitoring';
import type { ConnectorCheck, ConnectorDescriptor, ReadStamp } from './types';
import { restrictHosts } from './http';
import { ConnectorConfigError } from './errors';
import type { SecretPayload } from '../../ports/secrets';
import type { HttpClient } from '../../ports/http';
import type { Clock } from '../../ports/clock';

/** Provenance for a record read live from a connector. */
export function provenance(stamp: ReadStamp, externalId: string, observedAt: string, url?: string): Provenance {
  const mode: SourceMode = 'connected';
  return { source: stamp.source, provider: stamp.provider, connectionId: stamp.connectionId, mode, externalId, url, observedAt, fetchedAt: stamp.fetchedAt };
}

function prepare<C>(d: ConnectorDescriptor<C>, conn: Connection, ctx: { secret?: SecretPayload; http: HttpClient; clock: Clock }) {
  const parsed = d.config.safeParse(conn.config);
  if (!parsed.success) throw new ConnectorConfigError(`${d.name} configuration is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'config'} ${i.message}`).join('; ')}.`);
  if (!ctx.secret) throw new ConnectorConfigError(`${d.name} has no stored credential.`);
  if (!d.secretKinds.includes(ctx.secret.kind)) throw new ConnectorConfigError(`${d.name} cannot use a ${ctx.secret.kind} credential.`);
  return { connection: conn, config: parsed.data, secret: ctx.secret, http: restrictHosts(ctx.http, d.hosts(parsed.data), d.source), clock: ctx.clock };
}

/** Turn a descriptor into the factory the monitoring service registers. */
export function connectorFactory<C>(d: ConnectorDescriptor<C>): ConnectorFactory {
  return (conn, ctx) => {
    const c = prepare(d, conn, ctx);
    const built = d.build(c);
    const connection: SourceConnection = { provider: d.source, state: 'connected', detail: conn.detail, updatedAt: conn.updatedAt, label: conn.label, ...built.connection };
    const src: RegisteredSource = { ...built, id: d.source, connection };
    return src;
  };
}

/** Probe a connection's credential. Never throws: every outcome is a state and a safe message. */
export async function checkConnector<C>(d: ConnectorDescriptor<C>, conn: Connection, ctx: { secret?: SecretPayload; http: HttpClient; clock: Clock }): Promise<ConnectorCheck> {
  try {
    return await d.check(prepare(d, conn, ctx));
  } catch (e) {
    if (e instanceof ConnectorConfigError) return { state: 'error', detail: e.message };
    const name = (e as Error)?.name;
    if (name === 'ConnectorAuthError') return { state: 'needs_reconnect', detail: (e as Error).message };
    if (name === 'ProviderUnavailableError' || name === 'ConnectorRateLimited') return { state: (e as { state: string }).state === 'error' ? 'error' : 'unavailable', detail: (e as Error).message };
    return { state: 'error', detail: `${d.name} check failed unexpectedly.` };
  }
}
