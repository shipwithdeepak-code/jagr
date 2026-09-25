import { loadEnv } from 'vite';
import { test } from 'vitest';
import type { Connection } from '../../src/product/ports/persistence';
import { systemClock } from '../../src/product/ports/clock';
import { CONNECTORS } from '../../src/product/integrations/connectors/index';
import { checkConnector, connectorFactory } from '../../src/product/integrations/connectors/runtime';
import { configuredVars, OWNER_CONNECTORS } from '../../server/singleTenant';
import { slackChannel } from '../../src/product/integrations/channels/slack';

/**
 * MANUAL live connector check — makes real, read-only API calls. Never part of `npm test`.
 *
 *   npm run eval:connectors
 *
 * Uses the same owner credentials as single-tenant mode (JAGR_AMPLITUDE_*, JAGR_GITHUB_*, JAGR_JIRA_*,
 * JAGR_INTERCOM_*; environment or .env.local). For each configured connector: check(), then one read per
 * role over the last 24 hours. Prints health and record COUNTS only — never record content or credentials.
 * Connectors without credentials are reported as skipped, never faked.
 */

const env = loadEnv('development', process.cwd(), '');

test('live connectors', { timeout: 120_000 }, async () => {
  const http = (url: string, init?: RequestInit) => fetch(url, init);
  const now = systemClock.now();
  // JAGR_EVAL_WINDOW_HOURS widens the read window (default 24 h) when a provider has no recent activity.
  const hours = Math.min(24 * 30, Math.max(1, Number(env.JAGR_EVAL_WINDOW_HOURS) || 24));
  const window = { start: new Date(Date.parse(now) - hours * 3_600_000).toISOString(), end: now };
  const rows: string[] = [];
  for (const d of CONNECTORS) {
    const spec = OWNER_CONNECTORS.find((s) => s.source === d.id);
    if (!spec || !configuredVars(spec, env)) {
      rows.push(`${d.name.padEnd(10)} skipped — credentials not set`);
      continue;
    }
    const conn: Connection = { id: `live-${d.id}`, workspaceId: 'live', source: spec.source, provider: d.id, roles: spec.roles, authKind: 'owner_env', state: 'connected', detail: '', config: spec.config(env), updatedAt: now };
    const ctx = { secret: spec.secret(env), http, clock: systemClock };
    const check = await checkConnector(d, conn, ctx);
    rows.push(`${d.name.padEnd(10)} check: ${check.state} — ${check.detail}`);
    if (check.state !== 'connected') continue;
    const src = connectorFactory(d)(conn, ctx);
    const count = async (label: string, fn: () => Promise<unknown[] | null>) => {
      const t = Date.now();
      try {
        const r = await fn();
        rows.push(`${''.padEnd(10)} ${label}: ${r ? r.length : 0} record(s) in ${Date.now() - t} ms`);
      } catch (e) {
        rows.push(`${''.padEnd(10)} ${label}: FAILED (${(e as Error).name}) ${(e as Error).message}`);
      }
    };
    for (const m of src.metrics?.metricDefinitions() ?? []) await count(`metric ${m.key} points`, async () => (await src.metrics!.getSeries({ metric: m.key, window }))?.points ?? null);
    if (src.changes) await count('changes', () => src.changes!.getChanges({ window }));
    if (src.work_items) await count('work items', () => src.work_items!.getWorkItems({ window }));
    if (src.feedback) await count('feedback', () => src.feedback!.getFeedback({ window }));
  }
  // JAGR_EVAL_NEGATIVE=1: every connector against its REAL endpoint with deliberately invalid credentials —
  // verifies the real rejection is classified as a credential problem (never as "no data").
  if (env.JAGR_EVAL_NEGATIVE === '1') {
    const bogus: Record<string, { config: Record<string, unknown>; secret: Parameters<typeof checkConnector>[2]['secret'] }> = {
      amplitude: { config: { metrics: [{ kind: 'count', key: 'probe', name: 'Probe', event: { event_type: 'probe' }, badDirection: 'down', threshold: 10 }] }, secret: { kind: 'api_key', fields: { apiKey: 'invalid-key-for-jagr-check', secretKey: 'invalid-secret-for-jagr-check' } } },
      github: { config: { repos: ['shipwithdeepak-code/jagr'] }, secret: { kind: 'api_key', fields: { token: 'invalid-token-for-jagr-check' } } },
      jira: { config: { site: env.JAGR_EVAL_JIRA_SITE ?? 'https://jagr-negative-check.atlassian.net', project: 'JAGR' }, secret: { kind: 'api_key', fields: { email: 'nobody@invalid.test', apiToken: 'invalid-token-for-jagr-check' } } },
      intercom: { config: { region: 'us' }, secret: { kind: 'api_key', fields: { token: 'invalid-token-for-jagr-check' } } },
    };
    rows.push('Invalid credentials against the real endpoints:');
    for (const d of CONNECTORS) {
      const b = bogus[d.id];
      if (!b) continue;
      const conn: Connection = { id: `neg-${d.id}`, workspaceId: 'neg', source: d.source, provider: d.id, roles: d.roles, authKind: 'api_key', state: 'connected', detail: '', config: b.config, updatedAt: now };
      const check = await checkConnector(d, conn, { secret: b.secret, http, clock: systemClock });
      let read = 'n/a';
      try {
        const src = connectorFactory(d)(conn, { secret: b.secret, http, clock: systemClock });
        const r = src.metrics ? await src.metrics.getSeries({ metric: 'probe', window }) : src.changes ? await src.changes.getChanges({ window }) : src.work_items ? await src.work_items.getWorkItems({ window }) : await src.feedback!.getFeedback({ window });
        read = `ANSWERED (${Array.isArray(r) ? r.length : r ? 'series' : 'null'}) — a rejected credential must not answer`;
        // Some sandboxes' egress proxies attach their own credential to GitHub requests: then no token can be verified here.
        if (d.id === 'github') read += ' (this network adds its own GitHub credential — token authentication cannot be verified from here)';
      } catch (e) {
        read = `threw ${(e as Error).name}: ${(e as Error).message}`;
      }
      rows.push(`${d.name.padEnd(10)} check: ${check.state} — ${check.detail}\n${''.padEnd(10)} read: ${read}`);
    }
    const slack = await slackChannel('xoxb-invalid-token-for-jagr-check', http, systemClock).send(
      { kind: 'resolved', workspaceId: 'neg', dedupeKey: 'neg', title: 'probe', summary: 'probe', observed: [], inferred: [], unknown: [], links: [] },
      { address: 'C0000000000' },
    );
    rows.push(`${'Slack'.padEnd(10)} send: ${slack.status} — ${slack.detail}`);
  }
  console.log(`\nLive connector check (${window.start} → ${window.end})\n${rows.join('\n')}\n`);
});
