import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MonitoringResult, Watch } from './types';
import { defaultBriefSchedule, watchFromTemplate } from './catalog';
import { runMonitoring } from './engine/monitor';
import { hasCausalOverclaim } from './engine/language';
import { ApprovalRequiredError, executeAction } from './agent/actions';
import { createModelPlanner } from './agent/planner';
import { importFile, type ImportedDataset, type ImportKind } from './imports/schemas';
import { buildImportedWorld, watchesForImportedData } from './imports/world';
import { parseCsv } from './imports/parse';
import { generatedTexts } from './evaluation/golden';
import { plannerTexts } from './evaluation/adversarial';
import { PLANNER_DOUBLES } from './evaluation/plannerDoubles';

/**
 * Bring your own data: an external user's CSV / JSON evidence drives the real engine — not the
 * sample night. The golden path uses the downloadable sample files in public/samples/.
 */

const AT = '2026-09-25T09:00:00.000Z';
const sample = (name: string) => readFileSync(`public/samples/${name}`, 'utf8');
const imp = (kind: ImportKind, name: string, text: string) => importFile(kind, name, text, AT, `imp-${kind}-${name}`);
const goldenImports = () => [imp('metrics', 'metrics.csv', sample('metrics.csv')), imp('issues', 'issues.csv', sample('issues.csv')), imp('releases', 'releases.csv', sample('releases.csv')), imp('feedback', 'reviews.csv', sample('reviews.csv'))];
const checkoutWatch = (): Watch => watchFromTemplate('w-checkout', 'checkout_health', { schedule: { frequency: '30m', dailyAt: '07:00' } });

async function run(datasets: ImportedDataset[], opts: { planner?: Parameters<typeof runMonitoring>[0]['planner'] } = {}) {
  const iw = buildImportedWorld(datasets, AT);
  if (!iw.world) return { iw, r: undefined as MonitoringResult | undefined };
  const r = await runMonitoring({ world: iw.world, watches: watchesForImportedData([checkoutWatch()], iw.connections), connections: iw.connections, brief: { ...defaultBriefSchedule(), time: iw.world.end.slice(11, 16) }, planner: opts.planner });
  return { iw, r };
}
const checkout = (r?: MonitoringResult) => r?.investigations.find((i) => i.area === 'checkout' && i.status !== 'DISMISSED');

/** Metrics CSV with a chosen baseline / after value, 30-minute cadence, drop at 19:00. */
function metricsCsv(base: number, after: number, opts: { revenueAfter?: number; points?: number; baselineColumn?: boolean } = {}) {
  const rows = [opts.baselineColumn === false ? 'timestamp,metric,value' : 'timestamp,metric,value,baseline'];
  const n = opts.points ?? 25;
  for (let i = 0; i < n; i++) {
    const t = new Date(Date.parse('2026-09-24T14:00:00Z') + i * 30 * 60_000).toISOString();
    const post = t >= '2026-09-24T19:00:00';
    const w = [0, 0.004, -0.003, 0.002][i % 4];
    const b = opts.baselineColumn === false ? '' : `,${base}`;
    rows.push(`${t},checkout_conversion,${((post ? after : base) * (1 + w)).toFixed(3)}${b}`);
    rows.push(`${t},purchase_revenue,${Math.round((post ? (opts.revenueAfter ?? 4800) : 4800) * (1 + w))}${opts.baselineColumn === false ? '' : ',4800'}`);
    rows.push(`${t},sessions,${Math.round(21000 * (1 + w))}${opts.baselineColumn === false ? '' : ',21000'}`);
  }
  return rows.join('\n');
}

