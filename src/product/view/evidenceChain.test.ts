import { describe, expect, it } from 'vitest';
import { defaultBriefSchedule, defaultWatches } from '../catalog';
import { defaultConnections } from '../integrations/adapters';
import { defaultWorld } from '../integrations/world';
import { runMonitoring } from '../engine/monitor';
import { decide } from '../agent/decisions';
import { buildEvidenceChain, CHAIN_STAGES } from './evidenceChain';

async function night() {
  const r = await runMonitoring({ world: defaultWorld(), watches: defaultWatches(), connections: defaultConnections(), brief: defaultBriefSchedule() });
  return { r, checkout: r.investigations.find((i) => i.area === 'checkout')! };
}

describe('Evidence chain', () => {
  it('walks every stage for the checkout investigation, in order', async () => {
    const { checkout } = await night();
    const chain = buildEvidenceChain(checkout, {});
    expect(chain.stages).toEqual([...CHAIN_STAGES]);
    const order = chain.links.map((l) => CHAIN_STAGES.indexOf(l.stage));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(chain.links[0].text).toBe(`${checkout.signals[0].label} ${checkout.signals[0].magnitude}`);
  });

  it('every observed link carries provenance; no link is empty', async () => {
    const { checkout } = await night();
    const chain = buildEvidenceChain(checkout, {});
    for (const l of chain.links) expect(l.text.trim().length).toBeGreaterThan(0);
    for (const l of chain.links.filter((x) => x.stage === 'observed')) expect(l.provenance?.sources.length).toBeGreaterThan(0);
  });

  it('timing is stated as association — never cause', async () => {
    const { checkout } = await night();
    const chain = buildEvidenceChain(checkout, {});
    const timing = chain.links.find((l) => l.id === 'corr-timing')!;
    expect(timing.note).toMatch(/not a cause/);
    for (const l of chain.links) expect(`${l.text} ${l.note ?? ''}`).not.toMatch(/\bcaused\b|\bbecause of\b/i);
  });

  it('timing notes come from each change’s own time', async () => {
    const { checkout } = await night();
    const chain = buildEvidenceChain(checkout, {});
    const onset = Date.parse(checkout.signals[0].onsetAt);
    for (const e of checkout.evidence.filter((x) => x.direction === 'change' && x.onsetAt && Date.parse(x.onsetAt) < onset)) {
      const link = chain.links.find((l) => l.id === `obs-${e.id}`)!;
      expect(link.note).toBe(`${Math.round((onset - Date.parse(e.onsetAt!)) / 60_000)} min before the change began`);
    }
  });

  it('attention and recommendation come straight from the investigation', async () => {
    const { checkout } = await night();
    const chain = buildEvidenceChain(checkout, {});
    expect(chain.links.find((l) => l.stage === 'attention')!.text).toBe(checkout.attention);
    expect(chain.links.find((l) => l.stage === 'recommendation')!.text).toBe(checkout.recommendedNextStep);
  });

  it('approval links follow human decisions', async () => {
    const { checkout } = await night();
    const gated = checkout.actions.find((a) => a.risk === 'HIGH' || a.risk === 'CRITICAL')!;
    expect(buildEvidenceChain(checkout, {}).links.find((l) => l.id === `appr-${gated.id}`)!.decision).toBe('awaiting');
    const d = decide(gated, { status: 'approved', at: '2026-09-24T08:07:00.000Z', optionId: gated.options?.[0]?.id });
    const after = buildEvidenceChain(checkout, { [gated.id]: d }).links.find((l) => l.id === `appr-${gated.id}`)!;
    expect(after.decision).toBe('approved');
    expect(after.note).toMatch(/Approved/);
  });

  it('an investigation with nothing gated says so, rather than leaving the stage empty', async () => {
    const { r } = await night();
    const signup = r.investigations.find((i) => i.area === 'signup')!;
    const approval = buildEvidenceChain(signup, {}).links.filter((l) => l.stage === 'approval');
    expect(approval.length).toBeGreaterThan(0);
  });
});
