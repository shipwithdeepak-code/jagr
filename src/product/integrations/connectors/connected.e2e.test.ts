import { describe, expect, it } from 'vitest';
import type { Connection } from '../../ports/persistence';
import type { HttpRequest } from '../../ports/http';
import type { SecretPayload } from '../../ports/secrets';
import { manualClock } from '../../ports/clock';
import { createMemoryPersistence, createMemorySecretStore } from '../../ports/memory';
import { runWatchJob, sourcesForRun } from '../../app/monitoring';
import { watchFromTemplate } from '../../catalog';
import { createPlannerManager } from '../../agent/planner';
import { llmPlannerProvider } from '../../agent/providers/registry';
import { scriptedHttp, type Reply } from '../../testkit/connectorContract';
import { CONNECTORS, connectorsFrom } from './index';

/**
 * A connected workspace with every P0 connector (Amplitude, GitHub, Jira, Intercom), run end to end by
 * the scheduled-watch path — no sample or simulated data anywhere. Provider responses are synthesised
 * in each API's documented shape.
 */

const NOW = '2026-09-25T06:00:00.000Z';
const HOUR = 3_600_000;
const pad = (n: number) => String(n).padStart(2, '0');
const HOURS = Array.from({ length: 8 * 24 + 1 }, (_, i) => Date.parse(NOW) - 8 * 24 * HOUR + i * HOUR);
const local = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:00:00`;
};
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const PII = /maria|@example\.org|555 0132|4242 4242|svc-jagr@/i;

function route(u: URL, init?: HttpRequest): Reply | undefined {
  switch (u.hostname) {
    case 'amplitude.com': {
      if (u.pathname === '/api/2/annotations') return { body: { data: [] } };
      const e = JSON.parse(u.searchParams.get('e')!).event_type as string;
      const drop = (ms: number) => ms >= Date.parse('2026-09-25T02:00:00Z');
      return { body: { data: { series: [HOURS.map((h) => (e === 'Checkout Started' ? 200 : drop(h) ? 45 : 60))], seriesLabels: [0], xValues: HOURS.map(local) } } };
    }
    case 'api.github.com':
      if (u.pathname === '/repos/acme/web/deployments') return { body: u.searchParams.get('page') === '1' ? [{ id: 1, sha: 'abcdef1234567', ref: 'v2.3.0', environment: 'production', created_at: '2026-09-25T01:30:00Z' }] : [] };
      if (u.pathname === '/repos/acme/web/deployments/1/statuses') return { body: [{ state: 'success', created_at: '2026-09-25T01:45:00Z' }] };
      if (u.pathname === '/repos/acme/web/releases') return { body: [] };
      return undefined;
    case 'acme.atlassian.net':
      if (u.pathname === '/rest/api/3/search/jql')
        return {
          body: {
            issues: ['02:20', '02:50', '03:30', '04:10'].map((t, i) => ({
              key: `SHOP-${200 + i}`,
              fields: { summary: `Checkout payment fails on submit (${i + 1})`, created: `2026-09-25T${t}:00.000+0000`, issuetype: { name: 'Bug' }, priority: { name: i === 0 ? 'Highest' : 'High' }, components: [{ name: 'Checkout' }], labels: [], versions: [{ name: '2.3.0' }] },
            })),
            isLast: true,
          },
        };
      if (u.pathname === '/rest/api/3/project/SHOP/versions') return { body: [] };
      return undefined;
    case 'api.intercom.io':
      if (u.pathname === '/conversations/search' && init?.method === 'POST')
        return {
          body: {
            conversations: ['02:15', '02:40', '03:05', '03:20', '04:00'].map((t, i) => ({
              id: `90${i}`,
              created_at: unix(`2026-09-25T${t}:00Z`),
              source: { subject: '', body: `<p>I can't pay, checkout payment fails. Contact maria.lopez${i}@example.org or +1 415 555 0132. Card 4242 4242 4242 4242.</p>`, author: { type: 'user' } },
              tags: { tags: [{ name: 'checkout' }] },
            })),
            pages: { next: null },
          },
        };
      return undefined;
  }
  return undefined;
}

