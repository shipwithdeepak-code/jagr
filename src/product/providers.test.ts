import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultBriefSchedule, defaultWatches } from './catalog';
import { defaultConnections } from './integrations/adapters';
import { defaultWorld } from './integrations/world';
import { runMonitoring } from './engine/monitor';
import { ApprovalRequiredError, executeAction } from './agent/actions';
import { createPlannerManager, validatePlan, type LLMPlannerProvider, type PlannerInput } from './agent/planner';
import { llmPlannerProvider, PROVIDER_REGISTRY } from './agent/providers/registry';
import { publicPlannerConfig, readPlannerConfig } from './agent/providers/config';
import { createPlannerHandler, SAMPLE_PLANNER_STATE } from './agent/providers/server';
import { toGeminiSchema } from './agent/providers/gemini';
import { PLAN_JSON_SCHEMA } from './agent/plannerSchema';
import { impactFirst } from './evaluation/plannerDoubles';
import { unauthorisedCalls } from './evaluation/plannerEval';
import { plannerTexts } from './evaluation/adversarial';
import { hasCausalOverclaim } from './engine/language';

/**
 * Provider adapter tests with mocked HTTP. No live API calls — live comparison is `npm run eval:planners`.
 * The same cases run against every provider: each adapter must turn its native response into the
 * same normalized proposal, and the same policy must judge it.
 */

type Captured = { url: string; init: RequestInit; body: Record<string, unknown>; headers: Record<string, string> };

/** How each provider's API wraps a plan (given as the raw text the model produced). */
const NATIVE: Record<string, (text: string) => unknown> = {
  anthropic: (text) => {
    if (!text) return { content: [], stop_reason: 'end_turn' };
    try {
      const input = JSON.parse(text);
      if (input && typeof input === 'object') return { content: [{ type: 'tool_use', name: 'propose_next_step', input }], stop_reason: 'tool_use' };
    } catch {
      /* fall through: the model answered in prose */
    }
    return { content: [{ type: 'text', text }], stop_reason: 'end_turn' };
  },
  gemini: (text) => ({ candidates: [{ content: { parts: text ? [{ text }] : [] }, finishReason: 'STOP' }] }),
  openai: (text) => ({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }),
  'openai-compatible': (text) => ({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }),
};

const CONFIG: Record<string, { model: string; apiKey?: string; baseUrl?: string }> = {
  anthropic: { model: 'test-claude', apiKey: 'sk-ant-TESTKEY-1234' },
  gemini: { model: 'test-gemini', apiKey: 'AIzaTESTKEY-5678' },
  openai: { model: 'test-gpt', apiKey: 'sk-TESTKEY-9012' },
  'openai-compatible': { model: 'llama-test', baseUrl: 'http://localhost:11434/v1' },
};

