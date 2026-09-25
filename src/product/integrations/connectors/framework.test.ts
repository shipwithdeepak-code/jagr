import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Connection } from '../../ports/persistence';
import type { ChangeRecord } from '../../roles/types';
import { manualClock } from '../../ports/clock';
import { createMemoryPersistence, createMemorySecretStore } from '../../ports/memory';
import { checkConnection, sourcesForRun } from '../../app/monitoring';
import type { ConnectorDescriptor } from './types';
import { basicAuth, requestJson, restrictHosts } from './http';
import { plainText, redactPersonalData } from './redact';
import { provenance } from './runtime';
import { connectorsFrom } from './index';
import { connectorContract, scriptedHttp } from '../../testkit/connectorContract';
import { ProviderUnavailableError } from '../types';

/**
 * The connector framework, exercised through a minimal reference connector ("deploy log": one JSON
 * endpoint of deployments). Real connectors follow the same shape.
 */

const Config = z.object({ host: z.string().regex(/^[a-z0-9-]+\.deploylog\.test$/), service: z.string().min(1) }).strict();
type Config = z.infer<typeof Config>;

interface Deploy {
  id: string;
  finished_at: string;
  status: 'ok' | 'failed';
  author_email: string;
}

const reference: ConnectorDescriptor<Config> = {
  id: 'deploylog',
  source: 'github',
  name: 'Deploy log',
  roles: ['changes'],
  config: Config,
  secretKinds: ['api_key'],
  credentialFields: [{ key: 'token', label: 'Token' }],
  hosts: (cfg) => [cfg.host],
  build: (ctx) => ({
    changes: {
      tracksRollout: false,
      async getChanges({ window }) {
        const stamp = { connectionId: ctx.connection.id, provider: 'deploylog', source: 'github' as const, fetchedAt: ctx.clock.now() };
        const body = await requestJson<{ deploys: Deploy[] }>(ctx.http, 'github', 'Deploy log', `https://${ctx.config.host}/v1/deploys?service=${encodeURIComponent(ctx.config.service)}`, {
          headers: { authorization: `Bearer ${ctx.secret.kind === 'api_key' ? ctx.secret.fields.token : ''}` },
        });
        if (!Array.isArray(body.deploys)) throw new ProviderUnavailableError('github', 'error', 'Deploy log returned a response Jagr could not read.');
        return body.deploys
          .filter((d) => d.finished_at >= window.start && d.finished_at <= window.end)
          .map(
            (d): ChangeRecord => ({
              id: `deploylog-${d.id}`,
              source: 'github',
              kind: 'deploy',
              timing: 'actual',
              title: `Deploy ${d.id} of ${ctx.config.service}`,
              at: d.finished_at,
              status: d.status === 'ok' ? 'success' : 'failed',
              ref: { provider: 'github', kind: 'release', id: d.id },
              provenance: provenance(stamp, d.id, d.finished_at, `https://${ctx.config.host}/deploys/${d.id}`),
            }),
          );
      },
    },
  }),
  check: async (ctx) => {
    await requestJson(ctx.http, 'github', 'Deploy log', `https://${ctx.config.host}/v1/me`, { headers: { authorization: `Bearer ${ctx.secret.kind === 'api_key' ? ctx.secret.fields.token : ''}` } });
    return { state: 'connected', detail: `Deploy log · ${ctx.config.service}`, account: ctx.config.service };
  },
};

const connection: Connection = {
  id: 'conn-deploylog',
  workspaceId: 'ws-1',
  source: 'github',
  provider: 'deploylog',
  roles: ['changes'],
  authKind: 'api_key',
  state: 'connected',
  detail: 'Deploy log',
  config: { host: 'acme.deploylog.test', service: 'web' },
  updatedAt: '2026-09-25T00:00:00.000Z',
};

