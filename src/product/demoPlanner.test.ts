import { afterEach, describe, expect, it } from 'vitest';
import type { MonitoringResult, PlannerRunInfo } from './types';
import { defaultBriefSchedule, defaultWatches } from './catalog';
import { defaultConnections } from './integrations/adapters';
import { buildWorld, CHECKOUT_ISSUES, CHECKOUT_REVIEWS, defaultWorld, RELEASES_481 } from './integrations/world';
import { runMonitoring } from './engine/monitor';
import { ApprovalRequiredError, executeAction } from './agent/actions';
import { validatePlan } from './agent/planner';
import { createPlannerHandler, SAMPLE_PLANNER_STATE } from './agent/providers/server';
import { plannerTexts } from './evaluation/adversarial';
import { unauthorisedCalls } from './evaluation/plannerEval';
import { hasCausalOverclaim } from './engine/language';
import { fetchPlannerHealth, llmAvailability, resolvePlanner } from '../state/plannerConfig';

/**
 * Demo / simulated environment + selectable planner. The simulation controls the DATA; the planner
 * switch controls HOW Jagr investigates it. These tests drive the real client path —
 * resolvePlanner → HTTP provider → server endpoint → Gemini adapter — with Google's API mocked.
 */

const KEY = 'AIzaSECRET-test-key-do-not-leak';
const ENV = { LLM_PROVIDER: 'gemini', LLM_MODEL: 'gemini-test-model', LLM_API_KEY: KEY };

/** A stand-in for Google's API: answers generateContent in Gemini's native format. */
function googleApi(answer: (prompt: string) => { status?: number; text?: string; finishReason?: string }) {
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { contents: { parts: { text: string }[] }[] };
    const a = answer(body.contents[0].parts[0].text);
    if (a.status && a.status !== 200) return new Response(JSON.stringify({ error: { code: a.status, status: 'UNAVAILABLE', message: 'high demand' } }), { status: a.status });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: a.text ?? '' }] }, finishReason: a.finishReason ?? 'STOP' }] }), { status: 200 });
  }) as unknown as typeof fetch;
}

/** A sensible plan read from the prompt: the first reachable, not-yet-queried option that tests something. */
function sensible(prompt: string, patch: Record<string, unknown> = {}) {
  const lines = (prompt.split('Tool options:')[1] ?? '').split('\n').filter((l) => l.startsWith('- '));
  const line = lines.find((l) => !/already queried|unavailable|failed earlier|error\)|tests nothing open/.test(l)) ?? lines[0];
  const id = line.slice(2).split(' — ')[0].trim();
  const tests = (line.match(/tests ([^—]+)—/)?.[1] ?? 'HYP-02').split(',').map((s) => s.trim()).filter((s) => /^HYP-\d\d$/.test(s));
  return JSON.stringify({ nextTool: id, reason: `Tests whether ${tests.join(', ')} holds; ${id} is still unqueried.`, evidenceGap: `Evidence for ${tests.join(', ')}`, hypothesesAffected: tests.length ? tests : ['HYP-02'], expectedEvidence: 'A result consistent with, or weakening, these hypotheses.', ...patch });
}