describe('parsing and validation', () => {
  it('parses quoted CSV fields with commas, escaped quotes and newlines', () => {
    const p = parseCsv('id,text\n1,"Payment failed, twice"\n2,"He said ""no""\nthen left"\n');
    expect(p.rows.map((r) => r.values.text)).toEqual(['Payment failed, twice', 'He said "no"\nthen left']);
    expect(p.rows.map((r) => r.line)).toEqual([2, 3]);
  });

  it('5 · malformed rows are rejected with line numbers and reasons — never silently discarded', () => {
    const d = imp('metrics', 'bad.csv', 'timestamp,metric,value,baseline\n2026-09-24T19:00:00Z,checkout_conversion,2.79,3.40\n09/24/2026,checkout_conversion,2.8,3.40\n2026-09-24T20:00:00Z,checkout_conversion,abc,3.40\n2026-09-24T21:00:00Z,widgets_sold,10,12\n2026-09-24T19:00:00Z,checkout_conversion,2.79,3.40\n');
    expect(d.metrics).toHaveLength(1);
    expect(d.rejected.map((r) => r.line)).toEqual([3, 4, 5, 6]);
    expect(d.rejected[0].reason).toMatch(/timestamp/i);
    expect(d.rejected[1].reason).toMatch(/non-numeric/i);
    expect(d.rejected[2].reason).toMatch(/Unknown metric “widgets_sold”/);
    expect(d.rejected[3].reason).toMatch(/Duplicate/);
    expect(d.rejected[0].values.timestamp).toBe('09/24/2026');
  });

  it('JSON imports use the same rules', () => {
    const d = imp('feedback', 'fb.json', JSON.stringify({ records: [{ id: 'R1', text: 'Payment failed', rating: 1, createdAt: '2026-09-24T20:00:00Z' }, { id: 'R2', text: 'ok', rating: 9, createdAt: '2026-09-24T20:00:00Z' }] }));
    expect(d.format).toBe('json');
    expect(d.feedback.map((f) => f.id)).toEqual(['R1']);
    expect(d.rejected[0].reason).toMatch(/1 to 5/);
  });

  it('an empty or unreadable file is an error, not an empty success', () => {
    expect(imp('issues', 'empty.csv', '').error).toMatch(/empty/i);
    expect(imp('issues', 'x.json', '{nope').error).toMatch(/not valid JSON/);
    const iw = buildImportedWorld([], AT);
    expect(iw.world).toBeUndefined();
    expect(iw.notes.join(' ')).toMatch(/nothing to investigate/);
  });
});

