import { describe, expect, it } from 'vitest';
import { watchFromTemplate } from '../catalog';
import { connectorsFrom } from '../integrations/connectors';
import { sentryRoute } from '../integrations/connectors/__fixtures__/sentry';
import { sentryConnector } from '../integrations/connectors/sentry';
import { manualClock } from '../ports/clock';
import type { HttpClient } from '../ports/http';
import { createMemoryJobQueue, createMemoryPersistence, createMemorySecretStore } from '../ports/memory';
import { scriptedHttp } from '../testkit/connectorContract';
import { runOneJob, runWatchJob } from './monitoring';
import { runSourceCheckJob } from './sourceChecking';

const NOW = '2026-09-25T05:00:00.000Z';
const CONFIG = {
  organization: 'acme',
  projects: [42],
  environment: 'production',
  metrics: [
    { kind: 'errors' as const, key: 'checkout_errors', name: 'Checkout errors', area: 'checkout' as const, query: 'transaction:/checkout*', threshold: 100 },
    { kind: 'crash_free' as const, key: 'crash_free_sessions', name: 'Crash-free sessions', of: 'session' as const, threshold: 0.5 },
  ],
  releases: true,
  issues: true,
};

const contextRoute = (url: URL) => url.pathname.endsWith('/issues/')
  ? { body: Array.from({ length: 4 }, (_, i) => ({ id: String(101 + i), shortId: i ? `WEB-${i + 1}` : 'WEB-1A', title: `Crash ${i + 1}`, level: 'error', count: '100', userCount: 25, firstSeen: '2026-09-25T02:05:00Z', lastSeen: '2026-09-25T04:50:00Z', permalink: `https://acme.sentry.io/issues/${101 + i}/` })) }
  : sentryRoute(url);

async function setup() {
  const { repos, tx } = createMemoryPersistence();
  const clock = manualClock(NOW);
  const queue = createMemoryJobQueue(clock);
  const secrets = createMemorySecretStore();
  await repos.organizations.create({ id: 'org-1', name: 'Acme', createdAt: NOW });
  await repos.workspaces.create({ id: 'ws-1', organizationId: 'org-1', name: 'Acme', mode: 'connected', createdAt: NOW, settings: { planner: 'deterministic', aiEgressAllowed: false, timezone: 'UTC' }, brief: { enabled: false, time: '08:00', timezone: 'UTC' }, importedExportIds: [], version: 1 });
  const secretRef = await secrets.put({ workspaceId: 'ws-1', connectionId: 'conn-sentry' }, { kind: 'api_key', fields: { authToken: 'not-real' } });
  await repos.connections.save('ws-1', { id: 'conn-sentry', workspaceId: 'ws-1', source: 'sentry', provider: 'sentry', roles: ['metrics', 'changes', 'work_items'], authKind: 'api_key', state: 'connected', detail: 'Sentry', config: CONFIG, secretRef, updatedAt: NOW });
  await repos.sourceTargets.save('ws-1', { id: 'target-sentry', organizationId: 'org-1', workspaceId: 'ws-1', connectionId: 'conn-sentry', provider: 'sentry', externalId: 'acme:42', displayName: 'Acme / 42', configuration: CONFIG, status: 'active', checkIntervalMinutes: 15, createdAt: NOW, updatedAt: NOW });
  const watch = watchFromTemplate('w-stability', 'app_stability', { sources: ['sentry'], schedule: { frequency: '1h', dailyAt: '07:00' } }, '2026-09-25T04:00:00.000Z');
  await repos.watches.save('ws-1', { ...watch, signals: [{ key: 'work_items', area: 'stability' }, { key: 'changes' }], sourceTargetIds: ['target-sentry'] });
  return { repos, tx, clock, queue, secrets, connectors: connectorsFrom([sentryConnector]), http: scriptedHttp(contextRoute).http as HttpClient };
}

describe('normalized event investigation context', () => {
  it('carries the bounded Sentry watch-slot events into one investigation and keeps retries idempotent', async () => {
    const deps = await setup();
    const checked = await runSourceCheckJob(deps, { workspaceId: 'ws-1', payload: { organizationId: 'org-1', sourceTargetId: 'target-sentry' } });
    expect(checked.events).toBeGreaterThan(1);
    expect(checked.jobs).toBe(1);

    await expect(runOneJob(deps, { workerId: 'worker', leaseMs: 60_000 })).resolves.toMatchObject({ state: 'completed', kind: 'monitor.watch' });
    const [investigation] = await deps.repos.investigations.list('ws-1');
    expect(investigation, JSON.stringify(await deps.repos.audit.list('ws-1'))).toBeDefined();
    expect(investigation.sourceEvents!.length).toBeGreaterThan(1);
    expect(investigation.sourceEvents!.every((ref) => ref.provider === 'sentry' && ref.sourceTargetId === 'target-sentry')).toBe(true);
    expect(investigation.sourceEvents!.map((ref) => [ref.occurredAt, ref.eventId])).toEqual([...investigation.sourceEvents!].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId)).map((ref) => [ref.occurredAt, ref.eventId]));
    expect(investigation.evidence.some((evidence) => evidence.provenance?.normalizedEventIds?.length)).toBe(true);

    const before = investigation.sourceEvents!.map((ref) => ref.eventId);
    for (let i = 0; i < 105; i++) await deps.repos.investigations.save('ws-1', { ...investigation, id: `old-${String(i).padStart(3, '0')}`, startedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T01:00:00.000Z', completedAt: '2026-08-01T01:00:00.000Z', status: 'RESOLVED', dedupeKey: `historical-${i}` });
    await runWatchJob(deps, { workspaceId: 'ws-1', payload: { watchId: 'w-stability', dueAt: NOW, sourceTargetId: 'target-sentry' } });
    const after = await deps.repos.investigations.list('ws-1');
    expect(after).toHaveLength(106);
    expect(after.find((inv) => inv.id === investigation.id)!.sourceEvents!.map((ref) => ref.eventId)).toEqual(before);
  });
});
