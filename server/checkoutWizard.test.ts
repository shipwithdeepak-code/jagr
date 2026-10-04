import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { freshPglite } from './postgres/pglite';
import { createRuntime } from './runtime';
import { createApp } from './app';
import { hashToken } from './auth';
import { manualClock } from '../src/product/ports/clock';
import { checkoutBlocker, checkoutConfig, checkoutMapping } from '../src/product/view/checkoutWizard';
import { connectionView } from '../src/product/connections/model';
import type { Watch } from '../src/product/types';
import type { ApiRequest } from './http/types';
import type { Connector } from '../src/product/app/monitoring';
import { AmplitudeConfig } from '../src/product/integrations/connectors/amplitude';
import { SentryConfig } from '../src/product/integrations/connectors/sentry';
vi.setConfig({ testTimeout: 30_000 });
const NOW = '2026-09-25T10:00:00.000Z';
async function setup() {
  // No provider network requests: use real schemas/persistence/routes, with synthetic connector reads.
  const connectors: Record<string, Connector> = {};
  for (const source of ['amplitude', 'sentry', 'github'] as const) connectors[source] = {
    check: async () => ({ state: 'connected', detail: 'test connection' }),
    build: c => ({ id: source, connection: { provider: source, state: 'connected', detail: 'test', updatedAt: NOW }, ...(source === 'github' ? { changes: { tracksRollout: false, getChanges: async () => [] } } : { metrics: {
      metricDefinitions: () => source === 'amplitude' ? AmplitudeConfig.parse(c.config).metrics.map(m => ({ key: m.key, name: m.name, unit: 'percent' as const, area: m.area, badDirection: m.badDirection, mode: 'relative' as const, threshold: m.threshold })) : SentryConfig.parse(c.config).metrics.map(m => ({ key: m.key, name: m.name, unit: 'count' as const, area: 'checkout' as const, badDirection: 'up' as const, mode: 'relative' as const, threshold: m.threshold, telemetry: 'errors' as const })),
      getSeries: async () => null, listDimensions: () => [], getBreakdown: async () => [],
    } }) }),
  };
  const rt = await createRuntime({ JAGR_SESSION_SECRET: randomBytes(32).toString('hex'), JAGR_SECRET_KEY: randomBytes(32).toString('base64') }, { sql: await freshPglite(), clock: manualClock(NOW), identity: {}, connectors });
  await rt.repos.users.create({ id: 'u', displayName: 'PM', createdAt: NOW }, { provider: 'test', subject: 'u' });
  await rt.repos.sessions.create({ id: hashToken('session'), userId: 'u', createdAt: NOW, expiresAt: '2027-01-01T00:00:00.000Z' });
  for (const [id, org] of [['w', 'o'], ['other', 'foreign-org']]) {
    await rt.repos.organizations.create({ id: org, name: org, createdAt: NOW });
    await rt.repos.workspaces.create({ id, organizationId: org, name: id, mode: 'connected', createdAt: NOW, settings: { planner: 'deterministic', aiEgressAllowed: false, timezone: 'UTC' }, brief: { enabled: false, time: '08:00', timezone: 'UTC' }, importedExportIds: [], version: 1 });
    if (id === 'w') await rt.repos.members.add({ workspaceId: id, userId: 'u', role: 'owner', canApprove: true });
  }
  await rt.repos.organizationMembers.add({ organizationId: 'o', userId: 'u', role: 'owner' });
  for (const source of ['amplitude', 'sentry', 'github'] as const) {
    const secretRef = await rt.secrets.put({ workspaceId: 'w', connectionId: `stable-${source}` }, { kind: 'api_key', fields: { token: 'synthetic-test-only' } });
    await rt.repos.connections.save('w', { id: `stable-${source}`, workspaceId: 'w', provider: source, source, roles: source === 'github' ? ['changes'] : ['metrics'], authKind: 'api_key', secretRef, config: source === 'amplitude' ? { metrics: [{ kind: 'ratio', key: 'my_conversion', name: 'Checkout conversion', area: 'checkout', badDirection: 'down', threshold: 10, numerator: { event_type: 'Bought' }, denominator: { event_type: 'Started' } }] } : source === 'sentry' ? { organization: 'acme', projects: [1], metrics: [{ kind: 'errors', key: 'my_errors', name: 'Checkout errors', area: 'checkout', threshold: 100 }] } : { repos: ['acme/web'] }, state: 'connected', lastSuccessfulCheckAt: NOW, detail: 'test', updatedAt: NOW });
  }
  const app = createApp(rt);
  const request = (method: string, path: string, body?: unknown, query: Record<string, string> = {}) => app({ method, path, query, body, headers: { cookie: 'jagr_session=session; jagr_csrf=x', 'x-jagr-csrf': 'x' } } as ApiRequest);
  return { rt, request };
}
describe('checkout wizard reuses existing HTTP contracts', () => {
  it('saves validated shared mapping, retains connection/target identity, creates custom metric watch and reads queued status', async () => {
    const { rt, request } = await setup();
    const before = (await rt.repos.connections.get('w', 'stable-amplitude'))!;
    const view = connectionView(before, NOW);
    const response = await request('PUT', '/api/workspaces/w/connections', { provider: 'amplitude', config: checkoutConfig(view, { ...checkoutMapping(view)!, conversion: 'OrderCompleted' }) });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const stored = (await rt.repos.connections.get('w', before.id))!;
    expect(stored.id).toBe(before.id); expect(stored.secretRef).toBe(before.secretRef);
    const target = (await rt.repos.sourceTargets.list('w'))[0];
    expect(target).toMatchObject({ connectionId: before.id, workspaceId: 'w', organizationId: 'o', provider: 'amplitude' });
    await request('PUT', '/api/workspaces/w/connections', { provider: 'sentry', config: SentryConfig.parse((await rt.repos.connections.get('w', 'stable-sentry'))!.config) });
    await request('PUT', '/api/workspaces/w/connections', { provider: 'github', config: { repos: ['acme/web'] } });
    const views = (await rt.repos.connections.list('w')).map(c => connectionView(c, NOW));
    expect(checkoutBlocker(['amplitude', 'sentry', 'github'], views)).toBeUndefined();
    const saved = await request('POST', '/api/workspaces/w/watches', { templateId: 'checkout_health', name: 'My checkout', sources: ['amplitude', 'sentry', 'github'] });
    expect(saved.status).toBe(201);
    const watch = (saved.body as { watch: Watch }).watch;
    expect(watch.sources).toEqual(['amplitude', 'sentry', 'github']);
    expect(watch.signals.map(s => s.key)).toEqual(expect.arrayContaining(['metric:my_conversion', 'metric:my_errors', 'changes']));
    expect(watch.sourceTargetIds?.sort()).toEqual((await rt.repos.sourceTargets.list('w')).map(t => t.id).sort());
    expect((await rt.repos.sourceTargets.list('w')).filter(t => t.connectionId === before.id)).toHaveLength(1);
    const enqueued = await request('POST', '/api/workspaces/w/runs'); expect(enqueued.status).toBe(202);
    const key = (enqueued.body as { jobs: { idempotencyKey: string }[] }).jobs[0].idempotencyKey;
    expect(key).toContain(watch.id);
    expect((await request('GET', '/api/workspaces/w/runs/status', undefined, { key })).body).toMatchObject({ publicStatus: 'queued' });
  });
  it('rejects missing/foreign source selection and invalid config without writing a watch', async () => {
    const { rt, request } = await setup();
    expect((await request('POST', '/api/workspaces/w/watches', { templateId: 'checkout_health', sources: [] })).status).toBe(400);
    expect((await request('POST', '/api/workspaces/w/watches', { templateId: 'checkout_health', sources: ['jira'] })).status).toBe(400);
    expect((await request('POST', '/api/workspaces/other/watches', { templateId: 'checkout_health', sources: ['amplitude'] })).status).toBe(404);
    expect((await request('PUT', '/api/workspaces/w/connections', { provider: 'amplitude', config: { metrics: [] } })).body).toMatchObject({ code: 'invalid_config' });
    expect((await request('POST', '/api/workspaces/forbidden/watches', { templateId: 'checkout_health', sources: ['amplitude'] })).status).toBe(404);
    expect(await rt.repos.watches.list('w')).toEqual([]);
  });
});
