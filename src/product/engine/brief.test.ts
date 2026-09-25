import { describe, expect, it } from 'vitest';
import { defaultBriefSchedule, defaultWatches } from '../catalog';
import { defaultConnections } from '../integrations/adapters';
import { defaultWorld } from '../integrations/world';
import { runMonitoring } from './monitor';
import { briefView } from '../view/brief';

describe('morning brief: changes', () => {
  it('lists only changes that are evidence in reported items, each with its timing kind', async () => {
    const r = await runMonitoring({ world: defaultWorld(), watches: defaultWatches(), connections: defaultConnections(), brief: defaultBriefSchedule() });
    const brief = r.briefs[r.briefs.length - 1];
    expect(brief.items.length).toBeGreaterThan(0);
    const changes = brief.changes ?? [];
    expect(changes.length).toBeGreaterThan(0);
    const reported = new Set(brief.items.map((i) => i.investigationId));
    for (const c of changes) {
      expect(reported.has(c.investigationId)).toBe(true);
      expect(['actual', 'planned', 'reported']).toContain(c.timing);
    }
    // No duplicates, in time order.
    expect(new Set(changes.map((c) => c.title)).size).toBe(changes.length);
    expect([...changes].sort((a, b) => a.at.localeCompare(b.at))).toEqual(changes);
    const v = briefView(brief, { investigations: r.investigations, watches: defaultWatches(), decisions: {} });
    expect(v.changes).toEqual(changes);
    // The same attention model: each item's attention is its investigation's.
    for (const it of v.items) expect(it.attention).toBe(r.investigations.find((i) => i.id === it.investigationId)!.attention);
  });
});
