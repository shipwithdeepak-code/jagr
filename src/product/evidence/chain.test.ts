import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SourceConnection, WatchInvestigation } from '../types';
import { importFile, type ImportKind } from '../imports/schemas';
import { buildImportedWorld, watchesForImportedData } from '../imports/world';
import { defaultBriefSchedule, defaultWatches, watchFromTemplate } from '../catalog';
import { defaultConnections } from '../integrations/adapters';
import { defaultWorld } from '../integrations/world';
import { runMonitoring } from '../engine/monitor';
import { overclaimingSentences } from '../engine/language';
import { buildEvidenceChain } from '../view/evidenceChain';

/**
 * The evidence chain as a domain record: every investigation stores its evidence snapshot
 * (provenance: data mode, records, read time, freshness, metric values) and its assumptions, and
 * keeps FACT / INFERENCE / ASSUMPTION / UNKNOWN apart. Scenarios run the real engine over imported data.
 */

const sample = (k: string) => readFileSync(`public/samples/${k}.csv`, 'utf8');
const AT = '2026-09-25T09:00:00.000Z';

async function investigate(files: Partial<Record<ImportKind, string | string[]>>, tweak: (c: SourceConnection[]) => SourceConnection[] = (c) => c): Promise<WatchInvestigation[]> {
  const datasets = Object.entries(files).flatMap(([kind, texts]) => (Array.isArray(texts) ? texts : [texts]).map((t, i) => importFile(kind as ImportKind, `${kind}-${i}.csv`, t, AT, `imp-${kind}-${i}`)));
  const iw = buildImportedWorld(datasets, AT);
  const connections = tweak(iw.connections);
  const watches = watchesForImportedData([watchFromTemplate('w-checkout', 'checkout_health', {}, AT)], connections);
  const r = await runMonitoring({ world: iw.world!, watches, connections, brief: { enabled: true, time: iw.world!.end.slice(11, 16), timezone: 'UTC' } });
  return r.investigations;
}
const checkout = (invs: WatchInvestigation[]) => invs.find((i) => i.area === 'checkout')!;
const allText = (inv: WatchInvestigation) => [inv.summary, inv.likelyExplanation, inv.uncertainty, inv.recommendedNextStep, ...inv.observed, ...inv.inferred, ...inv.unknowns, ...(inv.assumptions ?? []), ...inv.evidence.map((e) => e.statement)];

describe('evidence snapshot', () => {
  it('every piece of evidence records where it came from, when it was read, and what it rested on', async () => {
    const inv = checkout(await investigate({ metrics: sample('metrics'), issues: sample('issues'), releases: sample('releases'), feedback: sample('reviews') }));
    expect(inv).toBeDefined();
    for (const e of inv.evidence) {
      expect(e.provenance, e.id).toBeDefined();
      expect(e.provenance!.sources).toEqual([e.provider]);
      expect(Date.parse(e.provenance!.fetchedAt)).not.toBeNaN();
      if (e.direction !== 'gap') expect(e.provenance!.mode).toBe('imported');
      if (e.refs.length && e.direction !== 'gap') expect(e.provenance!.records.length + (e.provenance!.moreRecords ?? 0)).toBe(e.refs.length);
    }
    const metric = inv.evidence.find((e) => e.provenance?.values)!;
    expect(metric.provenance!.values).toMatchObject({ metric: expect.any(String), baseline: expect.any(Number), baselineWindow: expect.any(String) });
  });

  it('an old investigation keeps its data mode and records after the source changes', async () => {
    const inv = checkout(await investigate({ metrics: sample('metrics'), issues: sample('issues') }));
    const stored: WatchInvestigation = JSON.parse(JSON.stringify(inv));
    // Later the source is gone; the chain is rebuilt only from the stored record.
    const chain = buildEvidenceChain(stored, {});
    const observed = chain.links.filter((l) => l.stage === 'observed' && l.provenance?.sources.length);
    expect(observed.length).toBeGreaterThan(0);
    for (const l of observed) expect(l.provenance!.mode).toBe('imported');
  });

  it('keeps FACT, INFERENCE, ASSUMPTION and UNKNOWN apart', async () => {
    const inv = checkout(await investigate({ metrics: sample('metrics'), issues: sample('issues'), changes: sample('changes') }));
    const chain = buildEvidenceChain(inv, {});
    const stages = new Set(chain.links.map((l) => l.stage));
    for (const s of ['signal', 'observed', 'inferred', 'assumed', 'unknown', 'attention', 'recommendation', 'approval'] as const) expect(stages.has(s), s).toBe(true);
    expect(inv.assumptions!.some((a) => /baseline .* is taken as normal/.test(a))).toBe(true);
    expect(inv.assumptions!.some((a) => /matched to checkout by their wording/.test(a))).toBe(true);
    expect(inv.assumptions!.some((a) => /Imported files are taken as complete/.test(a))).toBe(true);
    // Observed statements are facts: they never contain an inference.
    for (const l of chain.links.filter((x) => x.stage === 'observed')) expect(l.text).not.toMatch(/likely|probably|suggests|because/i);
  });
});