function mocked(provider: string, respond: (captured: Captured) => { status?: number; body?: unknown } | Promise<never>) {
  const calls: Captured[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const c = { url, init, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> };
    calls.push(c);
    const r = await respond(c);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  const adapter = PROVIDER_REGISTRY[provider].create({ provider, ...CONFIG[provider] }, f);
  return { provider: llmPlannerProvider(adapter, { timeoutMs: 50 }), calls };
}

const state = (patch: Partial<PlannerInput> = {}): PlannerInput => ({ ...SAMPLE_PLANNER_STATE, ...patch });
const proposal = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({ nextTool: 'getWorkItems', reason: 'The product-issue hypothesis has no engineering evidence yet.', evidenceGap: 'Recent checkout defects', hypothesesAffected: ['HYP-02'], expectedEvidence: 'Checkout bugs or incidents, or none.', ...patch });

const PROVIDERS = Object.keys(NATIVE);

describe.each(PROVIDERS)('%s adapter', (id) => {
  const planWith = async (text: string, s: PlannerInput = state()) => {
    const { provider, calls } = mocked(id, () => ({ body: NATIVE[id](text) }));
    return { out: await provider.plan(s), calls };
  };

  it('valid structured response → the normalized proposal, approved by policy', async () => {
    const { out, calls } = await planWith(proposal());
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.proposal).toEqual(JSON.parse(proposal()));
    expect(out.source?.provider).toBe(id);
    expect(validatePlan(out.proposal, state()).ok).toBe(true);
    // Keys travel only in headers, never in URLs or bodies.
    const key = CONFIG[id].apiKey;
    if (key) {
      expect(calls[0].url).not.toContain(key);
      expect(JSON.stringify(calls[0].body)).not.toContain(key);
      expect(Object.values(calls[0].headers).join(' ')).toContain(key);
    }
  });

  it.each([
    ['malformed', 'Sure — I would look at Jira next.', 'INVALID_JSON'],
    ['truncated JSON', '{"nextTool": "getWorkItems", "reason": "Engin', 'INVALID_JSON'],
    ['empty', '', 'EMPTY_RESPONSE'],
    ['extra field', proposal({ budget: 20 }), 'SCHEMA_VIOLATION'],
  ])('%s response → %s, nothing executes', async (_n, text, code) => {
    const { out } = await planWith(text);
    // Anthropic wraps JSON in a tool call, so truncated text arrives as prose → same failure class.
    expect(out.status).toBe('failed');
    if (out.status === 'failed') expect([code, 'INVALID_JSON']).toContain(out.code);
    if (out.status === 'failed' && code !== 'INVALID_JSON') expect(out.code).toBe(code);
  });

  it.each([
    ['unknown tool', { nextTool: 'getDatadogErrors' }, state(), 'UNKNOWN_TOOL'],
    ['unknown hypothesis', { hypothesesAffected: ['HYP-99'] }, state(), 'INVALID_HYPOTHESIS'],
    ['causal language', { reason: 'Release 4.8.1 caused the checkout drop.' }, state(), 'CAUSAL_CLAIM'],
    ['unavailable source', {}, state({ options: SAMPLE_PLANNER_STATE.options.map((o) => (o.source === 'jira' ? { ...o, sourceState: 'unavailable' } : o)) }), 'SOURCE_UNAVAILABLE'],
    ['repeated tool', {}, state({ options: SAMPLE_PLANNER_STATE.options.map((o) => (o.tool === 'getWorkItems' ? { ...o, alreadyQueried: true } : o)) }), 'ALREADY_QUERIED'],
    ['an action instead of a tool', { nextTool: 'rollback_release' }, state(), 'ACTION_NOT_TOOL'],
  ])('%s → well-formed, but rejected by the same policy (%s)', async (_n, patch, s, code) => {
    const { out } = await planWith(proposal(patch as Record<string, unknown>), s as PlannerInput);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    const v = validatePlan(out.proposal, s as PlannerInput);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe(code);
  });

  it('HTTP error → MODEL_UNAVAILABLE through the manager (no key in the message)', async () => {
    const { provider } = mocked(id, () => ({ status: 500, body: { error: { type: 'overloaded_error', message: `bad key ${CONFIG[id].apiKey}` } } }));
    const out = await createPlannerManager({ primary: provider }).plan(state());
    expect(out.status === 'failed' && out.code).toBe('MODEL_UNAVAILABLE');
    if (out.status === 'failed' && CONFIG[id].apiKey) expect(out.detail).not.toContain(CONFIG[id].apiKey);
  });

  it('timeout → TIMEOUT through the manager', async () => {
    const { provider } = mocked(id, ({ init }) => new Promise<never>((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })))));
    const out = await createPlannerManager({ primary: provider, timeoutMs: 1000 }).plan(state());
    expect(out.status === 'failed' && out.code).toBe('TIMEOUT');
  });
});

describe('cut-off output is reported as TRUNCATED_OUTPUT (found live: Gemini thinking used the whole budget)', () => {
  it.each([
    ['gemini', { candidates: [{ content: { parts: [{ text: '{"nextTool":"get' }] }, finishReason: 'MAX_TOKENS' }] }],
    ['openai', { choices: [{ message: { content: '{"nextTool":"get' }, finish_reason: 'length' }] }],
    ['anthropic', { content: [], stop_reason: 'max_tokens' }],
  ])('%s', async (id, body) => {
    const { provider } = mocked(id, () => ({ body }));
    const out = await provider.plan(state());
    expect(out.status === 'failed' && out.code).toBe('TRUNCATED_OUTPUT');
  });
  it('Gemini is given room for thinking tokens and ignores thought parts', async () => {
    const { provider, calls } = mocked('gemini', () => ({ body: { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: proposal() }] }, finishReason: 'STOP' }] } }));
    const out = await provider.plan(state());
    expect(out.status).toBe('ok');
    expect((calls[0].body.generationConfig as { maxOutputTokens: number }).maxOutputTokens).toBeGreaterThanOrEqual(2048);
  });
});