const DEPLOYS: Deploy[] = [
  { id: 'd1', finished_at: '2026-09-24T18:40:00.000Z', status: 'ok', author_email: 'dev@acme.test' },
  { id: 'd2', finished_at: '2026-09-24T20:05:00.000Z', status: 'failed', author_email: 'dev@acme.test' },
  { id: 'd-future', finished_at: '2026-09-25T09:00:00.000Z', status: 'ok', author_email: 'dev@acme.test' },
];

const route = (u: URL) => (u.pathname === '/v1/deploys' ? { body: { deploys: DEPLOYS } } : u.pathname === '/v1/me' ? { body: { ok: true } } : undefined);

connectorContract({
  name: 'reference (deploy log)',
  descriptor: reference,
  connection,
  secret: { kind: 'api_key', fields: { token: 'dl_token_AAAAAAAAAAAA' } },
  otherSecret: { kind: 'api_key', fields: { token: 'dl_token_BBBBBBBBBBBB' } },
  route,
  window: { start: '2026-09-24T00:00:00.000Z', end: '2026-09-25T06:00:00.000Z' },
  expectRecords: { changes: 2 },
  invalidConfigs: [{ host: 'evil.example.com', service: 'web' }, { host: 'acme.deploylog.test' }, { host: 'acme.deploylog.test', service: 'web', extra: 1 }],
});

