import { loadEnv } from 'vite';
import { test } from 'vitest';
import type { Connection } from '../../src/product/ports/persistence';
import { systemClock } from '../../src/product/ports/clock';
import { CONNECTORS } from '../../src/product/integrations/connectors/index';
import { checkConnector, connectorFactory } from '../../src/product/integrations/connectors/runtime';
import { configuredVars, OWNER_CONNECTORS } from '../../server/singleTenant';

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
  const window = { start: new Date(Date.parse(now) - 24 * 3_600_000).toISOString(), end: now };
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
  console.log(`\nLive connector check (${window.start} → ${window.end})\n${rows.join('\n')}\n`);
});
