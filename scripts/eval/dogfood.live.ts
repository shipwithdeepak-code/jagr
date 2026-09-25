import { randomBytes } from 'node:crypto';
import { loadEnv } from 'vite';
import { test } from 'vitest';
import type { NotificationMessage } from '../../src/product/ports/notify';
import type { SourceId } from '../../src/product/roles/types';
import { WATCH_TEMPLATES, watchFromTemplate } from '../../src/product/catalog';
import { checkConnection, runWatchJob, sourcesForRun } from '../../src/product/app/monitoring';
import { deliver } from '../../src/product/app/notifications';
import { createPlannerManager } from '../../src/product/agent/planner';
import { llmPlannerProvider } from '../../src/product/agent/providers/registry';
import { freshPglite } from '../../server/postgres/pglite';
import { createRuntime } from '../../server/runtime';
import { OWNER_WORKSPACE_ID } from '../../server/singleTenant';

/**
 * MANUAL live dogfood run — real provider calls, never part of `npm test`.
 *
 *   npm run eval:dogfood
 *
 * Boots the real single-tenant runtime (Postgres via in-process PGlite, the real connectors, the real
 * encrypted secret store) with the owner credentials in the environment (JAGR_AMPLITUDE_*, JAGR_GITHUB_*,
 * JAGR_JIRA_*, JAGR_INTERCOM_*, JAGR_SLACK_*), then:
 *   1. bootstrap → which connections exist; check() every one of them
 *   2. one watch per template the connected sources can serve; a scheduled run of each, "as of" now
 *   3. provenance + freshness of every source and every piece of evidence
 *   4. personal data: none in stored investigations, none in any AI planner prompt (a recording
 *      planner stands in for the model, so no model credentials are needed and nothing leaves)
 *   5. aiEgressAllowed=false: the same runs make zero planner calls
 *   6. Slack: only with JAGR_EVAL_SLACK_SEND=1, one clearly-labelled test message to JAGR_SLACK_CHANNEL
 *
 * Prints states, counts, hostnames and pass/fail only — never credentials or customer text.
 * A provider without credentials is reported NOT CONFIGURED; nothing is simulated.
 */

const env = { ...loadEnv('development', process.cwd(), ''), ...process.env } as Record<string, string | undefined>;
const PII = [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, /(?:\+|\b00)\d[\d ().-]{7,}\d\b/, /\b(?:\d[ -]?){12,18}\d\b/];
const piiHits = (text: string) => PII.filter((re) => re.test(text)).length;

