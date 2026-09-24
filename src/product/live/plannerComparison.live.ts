import { loadEnv } from 'vite';
import { test } from 'vitest';
import type { MonitoringResult, SourceConnection } from '../types';
import { defaultBriefSchedule, defaultWatches } from '../catalog';
import { defaultConnections } from '../integrations/adapters';
import { defaultWorld } from '../integrations/world';
import { runMonitoring } from '../engine/monitor';
import { createPlannerManager, type InvestigationPlanner } from '../agent/planner';
import { readPlannerConfig } from '../agent/providers/config';
import { llmPlannerProvider, PROVIDER_REGISTRY } from '../agent/providers/registry';
import { overclaimingSentences } from '../engine/language';
import { plannerTexts } from '../evaluation/adversarial';
import { generatedTexts } from '../evaluation/golden';
import { unauthorisedCalls } from '../evaluation/plannerEval';

/**
 * MANUAL live comparison — makes real API calls. Never part of `npm test`.
 *
 *   npm run eval:planners
 *
 * Runs the checkout −18% night (and a Jira-outage variant) once per planner:
 * deterministic, then each provider in PLANNER_COMPARE (default: anthropic,gemini,openai) that has
 * credentials — ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY and ANTHROPIC_MODEL /
 * GEMINI_MODEL / OPENAI_MODEL, from the environment or .env.local. Providers without credentials
 * are reported as skipped, never faked. Prints a comparison table; it does not assume any provider
 * is better.
 */

const env = loadEnv('development', process.cwd(), '');
const ids = (env.PLANNER_COMPARE ?? 'anthropic,gemini,openai').split(',').map((s) => s.trim()).filter(Boolean);

function plannerFor(id: string): { planner?: InvestigationPlanner; skip?: string; label: string } {
  if (id === 'deterministic') return { label: 'Deterministic' };
  // Compare on provider-specific variables so one generic LLM_* setting cannot leak across providers.
  const own = id === env.LLM_PROVIDER ? env : { ...env, LLM_MODEL: '', LLM_API_KEY: '', LLM_BASE_URL: '' };
  const cfg = readPlannerConfig({ ...own, PLANNER_MODE: 'llm', LLM_PROVIDER: id, LLM_FALLBACK_PROVIDER: '' });
  const r = cfg.primary;
  if (!r?.configured || !r.config) return { label: r?.displayName ?? id, skip: r?.problems.join(' ') ?? 'not configured' };
  const provider = llmPlannerProvider(PROVIDER_REGISTRY[id].create(r.config), { timeoutMs: cfg.timeoutMs });
  return { planner: createPlannerManager({ primary: provider, timeoutMs: cfg.timeoutMs + 2000 }), label: `${r.displayName} · ${r.model}` };
}

function summarise(r: MonitoringResult, ms: number) {
  const inv = r.investigations.find((i) => i.area === 'checkout' && i.status !== 'DISMISSED');
  const d = r.investigations.flatMap((i) => i.trace).filter((s) => s.planner).map((s) => s.planner!);
  const llm = d.filter((x) => x.type === 'LLM');
  const rejected = llm.filter((x) => x.validator === 'REJECTED');
  const firstPass = inv?.trace.filter((s) => s.kind === 'planner' && s.pass === Math.min(...inv.trace.filter((x) => x.kind === 'planner').map((x) => x.pass)));
  const latencies = llm.filter((x) => typeof x.latencyMs === 'number' && !x.cached).map((x) => x.latencyMs!);
  const h = (k: string) => inv?.agentHypotheses.find((x) => x.kind === k);
  const causal = [...generatedTexts(r), ...plannerTexts(r)].flatMap(overclaimingSentences).length;
  return {
    'tool calls': inv?.toolCalls ?? 0,
    'first-pass tool order': (firstPass ?? []).map((s) => s.planner!.executedTool ?? `✗${s.planner!.proposedTool ?? '—'}`).join(' → '),
    'LLM plans approved': llm.filter((x) => x.validator === 'APPROVED').length,
    'LLM plans rejected': rejected.length ? `${rejected.length} (${[...new Set(rejected.map((x) => x.rejection?.code))].join(', ')})` : '0',
    'LLM failures': llm.filter((x) => x.failure).length ? [...new Set(llm.filter((x) => x.failure).map((x) => x.failure!.code))].join(', ') : '0',
    'deterministic fallbacks': d.filter((x) => x.type === 'DETERMINISTIC_FALLBACK').length,
    'hypotheses (release / product / demand / tracking)': [h('release_related'), h('shared_product_issue'), h('demand_shift'), h('measurement_artifact')].map((x) => (x ? (x.status === 'ruled_out' ? 'ruled out' : x.strength) : '—')).join(' / '),
    unknowns: inv?.unknowns.length ?? 0,
    'final severity': inv?.attention ?? '—',
    actions: inv?.actions.map((a) => `${a.kind}:${a.status}`).join(', ') ?? '—',
    'causal sentences': causal,
    'unvalidated tool calls': unauthorisedCalls(r).length,
    'planner latency (avg / total)': latencies.length ? `${Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)} ms / ${latencies.reduce((a, b) => a + b, 0)} ms` : '—',
    'wall time': `${ms} ms`,
  };
}

const jiraDown = (cs: SourceConnection[]) => cs.map((c) => (c.provider === 'jira' ? { ...c, state: 'unavailable' as const, detail: 'Connection timed out (simulated outage)' } : c));

test(
  'live planner comparison — checkout −18%',
  async () => {
    const columns: Record<string, Record<string, unknown>> = {};
    for (const id of ['deterministic', ...ids]) {
      const p = plannerFor(id);
      for (const [scenario, connections] of [['checkout −18%', defaultConnections()], ['checkout −18%, Jira down', jiraDown(defaultConnections())]] as const) {
        const col = `${p.label} — ${scenario}`;
        if (p.skip) {
          columns[col] = { skipped: p.skip };
          continue;
        }
        const t0 = Date.now();
        const r = await runMonitoring({ world: defaultWorld(), watches: defaultWatches(), connections, brief: defaultBriefSchedule(), planner: p.planner });
        columns[col] = summarise(r, Date.now() - t0);
      }
    }
    const rows = [...new Set(Object.values(columns).flatMap((c) => Object.keys(c)))];
    const names = Object.keys(columns);
    const md = [`| metric | ${names.join(' | ')} |`, `|---|${names.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r} | ${names.map((n) => String(columns[n][r] ?? '').replace(/\|/g, '/')).join(' | ')} |`)].join('\n');
    console.log(`\nPlanner comparison (${new Date().toISOString()})\n\n${md}\n`);
  },
  15 * 60_000,
);
