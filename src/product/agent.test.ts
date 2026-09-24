import { describe, expect, it } from 'vitest';
import type { SourceConnection, Watch, WatchTemplateId } from './types';
import { defaultBriefSchedule, defaultWatches, watchFromTemplate } from './catalog';
import { defaultConnections } from './integrations/adapters';
import { buildWorld, CHECKOUT_ISSUES, CHECKOUT_REVIEWS, defaultWorld, RELEASES_481, type WorldSpec } from './integrations/world';
import { runMonitoring } from './engine/monitor';
import { hasCausalOverclaim } from './engine/language';
import { ApprovalRequiredError, executeAction } from './agent/actions';
import { runAdversarialSuite } from './evaluation/adversarial';

const brief = defaultBriefSchedule();
const w = (tpl: WatchTemplateId, freq: Watch['schedule']['frequency'] = '30m', id: string = tpl, patch: Partial<Watch> = {}) => ({ ...watchFromTemplate(id, tpl, { schedule: { frequency: freq, dailyAt: '07:00' } }), ...patch });
const down = (provider: string, state: 'unavailable' | 'error' = 'unavailable') => (cs: SourceConnection[]) => cs.map((c) => (c.provider === provider ? { ...c, state, detail: `${provider} unreachable (simulated outage)` } : c));

describe('acceptance: checkout conversion −18%', () => {
  const run = (connections = defaultConnections()) => runMonitoring({ world: defaultWorld(), watches: defaultWatches(), connections, brief });

  it('investigates like an agent and pauses for approval', async () => {
    const r = await run();
    const inv = r.investigations.find((i) => i.area === 'checkout')!;
    const tools = new Set(inv.trace.filter((s) => s.kind === 'tool_call').map((s) => s.tool));

    // Signal, sources, tool calls
    expect(inv.signals[0].key).toBe('metric:checkout_conversion');
    const calls = new Set(inv.trace.filter((s) => s.kind === 'tool_call').flatMap((s) => (s.sources ?? [s.source]).map((x) => `${s.tool}(${x})`)));
    expect(tools).toContain('getMetric');
    expect(tools).toContain('getWorkItems');
    expect(calls).toContain('getChanges(jira)');
    expect(tools).toContain('getFeedback');
    expect(inv.toolCalls).toBeGreaterThan(4);

    // Every tool call is followed by a result that says what changed.
    const pass = inv.trace.filter((s) => s.pass === 2);
    const loop = pass.slice(pass.findIndex((s) => s.kind === 'hypothesis'), pass.findIndex((s) => s.kind === 'stop'));
    const results = loop.filter((s) => s.kind === 'result');
    expect(results.length).toBeGreaterThan(3);
    for (const s of results) expect(s.changed?.length).toBeGreaterThan(0);
    // Every executed call was chosen by a planner decision that the validator approved (or by scoping policy).
    const approved = loop.filter((s) => s.kind === 'planner' && s.planner?.validator === 'APPROVED').length;
    const scoping = loop.filter((s) => s.kind === 'gap' && s.title.startsWith('Scope gap')).length;
    expect(approved + scoping).toBe(results.length);

    // Hypotheses: ≥2 live explanations with evidence for / against; unknowns; no causation.
    const live = inv.agentHypotheses.filter((h) => h.status !== 'ruled_out' && h.status !== 'untested');
    expect(live.length).toBeGreaterThanOrEqual(2);
    expect(inv.agentHypotheses.some((h) => h.evidenceAgainst.length > 0)).toBe(true);
    expect(inv.agentHypotheses.find((h) => h.kind === 'release_related')!.strength).not.toBe('strong');
    expect(inv.unknowns.some((u) => /release 4\.8\.1 is responsible/.test(u))).toBe(true);
    expect([inv.summary, inv.likelyExplanation, inv.uncertainty, ...inv.inferred].some(hasCausalOverclaim)).toBe(false);

    // Attention, action, approval, outcome.
    expect(inv.attention).toBe('HIGH');
    expect(inv.status).toBe('CONFIRMED');
    const pause = inv.actions.find((a) => a.kind === 'pause_rollout')!;
    expect(pause.status).toBe('awaiting_approval');
    expect(() => executeAction(pause)).toThrow(ApprovalRequiredError);
    expect(inv.actions.find((a) => a.kind === 'link_work_items')?.status).toBe('executed');
    expect(inv.trace.some((s) => s.kind === 'approval')).toBe(true);
    expect(inv.trace.some((s) => s.kind === 'stop')).toBe(true);
    expect(r.emails).toHaveLength(1);
  });

  it.each([
    ['jira', 'Jira is unavailable'],
    ['app_store', 'App Store Connect is unavailable'],
    ['ga4', 'Google Analytics 4 is unavailable'],
  ])('says so when %s is unavailable instead of guessing', async (provider, phrase) => {
    const r = await run(down(provider)(defaultConnections()));
    const inv = r.investigations.find((i) => i.status !== 'DISMISSED')!;
    expect(inv).toBeTruthy();
    expect(inv.unknowns.some((u) => u.includes(phrase))).toBe(true);
    expect(inv.evidence.some((e) => e.provider === provider && e.direction !== 'gap')).toBe(false);
    // Recorded in the trace — either as a failed call, or as a known-down source that is never called.
    expect(inv.trace.some((s) => s.source === provider && s.status === 'unavailable')).toBe(true);
  });

  it('with Jira down: one Jira call per pass, other sources used instead, and no pretend Jira writes', async () => {
    const r = await run(down('jira')(defaultConnections()));
    const inv = r.investigations.find((i) => i.area === 'checkout')!;
    const passes = new Set(inv.trace.map((s) => s.pass));
    for (const p of passes) expect(inv.trace.filter((s) => s.pass === p && s.kind === 'tool_call' && s.source === 'jira').length).toBeLessThanOrEqual(1);
    expect(inv.trace.some((s) => s.kind === 'tool_call' && s.tool === 'getChanges' && s.source !== 'jira')).toBe(true);
    expect(inv.releaseAssociation?.version).toBe('4.8.1');
    const incident = inv.actions.find((a) => a.kind === 'create_incident')!;
    expect(incident.title).toMatch(/^Draft/);
    expect(executeAction(incident, { status: 'done', at: incident.proposedAt })).toMatch(/Not filed/);
  });
});

