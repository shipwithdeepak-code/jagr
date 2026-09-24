import { z } from 'zod';
import type { Evidence, HypothesisType, ProductArea } from '@/domain/types';
import { proposeCandidates } from './hypotheses';
import { createDeterministicReasoner, type ReasoningContext, type ReasoningEngine } from './reasoning';

/**
 * Model-backed reasoner. Kept in its own module so the zod dependency only ships when it's used.
 */

/** Anything that can complete a prompt: a server-side proxy to Claude, Gemini, etc. */
export interface ModelClient {
  complete(request: { system: string; prompt: string; responseSchema: object }): Promise<string>;
}

const HYPOTHESIS_TYPES = ['provider_regression', 'provider_outage', 'release_regression', 'demand_shift', 'experiment_effect', 'instrumentation'] as const;

export const ModelHypothesesSchema = z.object({
  hypotheses: z
    .array(
      z.object({
        type: z.enum(HYPOTHESIS_TYPES),
        target: z.string().min(1),
        statement: z.string().min(8).max(200),
        supporting_evidence_ids: z.array(z.string()).min(1),
        contradicting_evidence_ids: z.array(z.string()).default([]),
      }),
    )
    .min(1)
    .max(6),
});

export type ModelHypotheses = z.infer<typeof ModelHypothesesSchema>;

export const MODEL_SYSTEM_PROMPT = `You are JAGR, a product-operations investigator.
You receive typed evidence gathered from analytics, payments, GitHub, support and experiments.
Propose up to 6 candidate explanations. Rules:
- Cite evidence only by the ids provided. Never invent evidence or ids.
- Include plausible alternatives, not just the favourite.
- Do not state confidence; it is computed separately from the evidence.
Respond with JSON matching the schema.`;

export function buildModelPrompt(evidence: Evidence[], ctx: ReasoningContext): string {
  const lines = evidence.map((e) => `- [${e.id}] (${e.source}/${e.kind}) ${e.title}: ${e.detail}`);
  return `Anomaly: ${ctx.primaryName} (area: ${ctx.primaryArea}; surfaces: ${ctx.surfaces.join(', ')}).\nEvidence:\n${lines.join('\n')}`;
}

export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelOutputError';
  }
}

/** Parse + validate + ground. Throws ModelOutputError with a precise reason. */
export function parseModelHypotheses(raw: string, evidence: Evidence[]): ModelHypotheses {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ModelOutputError('Model output was not valid JSON');
  }
  const parsed = ModelHypothesesSchema.safeParse(json);
  if (!parsed.success) throw new ModelOutputError(`Model output failed schema validation: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  const known = new Set(evidence.map((e) => e.id));
  for (const h of parsed.data.hypotheses) {
    const unknown = [...h.supporting_evidence_ids, ...h.contradicting_evidence_ids].filter((id) => !known.has(id));
    if (unknown.length) throw new ModelOutputError(`Model cited evidence that does not exist: ${unknown.join(', ')}`);
  }
  return parsed.data;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Model timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const AREA_BY_TYPE: Record<Exclude<HypothesisType, 'unexplained'>, ProductArea> = {
  provider_regression: 'payments',
  provider_outage: 'payments',
  release_regression: 'platform',
  demand_shift: 'growth',
  experiment_effect: 'growth',
  instrumentation: 'growth',
};

export function createModelReasoner(client: ModelClient, opts: { timeoutMs?: number; modelName?: string } = {}): ReasoningEngine {
  const fallback = createDeterministicReasoner();
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return {
    name: `Model reasoner (${opts.modelName ?? 'LLM'}) with deterministic fallback`,
    mode: 'model',
    async proposeHypotheses(evidence, ctx) {
      try {
        const raw = await withTimeout(
          client.complete({ system: MODEL_SYSTEM_PROMPT, prompt: buildModelPrompt(evidence, ctx), responseSchema: ModelHypothesesSchema }),
          timeoutMs,
        );
        const parsed = parseModelHypotheses(raw, evidence);
        // Keep the deterministic templates too, so alternatives the model skipped are still scored.
        const base = proposeCandidates(evidence, ctx);
        const byKey = new Map(base.map((c) => [c.key, c]));
        for (const h of parsed.hypotheses) {
          const key = `${h.type}:${h.target}`;
          const existing = byKey.get(key) ?? byKey.get(h.type);
          if (existing) {
            byKey.set(existing.key, { ...existing, statement: h.statement, proposedBy: 'model' });
          } else {
            byKey.set(key, { key, type: h.type, statement: h.statement, area: AREA_BY_TYPE[h.type], entities: [h.target], prior: -1.2, proposedBy: 'model' });
          }
        }
        return { candidates: [...byKey.values()], engine: 'model', notes: [`Model proposed ${parsed.hypotheses.length} hypotheses; all cited evidence verified.`] };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const res = await fallback.proposeHypotheses(evidence, ctx);
        return { ...res, engine: 'deterministic-fallback', notes: [`${reason} — fell back to deterministic reasoning.`] };
      }
    },
  };
}
