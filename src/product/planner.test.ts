import { describe, expect, it } from 'vitest';
import { createModelPlanner, createHttpPlannerProvider, parsePlan, planFingerprint, validatePlan, type PlannerInput, type PlannerOption } from './agent/planner';
import { createAnthropicPlannerClient } from './agent/anthropicPlanner';
import { PLAN_JSON_SCHEMA } from './agent/plannerSchema';
import { runPlannerSuite } from './evaluation/plannerEval';
import { evalStatus, runAdversarialSuite } from './evaluation/adversarial';
import { PLANNER_DOUBLES, scripted } from './evaluation/plannerDoubles';

const option = (o: Partial<PlannerOption> & Pick<PlannerOption, 'id' | 'tool' | 'source'>): PlannerOption => ({
  sourceState: 'simulated',
  tests: ['HYP-02'],
  question: 'q',
  alreadyQueried: false,
  sourceFailed: false,
  informative: true,
  ...o,
});

const input = (patch: Partial<PlannerInput> = {}): PlannerInput => ({
  investigationId: 'wi-checkout-1930',
  pass: 2,
  signal: { key: 'ga4.checkout_conversion', label: 'Checkout conversion', magnitude: '−18%' },
  area: 'checkout',
  budget: { used: 2, max: 9 },
  hypotheses: [
    { id: 'HYP-01', kind: 'release_related', label: 'Release-related', status: 'open', strength: 'moderate', ceiling: 'moderate', evidenceFor: [], evidenceAgainst: [], unknowns: [] },
    { id: 'HYP-02', kind: 'shared_product_issue', label: 'Real product issue', status: 'open', strength: 'weak', ceiling: 'strong', evidenceFor: [], evidenceAgainst: [], unknowns: [] },
  ],
  evidence: [],
  options: [
    option({ id: 'getWorkItems', tool: 'getWorkItems', source: 'jira' }),
    option({ id: 'getChanges', tool: 'getChanges', source: 'jira', tests: ['HYP-01'], informative: false }),
    option({ id: 'getMetric(crash_free_sessions_ios)', tool: 'getMetric', source: 'app_store', metric: 'crash_free_sessions_ios' }),
    option({ id: 'getMetric(crash_free_sessions_android)', tool: 'getMetric', source: 'google_play', metric: 'crash_free_sessions_android', alreadyQueried: true }),
  ],
  ...patch,
});

const plan = (patch: Record<string, unknown> = {}) => ({
  nextTool: 'getWorkItems',
  reason: 'The product-issue hypothesis lacks engineering evidence.',
  evidenceGap: 'Recent checkout defects',
  hypothesesAffected: ['HYP-02'],
  expectedEvidence: 'Checkout bugs or incidents, or none.',
  ...patch,
});

describe('plan parsing (fail closed)', () => {
  it('accepts a well-formed plan', () => {
    expect(parsePlan(JSON.stringify(plan())).status).toBe('ok');
  });
  it.each([
    ['', 'EMPTY_RESPONSE'],
    ['   ', 'EMPTY_RESPONSE'],
    ['null', 'EMPTY_RESPONSE'],
    ['{"nextTool": "getWorkItems", "reason": "Engin', 'INVALID_JSON'],
    ['Sure! I suggest calling Jira next.', 'INVALID_JSON'],
    [JSON.stringify(plan({ hypothesesAffected: [] })), 'SCHEMA_VIOLATION'],
    [JSON.stringify(plan({ hypothesesAffected: ['release'] })), 'SCHEMA_VIOLATION'],
    [JSON.stringify({ ...plan(), budget: 20 }), 'SCHEMA_VIOLATION'],
    [JSON.stringify({ ...plan(), reason: undefined }), 'SCHEMA_VIOLATION'],
    [JSON.stringify(plan({ reason: 'x'.repeat(400) })), 'SCHEMA_VIOLATION'],
  ])('rejects %j as %s', (raw, code) => {
    const out = parsePlan(raw);
    expect(out.status).toBe('failed');
    if (out.status === 'failed') expect(out.code).toBe(code);
  });
});

