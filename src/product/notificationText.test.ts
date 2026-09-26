import { describe, expect, it } from 'vitest';
import { defaultBriefSchedule, defaultWatches } from './catalog';
import { defaultConnections } from './integrations/adapters';
import { defaultWorld } from './integrations/world';
import { runMonitoring } from './engine/monitor';
import { traceWithDecisions } from './agent/decisions';
import { presentTraceStep, truthfulNotificationText } from './presentation';
import { auditEvents } from './view/audit';
import { replayFrames, replayPasses } from './view/replay';
import { watchCardStatus } from './view/watchCard';
import type { MonitoringResult, TraceStep, WatchInvestigation } from './types';

/**
 * Jagr has no email delivery — every notification it records is `delivery: 'simulated_outbox'` — yet the
 * engine's trace, and traces stored with past investigations, say "Emailed the PM". Stored records are
 * never rewritten; every view presents them as what the system can establish: an alert was recorded.
 */

const legacyStep: TraceStep = { id: 'inv-1-notify-2026-09-23T20:30:00.000Z', at: '2026-09-23T20:30:00.000Z', pass: 2, kind: 'notify', title: 'Emailed the PM: “Checkout conversion −18% — confirmed across Analytics, Jira”', detail: 'HIGH once confirmed.' };

describe('legacy notification text', () => {
  it('"Emailed the PM" is presented as an alert recorded — the subject and detail are kept', () => {
    expect(truthfulNotificationText(legacyStep.title)).toBe('Alert recorded: “Checkout conversion −18% — confirmed across Analytics, Jira”');
    expect(presentTraceStep(legacyStep)).toEqual({ ...legacyStep, title: 'Alert recorded: “Checkout conversion −18% — confirmed across Analytics, Jira”' });
  });

  it('stored run outcomes and notes say what was recorded, not that an email was sent', () => {
    expect(truthfulNotificationText('1 signal outside normal range · 1 email sent')).toBe('1 signal outside normal range · 1 alert recorded');
    expect(truthfulNotificationText('3 emails sent')).toBe('3 alerts recorded');
    expect(truthfulNotificationText('Email channel unavailable — notification not delivered; it will appear in the morning brief.')).toBe('Alert channel unavailable — alert not delivered; it will appear in the morning brief.');
  });

  it('text that is not a notification claim is left alone', () => {
    expect(truthfulNotificationText('Signal detected: Checkout conversion −18%')).toBe('Signal detected: Checkout conversion −18%');
    expect(presentTraceStep({ ...legacyStep, kind: 'signal' }).title).toBe(legacyStep.title);
    expect(truthfulNotificationText(undefined)).toBeUndefined();
  });

  it('every view of a real run (trace, audit trail, replay, run log) says "Alert recorded"; the stored investigation is untouched', async () => {
    const r = await runMonitoring({ world: defaultWorld(), watches: defaultWatches(), connections: defaultConnections(), brief: defaultBriefSchedule() });
    const inv = r.investigations.find((i) => i.trace.some((s) => s.kind === 'notify'))!;
    const stored = JSON.stringify(inv);
    // The engine still records its own wording — that is the historical record, and it is not rewritten.
    expect(inv.trace.find((s) => s.kind === 'notify')!.title).toMatch(/^Emailed the PM: /);

    const shown = [
      ...traceWithDecisions(inv, {}).map((s) => s.title),
      ...auditEvents(traceWithDecisions(inv, {})).map((e) => e.action),
      ...replayPasses(inv).flatMap((p) => replayFrames(inv, {}, p.pass)).flatMap((f) => [f.title, f.detail ?? '']),
      ...defaultWatches().flatMap((w) => watchCardStatus(w, { location: 'browser', result: r, clock: r.window.end }).runs.map((l) => l.outcome)),
    ].join('\n');
    expect(shown).toMatch(/Alert recorded: /);
    expect(shown).not.toMatch(/Emailed|email sent|emails sent/i);
    expect(JSON.stringify(inv)).toBe(stored);
  });

  it('a server run log with legacy wording is presented truthfully too', () => {
    const watch = { ...defaultWatches()[0], id: 'w-1' };
    const result = { window: { start: '', end: '' }, investigations: [] as WatchInvestigation[], emails: [], briefs: [], connections: [], actions: [], log: [{ jobId: 'j', type: 'watch_run', watchId: 'w-1', scheduledAt: '2026-09-25T10:00:00.000Z', outcome: '1 signal outside normal range · 1 email sent', investigationIds: [], emailIds: [] }] } as MonitoringResult;
    expect(watchCardStatus(watch, { location: 'server', result, clock: '2026-09-25T10:05:00.000Z', snapshotAt: '2026-09-25T10:05:00.000Z' }).lastRun?.outcome).toBe('1 signal outside normal range · 1 alert recorded');
  });
});
