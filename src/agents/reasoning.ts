import type { Evidence, ProductArea } from '@/domain/types';
import { proposeCandidates, type HypothesisCandidate } from './hypotheses';

/**
 * Reasoning engines propose hypotheses. They never grade them: confidence always comes from
 * the deterministic evidence scorer, so a model cannot talk itself into certainty.
 *
 * - DeterministicReasoner: rule templates over typed evidence. Always available, no API key.
 * - ModelReasoner: asks an LLM for hypotheses as structured JSON, validates the schema, rejects
 *   anything that cites evidence that doesn't exist, and falls back to deterministic on
 *   timeout or malformed output.
 */

export interface ReasoningContext {
  primaryName: string;
  primaryArea: ProductArea;
  surfaces: string[];
}

export interface ReasoningResult {
  candidates: HypothesisCandidate[];
  engine: string;
  notes: string[];
}

export interface ReasoningEngine {
  readonly name: string;
  readonly mode: 'deterministic' | 'model';
  proposeHypotheses(evidence: Evidence[], ctx: ReasoningContext): Promise<ReasoningResult>;
}

export function createDeterministicReasoner(): ReasoningEngine {
  return {
    name: 'Deterministic reasoner (local, simulation mode)',
    mode: 'deterministic',
    async proposeHypotheses(evidence, ctx) {
      return { candidates: proposeCandidates(evidence, ctx), engine: 'deterministic', notes: [] };
    },
  };
}

// The model-backed reasoner lives in ./modelReasoner.ts.
