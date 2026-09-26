import { describe, expect, it } from 'vitest';
import type { DetectedSignal, EvidenceItem } from '../types';
import type { ChangeRecord } from '../roles/types';
import { readMetric } from './detect';
import { associateChange, reason, type Gathered } from './investigate';
import { hasCausalOverclaim } from './language';
import { telemetryFindings, telemetryReadings } from './telemetry';

/**
 * Error / crash telemetry in investigations: detection, the four findings, the causality guard, and
 * where each statement lands (Observed · Inferred · Unknown). Source-neutral: telemetry is recognised by
 * the series definition, not by which tool reported it.
 */

const hours = (n: number, value: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ t: new Date(Date.parse('2026-09-25T00:00:00Z') + i * 3_600_000).toISOString(), value: value(i) }));

describe('detection', () => {
  it('ERROR_SPIKE: an error count rising past its threshold is anomalous; a small wobble is not', () => {
    const errors = { badDirection: 'up' as const, mode: 'relative' as const, threshold: 100, baseline: { mean: 5, stdDev: 1 } };
    expect(readMetric({ ...errors, points: hours(6, (i) => (i >= 2 ? 40 : 5)) }).status).toBe('anomalous');
    expect(readMetric({ ...errors, points: hours(6, () => 6) }).status).toBe('normal');
  });

  it('CRASH_REGRESSION: a crash-free rate falling past its threshold (points) is anomalous', () => {
    const crash = { badDirection: 'down' as const, mode: 'absolute' as const, threshold: 0.5, baseline: { mean: 99.5, stdDev: 0.1 } };
    expect(readMetric({ ...crash, points: hours(6, (i) => (i >= 2 ? 97 : 99.5)) }).status).toBe('anomalous');
    expect(readMetric({ ...crash, points: hours(6, () => 99.45) }).status).toBe('normal');
  });
});

const errorSignal: DetectedSignal = { key: 'metric:checkout_errors', provider: 'sentry', area: 'checkout', label: 'Checkout errors', magnitude: '+320%', ratio: 3.2, onsetAt: '2026-09-25T02:00:00.000Z', detectedAt: '2026-09-25T06:00:00.000Z', refs: [], telemetry: 'errors' };
const crashSignal: DetectedSignal = { ...errorSignal, key: 'metric:crash_free_sessions', label: 'Crash-free sessions', magnitude: '−2.50 pts', telemetry: 'crash_free' };
const base = { sourceNames: ['Sentry'], telemetryStable: false, areaLabel: 'checkout' };

describe('findings', () => {
  it('reads telemetry from signals and from degraded evidence — never from a non-telemetry series', () => {
    const ev: EvidenceItem = { id: 'e', provider: 'sentry', direction: 'degraded', statement: 's', refs: [], provenance: { sources: ['sentry'], fetchedAt: '', records: [], values: { metric: 'Crash-free sessions', current: 97, baseline: 99.5, baselineWindow: '', unit: 'percent', telemetry: 'crash_free' } } };
    const conversion: DetectedSignal = { ...errorSignal, provider: 'amplitude', label: 'Checkout conversion', telemetry: undefined };
    expect(telemetryReadings([errorSignal, conversion], [ev]).map((r) => [r.kind, r.label])).toEqual([
      ['errors', 'Checkout errors'],
      ['crash_free', 'Crash-free sessions'],
    ]);
  });

  it('each finding appears only when its evidence does', () => {
    const readings = telemetryReadings([errorSignal, crashSignal], []);
    expect(telemetryFindings({ ...base, readings, otherDegraded: [] }).kinds).toEqual(['ERROR_SPIKE', 'CRASH_REGRESSION']);
    expect(telemetryFindings({ ...base, readings, otherDegraded: [], change: { phrase: 'release 4.8.1', minutesBeforeOnset: 90 } }).kinds).toContain('RELEASE_IMPACT');
    expect(telemetryFindings({ ...base, readings, otherDegraded: ['Analytics', 'Jira'] }).kinds).toContain('CROSS_SOURCE_ANOMALY');
    // No telemetry reading: no telemetry finding, however many other sources degrade or releases happen.
    const none = telemetryFindings({ ...base, readings: [], otherDegraded: ['Analytics'], change: { phrase: 'release 4.8.1', minutesBeforeOnset: 90 } });
    expect(none.kinds).toEqual([]);
  });

  it('release correlation is temporal only — a change after the onset, or long before it, is not associated', () => {
    const rel = (at: string): ChangeRecord => ({ id: at, source: 'sentry', kind: 'release', timing: 'actual', title: 'Release 4.8.1', at, version: '4.8.1', ref: { provider: 'sentry', kind: 'release', id: '4.8.1' }, provenance: { source: 'sentry', provider: 'sentry', connectionId: 'c', mode: 'connected', externalId: '4.8.1', observedAt: at, fetchedAt: at } });
    expect(associateChange([rel('2026-09-25T00:30:00Z')], '2026-09-25T02:00:00.000Z')).toMatchObject({ version: '4.8.1', minutesBeforeOnset: 90 });
    expect(associateChange([rel('2026-09-25T03:00:00Z')], '2026-09-25T02:00:00.000Z')).toBeUndefined();
    expect(associateChange([rel('2026-09-24T20:00:00Z')], '2026-09-25T02:00:00.000Z')).toBeUndefined();
  });

  it('a stable telemetry reading narrows the picture without claiming anything', () => {
    const f = telemetryFindings({ ...base, readings: [], telemetryStable: true, otherDegraded: ['Analytics'] });
    expect(f.inferred[0]).toMatch(/shows no error or crash spike in the window, so the checkout change may not come from application errors/);
  });

  it('causality guard: nothing written claims a cause — and the guard does catch one', () => {
    const f = telemetryFindings({ ...base, readings: telemetryReadings([errorSignal, crashSignal], []), otherDegraded: ['Analytics', 'Jira'], change: { phrase: 'release 4.8.1', minutesBeforeOnset: 90 } });
    for (const t of [...f.inferred, ...f.unknowns]) expect(hasCausalOverclaim(t), t).toBe(false);
    expect(f.inferred.join(' ')).toMatch(/occurred 90 minutes after release 4\.8\.1 and may be related/);
    expect(hasCausalOverclaim('The checkout errors were caused by release 4.8.1.')).toBe(true);
  });
});