const conn = (source: Connection['source'], roles: Connection['roles'], config: Record<string, unknown>): Connection => ({ id: `owner-${source}`, workspaceId: 'ws-1', source, provider: source, roles, authKind: 'owner_env', state: 'connected', detail: source, config, updatedAt: NOW });
const CONNS: [Connection, SecretPayload][] = [
  [conn('amplitude', ['metrics', 'changes'], { metrics: [{ kind: 'ratio', key: 'checkout_conversion', name: 'Checkout conversion', area: 'checkout', numerator: { event_type: 'Order Completed' }, denominator: { event_type: 'Checkout Started' }, badDirection: 'down', threshold: 10 }] }), { kind: 'api_key', fields: { apiKey: 'amp_key_1234', secretKey: 'amp_secret_1234' } }],
  [conn('github', ['changes'], { repos: ['acme/web'] }), { kind: 'api_key', fields: { token: 'github_pat_e2e_000000000' } }],
  [conn('jira', ['work_items', 'changes'], { site: 'https://acme.atlassian.net', project: 'SHOP' }), { kind: 'api_key', fields: { email: 'svc-jagr@acme.test', apiToken: 'ATATT_e2e_0000000' } }],
  [conn('intercom', ['feedback'], { region: 'us' }), { kind: 'api_key', fields: { token: 'intercom_e2e_0000000' } }],
];

async function run(opts: { aiEgressAllowed: boolean }) {
  const { repos, tx } = createMemoryPersistence();
  const secrets = createMemorySecretStore();
  const clock = manualClock(NOW);
  await repos.workspaces.create({ id: 'ws-1', name: 'Acme', mode: 'connected', createdAt: NOW, settings: { planner: 'llm', aiEgressAllowed: opts.aiEgressAllowed, timezone: 'UTC' }, brief: { enabled: true, time: '08:00', timezone: 'UTC' }, importedExportIds: [], version: 1 });
  for (const [c, s] of CONNS) await repos.connections.save('ws-1', { ...c, secretRef: await secrets.put({ workspaceId: 'ws-1', connectionId: c.id }, s) });
  // A stand-in AI provider that records every prompt it is sent (and answers nothing usable, so Jagr falls back).
  const prompts: string[] = [];
  const planner = createPlannerManager({ primary: llmPlannerProvider({ id: 'spy', displayName: 'Spy', model: 'spy-1', generate: async (req) => (prompts.push(req.prompt, req.system), '{}') }), timeoutMs: 2000 });
  const deps = { repos, tx, secrets, clock, http: scriptedHttp(route).http, connectors: connectorsFrom(CONNECTORS), planner };
  const sources = await sourcesForRun(deps, (await repos.workspaces.get('ws-1'))!, NOW);
  await repos.watches.save('ws-1', watchFromTemplate('w-checkout', 'checkout_health', { sources: ['amplitude', 'github', 'jira', 'intercom'], metricKeys: sources.registry.metrics().map((m) => m.def.key) }, NOW));
  await runWatchJob(deps, { workspaceId: 'ws-1', payload: { watchId: 'w-checkout', dueAt: NOW } });
  return { investigations: await repos.investigations.list('ws-1'), prompts, sources };
}

describe('connected workspace, every P0 connector (end to end)', () => {
  it('all four sources load as connected', async () => {
    const { sources } = await run({ aiEgressAllowed: false });
    expect(sources.registry.sources().map((s) => s.id).sort()).toEqual(['amplitude', 'github', 'intercom', 'jira']);
    expect(sources.connections.every((c) => c.state === 'connected')).toBe(true);
  });

  it('investigates with corroboration across sources, correlation (not cause), and no personal data stored', async () => {
    const { investigations } = await run({ aiEgressAllowed: false });
    const inv = investigations.find((i) => i.signals.some((s) => s.key === 'metric:checkout_conversion'))!;
    expect(inv).toBeDefined();
    expect(new Set(inv.evidence.map((e) => e.provider))).toEqual(new Set(['amplitude', 'github', 'jira', 'intercom']));
    expect(inv.correlatedProviders).toEqual(expect.arrayContaining(['jira', 'intercom']));
    // Support conversations are named as such — never as star-rated reviews.
    expect(inv.trace.some((t) => /support conversations/.test(t.title))).toBe(true);
    expect(JSON.stringify(inv.trace)).not.toMatch(/1–2★/);
    expect(inv.releaseAssociation).toMatchObject({ kind: 'deploy', timing: 'actual' });
    const text = JSON.stringify(investigations);
    expect(text).not.toMatch(PII);
    expect(text).not.toMatch(/\b(caused by|root cause is|was caused)\b/i);
    expect(inv.sourceLinks.every((l) => !l.simulated)).toBe(true);
  });

  it('AI egress: prompts carry no personal data; a workspace that disallows egress never calls the model', async () => {
    const allowed = await run({ aiEgressAllowed: true });
    expect(allowed.prompts.length).toBeGreaterThan(0);
    for (const p of allowed.prompts) expect(p).not.toMatch(PII);
    const denied = await run({ aiEgressAllowed: false });
    expect(denied.prompts).toEqual([]);
  });
});
