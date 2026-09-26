import type { WatchInvestigation } from '../types.js';
import { headlineOf, readingOf } from '../presentation.js';
import { confidenceBand } from '../engine/monitor.js';
import { fmtTime } from '../lib/time.js';

/**
 * One identity for an investigation, wherever it appears (Overview, list, detail, brief, watch cards,
 * approvals): the change itself — "Checkout conversion dropped 18%" — never a second name such as
 * "Checkout health degraded". The watch that found it is secondary context, not a different title.
 */
export function investigationTitle(inv: WatchInvestigation): string {
  return headlineOf(inv);
}

/** The watches an investigation belongs to, by name — the secondary label under the title. */
export function investigationWatches(inv: WatchInvestigation, watches: { id: string; name: string }[]): string {
  return inv.watchIds.map((id) => watches.find((w) => w.id === id)?.name).filter(Boolean).join(' · ');
}

/**
 * Status in two independent statements, never one blended label like "Confirmed · low confidence":
 *   - the signal: is the change real and persisting?
 *   - the cause: Jagr never establishes a cause from timing or co-movement, so this stays "not established".
 * Confidence is separate again: how sure Jagr is that the signal is real — not that any cause is right.
 */
export interface FindingState {
  signal: string;
  cause: string;
  confidence: 'High' | 'Moderate' | 'Low';
  /** Closed investigations: resolved or dismissed. */
  closed: boolean;
}

export function findingState(inv: WatchInvestigation): FindingState {
  const failure = !!inv.deployment;
  const signal =
    inv.status === 'DETECTED'
      ? 'Signal detected'
      : inv.status === 'INVESTIGATING'
        ? 'Investigation in progress'
        : inv.status === 'CONFIRMED'
          ? failure
            ? 'Failure reported by the source'
            : 'Signal confirmed'
          : inv.status === 'RESOLVED'
            ? failure
              ? 'Resolved by a later deployment'
              : 'Resolved — back within normal range'
            : 'Dismissed — did not persist';
  const band = confidenceBand(inv.confidence);
  return {
    signal,
    cause: 'Cause not established',
    confidence: band === 'high' ? 'High' : band === 'moderate' ? 'Moderate' : 'Low',
    closed: inv.status === 'RESOLVED' || inv.status === 'DISMISSED',
  };
}

/** A time with what it marks: "Detected 19:30 UTC", never a bare "19:30". */
export function labelledTime(label: string, iso: string): string {
  return `${label} ${fmtTime(iso)} UTC`;
}

/**
 * The primary metric as one canonical reading: the value, its baseline, the period and when it was
 * read. Every view shows this reading; figures from other passes are labelled with their own time.
 */
export interface CanonicalReading {
  metric: string;
  current: string;
  baseline: string;
  change: string;
  /** How the baseline was formed, e.g. "same hours, previous 28 nights". */
  baselineWindow?: string;
  since: string;
  asOf?: string;
}

export function canonicalReading(inv: WatchInvestigation): CanonicalReading | undefined {
  const r = readingOf(inv);
  if (!r) return undefined;
  const lead = inv.signals[0];
  // The same evidence item readingOf parsed, so the value and its as-of time come from one reading.
  const e = inv.evidence.find((x) => x.provider === lead.provider && x.direction === 'degraded' && / vs .+ baseline/.test(x.statement));
  return {
    metric: lead.label,
    current: r.current,
    baseline: r.baseline,
    change: r.change,
    baselineWindow: e?.provenance?.values?.baselineWindow,
    since: lead.onsetAt,
    asOf: e?.provenance?.fetchedAt || undefined,
  };
}
