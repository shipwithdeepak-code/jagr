import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MonitoringResult, Watch } from './types';
import { defaultBriefSchedule, watchFromTemplate } from './catalog';
import { createRegistry } from './integrations/adapters';
import { importFile, IMPORT_KINDS, type ImportedDataset, type ImportKind } from './imports/schemas';
import { buildImportedWorld, watchesForImportedData } from './imports/world';
import { runMonitoring } from './engine/monitor';
import { hasCausalOverclaim } from './engine/language';
import { generatedTexts } from './evaluation/golden';
import { healthOf } from './roles/types';

/**
 * Stage 3 — import extensions. CSV / JSON stays a first-class source: a Changes dataset (deploys,
 * flags, experiments, config, annotations, incidents) and feedback with a channel and tags, all
 * normalised into the same role records a connector returns. No separate import-only engine.
 */

const AT = '2026-09-25T09:00:00.000Z';
const sample = (name: string) => readFileSync(`public/samples/${name}`, 'utf8');
const imp = (kind: ImportKind, name: string, text: string) => importFile(kind, name, text, AT, `imp-${kind}-${name}`);

/** Conversion −18% from 19:00, revenue with it, traffic flat — 30-minute points. */
function metricsCsv() {
  const rows = ['timestamp,metric,value,baseline'];
  for (let i = 0; i < 25; i++) {
    const t = new Date(Date.parse('2026-09-24T14:00:00Z') + i * 30 * 60_000).toISOString();
    const post = t >= '2026-09-24T19:00:00';
    const w = [0, 0.004, -0.003, 0.002][i % 4];
    rows.push(`${t},checkout_conversion,${((post ? 2.79 : 3.4) * (1 + w)).toFixed(3)},3.4`);
    rows.push(`${t},purchase_revenue,${Math.round((post ? 4000 : 4800) * (1 + w))},4800`);
    rows.push(`${t},sessions,${Math.round(21000 * (1 + w))},21000`);
  }
  return rows.join('\n');
}

async function investigate(datasets: ImportedDataset[]): Promise<MonitoringResult> {
  const iw = buildImportedWorld(datasets, AT);
  const watch: Watch = watchFromTemplate('w-checkout', 'checkout_health', { schedule: { frequency: '30m', dailyAt: '07:00' } });
  return runMonitoring({ world: iw.world!, watches: watchesForImportedData([watch], iw.connections), connections: iw.connections, brief: { ...defaultBriefSchedule(), time: iw.world!.end.slice(11, 16) } });
}
const checkout = (r: MonitoringResult) => r.investigations.find((i) => i.area === 'checkout' && i.status !== 'DISMISSED')!;

describe('changes dataset', () => {
  it('is a documented import kind with required columns and a sample file', () => {
    const spec = IMPORT_KINDS.find((k) => k.kind === 'changes')!;
    expect(spec.required).toEqual(['id', 'kind', 'title', 'at']);
    const d = imp('changes', 'changes.csv', sample('changes.csv'));
    expect(d.error).toBeUndefined();
    expect(d.rejected).toEqual([]);
    expect(d.changes!.map((c) => c.kind)).toEqual(['deploy', 'flag_change', 'experiment_change', 'annotation', 'incident']);
  });

  it('normalises kinds, timing, status and platform — and defaults timing honestly', () => {
    const d = imp('changes', 'c.csv', 'id,kind,title,at,timing,status,platform\nA,Deployment,api@1,2026-09-24T18:40:00Z,,succeeded,web\nB,feature-flag,new-sheet on,2026-09-24T18:50:00Z,,,\nC,note,Promo email,2026-09-24T17:00:00Z,,,\nD,release,4.9.0 marked released,2026-09-24T18:30:00Z,scheduled,,all\n');
    expect(d.rejected).toEqual([]);
    expect(d.changes!.map((c) => [c.id, c.kind, c.timing, c.status ?? '-', c.platform])).toEqual([
      ['A', 'deploy', 'actual', 'success', 'web'],
      ['B', 'flag_change', 'actual', '-', 'all'],
      ['C', 'annotation', 'reported', '-', 'all'],
      ['D', 'release', 'planned', '-', 'all'],
    ]);
    expect(d.notes.join(' ')).toMatch(/D: the timestamp is a planned date/);
  });

  it('rejects malformed rows with line numbers and reasons — never silently', () => {
    const d = imp(
      'changes',
      'bad.csv',
      'id,kind,title,at,timing,status,platform\n,deploy,x,2026-09-24T18:40:00Z,,,\nB,rollout,x,2026-09-24T18:40:00Z,,,\nC,deploy,,2026-09-24T18:40:00Z,,,\nD,deploy,x,09/24/2026,,,\nE,deploy,x,2026-09-24T18:40:00Z,soon,,\nF,deploy,x,2026-09-24T18:40:00Z,,exploded,\nG,deploy,x,2026-09-24T18:40:00Z,,,windows\nH,deploy,ok,2026-09-24T18:40:00Z,,,\nH,deploy,dup,2026-09-24T18:45:00Z,,,\n',
    );
    expect(d.changes!.map((c) => c.id)).toEqual(['H']);
    expect(d.rejected.map((r) => [r.line, r.reason.split(' ').slice(0, 3).join(' ')])).toEqual([
      [2, 'Missing change id.'],
      [3, 'Unknown change kind'],
      [4, 'Missing title.'],
      [5, 'Invalid or missing'],
      [6, 'Timing “soon” is'],
      [7, 'Status “exploded” is'],
      [8, 'Platform “windows” is'],
      [10, 'Duplicate of an'],
    ]);
  });

  it('reports missing columns', () => {
    const d = imp('changes', 'c.csv', 'id,title\nA,x\n');
    expect(d.notes[0]).toMatch(/Missing expected columns: kind, at/);
    expect(d.rejected).toHaveLength(1);
  });

  it('imported changes reach the engine through the same role source a connector would use, with import provenance', async () => {
    const iw = buildImportedWorld([imp('changes', 'changes.csv', sample('changes.csv')), imp('metrics', 'm.csv', metricsCsv())], AT);
    const src = createRegistry(iw.world!, iw.connections).registry.get('jira')!;
    const changes = await src.changes!.getChanges({ window: { start: '2026-09-23T00:00:00Z', end: '2026-09-25T00:00:00Z' } });
    expect(changes.map((c) => c.kind)).toContain('deploy');
    for (const c of changes) expect(c.provenance).toMatchObject({ source: 'jira', mode: 'imported', provider: 'import', externalId: c.id });
    expect(iw.counts.changes).toBe(5);
    expect(iw.connections.find((c) => c.provider === 'jira')?.detail).toMatch(/5 other changes/);
    // An import is a snapshot of what was uploaded: complete as of upload, never "stale".
    expect(healthOf('jira', iw.connections.find((c) => c.provider === 'jira'), iw.world!.end).state).toBe('ok');
  });

  it('an imported ACTUAL deploy is associated by timing; an imported PLANNED date is not', async () => {
    const actual = checkout(await investigate([imp('metrics', 'm.csv', metricsCsv()), imp('changes', 'c.csv', 'id,kind,title,at\nDEP-1,deploy,checkout-api@9f1c,2026-09-24T18:40:00Z\n')]));
    expect(actual.releaseAssociation).toMatchObject({ version: 'checkout-api@9f1c', kind: 'deploy', timing: 'actual', minutesBeforeOnset: 20 });
    const planned = checkout(await investigate([imp('metrics', 'm.csv', metricsCsv()), imp('changes', 'c.csv', 'id,kind,title,at,timing,version\nREL-1,release,4.9.0,2026-09-24T18:40:00Z,planned,4.9.0\n')]));
    expect(planned.releaseAssociation).toBeUndefined();
    expect(planned.unknowns.join(' ')).toMatch(/only its planned date/);
  });

  it('keeps causation out of the write-up', async () => {
    const r = await investigate([imp('metrics', 'm.csv', metricsCsv()), imp('changes', 'changes.csv', sample('changes.csv'))]);
    expect(generatedTexts(r).filter(hasCausalOverclaim)).toEqual([]);
  });
});