describe('deduplication', () => {
  const spec: WorldSpec = {
    id: 'dd',
    name: 'dedupe',
    seed: 481,
    effects: { 'ga4.checkout_conversion': [{ from: '19:00', change: -18 }], 'ga4.purchase_revenue': [{ from: '19:00', change: -16 }], 'app_store.crash_free_sessions': [{ from: '19:00', change: -0.67 }] },
    releases: RELEASES_481,
    issues: CHECKOUT_ISSUES,
    reviews: CHECKOUT_REVIEWS,
  };
  const open = async (watches: Watch[]) => {
    const r = await runMonitoring({ world: buildWorld(spec), watches, connections: defaultConnections(), brief });
    return { r, open: r.investigations.filter((i) => i.status !== 'DISMISSED' && i.attention !== 'LOW') };
  };

  it('same signal, two watches → one investigation', async () => {
    const { r, open: o } = await open([w('checkout_health', '30m', 'a'), w('conversion', '30m', 'b')]);
    expect(o).toHaveLength(1);
    expect(o[0].watchIds.sort()).toEqual(['a', 'b']);
    expect(r.emails).toHaveLength(1);
  });

  it('same event seen through different signals (metric, crash, reviews) → one investigation', async () => {
    const { r, open: o } = await open([w('checkout_health', '30m', 'a'), w('app_stability', '30m', 'b'), w('customer_issues', '1h', 'c')]);
    expect(o).toHaveLength(1);
    expect(r.emails).toHaveLength(1);
  });

  it('different timestamps: repeated runs and different frequencies → one investigation', async () => {
    const { r, open: o } = await open([w('checkout_health', '15m', 'a'), w('conversion', '1h', 'b'), w('revenue', '4h', 'c')]);
    expect(o).toHaveLength(1);
    expect(o[0].runs.length).toBeGreaterThan(10);
    expect(r.emails).toHaveLength(1);
  });

  it('different source combinations → one investigation', async () => {
    const { r, open: o } = await open([w('checkout_health', '30m', 'a', { sources: ['ga4'] }), w('checkout_health', '30m', 'b', { sources: ['ga4', 'jira'] }), w('checkout_health', '1h', 'c')]);
    expect(o).toHaveLength(1);
    expect(r.emails).toHaveLength(1);
  });

  it('control: two genuinely different problems stay separate', async () => {
    const world = buildWorld({ ...spec, effects: { ...spec.effects, 'ga4.search_usage': [{ from: '22:00', change: -30 }] } });
    const r = await runMonitoring({ world, watches: [w('checkout_health'), w('search_discovery', '1h')], connections: defaultConnections(), brief });
    const areas = r.investigations.filter((i) => i.status !== 'DISMISSED').map((i) => i.area);
    expect(areas).toContain('checkout');
    expect(areas).toContain('search');
  });
});

