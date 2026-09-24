import { describe, expect, it } from 'vitest';
import { defaultBriefSchedule, defaultWatches } from './catalog';
import { defaultConnections } from './integrations/adapters';
import { defaultWorld } from './integrations/world';
import { runMonitoring, type RunEvent } from './engine/monitor';
import { reduceProgress, startProgress } from './progress';

async function run() {
  const events: RunEvent[] = [];
  const result = await runMonitoring({ world: defaultWorld(), watches: defaultWatches(), connections: defaultConnections(), brief: defaultBriefSchedule(), onEvent: (e) => events.push(e) });
  return { events, result };
}

describe('live run progress', () => {
  it('only reports steps that end up in an investigation trace', async () => {
    const { events, result } = await run();
    const steps = events.filter((e) => e.type === 'step');
    expect(steps.length).toBeGreaterThan(0);
    // A stored pass keeps every step; a re-check pass with no material change really ran its
    // tools but is collapsed to a single "Re-checked" line in the stored trace.
    for (const inv of result.investigations) {
      const ids = new Set(inv.trace.map((t) => t.id));
      const mine = steps.filter((e) => e.investigationId === inv.id);
      const missing = mine.filter((e) => !ids.has(e.step.id));
      if (missing.length) expect(inv.trace.some((t) => t.kind === 'recheck')).toBe(true);
    }
    for (const e of steps) expect(result.investigations.some((i) => i.id === e.investigationId)).toBe(true);
  });

  it('reaches stages in the checkout investigation only from real tool calls', async () => {
    const { events, result } = await run();
    const checkout = result.investigations.find((i) => i.area === 'checkout')!;
    let p = startProgress(0);
    for (const e of events) p = reduceProgress(p, e);
    // Replay just the first checkout pass.
    const start = events.findIndex((e) => e.type === 'investigation' && e.id === checkout.id);
    let q = startProgress(0);
    for (const e of events.slice(start)) {
      if (e.type === 'investigation' && e.id !== checkout.id) break;
      if (e.type === 'investigation' && q.investigations > 0) break;
      q = reduceProgress(q, e);
    }
    expect(q.reached).toContain('detect');
    expect(q.reached).toContain('releases');
    expect(q.reached).toContain('severity');
    expect(q.toolCalls).toBeGreaterThan(0);
    expect(p.job?.total).toBeGreaterThan(0);
  });

  it('a listener that throws never breaks the run', async () => {
    const r = await runMonitoring({ world: defaultWorld(), watches: defaultWatches(), connections: defaultConnections(), brief: defaultBriefSchedule(), onEvent: () => { throw new Error('ui'); } });
    expect(r.investigations.length).toBeGreaterThan(0);
  });
});