describe('native request formats', () => {
  it('Claude: forced tool call with the shared schema', async () => {
    const { provider, calls } = mocked('anthropic', () => ({ body: NATIVE.anthropic(proposal()) }));
    await provider.plan(state());
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].headers['x-api-key']).toBe(CONFIG.anthropic.apiKey);
    expect(calls[0].body.model).toBe('test-claude');
    expect(calls[0].body.tool_choice).toEqual({ type: 'tool', name: 'propose_next_step' });
    expect((calls[0].body.tools as { input_schema: unknown }[])[0].input_schema).toEqual(PLAN_JSON_SCHEMA);
  });
  it('Gemini: JSON response mode with a Gemini-dialect schema; key in header, not URL', async () => {
    const { provider, calls } = mocked('gemini', () => ({ body: NATIVE.gemini(proposal()) }));
    await provider.plan(state());
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/test-gemini:generateContent');
    expect(calls[0].headers['x-goog-api-key']).toBe(CONFIG.gemini.apiKey);
    const gc = calls[0].body.generationConfig as { responseMimeType: string; responseSchema: Record<string, unknown> };
    expect(gc.responseMimeType).toBe('application/json');
    expect(gc.responseSchema).toEqual(toGeminiSchema(PLAN_JSON_SCHEMA));
    expect(JSON.stringify(gc.responseSchema)).not.toMatch(/additionalProperties|pattern/);
  });
  it('OpenAI: strict json_schema response format', async () => {
    const { provider, calls } = mocked('openai', () => ({ body: NATIVE.openai(proposal()) }));
    await provider.plan(state());
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0].headers.authorization).toBe(`Bearer ${CONFIG.openai.apiKey}`);
    const rf = calls[0].body.response_format as { type: string; json_schema: { strict: boolean; name: string } };
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema.strict).toBe(true);
  });
  it('OpenAI-compatible: configurable base URL, JSON mode by default, no auth header when no key', async () => {
    const { provider, calls } = mocked('openai-compatible', () => ({ body: NATIVE['openai-compatible']('```json\n' + proposal() + '\n```') }));
    const out = await provider.plan(state());
    expect(out.status).toBe('ok'); // a markdown fence is unwrapped by the adapter, not repaired by Jagr
    expect(calls[0].url).toBe('http://localhost:11434/v1/chat/completions');
    expect(calls[0].headers.authorization).toBeUndefined();
    expect((calls[0].body.response_format as { type: string }).type).toBe('json_object');
  });
});