test('live dogfood', { timeout: 600_000 }, async () => {
  const out: string[] = [];
  const say = (s: string) => out.push(s);
  const rt = await createRuntime(
    {
      ...env,
      JAGR_MODE: 'single-tenant',
      JAGR_OWNER_IDENTITIES: 'eval:owner',
      JAGR_SESSION_SECRET: env.JAGR_SESSION_SECRET ?? randomBytes(32).toString('hex'),
      JAGR_SECRET_KEY: env.JAGR_SECRET_KEY ?? randomBytes(32).toString('base64'),
    },
    { sql: await freshPglite(), identity: {} },
  );
  say(`bootstrap: configured [${rt.bootstrap?.configured.join(', ') || 'none'}]`);

  // 1. Every connection, checked for real.
  const conns = await rt.repos.connections.list(OWNER_WORKSPACE_ID);
  for (const name of ['amplitude', 'github', 'jira', 'intercom', 'slack']) {
    const c = conns.find((x) => x.source === name);
    if (!c) {
      say(`${name.padEnd(9)} NOT CONFIGURED (no credentials in the environment)`);
      continue;
    }
    const r = await checkConnection(rt, OWNER_WORKSPACE_ID, c.id);
    say(`${name.padEnd(9)} check: ${r.state} — ${r.detail}`);
  }

  // 2. Watches over what the sources can serve; one scheduled run each.
  const ws = (await rt.repos.workspaces.get(OWNER_WORKSPACE_ID))!;
  const now = rt.clock.now();
  const run0 = await sourcesForRun(rt, ws, now);
  const sources = run0.registry.sources().map((s) => s.id);
  say(`sources readable: [${sources.join(', ') || 'none'}]; connections: ${run0.connections.map((c) => `${c.provider}=${c.state}${c.freshAsOf ? ` (fresh to ${c.freshAsOf})` : ''}`).join(', ')}`);
  const metricKeys = run0.registry.metrics().map((m) => m.def.key);
  for (const tpl of WATCH_TEMPLATES) {
    const w = watchFromTemplate(`live-${tpl.id}`, tpl.id, { sources: sources as SourceId[], metricKeys }, now);
    for (const m of run0.registry.metrics()) if ((tpl.area === '*' || m.def.area === tpl.area) && !w.signals.some((s) => s.key === `metric:${m.def.key}`)) w.signals.unshift({ key: `metric:${m.def.key}` });
    if (w.signals.some((s) => s.key !== 'changes')) await rt.repos.watches.save(ws.id, w);
  }
  const watches = await rt.repos.watches.list(ws.id);
  say(`watches with a detectable signal: ${watches.length}${watches.length ? '' : ' — no signal source (metrics, work items or feedback) is connected, so nothing can be detected; change sources alone never start an investigation'}`);

  const prompts: string[] = [];
  const planner = createPlannerManager({ primary: llmPlannerProvider({ id: 'recorder', displayName: 'Recording stand-in', model: 'none', generate: async (req) => (prompts.push(req.system, req.prompt), '{}') }), timeoutMs: 5000 });
  for (const w of watches) await runWatchJob({ ...rt, planner }, { workspaceId: ws.id, payload: { watchId: w.id, dueAt: now } });
  const invs = await rt.repos.investigations.list(ws.id);
  say(`investigations: ${invs.length}`);

  // 3. Provenance and freshness.
  for (const inv of invs) {
    const byProvider = [...new Set(inv.evidence.map((e) => e.provider))];
    const hosts = [...new Set(inv.evidence.flatMap((e) => (e.link ? [new URL(e.link.externalUrl).hostname] : [])))];
    const gaps = inv.trace.filter((t) => t.kind === 'gap').length;
    say(`  • ${inv.attention} ${inv.status} — evidence from [${byProvider.join(', ')}], link hosts [${hosts.join(', ')}], simulated links: ${inv.sourceLinks.filter((l) => l.simulated).length}, gaps: ${gaps}, tool calls: ${inv.toolCalls}`);
  }

  // 4–5. Personal data and AI egress.
  say(`PII in stored investigations: ${piiHits(JSON.stringify(invs))} pattern(s) matched (expect 0)`);
  say(`planner prompts recorded (aiEgressAllowed=true): ${prompts.length}; PII in prompts: ${piiHits(prompts.join('\n'))} pattern(s) matched (expect 0)`);
  const before = prompts.length;
  await rt.repos.workspaces.update({ ...ws, settings: { ...ws.settings, aiEgressAllowed: false } }, ws.version);
  const fresh = (await rt.repos.workspaces.get(ws.id))!;
  for (const w of watches) await rt.repos.watches.save(ws.id, { ...w, id: `${w.id}-noegress` });
  for (const w of watches) await runWatchJob({ ...rt, planner }, { workspaceId: fresh.id, payload: { watchId: `${w.id}-noegress`, dueAt: now } });
  say(`aiEgressAllowed=false: ${prompts.length - before} planner call(s) (expect 0)${watches.length ? '' : ' — not exercised: no watch could run'}`);

  // 6. Slack, only on explicit request.
  if (conns.some((c) => c.source === 'slack' && c.state === 'connected')) {
    if (env.JAGR_EVAL_SLACK_SEND === '1') {
      const msg: NotificationMessage = { kind: 'resolved', workspaceId: ws.id, dedupeKey: `eval:${now}`, title: 'Jagr live check — test message', summary: 'This is a test delivery from `npm run eval:dogfood`. No action needed.', observed: [], inferred: [], unknown: [], links: [] };
      const r = await deliver(rt, fresh, [msg]);
      const log = (await rt.repos.notifications.list(ws.id)).filter((n) => n.channel === 'slack');
      say(`slack test message: delivered ${r.delivered}, failed ${r.failed}${log.length ? ` — ${log[log.length - 1].detail?.replace(/^.*· /, '')}` : ''}`);
    } else say('slack: configured; set JAGR_EVAL_SLACK_SEND=1 to send one test message');
  }
  console.log(`\nLive dogfood (${now})\n${out.join('\n')}\n`);
});