describe('connector HTTP helpers', () => {
  it('restrictHosts refuses other hosts and plain http, without calling out', async () => {
    const { http, calls } = scriptedHttp(() => ({ body: {} }));
    const r = restrictHosts(http, ['api.example.test'], 'github');
    await expect(r('https://evil.test/x')).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(r('http://api.example.test/x')).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(r('not a url')).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(calls).toHaveLength(0);
    await r('https://api.example.test/x');
    expect(calls).toHaveLength(1);
  });

  it('error messages never echo the URL query or the response body', async () => {
    const { http } = scriptedHttp(() => ({ status: 400, body: { error: 'bad token sk-live-SECRETSECRETSECRET' } }));
    const err = (await requestJson(http, 'github', 'X', 'https://h.test/p?api_key=SECRET123').catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('X returned 400.');
  });

  it('basicAuth encodes like btoa for ASCII and handles UTF-8', () => {
    expect(basicAuth('a@b.test', 'tok:en')).toBe(`Basic ${Buffer.from('a@b.test:tok:en').toString('base64')}`);
    expect(basicAuth('zoë', 'ü')).toBe(`Basic ${Buffer.from('zoë:ü', 'utf8').toString('base64')}`);
  });
});

describe('personal data redaction', () => {
  it('removes contact details, links, card numbers and tokens; keeps the complaint', () => {
    const t = redactPersonalData('Checkout fails! email me at jo.smith+x@mail.co.uk or +44 20 7946 0958, card 4111 1111 1111 1111. see https://x.test/a?t=1 token ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(t).toContain('Checkout fails!');
    expect(t).not.toMatch(/jo\.smith|7946|4111|x\.test|ghp_/);
  });
  it('turns provider HTML into plain text', () => {
    expect(plainText('<p>Hi&nbsp;there</p><p>It &amp; that</p>')).toBe('Hi there\nIt & that');
  });
});

describe('connected workspaces: isolation and health', () => {
  async function workspace(connections: Connection[], secrets: Record<string, string>) {
    const { repos, tx } = createMemoryPersistence();
    const store = createMemorySecretStore();
    const clock = manualClock('2026-09-25T06:00:00.000Z');
    await repos.workspaces.create({ id: 'ws-1', name: 'W', mode: 'connected', createdAt: clock.now(), settings: { planner: 'deterministic', aiEgressAllowed: false, timezone: 'UTC' }, brief: { enabled: false, time: '08:00', timezone: 'UTC' }, importedExportIds: [], version: 1 });
    for (const c of connections) {
      const ref = secrets[c.id] ? await store.put({ workspaceId: 'ws-1', connectionId: c.id }, { kind: 'api_key', fields: { token: secrets[c.id] } }) : undefined;
      await repos.connections.save('ws-1', { ...c, secretRef: ref });
    }
    return { repos, tx, secrets: store, clock };
  }

  it('one broken connection is a gap; the others still load', async () => {
    const ok = connection;
    const badConfig: Connection = { ...connection, id: 'conn-bad', source: 'jira', config: { host: 'evil.example.com', service: 'web' } };
    const noSecret: Connection = { ...connection, id: 'conn-nosecret', source: 'intercom' };
    const w = await workspace([ok, badConfig, noSecret], { 'conn-deploylog': 'dl_token_AAAAAAAAAAAA', 'conn-bad': 'x' });
    const deps = { ...w, http: scriptedHttp(route).http, connectors: connectorsFrom([reference as ConnectorDescriptor<unknown>]) };
    const run = await sourcesForRun(deps, (await w.repos.workspaces.get('ws-1'))!, w.clock.now());
    expect(run.registry.sources().map((s) => s.id)).toEqual(['github']);
    const byProvider = Object.fromEntries(run.connections.map((c) => [c.provider, c]));
    expect(byProvider.jira.state).toBe('error');
    expect(byProvider.jira.detail).toMatch(/configuration is invalid/);
    expect(byProvider.intercom.state).toBe('error');
    expect(byProvider.intercom.detail).toMatch(/no stored credential/);
  });

  it('a missing stored secret means reconnect, not "no data"', async () => {
    const w = await workspace([connection], { 'conn-deploylog': 'dl_token_AAAAAAAAAAAA' });
    const c = (await w.repos.connections.get('ws-1', connection.id))!;
    await w.secrets.delete(c.secretRef!);
    const deps = { ...w, http: scriptedHttp(route).http, connectors: connectorsFrom([reference as ConnectorDescriptor<unknown>]) };
    const run = await sourcesForRun(deps, (await w.repos.workspaces.get('ws-1'))!, w.clock.now());
    expect(run.registry.sources()).toHaveLength(0);
    expect(run.connections[0].state).toBe('needs_reconnect');
  });

  it('checkConnection records the outcome: rejected credentials stop reads, outages do not', async () => {
    const w = await workspace([connection], { 'conn-deploylog': 'dl_token_AAAAAAAAAAAA' });
    const connectors = connectorsFrom([reference as ConnectorDescriptor<unknown>]);
    expect((await checkConnection({ ...w, http: scriptedHttp(route).http, connectors }, 'ws-1', connection.id)).state).toBe('connected');
    expect((await w.repos.connections.get('ws-1', connection.id))!.externalAccount).toBe('web');
    expect((await w.repos.connections.get('ws-1', connection.id))!.lastSuccessfulCheckAt).toBe(w.clock.now());

    const outage = await checkConnection({ ...w, http: scriptedHttp(() => ({ status: 503 })).http, connectors }, 'ws-1', connection.id);
    expect(outage.state).toBe('unavailable');
    const afterOutage = (await w.repos.connections.get('ws-1', connection.id))!;
    expect(afterOutage.state).toBe('connected');
    expect(afterOutage.lastError).toMatch(/503/);
    expect(afterOutage.lastErrorAt).toBe(w.clock.now());

    expect((await checkConnection({ ...w, http: scriptedHttp(() => ({ status: 401 })).http, connectors }, 'ws-1', connection.id)).state).toBe('needs_reconnect');
    expect((await w.repos.connections.get('ws-1', connection.id))!.state).toBe('needs_reconnect');
    const run = await sourcesForRun({ ...w, http: scriptedHttp(route).http, connectors }, (await w.repos.workspaces.get('ws-1'))!, w.clock.now());
    expect(run.registry.sources()).toHaveLength(0);
  });

  it('channels (no roles) are never loaded as sources', async () => {
    const slack: Connection = { ...connection, id: 'conn-slack', source: 'slack', provider: 'slack', roles: [] };
    const w = await workspace([slack], { 'conn-slack': 'xoxb-0000000000-aaaa' });
    const run = await sourcesForRun({ ...w, http: scriptedHttp(route).http, connectors: {} }, (await w.repos.workspaces.get('ws-1'))!, w.clock.now());
    expect(run.connections).toHaveLength(0);
  });
});