describe('evidence chain scenarios', () => {
  it('missing evidence: sources that were never part of the workspace produce no findings and no "none found" claims', async () => {
    const inv = checkout(await investigate({ metrics: sample('metrics') }));
    expect(inv.evidence.some((e) => /:(issues|no_issues|reviews|no_reviews|release|no_release):/.test(`${e.id}:`))).toBe(false);
    expect(allText(inv).join(' ')).not.toMatch(/no (issues|bugs|reviews|complaints) (were|was) (found|reported)/i);
  });

  it('stale evidence: data after the last sync is unknown, never "nothing happened"', async () => {
    const invs = await investigate({ metrics: sample('metrics'), issues: sample('issues') }, (cs) => cs.map((c) => (c.state === 'imported' && c.provider === 'jira' ? { ...c, freshAsOf: '2026-09-24T17:00:00.000Z' } : c)));
    const inv = checkout(invs);
    const stale = inv.evidence.find((e) => e.gap === 'stale')!;
    expect(stale).toBeDefined();
    expect(stale.provenance!.freshAsOf).toBe('2026-09-24T17:00:00.000Z');
    expect(inv.evidence.some((e) => e.id.includes(':no_issues:'))).toBe(false);
    const chain = buildEvidenceChain(inv, {});
    expect(chain.links.some((l) => l.stage === 'unknown' && /only complete up to/.test(l.text))).toBe(true);
  });

  it('conflicting evidence: a metric that moved and one that did not are both shown; neither is dropped', async () => {
    // Conversion falls from 21:00; revenue stays flat — the sources disagree.
    const rows = ['timestamp,metric,value,baseline'];
    for (let m = 14 * 60; m < 24 * 60; m += 15) {
      const t = `2026-09-24T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00Z`;
      rows.push(`${t},checkout_conversion,${m >= 21 * 60 ? '2.500' : '3.400'},3.40`, `${t},purchase_revenue,4800,4800`);
    }
    const inv = checkout(await investigate({ metrics: rows.join('\n') }));
    expect(inv.evidence.filter((e) => e.provenance?.values).map((e) => e.direction).sort()).toEqual(['degraded', 'stable']);
    const dirs = inv.evidence.filter((e) => e.provenance?.values).map((e) => [e.provenance!.values!.metric, e.direction]);
    expect(dirs.some(([, d]) => d === 'degraded')).toBe(true);
    const measurement = inv.agentHypotheses.find((h) => h.kind === 'measurement_artifact');
    expect(measurement?.status).not.toBe('ruled_out');
  });

  it('correlation without causality: a change just before the drop is an association, never a cause', async () => {
    const inv = checkout(await investigate({ metrics: sample('metrics'), changes: sample('changes') }));
    expect(inv.releaseAssociation).toBeDefined();
    expect(overclaimingSentences(allText(inv).join(' '))).toEqual([]);
    const chain = buildEvidenceChain(inv, {});
    expect(chain.links.find((l) => l.id === 'corr-timing')!.note).toMatch(/not a cause/);
  });

  it('planned vs actual: a planned date alone forms no timing association; the actual one does', async () => {
    const planned = 'id,kind,title,at,timing,status,version,platform\nREL-P,release,Release 4.8.1,2026-09-24T18:30:00Z,planned,success,4.8.1,all\n';
    const actual = 'id,kind,title,at,timing,status,version,platform\nREL-A,release,Release 4.8.1,2026-09-24T18:30:00Z,actual,success,4.8.1,all\n';
    const p = checkout(await investigate({ metrics: sample('metrics'), changes: planned }));
    const a = checkout(await investigate({ metrics: sample('metrics'), changes: actual }));
    expect(p.releaseAssociation).toBeUndefined();
    expect(p.evidence.some((e) => e.timing === 'planned')).toBe(true);
    expect(p.assumptions).toContain('A planned release date is bookkeeping: it is not taken as the time users received the change.');
    expect(a.releaseAssociation).toMatchObject({ timing: 'actual' });
  });

  it('unavailable source: a gap with no data mode claimed, and it never rules anything out', async () => {
    // The sample workspace's outage path (imported workspaces leave unusable channels out of watches).
    const connections = defaultConnections().map((c) => (c.provider === 'jira' ? { ...c, state: 'unavailable' as const, detail: 'Jira could not be reached' } : c));
    const r = await runMonitoring({ world: defaultWorld(), watches: defaultWatches(), connections, brief: defaultBriefSchedule() });
    const inv = checkout(r.investigations);
    const gap = inv.evidence.find((e) => e.provider === 'jira' && e.direction === 'gap')!;
    expect(gap).toBeDefined();
    expect(gap.provenance!.mode).toBeUndefined();
    expect(inv.evidence.some((e) => e.provider === 'jira' && e.direction !== 'gap')).toBe(false);
    for (const h of inv.agentHypotheses) expect(h.evidenceAgainst.some((id) => id.startsWith('jira:'))).toBe(false);
  });

  it('duplicate evidence: the same records imported twice are one finding with unique references', async () => {
    const inv = checkout(await investigate({ metrics: sample('metrics'), issues: [sample('issues'), sample('issues')] }));
    const ids = inv.evidence.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of inv.evidence) {
      const keys = e.refs.map((r) => `${r.provider}:${r.kind}:${r.id}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('My data: the feedback channel is never reported as "not checked" (or as having no releases) while its feedback is evidence', async () => {
    // Regression: the imported feedback channel reuses a store's source id and used to inherit the store's
    // crash metrics and releases, producing a "not checked" gap and a "no releases" claim beside its reviews.
    const inv = checkout(await investigate({ metrics: sample('metrics'), issues: sample('issues'), releases: sample('releases'), changes: sample('changes'), feedback: sample('reviews') }));
    const feedback = inv.evidence.filter((e) => e.provider === 'app_store');
    expect(feedback.map((e) => e.direction)).toEqual(['degraded']);
    expect(feedback[0].id).toMatch(/:reviews:checkout$/);
    expect(inv.unknowns.join(' ')).not.toMatch(/crash free sessions/i);
    // Its reviews are still read, and the other channels still answer for their own data.
    expect(inv.correlatedProviders).toContain('app_store');
    expect(inv.evidence.some((e) => e.provider === 'jira' && e.direction === 'change')).toBe(true);
  });
});
