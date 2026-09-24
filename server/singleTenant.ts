import { createHmac } from 'node:crypto';
import type { ProviderId } from '../src/product/types';
import type { Role } from '../src/product/roles/types';
import type { Connection, Repositories, Workspace } from '../src/product/ports/persistence';
import { WriteConflict } from '../src/product/ports/persistence';
import type { SecretPayload, SecretRef, SecretStore } from '../src/product/ports/secrets';
import { SecretNotFound } from '../src/product/ports/secrets';
import type { Clock } from '../src/product/ports/clock';
import type { Env } from './runtime';

/**
 * Single-tenant dogfood mode: one workspace, owned by the identities in JAGR_OWNER_IDENTITIES, whose
 * connections take their credentials from the deployment environment.
 *
 * Bootstrap copies each configured credential into the SecretStore (encrypted) and stores only a
 * SecretRef on the connection — the same shape an OAuth or app-install connection has, so connectors
 * read it through the same path in both modes. Nothing here is a fake connector: until a connector
 * for a provider is registered, its connection is reported as a gap ("No connector …").
 *
 * Idempotent. Runs at runtime start. Changing an env value rotates the stored secret (compare-and-swap);
 * removing one marks the connection not_configured and deletes the stored secret. Audit entries name
 * the connection and the env var names involved — never a value.
 */

export const OWNER_WORKSPACE_ID = 'ws_owner';

interface OwnerConnectorSpec {
  source: ProviderId;
  label: { name: string; short: string };
  roles: Role[];
  /** Env vars that must all be set for the connection to exist. */
  required: string[];
  /** Alternative complete credential sets (e.g. GitHub token OR GitHub App). */
  alternatives?: string[][];
  secret(env: Env): SecretPayload;
  /** Non-secret settings. Never an email address, token or key. */
  config(env: Env): Record<string, unknown>;
}