describe('risk-based autonomy', () => {
  it('never executes HIGH or CRITICAL actions without approval, and records the approved result', async () => {
    const world = buildWorld({ id: 'crit', name: 'crit', seed: 481, effects: { 'ga4.checkout_conversion': [{ from: '19:00', change: -60 }], 'app_store.crash_free_sessions': [{ from: '19:00', change: -0.67 }] }, releases: RELEASES_481, issues: CHECKOUT_ISSUES, reviews: CHECKOUT_REVIEWS });
    const r = await runMonitoring({ world, watches: [w('checkout_health')], connections: defaultConnections(), brief });
    const consequential = r.actions.filter((a) => a.risk === 'HIGH' || a.risk === 'CRITICAL');
    expect(consequential.map((a) => a.kind)).toEqual(expect.arrayContaining(['rollback_release', 'notify_customers']));
    for (const a of consequential) {
      expect(a.status).toBe('awaiting_approval');
      expect(() => executeAction(a)).toThrow(ApprovalRequiredError);
      expect(() => executeAction(a, { status: 'rejected', at: a.proposedAt })).toThrow(ApprovalRequiredError);
      expect(executeAction(a, { status: 'approved', at: a.proposedAt, optionId: a.options?.[0]?.id })).toMatch(/simulat/i);
    }
    expect(r.actions.filter((a) => a.status === 'executed').every((a) => a.risk === 'LOW')).toBe(true);
  });
});

describe('adversarial evaluation', () => {
  it('passes every case except the documented known failures', async () => {
    const rep = await runAdversarialSuite();
    const unexpected = rep.results.filter((r) => !r.passed && !r.knownFailure).map((r) => `${r.id}: ${r.checks.filter((c) => !c.passed).map((c) => c.label).join('; ')}`);
    expect(unexpected).toEqual([]);
    expect(rep.results.length).toBeGreaterThanOrEqual(15);
  });

  it('known failures still fail — if one starts passing, update its documentation', async () => {
    const rep = await runAdversarialSuite();
    const fixed = rep.results.filter((r) => r.knownFailure && r.passed).map((r) => r.id);
    expect(fixed).toEqual([]);
  });
});

describe('human decisions', async () => {
  const { decide, effectiveActions, pendingApprovals, traceWithDecisions } = await import('./agent/decisions');
  const r = await runMonitoring({ world: defaultWorld(), watches: defaultWatches(), connections: defaultConnections(), brief });
  const inv = r.investigations.find((i) => i.area === 'checkout')!;
  const pause = inv.actions.find((a) => a.kind === 'pause_rollout')!;
  const at = '2026-09-24T08:05:00.000Z';

  it('rejecting executes nothing and is recorded in the trace', () => {
    const d = decide(pause, { status: 'rejected', at, note: 'Rollout is already at 20%, watching instead' });
    expect(d.result).toMatch(/nothing was executed/);
    const trace = traceWithDecisions(inv, { [pause.id]: d });
    const step = trace.find((s) => s.kind === 'human')!;
    expect(step.title).toMatch(/^Rejected by PM/);
    expect(step.detail).toMatch(/watching instead/);
    expect(pendingApprovals([inv], { [pause.id]: d })).toHaveLength(0);
  });

  it('approving a modified option executes that option and records the modification', () => {
    const option = pause.options!.find((o) => o.id !== pause.options![0].id) ?? pause.options![0];
    const d = decide(pause, { status: 'approved', at, optionId: option.id });
    expect(d.result).toContain(option.label);
    expect(effectiveActions(inv, { [pause.id]: d }).find((a) => a.id === pause.id)!.effective).toBe('approved');
    expect(traceWithDecisions(inv, { [pause.id]: d }).at(-1)!.title).toContain(option.label);
  });

  it('a HIGH action cannot be marked "done" to bypass approval', () => {
    expect(() => decide(pause, { status: 'done', at })).toThrow(ApprovalRequiredError);
  });

  it('pending approvals come from the engine, not the demo', () => {
    expect(pendingApprovals(r.investigations, {}).map((a) => a.kind)).toContain('pause_rollout');
  });
});
