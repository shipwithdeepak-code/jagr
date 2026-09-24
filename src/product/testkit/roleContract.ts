import { describe, expect, it } from 'vitest';
import type { SourceConnection } from '../types';
import { ProviderUnavailableError } from '../integrations/types';
import type { Provenance, RegisteredSource, TimeWindow } from '../roles/types';

/**
 * The role-source contract. Every source — simulated, imported, or a real connector — must pass it.
 * Test-support code (vitest), excluded from the core's compile and boundary rules.
 *
 *   - every record carries complete provenance, and its reference points at the source itself
 *   - records respect the requested window ("as of" reads never see the future)
 *   - a source that is down throws SourceUnavailable — it never returns an empty (fabricated) answer
 */
export interface ContractCase {
  name: string;
  /** A working source, and a window that contains data for its roles. */
  make: () => RegisteredSource;
  window: TimeWindow;
  /** The same source with its connection in a failing state. */
  broken?: (state: Extract<SourceConnection['state'], 'unavailable' | 'error'>) => RegisteredSource;
}

function checkProvenance(src: RegisteredSource, p: Provenance, ref: { provider: string; id: string }, window: TimeWindow) {
  expect(p.source).toBe(src.id);
  expect(ref.provider).toBe(src.id);
  expect(p.connectionId).toBeTruthy();
  expect(p.provider).toBeTruthy();
  expect(['connected', 'imported', 'simulated']).toContain(p.mode);
  expect(p.externalId).toBe(ref.id);
  expect(Date.parse(p.observedAt)).not.toBeNaN();
  expect(Date.parse(p.fetchedAt)).not.toBeNaN();
  expect(p.fetchedAt <= window.end || p.fetchedAt === window.end).toBe(true);
}

export function roleSourceContract(c: ContractCase) {
  describe(`role-source contract: ${c.name}`, () => {
    it('declares at least one role', () => {
      const s = c.make();
      expect(['metrics', 'changes', 'work_items', 'feedback', 'conversations', 'context'].some((r) => !!s[r as keyof RegisteredSource])).toBe(true);
    });

    it('metrics: unique keys, provenance on every series, points inside the window, null for unknown metrics', async () => {
      const s = c.make();
      if (!s.metrics) return;
      const defs = s.metrics.metricDefinitions();
      expect(new Set(defs.map((d) => d.key)).size).toBe(defs.length);
      for (const d of defs) {
        const series = await s.metrics.getSeries({ metric: d.key, window: c.window });
        if (!series) continue;
        expect(series.key).toBe(d.key);
        checkProvenance(s, series.provenance, series.ref, c.window);
        for (const pt of series.points) expect(pt.t >= c.window.start && pt.t <= c.window.end).toBe(true);
      }
      expect(await s.metrics.getSeries({ metric: '__no_such_metric__', window: c.window })).toBeNull();
    });

    it('changes, work items and feedback: provenance on every record, all inside the window', async () => {
      const s = c.make();
      const inWindow = (at: string) => at >= c.window.start && at <= c.window.end;
      for (const x of (await s.changes?.getChanges({ window: c.window })) ?? []) {
        checkProvenance(s, x.provenance, x.ref, c.window);
        expect(inWindow(x.at)).toBe(true);
        expect(['actual', 'planned', 'reported']).toContain(x.timing);
      }
      for (const x of (await s.work_items?.getWorkItems({ window: c.window })) ?? []) {
        checkProvenance(s, x.provenance, x.ref, c.window);
        expect(inWindow(x.createdAt)).toBe(true);
      }
      for (const x of (await s.feedback?.getFeedback({ window: c.window })) ?? []) {
        checkProvenance(s, x.provenance, x.ref, c.window);
        expect(inWindow(x.createdAt)).toBe(true);
      }
    });

    it('a failing source throws — it never answers with empty data', async () => {
      if (!c.broken) return;
      for (const state of ['unavailable', 'error'] as const) {
        const s = c.broken(state);
        const calls: Promise<unknown>[] = [];
        if (s.metrics) for (const d of s.metrics.metricDefinitions()) calls.push(s.metrics.getSeries({ metric: d.key, window: c.window }));
        if (s.changes) calls.push(s.changes.getChanges({ window: c.window }));
        if (s.work_items) calls.push(s.work_items.getWorkItems({ window: c.window }));
        if (s.feedback) calls.push(s.feedback.getFeedback({ window: c.window }));
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) await expect(call).rejects.toBeInstanceOf(ProviderUnavailableError);
      }
    });
  });
}
