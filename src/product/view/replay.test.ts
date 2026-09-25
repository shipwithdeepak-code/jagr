import { describe, expect, it } from 'vitest';
import { defaultBriefSchedule, defaultWatches } from '../catalog';
import { defaultConnections } from '../integrations/adapters';
import { defaultWorld } from '../integrations/world';
import { runMonitoring } from '../engine/monitor';
import { decide } from '../agent/decisions';
import { defaultReplayPass, REPLAY_STAGES, replayFrames, replayPasses } from './replay';

async function checkout() {
  const r = await runMonitoring({ world: defaultWorld(), watches: defaultWatches(), connections: defaultConnections(), brief: defaultBriefSchedule() });
  return r.investigations.find((i) => i.area === 'checkout')!;
}

describe('Investigation replay', () => {
  it('every frame is a recorded trace step — nothing is re-run or invented', async () => {
    const inv = await checkout();
    const ids = new Set(inv.trace.map((s) => s.id));
    for (const p of replayPasses(inv)) for (const f of replayFrames(inv, {}, p.pass)) expect(ids.has(f.stepId)).toBe(true);
  });

  it('defaults to the pass that produced the current attention', async () => {
    const inv = await checkout();
    const pass = defaultReplayPass(inv);
    const chosen = replayPasses(inv).find((p) => p.pass === pass)!;
    expect(chosen.concluded).toBe(true);
    expect(chosen.attention).toBe(inv.attention);
  });

  it('a concluded pass walks from signal to attention in recorded order, covering the stages', async () => {
    const inv = await checkout();
    const frames = replayFrames(inv, {}, defaultReplayPass(inv));
    expect(frames[0].stage).toBe('signal');
    expect(frames[1].stage).toBe('started');
    const stages = new Set(frames.map((f) => f.stage));
    for (const s of ['planner', 'tool', 'evidence', 'hypothesis', 'next', 'correlation', 'attention', 'recommendation', 'action'] as const) expect(stages.has(s)).toBe(true);
    const at = frames.map((f) => f.at);
    expect(at).toEqual([...at].sort());
    expect(REPLAY_STAGES.length).toBe(11);
  });

  it('human decisions are replayed after the investigation', async () => {
    const inv = await checkout();
    const gated = inv.actions.find((a) => a.risk === 'HIGH')!;
    const d = decide(gated, { status: 'approved', at: '2026-09-24T08:07:00.000Z', optionId: gated.options?.[0]?.id });
    const frames = replayFrames(inv, { [gated.id]: d }, defaultReplayPass(inv));
    const last = frames.at(-1)!;
    expect(last.stepId).toBe(`${gated.id}-human`);
    expect(last.stage).toBe('action');
  });
});
