import type { ConnectionType } from '../app/connections.js';
import type { ConnectorDescriptor } from './connectors/types.js';
import { CONNECTORS } from './connectors/index.js';
import { SlackConfig } from './channels/slack.js';

/**
 * The connection types this build offers (Connection.provider → type): every connector, plus the
 * outbound Slack channel. Config validation is each provider's own schema; credentials are the api_key
 * fields the provider declares.
 */
const zodParse = (schema: { safeParse(v: unknown): { success: true; data: unknown } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }) => (config: unknown) => {
  const r = schema.safeParse(config);
  return r.success ? { ok: true as const, config: r.data as Record<string, unknown> } : { ok: false as const, errors: r.error.issues.map((i) => `${i.path.map(String).join('.') || 'config'} ${i.message}`) };
};

/** Starting configurations shown in the connect form — placeholders to edit, never real values. */
const EXAMPLES: Record<string, Record<string, unknown>> = {
  amplitude: { region: 'us', metrics: [{ kind: 'ratio', key: 'checkout_conversion', name: 'Checkout conversion', area: 'checkout', numerator: { event_type: 'Order Completed' }, denominator: { event_type: 'Checkout Started' }, badDirection: 'down', threshold: 10 }] },
  github: { repos: ['owner/repo'], environments: ['production'] },
  jira: { site: 'https://your-site.atlassian.net', project: 'KEY' },
  intercom: { region: 'us' },
  slack: { channel: 'C0123456789' },
};

const fromConnector = (d: ConnectorDescriptor<unknown>): ConnectionType => ({
  provider: d.id,
  source: d.source,
  name: d.name,
  roles: d.roles,
  kind: 'source',
  credentialFields: d.credentialFields,
  configExample: EXAMPLES[d.id] ?? {},
  parseConfig: zodParse(d.config as never),
});

export const CONNECTION_TYPES: Record<string, ConnectionType> = {
  ...Object.fromEntries(CONNECTORS.map((d) => [d.id, fromConnector(d)])),
  slack: { provider: 'slack', source: 'slack', name: 'Slack', roles: [], kind: 'channel', credentialFields: [{ key: 'botToken', label: 'Bot token (chat:write)' }], configExample: EXAMPLES.slack, parseConfig: zodParse(SlackConfig as never) },
};
