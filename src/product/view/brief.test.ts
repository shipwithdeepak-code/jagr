import { describe, expect, it } from 'vitest';
import { defaultBriefSchedule, defaultWatches } from '../catalog';
import { defaultConnections } from '../integrations/adapters';
import { defaultWorld } from '../integrations/world';
import { runMonitoring } from '../engine/monitor';
import { briefView } from './brief';

async function night() {
  const watches = defaultWatches();
  const r = await runMonitoring({ world: defaultWorld(), watches, connections: defaultConnections(), brief: defaultBriefSchedule() });
  return { r, watches, view: briefView(r.briefs.at(-1)!, { investigations: r.investigations, watches, decisions: {} }) };
}

describe('Morning brief view', () => {
  it('leads with what needs attention, highest first, straight from the brief', async () => {
    const { r, view } = await night();
    expect(view.headline).toBe(r.briefs.at(-1)!.headline);
    expect(view.items.map((i) => i.attention)).toEqual(['HIGH', 'MEDIUM']);
    expect(view.items[0].headline).toMatch(/^Checkout conversion dropped/);
  });

  it('each item answers what changed, what was found, what is uncertain and what to do', async () => {
    const { r, view } = await night();
    const checkout = view.items[0];
    const inv = r.investigations.find((i) => i.id === checkout.investigationId)!;
    expect(checkout.whatChanged).toMatch(/Release 4\.8\.1 preceded it by \d+ min — timing, not a cause\./);
    expect(checkout.found.length).toBeGreaterThan(0);
    expect(checkout.uncertainty).toBe(inv.uncertainty);
    expect(checkout.next).toBe(inv.recommendedNextStep);
    expect(checkout.approvalsWaiting).toBeGreaterThan(0);
  });

  it('quiet counts monitored signals that are not part of anything reported', async () => {
    const { view } = await night();
    expect(view.quiet.signals).toBeGreaterThan(0);
    const { r, watches } = await night();
    // With every signal unreadable, nothing is "monitored" — so nothing is claimed quiet.
    expect(briefView(r.briefs.at(-1)!, { investigations: r.investigations, watches, decisions: {}, evaluable: () => false }).quiet.signals).toBe(0);
  });
});
