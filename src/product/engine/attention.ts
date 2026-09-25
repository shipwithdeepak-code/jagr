import type { AttentionLevel, DetectedSignal } from '../types.js';
import { signalMeta } from '../catalog.js';

/**
 * Attention model — "only interrupt me when it matters".
 *
 * LOW       possible fluctuation (not persistent)                        → no email, not in brief
 * MEDIUM    persistent degradation, but single-source or customer-only    → morning brief
 * HIGH      core funnel degradation corroborated by another source or a   → email once confirmed
 *           release in the window; or crashes corroborated elsewhere
 * CRITICAL  severe production/customer impact                             → email immediately
 */

export const ATTENTION_RANK: Record<AttentionLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export function atLeast(level: AttentionLevel, min: AttentionLevel) {
  return ATTENTION_RANK[level] >= ATTENTION_RANK[min];
}

export interface AttentionInput {
  signals: DetectedSignal[];
  /** Signals that persisted, as `${key}@${provider}`. */
  anomalous: Set<string>;
  corroborating: number;
  releaseAssociated: boolean;
  blockerIssues: number;
}

export function assessAttention(i: AttentionInput): { level: AttentionLevel; reason: string } {
  const persistent = i.signals.filter((s) => i.anomalous.has(`${s.key}@${s.provider}`));
  if (!persistent.length) return { level: 'LOW', reason: 'A single degraded reading that has not persisted — likely a fluctuation.' };

  const funnel = persistent.filter((s) => signalMeta(s.key).coreFunnel);
  const crash = persistent.filter((s) => signalMeta(s.key).purpose === 'stability');

  const severeFunnel = funnel.find((s) => s.ratio >= 8);
  const severeCrash = crash.find((s) => s.ratio >= 5);
  if (severeFunnel || severeCrash || i.blockerIssues >= 2) {
    const why = severeFunnel ? `${severeFunnel.label} ${severeFunnel.magnitude}` : severeCrash ? `${severeCrash.label} ${severeCrash.magnitude}` : `${i.blockerIssues} highest-priority issues`;
    return { level: 'CRITICAL', reason: `Severe customer impact: ${why}. Notify immediately.` };
  }
  if (funnel.length && (i.corroborating >= 1 || i.releaseAssociated)) {
    return { level: 'HIGH', reason: `Core funnel degradation (${funnel[0].label} ${funnel[0].magnitude}) ${i.corroborating ? `corroborated by ${i.corroborating} other source${i.corroborating === 1 ? '' : 's'}` : 'following a release'}.` };
  }
  if (crash.length && i.corroborating >= 1) {
    return { level: 'HIGH', reason: `Crash rate increase (${crash[0].magnitude}) corroborated by ${i.corroborating} other source${i.corroborating === 1 ? '' : 's'}.` };
  }
  return { level: 'MEDIUM', reason: funnel.length ? 'Persistent funnel degradation with no corroborating source — worth a look, not an interruption.' : 'Persistent change in one source — included in the morning brief.' };
}
