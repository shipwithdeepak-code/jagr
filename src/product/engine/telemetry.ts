import type { DetectedSignal, EvidenceItem, ProviderId } from '../types.js';

/**
 * Error and crash telemetry in an investigation — what it adds to the write-up. Pure, and
 * source-neutral: a series is telemetry because its definition says so (MetricDefinition.telemetry),
 * never because of which tool reported it.
 *
 *   ERROR_SPIKE           an error series rose past its threshold
 *   CRASH_REGRESSION      a crash-free rate fell past its threshold
 *   RELEASE_IMPACT        either of those began after a change reached users (a temporal association)
 *   CROSS_SOURCE_ANOMALY  telemetry and at least one other, independent source degraded together
 *
 * Every sentence is correlation language ("occurred after", "may be related", "evidence supports");
 * none asserts a cause (engine/language.ts checks it). What these sources cannot show — above all
 * whether the same users are affected across them — is stated as unknown.
 */

export type TelemetrySignalKind = 'ERROR_SPIKE' | 'CRASH_REGRESSION' | 'RELEASE_IMPACT' | 'CROSS_SOURCE_ANOMALY';

export interface TelemetryReading {
  provider: ProviderId;
  kind: 'errors' | 'crash_free';
  label: string;
  magnitude?: string;
}

export interface TelemetryFindings {
  kinds: TelemetrySignalKind[];
  inferred: string[];
  unknowns: string[];
}

/** The degraded telemetry readings among the detected signals and the gathered evidence. */
export function telemetryReadings(signals: DetectedSignal[], evidence: EvidenceItem[]): TelemetryReading[] {
  const out = new Map<string, TelemetryReading>();
  for (const s of signals) if (s.telemetry) out.set(`${s.provider}:${s.label}`, { provider: s.provider, kind: s.telemetry, label: s.label, magnitude: s.magnitude });
  for (const e of evidence) {
    const v = e.provenance?.values;
    if (e.direction !== 'degraded' || !v?.telemetry || out.has(`${e.provider}:${v.metric}`)) continue;
    out.set(`${e.provider}:${v.metric}`, { provider: e.provider, kind: v.telemetry, label: v.metric });
  }
  return [...out.values()];
}

export function telemetryFindings(input: {
  readings: TelemetryReading[];
  /** Display names of the telemetry sources read in this investigation. */
  sourceNames: string[];
  /** A telemetry source was read and showed a series within its normal range. */
  telemetryStable: boolean;
  /** Other (non-telemetry) sources that degraded in the same investigation — display names. */
  otherDegraded: string[];
  /** The change that preceded the onset, if one did: e.g. "release 4.8.1". */
  change?: { phrase: string; minutesBeforeOnset: number };
  areaLabel: string;
}): TelemetryFindings {
  const { readings, otherDegraded, change, areaLabel } = input;
  const src = input.sourceNames.join(', ') || 'Error telemetry';
  const kinds: TelemetrySignalKind[] = [];
  const inferred: string[] = [];
  const unknowns: string[] = [];
  const errors = readings.filter((r) => r.kind === 'errors');
  const crashes = readings.filter((r) => r.kind === 'crash_free');
  const moved = (r: TelemetryReading) => `${r.label}${r.magnitude ? ` (${r.magnitude})` : ''}`;

  if (errors.length) {
    kinds.push('ERROR_SPIKE');
    inferred.push(`Error telemetry supports a real ${areaLabel} problem: ${errors.map(moved).join(' and ')} rose past normal levels in ${src}.`);
  }
  if (crashes.length) {
    kinds.push('CRASH_REGRESSION');
    inferred.push(`${crashes.map(moved).join(' and ')} fell in ${src} — a stability regression in the same window.`);
  }
  if (readings.length && change) {
    kinds.push('RELEASE_IMPACT');
    inferred.push(`The ${errors.length ? 'error rise' : 'crash regression'} in ${src} occurred ${change.minutesBeforeOnset} minutes after ${change.phrase} and may be related to it; timing alone does not establish that it is responsible.`);
  }
  if (readings.length && otherDegraded.length) {
    kinds.push('CROSS_SOURCE_ANOMALY');
    inferred.push(`${src} and ${otherDegraded.join(', ')} degraded in the same window — independent sources whose evidence supports one shared ${areaLabel} problem, correlated in time.`);
    unknowns.push(`Whether the users affected in ${src} are the same users behind the change in ${otherDegraded.join(', ')} — Jagr does not match users across sources.`);
  }
  if (!readings.length && input.telemetryStable && otherDegraded.length) {
    inferred.push(`${src} shows no error or crash spike in the window, so the ${areaLabel} change may not come from application errors (for example a UX, pricing or tracking change).`);
  }
  return { kinds, inferred, unknowns };
}