/** Route the browser's /api/planner/* calls to the real server handler (as the dev server does). */
function mountEndpoint(env: Record<string, string>, google: typeof fetch) {
  const handle = createPlannerHandler(env, google);
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (!u.startsWith('/api/planner')) return original(url, init);
    const out = await handle({ method: init?.method ?? 'GET', path: u.replace('/api/planner', ''), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return () => (globalThis.fetch = original);
}

let unmount: (() => void) | undefined;
afterEach(() => unmount?.());

async function demoRun(choice: 'deterministic' | 'llm', google: typeof fetch = googleApi((p) => ({ text: sensible(p) })), world = defaultWorld()) {
  unmount = mountEndpoint(ENV, google);
  const health = await fetchPlannerHealth();
  const { planner, info } = await resolvePlanner(choice, health);
  const r = await runMonitoring({ world, watches: defaultWatches(), connections: defaultConnections(), brief: defaultBriefSchedule(), planner });
  return { r, info, health };
}

const checkout = (r: MonitoringResult) => r.investigations.find((i) => i.area === 'checkout' && i.status !== 'DISMISSED')!;
const decisions = (r: MonitoringResult) => checkout(r).trace.filter((s) => s.planner).map((s) => s.planner!);

describe('planner selection in the demo / simulated environment', () => {
  it('the selector offers the real provider and model, or explains why not', async () => {
    unmount = mountEndpoint(ENV, googleApi((p) => ({ text: sensible(p) })));
    expect(llmAvailability(await fetchPlannerHealth())).toEqual({ available: true, label: 'Gemini · gemini-test-model' });
    unmount();
    unmount = mountEndpoint({}, googleApi(() => ({})));
    expect(llmAvailability(await fetchPlannerHealth())).toMatchObject({ available: false, reason: 'No LLM provider configured.' });
  });

  it('1 · demo + deterministic (the default): no LLM call, every decision DETERMINISTIC', async () => {
    let calls = 0;
    const { r, info } = await demoRun('deterministic', googleApi((p) => (calls++, { text: sensible(p) })));
    expect(info.mode).toBe('deterministic');
    expect(calls).toBe(0);
    expect(decisions(r).every((d) => d.type === 'DETERMINISTIC')).toBe(true);
    expect(checkout(r).attention).toBe('HIGH');
    // Default choice is deterministic even when an LLM is configured.
    expect((await resolvePlanner(undefined, await fetchPlannerHealth())).info.mode).toBe('deterministic');
  });

  it('2 · demo + Gemini: Gemini proposes, the validator approves, simulated tools execute, HIGH, pause waits', async () => {
    const { r, info } = await demoRun('llm');
    expect(info).toMatchObject({ mode: 'llm', provider: 'gemini', model: 'gemini-test-model' });
    const approved = decisions(r).filter((d) => d.type === 'LLM' && d.provider === 'gemini' && d.model === 'gemini-test-model' && d.validator === 'APPROVED');
    expect(approved.length).toBeGreaterThan(2);
    expect(unauthorisedCalls(r)).toEqual([]);
    expect(checkout(r).trace.some((s) => s.kind === 'tool_call')).toBe(true);
    expect(checkout(r).attention).toBe('HIGH');
    expect(checkout(r).actions.find((a) => a.kind === 'pause_rollout')?.status).toBe('awaiting_approval');
  });

  it('3 · demo + LLM unavailable: labelled failures, then the circuit opens naming the last error; deterministic takes over', async () => {
    const { r } = await demoRun('llm', googleApi(() => ({ status: 503 })));
    const d = decisions(r);
    expect(d.some((x) => x.type === 'LLM' && x.failure?.code === 'MODEL_UNAVAILABLE')).toBe(true);
    const circuit = d.find((x) => x.failure?.code === 'CIRCUIT_OPEN');
    expect(circuit?.failure?.detail).toMatch(/last error: .*503/);
    expect(d.filter((x) => x.type === 'DETERMINISTIC_FALLBACK').length).toBeGreaterThan(2);
    expect(checkout(r).attention).toBe('HIGH');
  });

  it('4 · demo + malformed LLM response → INVALID_JSON, deterministic fallback', async () => {
    const { r } = await demoRun('llm', googleApi(() => ({ text: '{"nextTool": "getWorkItems", "reason": "Engin' })));
    expect(decisions(r).some((x) => x.failure?.code === 'INVALID_JSON')).toBe(true);
    expect(decisions(r).some((x) => x.type === 'DETERMINISTIC_FALLBACK' && x.validator === 'APPROVED')).toBe(true);
  });

  it('4b · demo + cut-off LLM response (thinking used the output budget) → TRUNCATED_OUTPUT, deterministic fallback', async () => {
    const { r } = await demoRun('llm', googleApi(() => ({ text: '{"nextTool":"get', finishReason: 'MAX_TOKENS' })));
    expect(decisions(r).some((x) => x.failure?.code === 'TRUNCATED_OUTPUT')).toBe(true);
    expect(checkout(r).attention).toBe('HIGH');
  });

  it('5 · demo + rejected LLM proposal → rejection recorded, deterministic plan executes instead', async () => {
    const { r } = await demoRun('llm', googleApi((p) => ({ text: sensible(p, { reason: 'Release 4.8.1 caused the checkout drop, so check Jira.' }) })));
    const d = decisions(r);
    expect(d.some((x) => x.type === 'LLM' && x.validator === 'REJECTED' && x.rejection?.code === 'CAUSAL_CLAIM' && !x.reason)).toBe(true);
    expect(d.some((x) => x.type === 'DETERMINISTIC_FALLBACK' && x.validator === 'APPROVED')).toBe(true);
    expect(plannerTexts(r).some(hasCausalOverclaim)).toBe(false);
  });

  it('6 · same simulated scenario → same evidence available, whichever planner asks', async () => {
    const det = (await demoRun('deterministic')).r;
    unmount?.();
    const gem = (await demoRun('llm')).r;
    const results = (r: MonitoringResult) => {
      const m = new Map<string, string>();
      const t = checkout(r).trace;
      t.forEach((s, i) => s.kind === 'tool_call' && t[i + 1]?.kind === 'result' && m.set(`${s.at.slice(0, 16)}|${s.tool}|${s.source}|${s.input}|${s.why}`, t[i + 1].title));
      return m;
    };
    const a = results(det);
    const b = results(gem);
    const shared = [...a.keys()].filter((k) => b.has(k));
    expect(shared.length).toBeGreaterThan(5);
    for (const k of shared) expect(b.get(k)).toBe(a.get(k));
  });

  it('7 · the validator judges a proposal the same way whoever made it', async () => {
    const proposal = JSON.parse(sensible('Tool options:\n- rollback_release — jira (simulated) — tests HYP-01 — x', { nextTool: 'rollback_release' }));
    expect(validatePlan(proposal, SAMPLE_PLANNER_STATE)).toMatchObject({ ok: false, code: 'ACTION_NOT_TOOL' });
    const { r } = await demoRun('llm', googleApi((p) => ({ text: sensible(p, { nextTool: 'rollback_release' }) })));
    const codes = new Set(decisions(r).filter((d) => d.type === 'LLM' && d.validator === 'REJECTED').map((d) => d.rejection?.code));
    expect([...codes]).toEqual(['ACTION_NOT_TOOL']);
    expect(r.actions.some((a) => a.kind === 'rollback_release' && a.status === 'executed')).toBe(false);
  });

  it('8 · HIGH / CRITICAL approval enforcement is identical under both planners', async () => {
    const critical = () => buildWorld({ id: 'crit', name: 'crit', seed: 481, effects: { 'ga4.checkout_conversion': [{ from: '19:00', change: -60 }], 'app_store.crash_free_sessions': [{ from: '19:00', change: -0.67 }] }, releases: RELEASES_481, issues: CHECKOUT_ISSUES, reviews: CHECKOUT_REVIEWS });
    const summary: string[] = [];
    for (const choice of ['deterministic', 'llm'] as const) {
      unmount?.();
      const { r } = await demoRun(choice, undefined, critical());
      const risky = r.actions.filter((a) => a.risk === 'HIGH' || a.risk === 'CRITICAL');
      expect(risky.length).toBeGreaterThan(0);
      for (const a of risky) {
        expect(a.status).toBe('awaiting_approval');
        expect(() => executeAction(a)).toThrow(ApprovalRequiredError);
      }
      summary.push(JSON.stringify(risky.map((a) => [a.kind, a.risk, a.status]).sort()));
    }
    expect(summary[0]).toBe(summary[1]);
  });

  it('9 · the API key never reaches client state, the run info or the trace', async () => {
    const ok = await demoRun('llm');
    unmount?.();
    const failing = await demoRun('llm', googleApi(() => ({ status: 503 })));
    const clientSide = (x: { r: MonitoringResult; info: PlannerRunInfo; health: unknown }) => JSON.stringify([x.r, x.info, x.health, { ...x.r, planner: x.info }]);
    expect(clientSide(ok)).not.toContain(KEY);
    expect(clientSide(failing)).not.toContain(KEY);
    expect(clientSide(ok)).not.toMatch(/AIza/);
  });
});