describe('configuration layer', () => {
  it('defaults to deterministic when nothing is configured', () => {
    expect(readPlannerConfig({}).mode).toBe('deterministic');
    expect(readPlannerConfig({ PLANNER_MODE: 'deterministic', LLM_PROVIDER: 'gemini', LLM_MODEL: 'm', LLM_API_KEY: 'k' }).mode).toBe('deterministic');
  });
  it('resolves each provider from generic or provider-specific variables', () => {
    const g = readPlannerConfig({ LLM_PROVIDER: 'gemini', LLM_MODEL: 'gm', GEMINI_API_KEY: 'k1' });
    expect(g.primary).toMatchObject({ provider: 'gemini', model: 'gm', configured: true });
    const o = readPlannerConfig({ LLM_PROVIDER: 'openai', OPENAI_MODEL: 'om', LLM_API_KEY: 'k2' });
    expect(o.primary).toMatchObject({ provider: 'openai', model: 'om', configured: true });
    const legacy = readPlannerConfig({ ANTHROPIC_API_KEY: 'k3' });
    expect(legacy.primary).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5', configured: true });
  });
  it('explains what is missing instead of guessing', () => {
    expect(readPlannerConfig({ LLM_PROVIDER: 'gemini', LLM_API_KEY: 'k' }).primary?.problems.join(' ')).toMatch(/does not guess model names/);
    expect(readPlannerConfig({ LLM_PROVIDER: 'openai', LLM_MODEL: 'm' }).primary?.problems.join(' ')).toMatch(/No API key/);
    expect(readPlannerConfig({ LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'm' }).primary?.problems.join(' ')).toMatch(/LLM_BASE_URL/);
    expect(readPlannerConfig({ LLM_PROVIDER: 'mystery' }).primary?.problems.join(' ')).toMatch(/Unknown provider/);
  });
  it('the fallback provider never borrows the primary key', () => {
    const c = readPlannerConfig({ LLM_PROVIDER: 'gemini', LLM_MODEL: 'g', LLM_API_KEY: 'primary-key', LLM_FALLBACK_PROVIDER: 'openai', LLM_FALLBACK_MODEL: 'o' });
    expect(c.fallback?.configured).toBe(false);
    expect(c.fallback?.problems.join(' ')).toMatch(/No API key/);
  });
  it('public config never contains a key', () => {
    const c = readPlannerConfig({ LLM_PROVIDER: 'gemini', LLM_MODEL: 'g', LLM_API_KEY: 'SECRET-abc123', LLM_FALLBACK_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'SECRET-def456' });
    expect(JSON.stringify(publicPlannerConfig(c))).not.toMatch(/SECRET/);
  });
});

describe('server planner endpoint', () => {
  const env = { LLM_PROVIDER: 'gemini', LLM_MODEL: 'test-gemini', LLM_API_KEY: 'SECRET-gemini-key' };
  const f = (async () => new Response(JSON.stringify(NATIVE.gemini(proposal())), { status: 200 })) as unknown as typeof fetch;

  it('health returns safe information only', async () => {
    const r = await createPlannerHandler(env, f)({ method: 'GET', path: '/health' });
    expect(r.body).toMatchObject({ mode: 'llm', configured: true, primary: { provider: 'gemini', model: 'test-gemini' } });
    expect(JSON.stringify(r.body)).not.toContain('SECRET');
  });
  it('plan and test routes return a normalized outcome and source, never a key', async () => {
    const handle = createPlannerHandler(env, f);
    const plan = await handle({ method: 'POST', path: '/plan', body: { role: 'primary', state: state() } });
    expect(plan.body).toMatchObject({ outcome: { status: 'ok' }, source: { provider: 'gemini', model: 'test-gemini' } });
    const test = await handle({ method: 'POST', path: '/test', body: {} });
    expect(test.body).toMatchObject({ outcome: { status: 'ok' } });
    expect(JSON.stringify([plan.body, test.body])).not.toContain('SECRET');
  });
  it('redacts a key that appears in an upstream error', async () => {
    const leaky = (async () => {
      throw new Error('connect failed for key SECRET-gemini-key');
    }) as unknown as typeof fetch;
    const r = await createPlannerHandler(env, leaky)({ method: 'POST', path: '/plan', body: { state: state() } });
    expect(JSON.stringify(r.body)).not.toContain('SECRET');
    expect(r.body).toMatchObject({ outcome: { status: 'failed', code: 'MODEL_UNAVAILABLE' } });
  });
  it('rejects malformed state and reports misconfiguration as NOT_CONFIGURED', async () => {
    expect((await createPlannerHandler(env, f)({ method: 'POST', path: '/plan', body: { state: { nope: 1 } } })).status).toBe(400);
    const r = await createPlannerHandler({ LLM_PROVIDER: 'gemini', LLM_API_KEY: 'k' }, f)({ method: 'POST', path: '/plan', body: { state: state() } });
    expect(r.body).toMatchObject({ outcome: { status: 'failed', code: 'NOT_CONFIGURED' } });
  });
});

