import { describe, expect, it } from 'vitest';
import type { Connection } from '../../ports/persistence';
import type { SecretPayload } from '../../ports/secrets';
import { manualClock } from '../../ports/clock';
import { createMemoryPersistence, createMemorySecretStore } from '../../ports/memory';
import { runWatchJob, sourcesForRun } from '../../app/monitoring';
import { watchFromTemplate } from '../../catalog';
import { createPlannerManager } from '../../agent/planner';
import { llmPlannerProvider } from '../../agent/providers/registry';
import { BUDGET } from '../../agent/investigator';
import { hasCausalOverclaim } from '../../engine/language';
import { scriptedHttp, type Reply } from '../../testkit/connectorContract';
import { CONNECTORS, connectorsFrom } from './index';
import { CHANNELS } from '../channels/index';
import { sentryRoute } from './__fixtures__/sentry';

/**
 * Sentry in a connected investigation, end to end through the scheduled-watch path: checkout conversion
 * (Amplitude) drops at 02:00, checkout errors (Sentry) spike at 02:00, release 4.8.1 finished deploying
 * at 01:00, and checkout bugs are filed in Jira. No sample or simulated data anywhere.
 */

const NOW = '2026-09-25T06:00:00.000Z';
const HOUR = 3_600_000;
const pad = (n: number) => String(n).padStart(2, '0');
const HOURS = Array.from({ length: 8 * 24 + 1 }, (_, i) => Date.parse(NOW) - 8 * 24 * HOUR + i * HOUR);
const local = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:00:00`;
};

function route(sentryDown: boolean) {
  return (u: URL): Reply | undefined => {
    switch (u.hostname) {
      case 'sentry.io':
        return sentryDown ? { status: 503, body: {} } : sentryRoute(u);
      case 'amplitude.com': {
        if (u.pathname === '/api/2/annotations') return { body: { data: [] } };
        const e = JSON.parse(u.searchParams.get('e')!).event_type as string;
        return { body: { data: { series: [HOURS.map((h) => (e === 'Checkout Started' ? 200 : h >= Date.parse('2026-09-25T02:00:00Z') ? 45 : 60))], seriesLabels: [0], xValues: HOURS.map(local) } } };
      }
      case 'acme.atlassian.net':
        if (u.pathname === '/rest/api/3/search/jql')
          return {
            body: {
              issues: ['02:20', '02:50', '03:30', '04:10'].map((t, i) => ({
                key: `SHOP-${200 + i}`,
                fields: { summary: `Checkout payment fails on submit (${i + 1})`, created: `2026-09-25T${t}:00.000+0000`, issuetype: { name: 'Bug' }, priority: { name: 'High' }, components: [{ name: 'Checkout' }], labels: [], versions: [] },
              })),
              isLast: true,
            },
          };
        if (u.pathname === '/rest/api/3/project/SHOP/versions') return { body: [] };
        return undefined;
    }
    return undefined;
  };
}

const conn = (source: Connection['source'], roles: Connection['roles'], config: Record<string, unknown>): Connection => ({ id: `owner-${source}`, workspaceId: 'ws-1', source, provider: source, roles, authKind: 'owner_env', state: 'connected', detail: source, config, updatedAt: NOW });
const CONNS: [Connection, SecretPayload][] = [
  [conn('amplitude', ['metrics', 'changes'], { metrics: [{ kind: 'ratio', key: 'checkout_conversion', name: 'Checkout conversion', area: 'checkout', numerator: { event_type: 'Order Completed' }, denominator: { event_type: 'Checkout Started' }, badDirection: 'down', threshold: 10 }] }), { kind: 'api_key', fields: { apiKey: 'amp_key_1234', secretKey: 'amp_secret_1234' } }],
  [conn('jira', ['work_items', 'changes'], { site: 'https://acme.atlassian.net', project: 'SHOP' }), { kind: 'api_key', fields: { email: 'svc-jagr@acme.test', apiToken: 'ATATT_e2e_0000000' } }],
  [
    conn('sentry', ['metrics', 'changes', 'work_items'], { organization: 'acme', projects: [42], environment: 'production', metrics: [{ kind: 'errors', key: 'checkout_errors', name: 'Checkout errors', area: 'checkout', query: 'transaction:/checkout*', threshold: 100 }] }),
    { kind: 'api_key', fields: { authToken: 'sntrys_e2e_000000000' } },
  ],
];

async function run(sentryDown = false) {
  const { repos, tx } = createMemoryPersistence();
  const secrets = createMemorySecretStore();
  const clock = manualClock(NOW);
  await repos.workspaces.create({ id: 'ws-1', name: 'Acme', mode: 'connected', createdAt: NOW, settings: { planner: 'deterministic', aiEgressAllowed: false, timezone: 'UTC' }, brief: { enabled: true, time: '08:00', timezone: 'UTC' }, importedExportIds: [], version: 1 });
  for (const [c, s] of CONNS) await repos.connections.save('ws-1', { ...c, secretRef: await secrets.put({ workspaceId: 'ws-1', connectionId: c.id }, s) });
  // AI egress is off for this workspace, so the stand-in model is never called; the deterministic planner runs.
  const planner = createPlannerManager({ primary: llmPlannerProvider({ id: 'unused', displayName: 'Unused', model: 'unused', generate: async () => '{}' }), timeoutMs: 2000 });
  const deps = { repos, tx, secrets, clock, http: scriptedHttp(route(sentryDown)).http, connectors: connectorsFrom(CONNECTORS), channels: CHANNELS, planner, appBaseUrl: 'https://jagr.acme.test' };
  const sources = await sourcesForRun(deps, (await repos.workspaces.get('ws-1'))!, NOW);
  const served = sources.registry.metrics();
  const watch = watchFromTemplate('w-checkout', 'checkout_health', { sources: ['amplitude', 'jira', 'sentry'], metricKeys: served.map((m) => m.def.key) }, NOW);
  // As the server does when it creates a watch: connected metrics for the area, and telemetry whatever its area.
  for (const m of served) if ((m.def.area === 'checkout' || m.def.telemetry) && !watch.signals.some((x) => x.key === `metric:${m.def.key}`)) watch.signals.unshift({ key: `metric:${m.def.key}` });
  await repos.watches.save('ws-1', watch);
  await runWatchJob(deps, { workspaceId: 'ws-1', payload: { watchId: 'w-checkout', dueAt: NOW } });
  return { investigations: await repos.investigations.list('ws-1') };
}

describe('Sentry in a connected investigation (end to end)', () => {
  it('correlates error telemetry with the release, analytics and Jira — observed, inferred and unknown kept apart', async () => {
    const { investigations } = await run();
    const inv = investigations.find((i) => i.correlatedProviders.includes('sentry'))!;
    expect(inv).toBeDefined();
    expect(inv.correlatedProviders).toEqual(expect.arrayContaining(['amplitude', 'sentry', 'jira']));

    // OBSERVED — factual statements from each source, Sentry included.
    expect(inv.observed.some((o) => /^Sentry: Checkout errors /.test(o))).toBe(true);
    // INFERRED — the four telemetry findings, in correlation language.
    const inferred = inv.inferred.join('\n');
    expect(inferred).toMatch(/Error telemetry supports a real checkout problem: Checkout errors/);
    expect(inferred).toMatch(/occurred \d+ minutes after release 4\.8\.1 and may be related to it; timing alone does not establish that it is responsible/);
    expect(inferred).toMatch(/Sentry and Amplitude, Jira degraded in the same window/);
    // UNKNOWN — what cannot be known, stated; server error data is no longer "not connected".
    expect(inv.unknowns.some((u) => /same users/.test(u))).toBe(true);
    expect(inv.unknowns.some((u) => /Whether release 4\.8\.1 is responsible/.test(u))).toBe(true);
    expect(inv.unknowns.join('\n')).not.toMatch(/server error data/i);
    expect(inv.releaseAssociation).toMatchObject({ version: '4.8.1', timing: 'actual' });

    // Causality guard across everything written.
    for (const text of [...inv.observed, ...inv.inferred, ...inv.unknowns, inv.likelyExplanation, inv.uncertainty]) expect(hasCausalOverclaim(text), text).toBe(false);
    // Budget and stopping rules hold with one more source.
    expect(inv.toolCalls).toBeLessThanOrEqual(BUDGET);
    expect(inv.stopReason).toBeTruthy();
    // Links go to the organization's Sentry; no personal data from issue titles.
    expect(inv.evidence.some((e) => e.link?.externalUrl?.startsWith('https://acme.sentry.io/'))).toBe(true);
    expect(JSON.stringify(investigations)).not.toMatch(/maria\.lopez@example\.org/);
  });

  it('Sentry unavailable: a stated gap — never a fabricated reading, never a telemetry finding', async () => {
    const { investigations } = await run(true);
    const inv = investigations[0];
    expect(inv).toBeDefined();
    expect(inv.evidence.some((e) => e.provider === 'sentry' && (e.direction === 'degraded' || e.direction === 'stable'))).toBe(false);
    expect(inv.evidence.some((e) => e.provider === 'sentry' && e.direction === 'gap')).toBe(true);
    expect(inv.inferred.join('\n')).not.toMatch(/Error telemetry|Sentry and/);
    expect(inv.toolCalls).toBeLessThanOrEqual(BUDGET);
  });
});