describe('observed · inferred · unknown', () => {
  it('places every statement where it belongs, with all four telemetry findings', () => {
    const conversion: DetectedSignal = { key: 'metric:checkout_conversion', provider: 'amplitude', area: 'checkout', label: 'Checkout conversion', magnitude: '−14%', ratio: 1.4, onsetAt: '2026-09-25T02:10:00.000Z', detectedAt: '2026-09-25T06:00:00.000Z', refs: [] };
    const release: ChangeRecord = { id: 'r', source: 'sentry', kind: 'release', timing: 'actual', title: 'Release 4.8.1', at: '2026-09-25T00:40:00.000Z', version: '4.8.1', platform: 'android', ref: { provider: 'sentry', kind: 'release', id: '4.8.1' }, provenance: { source: 'sentry', provider: 'sentry', connectionId: 'c', mode: 'connected', externalId: '4.8.1', observedAt: '2026-09-25T00:40:00.000Z', fetchedAt: '2026-09-25T06:00:00.000Z' } };
    const g: Gathered = {
      evidence: [
        { id: 'a', provider: 'amplitude', direction: 'degraded', statement: 'Amplitude: Checkout conversion is 2.79% vs 3.25% baseline (−14%) since 02:10.', onsetAt: '2026-09-25T02:10:00.000Z', refs: [] },
        { id: 'j', provider: 'jira', direction: 'degraded', statement: 'Jira: 3 new checkout issues since 02:30 (SHOP-1, SHOP-2, SHOP-3).', onsetAt: '2026-09-25T02:30:00.000Z', refs: [] },
        { id: 'r', provider: 'sentry', direction: 'change', statement: 'Sentry: release 4.8.1 at 00:40.', refs: [] },
      ],
      gaps: [],
      notInWatch: [],
      changes: [release],
      workItems: [],
      feedback: [],
    };
    const r = reason(conversion, [conversion, errorSignal, crashSignal], g, 'checkout', conversion.onsetAt, false);
    expect(r.telemetrySignals).toEqual(['ERROR_SPIKE', 'CRASH_REGRESSION', 'RELEASE_IMPACT', 'CROSS_SOURCE_ANOMALY']);
    expect(r.correlatedProviders).toEqual(expect.arrayContaining(['amplitude', 'jira', 'sentry']));
    // OBSERVED: facts from each source, telemetry included.
    expect(r.observed).toEqual(expect.arrayContaining([g.evidence[0].statement, g.evidence[1].statement, 'Sentry: release 4.8.1 at 00:40.']));
    expect(r.observed.some((o) => /^Sentry: Checkout errors moved \+320% from its baseline/.test(o))).toBe(true);
    // INFERRED: correlation, never cause.
    expect(r.inferred.join('\n')).toMatch(/temporal association/);
    expect(r.inferred.join('\n')).toMatch(/independent sources whose evidence supports one shared checkout problem/);
    // UNKNOWN: causation and user overlap stay open; telemetry is no longer "not connected".
    expect(r.unknowns).toEqual(expect.arrayContaining(['Whether release 4.8.1 is responsible — timing alone does not establish causation.']));
    expect(r.unknowns.some((u) => /same users/.test(u))).toBe(true);
    expect(r.unknowns.join('\n')).not.toMatch(/server error data/i);
    for (const t of [...r.observed, ...r.inferred, ...r.unknowns, r.likelyExplanation, r.uncertainty]) expect(hasCausalOverclaim(t), t).toBe(false);
  });

  it('without telemetry, the write-up is unchanged: server error data is still stated as not connected', () => {
    const conversion: DetectedSignal = { key: 'metric:checkout_conversion', provider: 'amplitude', area: 'checkout', label: 'Checkout conversion', magnitude: '−14%', ratio: 1.4, onsetAt: '2026-09-25T02:10:00.000Z', detectedAt: '2026-09-25T06:00:00.000Z', refs: [] };
    const r = reason(conversion, [conversion], { evidence: [], gaps: [], notInWatch: [], changes: [], workItems: [], feedback: [] }, 'checkout', conversion.onsetAt, false);
    expect(r.telemetrySignals).toEqual([]);
    expect(r.unknowns).toContain('Payment-provider and server error data are not connected to Jagr.');
  });
});
