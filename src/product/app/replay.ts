import type { ActionDecision, EvidenceItem, ISO, WatchInvestigation } from '../types';
import { defaultReplayPass, replayFrames, replayPasses, type ReplayFrame, type ReplayPass } from '../view/replay';

/**
 * Investigation replay as product data. Built ONLY from the stored investigation (its trace, its
 * evidence snapshot) and the recorded human decisions — no source is read and nothing is re-run, so a
 * replay works when every provider is down, disconnected or has changed since.
 *
 * "Run again" is a different operation (a new monitoring run over current data, whose results can
 * differ); it never rewrites the original pass shown here.
 */
export interface InvestigationReplay {
  investigationId: string;
  kind: 'original';
  /** When the investigation was last recorded. */
  recordedAt: ISO;
  passes: ReplayPass[];
  pass: number;
  frames: ReplayFrame[];
  /** The evidence snapshot the investigation used. */
  evidence: EvidenceItem[];
  assumptions: string[];
}

export function replayInvestigation(inv: WatchInvestigation, decisions: Record<string, ActionDecision>, pass?: number): InvestigationReplay {
  const passes = replayPasses(inv);
  const chosen = pass !== undefined && passes.some((p) => p.pass === pass) ? pass : defaultReplayPass(inv);
  return { investigationId: inv.id, kind: 'original', recordedAt: inv.updatedAt, passes, pass: chosen, frames: replayFrames(inv, decisions, chosen), evidence: inv.evidence, assumptions: inv.assumptions ?? [] };
}