describe('policy validator', () => {
  const v = (p: Record<string, unknown>, i: PlannerInput = input()) => validatePlan(parsePlan(JSON.stringify(plan(p))).status === 'ok' ? (plan(p) as never) : (plan(p) as never), i);

  it('approves a valid, informative, available tool and resolves it to Jagr’s own option', () => {
    const r = v({});
    expect(r.ok && r.option.id).toBe('getWorkItems');
    const q = v({ nextTool: 'getMetric' });
    expect(q.ok && q.option.id).toBe('getMetric(crash_free_sessions_ios)');
  });
  it.each([
    [{ reason: 'Release 4.8.1 caused the drop, so Jira will confirm it.' }, 'CAUSAL_CLAIM'],
    [{ nextTool: 'rollback_release' }, 'ACTION_NOT_TOOL'],
    [{ nextTool: 'pause_rollout' }, 'ACTION_NOT_TOOL'],
    [{ nextTool: 'notifyCustomers' }, 'ACTION_NOT_TOOL'],
    [{ nextTool: 'getDatadogErrors' }, 'UNKNOWN_TOOL'],
    [{ nextTool: 'getFeedbackVolume' }, 'NOT_IN_INVESTIGATION'],
    [{ nextTool: 'getMetric(crash_free_sessions_android)' }, 'ALREADY_QUERIED'],
    [{ hypothesesAffected: ['HYP-07'] }, 'INVALID_HYPOTHESIS'],
    [{ nextTool: 'getChanges', hypothesesAffected: ['HYP-01'] }, 'NO_INFORMATION_VALUE'],
  ])('rejects %j as %s', (p, code) => {
    const r = v(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });
  it('rejects a source that is down, or failed earlier in this pass', () => {
    const downJira = input({ options: input().options.map((o) => (o.source === 'jira' ? { ...o, sourceState: 'unavailable' } : o)) });
    const r1 = v({}, downJira);
    expect(!r1.ok && r1.code).toBe('SOURCE_UNAVAILABLE');
    const failed = input({ options: input().options.map((o) => (o.source === 'jira' ? { ...o, sourceFailed: true } : o)) });
    const r2 = v({}, failed);
    expect(!r2.ok && r2.code).toBe('SOURCE_UNAVAILABLE');
  });
  it('blocks tunnel vision: a twice-unchanged probe waits while another explanation is untested', () => {
    const limited = input({ options: input().options.map((o) => (o.id === 'getWorkItems' ? { ...o, informative: false, probeLimited: true } : o)) });
    const r = v({}, limited);
    expect(!r.ok && r.code).toBe('REPETITIVE_PROBE');
  });
  it('rejects anything once the budget is exhausted — the planner cannot extend it', () => {
    const r = v({}, input({ budget: { used: 9, max: 9 } }));
    expect(!r.ok && r.code).toBe('BUDGET_EXHAUSTED');
  });
});

describe('model planner client handling', () => {
  it('times out, then stops calling a dead planner for the rest of the run', async () => {
    const p = createModelPlanner(PLANNER_DOUBLES.timeout, { timeoutMs: 5, circuitAfter: 2 });
    const codes = [];
    for (let i = 0; i < 4; i++) {
      const r = await p.plan(input({ budget: { used: i, max: 9 } }));
      codes.push(r.status === 'failed' ? r.code : 'ok');
    }
    expect(codes).toEqual(['TIMEOUT', 'TIMEOUT', 'CIRCUIT_OPEN', 'CIRCUIT_OPEN']);
  });
  it('treats a thrown client error as unavailable, never as a plan', async () => {
    const p = createModelPlanner(scripted('throws', () => { throw new Error('ECONNREFUSED'); }));
    const r = await p.plan(input());
    expect(r.status === 'failed' && r.code).toBe('MODEL_UNAVAILABLE');
  });
  it('reuses a plan for an identical investigation state, and says so', async () => {
    let calls = 0;
    const p = createModelPlanner(scripted('counts', () => { calls++; return JSON.stringify(plan()); }));
    const a = await p.plan(input());
    const b = await p.plan(input({ pass: 3, investigationId: 'other' }));
    expect(calls).toBe(1);
    expect(a.status === 'ok' && a.cached).toBe(false);
    expect(b.status === 'ok' && b.cached).toBe(true);
    expect(planFingerprint(input())).not.toBe(planFingerprint(input({ budget: { used: 3, max: 9 } })));
  });
});

describe('Claude planner client (mocked HTTP)', () => {
  it('forces a structured tool call with the plan schema and returns only its input', async () => {
    const requests: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'propose_next_step', input: plan() }], stop_reason: 'tool_use' }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createAnthropicPlannerClient({ apiKey: 'test-key', http: f });
    const raw = await client.complete({ system: 's', prompt: 'p' });
    expect(parsePlan(raw).status).toBe('ok');
    expect(requests[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(requests[0].headers['x-api-key']).toBe('test-key');
    expect(requests[0].body.model).toBe('claude-sonnet-5');
    expect(requests[0].body.tool_choice).toEqual({ type: 'tool', name: 'propose_next_step' });
    expect((requests[0].body.tools as { input_schema: unknown }[])[0].input_schema).toEqual(PLAN_JSON_SCHEMA);
  });
  it('surfaces API errors as errors (→ MODEL_UNAVAILABLE), and text-only replies as unparseable', async () => {
    const err = createAnthropicPlannerClient({ apiKey: 'k', http: (async () => new Response('{}', { status: 529 })) as unknown as typeof fetch });
    await expect(err.complete({ system: 's', prompt: 'p' })).rejects.toThrow(/529/);
    const text = createAnthropicPlannerClient({ apiKey: 'k', http: (async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'I would check Jira.' }] }), { status: 200 })) as unknown as typeof fetch });
    expect(parsePlan(await text.complete({ system: 's', prompt: 'p' })).status).toBe('failed');
  });
  it('the browser provider only talks to the planner endpoint, never carries a key, and re-validates what comes back', async () => {
    let seen: RequestInit | undefined;
    let reply: unknown = { outcome: { status: 'ok', proposal: plan() }, source: { provider: 'gemini', displayName: 'Gemini (Google)', model: 'm', latencyMs: 12 } };
    const f = (async (_u: string, init: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify(reply), { status: 200 });
    }) as unknown as typeof fetch;
    const c = createHttpPlannerProvider({ role: 'primary', id: 'gemini', displayName: 'Gemini (Google)', http: f });
    const ok = await c.plan(input());
    expect(ok.status).toBe('ok');
    expect(ok.source?.provider).toBe('gemini');
    expect(JSON.stringify(seen)).not.toMatch(/api[-_]?key|authorization|bearer/i);
    // A compromised or buggy endpoint cannot smuggle an invalid plan past the shared schema.
    reply = { outcome: { status: 'ok', proposal: { ...plan(), budget: 20 } } };
    const bad = await c.plan(input());
    expect(bad.status === 'failed' && bad.code).toBe('SCHEMA_VIOLATION');
  });
});