describe('golden external-user path (public/samples)', () => {
  it('imports every file and reports exactly what was accepted and rejected', () => {
    const [m, i, rel, fb] = goldenImports();
    expect([m.metrics.length, i.issues.length, rel.releases.length, fb.feedback.length]).toEqual([75, 5, 2, 6]);
    expect(rel.rejected).toHaveLength(1);
    expect(rel.rejected[0]).toMatchObject({ line: 4 });
    expect(rel.rejected[0].reason).toMatch(/planned/);
  });

  it('investigates the uploaded data: HIGH, your numbers, your labels, the approval boundary', async () => {
    const { iw, r } = await run(goldenImports());
    expect(iw.connections.filter((c) => c.state === 'imported').map((c) => c.provider)).toEqual(['ga4', 'jira', 'app_store']);
    const inv = checkout(r)!;
    expect(inv.attention).toBe('HIGH');
    // The uploaded numbers — not the sample night.
    expect(inv.observed.join(' ')).toContain('Checkout conversion is 2.79% vs 3.40% baseline (−18%)');
    expect(inv.observed.join(' ')).toContain('Purchase revenue is $4,031 vs $4,800 baseline');
    expect(inv.observed.join(' ')).toMatch(/PAY-512, PAY-513, PAY-514, PAY-516/);
    // Source identity: imported channels, never provider names that did not supply the data.
    const texts = [...inv.observed, inv.summary, inv.likelyExplanation, ...inv.unknowns, ...inv.evidence.map((e) => e.statement)].join(' ');
    expect(texts).toMatch(/Metrics: /);
    expect(texts).toMatch(/Feedback: /);
    expect(texts).not.toMatch(/App Store|Play Store|Jira|Analytics|GA4/);
    // Hypotheses, Observed / Inferred / Unknown.
    const h = (k: string) => inv.agentHypotheses.find((x) => x.kind === k)!;
    expect(h('shared_product_issue').strength).toBe('strong');
    expect(h('release_related').strength).toBe('moderate');
    expect(h('demand_shift').status).toBe('ruled_out');
    expect(h('measurement_artifact').status).toBe('ruled_out');
    expect(inv.observed.length && inv.inferred.length && inv.unknowns.length).toBeTruthy();
    expect(inv.unknowns.join(' ')).toMatch(/timing alone does not establish causation/);
    // Recommended action + approval boundary.
    expect(inv.recommendedNextStep.length).toBeGreaterThan(10);
    const pause = inv.actions.find((a) => a.kind === 'pause_rollout')!;
    expect(pause.status).toBe('awaiting_approval');
    expect(() => executeAction(pause)).toThrow(ApprovalRequiredError);
    // Actions never claim an external tracker that isn't connected.
    expect(inv.actions.find((a) => a.kind === 'link_issues')?.title).toMatch(/imported issues/);
    const incident = inv.actions.find((a) => a.kind === 'create_jira_incident')!;
    expect(incident.title).toMatch(/^Draft/);
    expect(incident.whatWillHappen).toMatch(/not connected/);
    expect(executeAction(incident, { status: 'done', at: incident.proposedAt })).toMatch(/Not filed in any external tracker/);
        // Trace: the metric call reads the imported value.
    const call = inv.trace.findIndex((s) => s.kind === 'tool_call' && s.tool === 'getAnalyticsMetric');
    expect(inv.trace[call + 1].title).toContain('2.79%');
  });

  it('it really is your data: different uploaded numbers → different findings', async () => {
    const custom = [imp('metrics', 'm.csv', metricsCsv(5.0, 4.0, { revenueAfter: 3900 })), imp('issues', 'issues.csv', sample('issues.csv'))];
    const inv = checkout((await run(custom)).r)!;
    expect(inv.observed.join(' ')).toContain('Checkout conversion is 4.00% vs 5.00% baseline (−20%)');
    expect(inv.observed.join(' ')).not.toContain('3.40');
  });

  it('works with an LLM planner too — same imported evidence, same policy', async () => {
    const { r } = await run(goldenImports(), { planner: createModelPlanner(PLANNER_DOUBLES.impactFirst) });
    const inv = checkout(r)!;
    expect(inv.trace.some((s) => s.planner?.type === 'LLM' && s.planner.validator === 'APPROVED')).toBe(true);
    expect(inv.attention).toBe('HIGH');
    expect(inv.actions.find((a) => a.kind === 'pause_rollout')?.status).toBe('awaiting_approval');
  });
});