const parseJson = (v: string | undefined): unknown => {
  if (!v) return undefined;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const pick = (env: Env, names: string[]) => Object.fromEntries(names.filter((n) => env[n]).map((n) => [n, env[n]!]));

export const OWNER_CONNECTORS: OwnerConnectorSpec[] = [
  {
    source: 'amplitude',
    label: { name: 'Amplitude', short: 'Amplitude' },
    roles: ['metrics', 'changes'],
    required: ['JAGR_AMPLITUDE_API_KEY', 'JAGR_AMPLITUDE_SECRET_KEY'],
    secret: (env) => ({ kind: 'api_key', fields: { apiKey: env.JAGR_AMPLITUDE_API_KEY!, secretKey: env.JAGR_AMPLITUDE_SECRET_KEY! } }),
    // Metric bindings are JSON; an unparseable value is kept as-is so the connector reports it as invalid configuration.
    config: (env) => ({
      region: env.JAGR_AMPLITUDE_REGION === 'eu' ? 'eu' : 'us',
      metrics: parseJson(env.JAGR_AMPLITUDE_METRICS) ?? [],
      ...(env.JAGR_AMPLITUDE_APP_URL ? { appUrl: env.JAGR_AMPLITUDE_APP_URL } : {}),
      ...(env.JAGR_AMPLITUDE_UTC_OFFSET_MINUTES ? { utcOffsetMinutes: Number(env.JAGR_AMPLITUDE_UTC_OFFSET_MINUTES) } : {}),
    }),
  },
  {
    source: 'github',
    label: { name: 'GitHub', short: 'GitHub' },
    roles: ['changes'],
    required: ['JAGR_GITHUB_REPOS'],
    alternatives: [['JAGR_GITHUB_TOKEN'], ['JAGR_GITHUB_APP_ID', 'JAGR_GITHUB_APP_PRIVATE_KEY', 'JAGR_GITHUB_INSTALLATION_ID']],
    secret: (env): SecretPayload =>
      env.JAGR_GITHUB_TOKEN
        ? { kind: 'api_key', fields: { token: env.JAGR_GITHUB_TOKEN } }
        : { kind: 'api_key', fields: { appId: env.JAGR_GITHUB_APP_ID!, privateKey: env.JAGR_GITHUB_APP_PRIVATE_KEY!, installationId: env.JAGR_GITHUB_INSTALLATION_ID! } },
    config: (env) => ({ repos: list(env.JAGR_GITHUB_REPOS), ...(env.JAGR_GITHUB_ENVIRONMENTS ? { environments: list(env.JAGR_GITHUB_ENVIRONMENTS) } : {}), auth: env.JAGR_GITHUB_TOKEN ? 'token' : 'app' }),
  },
  {
    source: 'jira',
    label: { name: 'Jira', short: 'Jira' },
    roles: ['work_items', 'changes'],
    required: ['JAGR_JIRA_SITE', 'JAGR_JIRA_EMAIL', 'JAGR_JIRA_API_TOKEN', 'JAGR_JIRA_PROJECT'],
    // The account email is part of the credential (basic auth), so it lives in the secret, not config.
    secret: (env) => ({ kind: 'api_key', fields: { email: env.JAGR_JIRA_EMAIL!, apiToken: env.JAGR_JIRA_API_TOKEN! } }),
    config: (env) => ({ site: env.JAGR_JIRA_SITE, project: env.JAGR_JIRA_PROJECT }),
  },
  {
    source: 'intercom',
    label: { name: 'Intercom', short: 'Intercom' },
    roles: ['feedback'],
    required: ['JAGR_INTERCOM_TOKEN'],
    secret: (env) => ({ kind: 'api_key', fields: { token: env.JAGR_INTERCOM_TOKEN! } }),
    config: (env) => ({ region: env.JAGR_INTERCOM_REGION === 'eu' ? 'eu' : env.JAGR_INTERCOM_REGION === 'au' ? 'au' : 'us' }),
  },
  {
    source: 'slack',
    label: { name: 'Slack', short: 'Slack' },
    roles: [],
    required: ['JAGR_SLACK_BOT_TOKEN', 'JAGR_SLACK_CHANNEL'],
    secret: (env) => ({ kind: 'api_key', fields: { botToken: env.JAGR_SLACK_BOT_TOKEN! } }),
    config: (env) => ({ channel: env.JAGR_SLACK_CHANNEL }),
  },
];

/** Which credential set the environment provides, or undefined when it is incomplete. */
export function configuredVars(spec: OwnerConnectorSpec, env: Env): string[] | undefined {
  if (!spec.required.every((n) => env[n])) return undefined;
  if (!spec.alternatives) return spec.required;
  const alt = spec.alternatives.find((set) => set.every((n) => env[n]));
  return alt ? [...spec.required, ...alt] : undefined;
}

const allVars = (spec: OwnerConnectorSpec) => [...spec.required, ...(spec.alternatives ?? []).flat()];

/** Keyed fingerprint of the secret material: detects env changes without storing anything guessable. */
function fingerprint(key: string, spec: OwnerConnectorSpec, env: Env): string {
  const material = pick(env, allVars(spec));
  return createHmac('sha256', key).update(JSON.stringify(Object.entries(material).sort())).digest('hex').slice(0, 32);
}

export interface BootstrapResult {
  workspaceId: string;
  configured: string[];
  rotated: string[];
  removed: string[];
}

export async function bootstrapSingleTenant(deps: { repos: Repositories; secrets: SecretStore; clock: Clock }, env: Env, opts: { fingerprintKey: string; workspaceName?: string }): Promise<BootstrapResult> {
  const { repos, secrets, clock } = deps;
  const now = clock.now();
  const ws: Workspace = {
    id: OWNER_WORKSPACE_ID,
    name: opts.workspaceName ?? 'Jagr',
    mode: 'connected',
    createdAt: now,
    settings: { planner: 'deterministic', aiEgressAllowed: true, timezone: 'UTC' },
    brief: { enabled: true, time: '08:00', timezone: 'UTC' },
    importedExportIds: [],
    version: 1,
  };
  if (!(await repos.workspaces.get(ws.id))) {
    try {
      await repos.workspaces.create(ws);
    } catch (e) {
      if (!(e instanceof WriteConflict)) throw e; // another instance created it first
    }
  }

  const result: BootstrapResult = { workspaceId: ws.id, configured: [], rotated: [], removed: [] };
  const audit = (action: string, target: string, detail: string) =>
    repos.audit.append({ id: `audit-${action}-${target}-${now}`, workspaceId: ws.id, at: now, actor: { ref: 'system', displayName: 'Jagr' }, action, target, detail });

  for (const spec of OWNER_CONNECTORS) {
    const id = `owner-${spec.source}`;
    const existing = await repos.connections.get(ws.id, id);
    const vars = configuredVars(spec, env);
    const cursorKey = `owner-env:${id}`;

    if (!vars) {
      if (existing && existing.authKind === 'owner_env' && existing.state !== 'not_configured') {
        if (existing.secretRef) await secrets.delete(existing.secretRef).catch((e) => { if (!(e instanceof SecretNotFound)) throw e; });
        const { secretRef: _r, ...rest } = existing;
        void _r;
        await repos.connections.save(ws.id, { ...rest, state: 'not_configured', detail: `Credentials were removed from the deployment environment (${spec.required.join(', ')}).`, updatedAt: now });
        await repos.cursors.set(ws.id, cursorKey, '');
        await audit('connection.owner_env.removed', id, `${spec.label.name}: environment credentials removed; stored secret deleted.`);
        result.removed.push(spec.source);
      }
      continue;
    }

    const fp = fingerprint(opts.fingerprintKey, spec, env);
    const config = spec.config(env);
    let secretRef: SecretRef | undefined = existing?.secretRef;
    let changed = false;
    if (!secretRef) {
      secretRef = await secrets.put({ workspaceId: ws.id, connectionId: id }, spec.secret(env));
      await audit('connection.owner_env.configured', id, `${spec.label.name}: credentials copied from ${vars.join(', ')} into encrypted storage.`);
      result.configured.push(spec.source);
      changed = true;
    } else if ((await repos.cursors.get(ws.id, cursorKey)) !== fp) {
      try {
        const cur = await secrets.get(secretRef);
        await secrets.replace(secretRef, cur.version, spec.secret(env));
      } catch (e) {
        if (!(e instanceof SecretNotFound)) throw e;
        secretRef = await secrets.put({ workspaceId: ws.id, connectionId: id }, spec.secret(env));
      }
      await audit('connection.owner_env.rotated', id, `${spec.label.name}: credentials in ${vars.join(', ')} changed; stored secret replaced.`);
      result.rotated.push(spec.source);
      changed = true;
    }
    const next: Connection = {
      id,
      workspaceId: ws.id,
      source: spec.source,
      provider: spec.source,
      roles: spec.roles,
      authKind: 'owner_env',
      state: changed || !existing || existing.state === 'not_configured' ? 'connected' : existing.state,
      detail: changed || !existing || existing.state === 'not_configured' ? 'Owner credentials from the deployment environment; not yet read.' : existing.detail,
      label: spec.label,
      config,
      secretRef,
      freshAsOf: changed ? undefined : existing?.freshAsOf,
      lastSyncAt: changed ? undefined : existing?.lastSyncAt,
      lastError: changed ? undefined : existing?.lastError,
      updatedAt: changed || !existing ? now : existing.updatedAt,
    };
    await repos.connections.save(ws.id, next);
    await repos.cursors.set(ws.id, cursorKey, fp);
  }
  return result;
}
