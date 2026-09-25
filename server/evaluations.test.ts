import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000 });
import type { IdentityProvider } from '../src/product/ports/identity';
import { manualClock } from '../src/product/ports/clock';
import { SCENARIO_KINDS, type EvaluationLabReport } from '../src/product/app/evaluationLab';
import { freshPglite } from './postgres/pglite';
import { createRuntime } from './runtime';
import { createApp } from './app';
import type { ApiRequest, ApiResponse } from './http/types';

/** The Evaluation Lab over the API: structured results only, every requested scenario covered, nothing hidden or scored. */
describe('evaluation lab API', () => {
  it('reports suites, dimensions, scenarios and coverage — no traces, no reasoning text', async () => {
    const idp: IdentityProvider = { id: 'fake', authorizationUrl: ({ state }) => `https://idp.example/a?state=${state}`, exchange: async () => ({ provider: 'fake', subject: 'ana-1', emailVerified: true, displayName: 'Ana' }) };
    const calls: string[] = [];
    const rt = await createRuntime({ JAGR_SESSION_SECRET: randomBytes(32).toString('hex'), JAGR_SECRET_KEY: randomBytes(32).toString('base64') }, { sql: await freshPglite(), clock: manualClock('2026-09-25T10:00:00.000Z'), identity: { fake: idp }, http: async (u) => (calls.push(u), Promise.reject(new Error('no network in evaluations'))) });
    const app = createApp(rt);
    const req = (method: string, path: string, headers: Record<string, string> = {}): ApiRequest => {
      const [p, q] = path.split('?');
      return { method, path: p, query: Object.fromEntries(new URLSearchParams(q ?? '')), headers };
    };
    const cookiesOf = (r: ApiResponse) => Object.fromEntries((r.cookies ?? []).map((c) => c.split(';')[0].split('=')).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
    expect((await app(req('GET', '/api/evaluations'))).status).toBe(401);
    const start = await app(req('GET', '/api/auth/fake/start'));
    const state = new URL(start.headers!.location).searchParams.get('state')!;
    const c = cookiesOf(await app(req('GET', `/api/auth/fake/callback?code=x&state=${state}`, { cookie: `jagr_oauth=${encodeURIComponent(cookiesOf(start).jagr_oauth)}` })));
    const r = await app(req('GET', '/api/evaluations', { cookie: `jagr_session=${c.jagr_session}; jagr_csrf=${c.jagr_csrf}`, 'x-jagr-csrf': c.jagr_csrf }));
    expect(r.status).toBe(200);
    const lab = r.body as EvaluationLabReport;
    expect(calls).toEqual([]);
    expect(lab.engine).toEqual({ planner: 'deterministic', data: 'fixtures' });
    expect(lab.dimensions.map((d) => d.key).sort()).toEqual(['approval', 'attention', 'causality', 'dedupe', 'detection', 'grounding', 'tool_selection']);
    for (const kind of Object.keys(SCENARIO_KINDS)) {
      const cov = lab.coverage.find((x) => x.kind === kind)!;
      expect(cov.cases.length, kind).toBeGreaterThan(0);
      expect(cov.status, kind).not.toBe('regression');
    }
    expect(lab.scenarios.some((s) => s.status === 'REGRESSION')).toBe(false);
    expect(lab.suites.planner.total).toBeGreaterThan(0);
    const text = JSON.stringify(lab);
    // Structured results only: no stored traces, planner rationales or hidden reasoning.
    expect(text).not.toMatch(/"trace"|"rationale"|"reasoning"|chain.of.thought/i);
  });
});
