import { describe, expect, it } from 'vitest';
import type { Evidence } from '@/domain/types';
import { createModelReasoner, parseModelHypotheses, ModelOutputError } from './modelReasoner';
import { evaluateConfidence, scoreHypotheses, proposeCandidates } from './hypotheses';

const ev = (id: string, kind: Evidence['kind'], entities: string[], source: Evidence['source'] = 'payments'): Evidence => ({
  id,
  kind,
  source,
  title: id,
  detail: id,
  strength: 1,
  entities,
  observationIds: [],
  observedAt: '2026-09-23T20:00:00.000Z',
  stance: 'context',
});

const evidence = [ev('e1', 'provider_outlier', ['klarna', 'payments']), ev('e2', 'provider_normal', ['paypal']), ev('e3', 'support_cluster', ['checkout', 'klarna'], 'support')];
const ctx = { primaryName: 'Checkout completion', primaryArea: 'payments' as const, surfaces: ['checkout'] };

describe('hypotheses & confidence', () => {
  it('reserves probability for unexplained causes', () => {
    const hyps = scoreHypotheses(proposeCandidates(evidence, ctx), evidence);
    expect(hyps.reduce((a, h) => a + h.confidence, 0)).toBeLessThan(1);
  });

  it('refuses to conclude from a single source', () => {
    const one = [ev('e1', 'provider_outlier', ['klarna'])];
    const hyps = scoreHypotheses(proposeCandidates(one, ctx), one);
    expect(evaluateConfidence(hyps[0], one).band).toBe('insufficient');
  });

  it('returns insufficient when there is no hypothesis at all', () => {
    expect(evaluateConfidence(undefined, []).band).toBe('insufficient');
  });
});

describe('model reasoner', () => {
  const valid = JSON.stringify({ hypotheses: [{ type: 'provider_regression', target: 'klarna', statement: 'Klarna integration broke after deploy', supporting_evidence_ids: ['e1', 'e3'] }] });

  it('accepts structured, grounded output', () => {
    expect(parseModelHypotheses(valid, evidence).hypotheses).toHaveLength(1);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseModelHypotheses('{not json', evidence)).toThrow(ModelOutputError);
  });

  it('rejects output that fails the schema', () => {
    expect(() => parseModelHypotheses(JSON.stringify({ hypotheses: [{ type: 'magic', target: 'x', statement: 'y', supporting_evidence_ids: [] }] }), evidence)).toThrow(/schema/);
  });

  it('rejects hallucinated evidence ids', () => {
    const bad = JSON.stringify({ hypotheses: [{ type: 'provider_outage', target: 'klarna', statement: 'Klarna is down globally', supporting_evidence_ids: ['e99'] }] });
    expect(() => parseModelHypotheses(bad, evidence)).toThrow(/does not exist/);
  });

  it('uses model statements when valid, but confidence stays deterministic', async () => {
    const reasoner = createModelReasoner({ complete: async () => valid });
    const res = await reasoner.proposeHypotheses(evidence, ctx);
    expect(res.engine).toBe('model');
    expect(res.candidates.find((c) => c.key === 'provider_regression:klarna')?.statement).toBe('Klarna integration broke after deploy');
  });

  it('falls back to deterministic reasoning on malformed output', async () => {
    const res = await createModelReasoner({ complete: async () => 'Sure! Here are some ideas…' }).proposeHypotheses(evidence, ctx);
    expect(res.engine).toBe('deterministic-fallback');
    expect(res.notes[0]).toMatch(/not valid JSON/);
    expect(res.candidates.length).toBeGreaterThan(0);
  });

  it('falls back on timeout', async () => {
    const slow = { complete: () => new Promise<string>((r) => setTimeout(() => r(valid), 200)) };
    const res = await createModelReasoner(slow, { timeoutMs: 10 }).proposeHypotheses(evidence, ctx);
    expect(res.engine).toBe('deterministic-fallback');
    expect(res.notes[0]).toMatch(/timed out/);
  });
});
