import { describe, expect, it } from 'vitest';
import { defaultBriefSchedule, defaultWatches } from '../catalog';
import { defaultConnections } from '../integrations/adapters';
import { defaultWorld } from '../integrations/world';
import { runMonitoring } from '../engine/monitor';
import { briefView } from './brief';
import { canonicalReading, findingState, investigationTitle, investigationWatches, labelledTime } from './investigation';
import type { WatchInvestigation } from '../types';

/**
 * One identity per investigation, and status language that never blends "the signal is real" with
 * "the cause is known". Regressions from the UI audit: the same investigation was called "Checkout
 * conversion dropped 18%" on the Overview and "Checkout health degraded" in the list, and a finding
 * read "Confirmed · low confidence".
 */

const run = runMonitoring({ world: defaultWorld(), watches: defaultWatches(), connections: defaultConnections(), brief: defaultBriefSchedule() });
const byWatch = async (w: string) => (await run).investigations.find((i) => i.watchId === w && i.status !== 'DISMISSED')!;

describe('canonical investigation identity', () => {
  it('one title — the change itself — used by the list, the detail and the brief alike', async () => {
    const r = await run;
    const checkout = await byWatch('w-checkout');
    expect(investigationTitle(checkout)).toBe('Checkout conversion dropped 18%');
    // The engine's internal title is not what people see.
    expect(checkout.title).not.toBe(investigationTitle(checkout));
    const brief = briefView(r.briefs.at(-1)!, { investigations: r.investigations, watches: defaultWatches(), decisions: {} });
    expect(brief.items.find((i) => i.investigationId === checkout.id)!.headline).toBe(investigationTitle(checkout));
  });

  it('the watch is a secondary label, not a second name', async () => {
    const checkout = await byWatch('w-checkout');
    expect(investigationWatches(checkout, defaultWatches())).toBe('Checkout health · Customer issues');
  });

  it('times always say what they mark', () => {
    expect(labelledTime('Detected', '2026-09-23T19:30:00.000Z')).toBe('Detected 19:30 UTC');
  });
});

describe('status language', () => {
  it('signal, cause and confidence are three separate statements', async () => {
    const checkout = findingState(await byWatch('w-checkout'));
    expect(checkout).toEqual({ signal: 'Signal confirmed', cause: 'Cause not established', confidence: 'High', closed: false });
  });

  it('a low-confidence finding is never "Confirmed · low confidence": confidence is separate and says what it measures', async () => {
    const signup = findingState(await byWatch('w-signup'));
    expect(signup.signal).toBe('Signal confirmed');
    expect(signup.cause).toBe('Cause not established');
    expect(signup.confidence).toBe('Low');
    expect(`${signup.signal} ${signup.cause}`).not.toMatch(/confidence/i);
  });

  it('closed states say why they closed; deployment failures speak about the deployment', () => {
    const base = { status: 'RESOLVED', confidence: 0.9 } as WatchInvestigation;
    expect(findingState(base)).toMatchObject({ signal: 'Resolved — back within normal range', closed: true });
    expect(findingState({ ...base, status: 'DISMISSED' })).toMatchObject({ signal: 'Dismissed — did not persist', closed: true });
    const deploy = { ...base, deployment: { source: 'github', recordId: 'r', target: 't', at: '' } } as WatchInvestigation;
    expect(findingState({ ...deploy, status: 'CONFIRMED' }).signal).toBe('Failure reported by the source');
    expect(findingState(deploy).signal).toBe('Resolved by a later deployment');
  });
});

describe('canonical reading', () => {
  it('value, baseline, baseline window, period and as-of all come from one reading', async () => {
    const reading = canonicalReading(await byWatch('w-checkout'))!;
    expect(reading).toMatchObject({ metric: 'Checkout conversion', baseline: '3.40%', change: '−18%' });
    expect(reading.current).toMatch(/^2\.7\d%$/);
    expect(reading.since).toMatch(/T19:00/);
    expect(reading.asOf).toBeTruthy();
    expect(reading.baselineWindow).toBeTruthy();
  });
});
