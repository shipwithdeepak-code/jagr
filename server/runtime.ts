import type { Clock } from '../src/product/ports/clock.js';
import { systemClock } from '../src/product/ports/clock.js';
import type { HttpClient } from '../src/product/ports/http.js';
import type { IdentityProvider } from '../src/product/ports/identity.js';
import type { JobQueue } from '../src/product/ports/jobs.js';
import type { Connector, MonitoringDeps } from '../src/product/app/monitoring.js';
import { CONNECTORS, connectorsFrom } from '../src/product/integrations/connectors/index.js';
import { CHANNELS } from '../src/product/integrations/channels/index.js';
import type { ChannelFactory } from '../src/product/app/notifications.js';
import type { ConnectionType } from '../src/product/app/connections.js';
import { CONNECTION_TYPES } from '../src/product/integrations/connectionTypes.js';
import { createPlannerManager, type InvestigationPlanner } from '../src/product/agent/planner.js';
import { readPlannerConfig } from '../src/product/agent/providers/config.js';
import { llmPlannerProvider, PROVIDER_REGISTRY } from '../src/product/agent/providers/registry.js';
import type { SqlClient } from './postgres/sql.js';
import { migrate } from './postgres/migrations.js';
import { postgresPersistence } from './postgres/repositories.js';
import { postgresJobQueue } from './postgres/jobs.js';
import { postgresSecretStore } from './postgres/secrets.js';
import { envKeyProvider } from './crypto/keys.js';
import { googleIdentity } from './identity/google.js';
import { githubIdentity } from './identity/github.js';
import { bootstrapSingleTenant, type BootstrapResult } from './singleTenant.js';

/**
 * Composition root: the only place that knows which implementation stands behind each port.
 *
 *   Repositories / Transactor → Postgres        JobQueue → Postgres (SKIP LOCKED)
 *   SecretStore → envelope-encrypted Postgres   KeyProvider → environment (KMS later)
 *   IdentityProvider → Google, GitHub           Clock → system    HttpClient → platform fetch
 *
 * Swapping any of these changes this file only.
 */

export interface RuntimeConfig {
  appBaseUrl: string;
  sessionSecret: string;
  cronSecret?: string;
  secureCookies: boolean;
  mode: 'multi-tenant' | 'single-tenant';
  /** single-tenant: the only identities allowed to sign in, as "provider:subject". */
  ownerIdentities: string[];
}

export interface Runtime extends MonitoringDeps {
  queue: JobQueue;
  identity: Record<string, IdentityProvider>;
  config: RuntimeConfig;
  sql: SqlClient;
  /** single-tenant: what bootstrap did at start (connection ids only, never values). */
  bootstrap?: BootstrapResult;
  /** Connection types this deployment offers (connectors + outbound channels). */
  types: Record<string, ConnectionType>;
}

export type Env = Record<string, string | undefined>;

export function readRuntimeConfig(env: Env): RuntimeConfig {
  const appBaseUrl = (env.JAGR_APP_URL ?? 'http://localhost:5173').replace(/\/$/, '');
  const sessionSecret = env.JAGR_SESSION_SECRET ?? '';
  if (sessionSecret.length < 32) throw new Error('JAGR_SESSION_SECRET must be set to at least 32 random characters.');
  const mode = env.JAGR_MODE === 'single-tenant' ? 'single-tenant' : 'multi-tenant';
  const ownerIdentities = (env.JAGR_OWNER_IDENTITIES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (mode === 'single-tenant' && !ownerIdentities.length) throw new Error('JAGR_MODE=single-tenant requires JAGR_OWNER_IDENTITIES (e.g. "google:1234567890").');
  return { appBaseUrl, sessionSecret, cronSecret: env.CRON_SECRET, secureCookies: appBaseUrl.startsWith('https://'), mode, ownerIdentities };
}

function serverPlanner(env: Env, http: HttpClient): InvestigationPlanner | undefined {
  const cfg = readPlannerConfig(env);
  if (cfg.mode !== 'llm' || !cfg.primary?.configured || !cfg.primary.config) return undefined;
  const make = (r: NonNullable<typeof cfg.primary>) => llmPlannerProvider(PROVIDER_REGISTRY[r.provider].create(r.config!, http), { timeoutMs: cfg.timeoutMs });
  return createPlannerManager({ primary: make(cfg.primary), fallback: cfg.fallback?.configured && cfg.fallback.config ? make(cfg.fallback) : undefined, timeoutMs: cfg.timeoutMs + 2000 });
}

export async function createRuntime(env: Env, deps: { sql: SqlClient; http?: HttpClient; clock?: Clock; identity?: Record<string, IdentityProvider>; connectors?: Record<string, Connector>; channels?: Record<string, ChannelFactory> }): Promise<Runtime> {
  const config = readRuntimeConfig(env);
  const http: HttpClient = deps.http ?? ((url, init) => fetch(url, init));
  const clock = deps.clock ?? systemClock;
  await migrate(deps.sql);
  const { repos, tx } = postgresPersistence(deps.sql);
  const identity: Record<string, IdentityProvider> = deps.identity ?? {};
  if (!deps.identity) {
    if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) identity.google = googleIdentity({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, http });
    if (env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET) identity.github = githubIdentity({ clientId: env.GITHUB_OAUTH_CLIENT_ID, clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET, http });
  }
  const secrets = postgresSecretStore(deps.sql, envKeyProvider(env));
  const bootstrap = config.mode === 'single-tenant' ? await bootstrapSingleTenant({ repos, secrets, clock }, env, { fingerprintKey: config.sessionSecret, workspaceName: env.JAGR_OWNER_WORKSPACE_NAME }) : undefined;
  return {
    sql: deps.sql,
    bootstrap,
    repos,
    tx,
    clock,
    http,
    queue: postgresJobQueue(deps.sql, clock),
    secrets,
    identity,
    connectors: deps.connectors ?? connectorsFrom(CONNECTORS),
    channels: deps.channels ?? CHANNELS,
    types: CONNECTION_TYPES,
    planner: serverPlanner(env, http),
    appBaseUrl: config.appBaseUrl,
    config,
  };
}

/** Production wiring: a `pg` pool from DATABASE_URL. Cached per server instance. */
let cached: Promise<Runtime> | undefined;
export function productionRuntime(env: Env): Promise<Runtime> {
  cached ??= (async () => {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
    const { default: pg } = await import('pg');
    const { pgClient } = await import('./postgres/sql.js');
    const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3, ssl: env.DATABASE_SSL === 'disable' ? undefined : { rejectUnauthorized: env.DATABASE_SSL !== 'no-verify' } });
    return createRuntime(env, { sql: pgClient(pool) });
  })();
  // A failed start (configuration, or the database unreachable) is not kept: the next request tries again.
  cached.catch(() => {
    cached = undefined;
  });
  return cached;
}