describe('provider fallback (only when configured, never silent)', () => {
  const ok = (id: string): LLMPlannerProvider => ({ id, displayName: id, model: `${id}-m`, plan: async () => ({ status: 'ok', proposal: JSON.parse(proposal()), cached: false }) });
  const down = (id: string): LLMPlannerProvider => ({ id, displayName: id, plan: async () => { throw new Error('ECONNREFUSED'); } });
  const garbage = (id: string): LLMPlannerProvider => ({ id, displayName: id, plan: async () => ({ status: 'failed', code: 'INVALID_JSON', detail: 'not json' }) });

  it('primary unavailable → fallback provider answers, and says so', async () => {
    const out = await createPlannerManager({ primary: down('gemini'), fallback: ok('anthropic') }).plan(state());
    expect(out.status).toBe('ok');
    expect(out.source?.provider).toBe('anthropic');
    expect(out.source?.fallbackFrom?.provider).toBe('gemini');
  });
  it('primary misbehaves (malformed output) → no provider switch; deterministic fallback handles it', async () => {
    const out = await createPlannerManager({ primary: garbage('gemini'), fallback: ok('anthropic') }).plan(state());
    expect(out.status === 'failed' && out.code).toBe('INVALID_JSON');
    expect(out.source?.provider).toBe('gemini');
  });
  it('no fallback configured → no switch', async () => {
    const out = await createPlannerManager({ primary: down('gemini') }).plan(state());
    expect(out.status === 'failed' && out.code).toBe('MODEL_UNAVAILABLE');
  });
});

describe('changing the provider does not change product safety', () => {
  /** A provider backed by the real adapter + mocked HTTP, answering with a sensible plan for the current state. */
  function scriptedOver(id: string) {
    let current: PlannerInput = SAMPLE_PLANNER_STATE;
    const { provider } = mocked(id, () => ({ body: NATIVE[id](impactFirst(current)) }));
    const wrapped: LLMPlannerProvider = { ...provider, plan: (s) => ((current = s), provider.plan(s)) };
    return wrapped;
  }
  const run = (primary?: LLMPlannerProvider) => runMonitoring({ world: defaultWorld(), watches: defaultWatches(), connections: defaultConnections(), brief: defaultBriefSchedule(), planner: primary ? createPlannerManager({ primary }) : undefined });

  it.each(PROVIDERS)('%s: same policy outcome on checkout −18%%', async (id) => {
    const r = await run(scriptedOver(id));
    const inv = r.investigations.find((i) => i.area === 'checkout')!;
    const decisions = inv.trace.filter((s) => s.planner).map((s) => s.planner!);
    expect(decisions.some((d) => d.type === 'LLM' && d.provider === id && d.validator === 'APPROVED')).toBe(true);
    // Policy invariants, whatever the provider:
    expect(unauthorisedCalls(r)).toEqual([]);
    expect(inv.attention).toBe('HIGH');
    expect(inv.agentHypotheses.find((h) => h.kind === 'release_related')!.strength).not.toBe('strong');
    const pause = inv.actions.find((a) => a.kind === 'pause_rollout')!;
    expect(pause.status).toBe('awaiting_approval');
    expect(() => executeAction(pause)).toThrow(ApprovalRequiredError);
    expect(r.actions.filter((a) => a.status === 'executed').every((a) => a.risk === 'LOW')).toBe(true);
    expect(r.emails).toHaveLength(1);
    expect(plannerTexts(r).some(hasCausalOverclaim)).toBe(false);
  });

  it('every provider reaches the identical final assessment and actions when given the same plans', async () => {
    const summary = async (id: string) => {
      const r = await run(scriptedOver(id));
      const inv = r.investigations.find((i) => i.area === 'checkout')!;
      return JSON.stringify([inv.attention, inv.status, inv.agentHypotheses.map((h) => [h.kind, h.status, h.strength]), inv.actions.map((a) => [a.kind, a.status]), r.emails.length]);
    };
    const all = await Promise.all(PROVIDERS.map(summary));
    expect(new Set(all).size).toBe(1);
  });
});

describe('architecture: the engine is provider-agnostic', () => {
  it.each(['src/product/agent/investigator.ts', 'src/product/engine/monitor.ts', 'src/state/product.tsx', 'src/product/agent/planner.ts', 'src/product/agent/plannerManager.ts'])('%s names no provider and reads no key', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).not.toMatch(/anthropic|gemini|openai|claude|api[_-]?key|process\.env/i);
  });
});
