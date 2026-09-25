import { describe, expect, it } from 'vitest';
import { defaultBriefSchedule, defaultWatches } from '../catalog';
import { defaultConnections } from '../integrations/adapters';
import { defaultWorld } from '../integrations/world';
import { runMonitoring } from '../engine/monitor';
import { decide, traceWithDecisions } from '../agent/decisions';
import type { SourceConnection } from '../types';
import { auditEvents } from './audit';
import { createModelPlanner } from '../agent/planner';
import { PLANNER_DOUBLES } from '../evaluation/plannerDoubles';

async function run(connections = defaultConnections()) {
  const r = await runMonitoring({ world: defaultWorld(), watches: defaultWatches(), connections, brief: defaultBriefSchedule() });
  return r.investigations.find((i) => i.area === 'checkout')!;
}

describe('Agent Trace audit trail', () => {
  it('every recorded step becomes at least one event, and every event points at a recorded step', async () => {
    const inv = await run();
    const events = auditEvents(inv.trace);
    const stepIds = new Set(inv.trace.map((s) => s.id));
    for (const s of inv.trace) expect(events.some((e) => e.stepId === s.id)).toBe(true);
    for (const e of events) expect(stepIds.has(e.stepId)).toBe(true);
  });

  it('reads as detected → investigating → found, with readable actions instead of function names', async () => {
    const inv = await run();
    const events = auditEvents(inv.trace);
    expect(events[0].stage).toBe('detected');
    const changes = events.find((e) => e.action === 'Checking recent changes')!;
    expect(changes.stage).toBe('investigating');
    expect(events.some((e) => e.stage === 'found')).toBe(true);
    for (const e of events) expect(e.action).not.toMatch(/^get[A-Z]\w+\(/);
  });

  it('checks that came back normal are not presented as findings', async () => {
    const inv = await run();
    const sessions = auditEvents(inv.trace).find((e) => /Sessions is within its normal range/.test(e.action))!;
    expect(sessions.stage).toBe('normal');
  });

  it('an unavailable source is NOT CHECKED — never a clean result', async () => {
    const conns: SourceConnection[] = defaultConnections().map((c) => (c.provider === 'app_store' ? { ...c, state: 'unavailable', detail: 'timeout' } : c));
    const inv = await run(conns);
    const events = auditEvents(inv.trace);
    expect(events.some((e) => e.stage === 'not_checked')).toBe(true);
  });

  it('planner events carry the validator verdict and only recorded summaries', async () => {
    const inv = await run();
    const planned = auditEvents(inv.trace).filter((e) => e.stage === 'planned');
    expect(planned.length).toBeGreaterThan(0);
    for (const p of planned) expect(p.detail.some((d) => d.label === 'Validator')).toBe(true);
    for (const p of planned) expect(p.action).not.toMatch(/\bget[A-Z]/);
    expect(planned.some((p) => p.action === 'Deterministic planner chose: checking recent changes')).toBe(true);
    expect(planned.some((p) => p.action === 'Deterministic planner chose: reading sessions')).toBe(true);
  });

  it('model planner lines read as proposals, and rejected proposals say they were not executed', async () => {
    for (const client of [PLANNER_DOUBLES.impactFirst, PLANNER_DOUBLES.hallucinated]) {
      const r = await runMonitoring({ world: defaultWorld(), watches: defaultWatches(), connections: defaultConnections(), brief: defaultBriefSchedule(), planner: createModelPlanner(client, { timeoutMs: 2000 }) });
      const inv = r.investigations.find((i) => i.area === 'checkout')!;
      const planned = auditEvents(inv.trace).filter((e) => e.stage === 'planned');
      const model = planned.filter((p) => p.action.startsWith('Model planner proposed:'));
      expect(model.length).toBeGreaterThan(0);
      if (client === PLANNER_DOUBLES.hallucinated) expect(planned.some((p) => p.result === 'Rejected by the validator — not executed')).toBe(true);
    }
  });

  it('a human decision is recorded as such', async () => {
    const inv = await run();
    const gated = inv.actions.find((a) => a.risk === 'HIGH')!;
    const d = decide(gated, { status: 'approved', at: '2026-09-24T08:07:00.000Z', optionId: gated.options?.[0]?.id });
    const last = auditEvents(traceWithDecisions(inv, { [gated.id]: d })).at(-1)!;
    expect(last.stage).toBe('decided');
  });
});