describe('model-planning evaluation', () => {
  it('no regressions; intentional failures stay visible', async () => {
    const rep = await runPlannerSuite();
    const regressions = rep.results.filter((r) => evalStatus(r) === 'REGRESSION').map((r) => `${r.id}: ${r.checks.filter((c) => !c.passed).map((c) => `${c.label} (${c.detail})`).join('; ')}`);
    expect(regressions).toEqual([]);
    expect(rep.results.filter((r) => evalStatus(r) === 'INTENTIONAL_FAILURE').map((r) => r.id)).toEqual(['PLN-17', 'PLN-18']);
  }, 60_000);

  it('the whole adversarial set holds under a model planner too (same intentional failures; only stopping efficiency differs)', async () => {
    const { createModelPlanner: make } = await import('./agent/planner');
    const rep = await runAdversarialSuite({ planner: () => make(PLANNER_DOUBLES.impactFirst) });
    // Correctness, safety, dedupe, severity, causality, grounding: must all hold, whatever the planner.
    const broken = rep.results.filter((r) => !r.knownFailure).flatMap((r) => r.checks.filter((c) => !c.passed && c.dimension !== 'stopping').map((c) => `${r.id}: ${c.label} (${c.detail})`));
    expect(broken).toEqual([]);
    // Finding, kept visible: an impact-first planner spends the whole 9-call budget where the
    // deterministic planner stops early. The budget — not the model — bounds it. Not tuned away.
    const efficiency = rep.results.filter((r) => !r.knownFailure && r.checks.some((c) => !c.passed && c.dimension === 'stopping')).map((r) => r.id);
    expect(efficiency).toEqual(['ADV-01', 'ADV-12']);
    expect(rep.results.filter((r) => evalStatus(r) === 'INTENTIONAL_FAILURE').map((r) => r.id)).toEqual(['ADV-16', 'ADV-17']);
  }, 60_000);
});