describe('BYOD evaluation cases', () => {
  it('1 · imported metric drop opens an investigation from the imported series', async () => {
    const inv = checkout((await run([imp('metrics', 'm.csv', metricsCsv(3.4, 2.79, { revenueAfter: 4000 }))])).r)!;
    expect(inv.signals[0].key).toBe('ga4.checkout_conversion');
    expect(inv.evidence.find((e) => e.provider === 'ga4')?.statement).toMatch(/^Metrics: Checkout conversion is 2\.79%/);
  });

  it('2 · imported issues are correlated and cited by their own ids', async () => {
    const inv = checkout((await run([imp('metrics', 'm.csv', metricsCsv(3.4, 2.79, { revenueAfter: 4000 })), imp('issues', 'issues.csv', sample('issues.csv'))])).r)!;
    expect(inv.correlatedProviders).toContain('jira');
    expect(inv.evidence.some((e) => e.statement.startsWith('Issues & releases: 4 new checkout issues'))).toBe(true);
  });

  it('3 · an imported release is correlated by timing only — at most moderate, never causal', async () => {
    const inv = checkout((await run([imp('metrics', 'm.csv', metricsCsv(3.4, 2.79, { revenueAfter: 4000 })), imp('releases', 'releases.csv', sample('releases.csv'))])).r)!;
    expect(inv.releaseAssociation?.version).toBe('4.8.1');
    expect(inv.agentHypotheses.find((h) => h.kind === 'release_related')!.strength).not.toBe('strong');
  });

  it('4 · a source that was not imported is NOT CONFIGURED — never "no negative reviews"', async () => {
    const { iw, r } = await run([imp('metrics', 'm.csv', metricsCsv(3.4, 2.79, { revenueAfter: 4000 })), imp('issues', 'issues.csv', sample('issues.csv'))]);
    expect(iw.connections.find((c) => c.provider === 'app_store')?.state).toBe('not_configured');
    const inv = checkout(r)!;
    expect(inv.evidence.some((e) => e.provider === 'app_store' && e.direction !== 'gap')).toBe(false);
    expect([...inv.observed, ...inv.evidence.map((e) => e.statement)].join(' ')).not.toMatch(/no negative reviews/i);
  });

  it('6 · contradictory evidence (conversion down, revenue flat, nothing else) → conflict stated, no email', async () => {
    const { r } = await run([imp('metrics', 'm.csv', metricsCsv(3.4, 2.79))]);
    const inv = checkout(r)!;
    expect(r!.emails).toHaveLength(0);
    expect(inv.likelyExplanation).toMatch(/conflict/i);
    expect(inv.agentHypotheses.find((h) => h.kind === 'measurement_artifact')!.status).not.toBe('ruled_out');
  });

  it('7 · insufficient evidence (too few points) → no investigation, and Jagr says why', async () => {
    const { iw, r } = await run([imp('metrics', 'm.csv', metricsCsv(3.4, 2.79, { points: 2 }))]);
    expect(iw.notes.join(' ')).toMatch(/needs at least 4/);
    expect(checkout(r)).toBeUndefined();
    expect(r!.emails).toHaveLength(0);
  });

  it('7b · no baseline column → baseline estimated from the earliest points, and stated', () => {
    const iw = buildImportedWorld([imp('metrics', 'm.csv', metricsCsv(3.4, 2.79, { baselineColumn: false }))], AT);
    expect(iw.world!.metrics.find((m) => m.id === 'ga4.checkout_conversion')!.baseline.window).toMatch(/Estimated/);
    expect(iw.notes.join(' ')).toMatch(/estimated from the first/);
  });

  it('8 · duplicate evidence across two files is counted once', async () => {
    const issues = sample('issues.csv');
    const { iw, r } = await run([imp('metrics', 'm.csv', metricsCsv(3.4, 2.79, { revenueAfter: 4000 })), imp('issues', 'a.csv', issues), imp('issues', 'b.csv', issues)]);
    expect(iw.counts.issues).toBe(5);
    expect(iw.counts.duplicates).toBe(5);
    expect(checkout(r)!.evidence.find((e) => e.statement.includes('checkout issues'))?.statement).toMatch(/4 new checkout issues/);
  });

  it('9 · causality temptation: release 30 min before the drop → correlation language only', async () => {
    const { r } = await run(goldenImports());
    expect([...generatedTexts(r!), ...plannerTexts(r!)].some(hasCausalOverclaim)).toBe(false);
    expect(checkout(r)!.likelyExplanation).toMatch(/does not establish causation/);
  });

  it('10 · a high-risk action from imported evidence still needs human approval', async () => {
    const { r } = await run(goldenImports());
    const risky = r!.actions.filter((a) => a.risk === 'HIGH' || a.risk === 'CRITICAL');
    expect(risky.length).toBeGreaterThan(0);
    for (const a of risky) {
      expect(a.status).toBe('awaiting_approval');
      expect(() => executeAction(a)).toThrow(ApprovalRequiredError);
    }
    expect(r!.actions.filter((a) => a.status === 'executed').every((a) => a.risk === 'LOW')).toBe(true);
  });
});
