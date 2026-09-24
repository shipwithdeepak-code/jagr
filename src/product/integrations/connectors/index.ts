import type { Connector } from '../../app/monitoring';
import type { ConnectorDescriptor } from './types';
import { checkConnector, connectorFactory } from './runtime';
import { amplitudeConnector } from './amplitude';
import { githubConnector } from './github';

/**
 * The connectors this build ships. The composition root registers them; a connection whose provider
 * is not listed here is reported as a gap ("No connector …"), never replaced by sample data.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CONNECTORS: ConnectorDescriptor<any>[] = [amplitudeConnector, githubConnector];

export function connectorsFrom(list: ConnectorDescriptor<unknown>[]): Record<string, Connector> {
  return Object.fromEntries(list.map((d) => [d.id, { build: connectorFactory(d), check: (conn, ctx) => checkConnector(d, conn, ctx) } satisfies Connector]));
}

export type { ConnectorDescriptor, ConnectorContext, ConnectorCheck } from './types';