describe('feedback channel and tags', () => {
  it('accepts support conversations without a rating; reviews and surveys still need one', () => {
    const d = imp('feedback', 'f.csv', 'id,text,rating,created_at,channel,tags\nS-1,Card declined at checkout,,2026-09-24T20:00:00Z,ticket,checkout;payments\nR-1,Checkout broken,,2026-09-24T20:05:00Z,review,\nV-1,Hard to pay,2,2026-09-24T20:10:00Z,nps,\nQ-1,Please add PayPal,,2026-09-24T20:20:00Z,feature_request,checkout\nX-1,Hmm,3,2026-09-24T20:30:00Z,carrier_pigeon,\n');
    expect(d.feedback.map((f) => [f.id, f.channel, f.rating ?? '-', (f.tags ?? []).join('|')])).toEqual([
      ['S-1', 'support', '-', 'checkout|payments'],
      ['V-1', 'survey', 2, ''],
      ['Q-1', 'request', '-', 'checkout'],
    ]);
    expect(d.rejected.map((r) => [r.line, r.reason.slice(0, 30)])).toEqual([
      [3, 'Rating must be a whole number '],
      [6, 'Unknown channel “carrier_pigeo'],
    ]);
  });

  it('tags classify feedback into product areas, and support volume is investigated as feedback', async () => {
    const rows = ['id,text,created_at,channel,tags'];
    for (let i = 0; i < 6; i++) rows.push(`S-${i},It just does not work anymore,2026-09-24T2${i}:00:00Z,support,checkout`);
    const r = await investigate([imp('metrics', 'm.csv', metricsCsv()), imp('feedback', 's.csv', rows.join('\n'))]);
    const inv = checkout(r);
    const fb = inv.evidence.find((e) => e.provider === 'app_store' && e.direction === 'degraded');
    expect(fb?.statement).toMatch(/support conversations mention checkout/);
    expect(generatedTexts(r).filter(hasCausalOverclaim)).toEqual([]);
  });
});

describe('compatibility with imports saved before stage 3', () => {
  it('a stored dataset without `changes`, feedback channel or tags still builds and investigates', async () => {
    const legacy = (d: ImportedDataset): ImportedDataset => {
      const { changes: _c, ...rest } = d;
      void _c;
      return { ...rest, feedback: d.feedback.map(({ channel: _ch, tags: _t, ...f }) => (void _ch, void _t, f)) } as ImportedDataset;
    };
    const old = [imp('metrics', 'metrics.csv', sample('metrics.csv')), imp('releases', 'releases.csv', sample('releases.csv')), imp('feedback', 'reviews.csv', sample('reviews.csv'))].map(legacy);
    expect(old.every((d) => d.changes === undefined && d.feedback.every((f) => f.channel === undefined))).toBe(true);
    const r = await investigate(old);
    expect(checkout(r)).toBeDefined();
    expect(checkout(r).releaseAssociation?.version).toBe('4.8.1');
  });
});
