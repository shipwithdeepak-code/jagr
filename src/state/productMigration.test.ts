import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrateStoredProductState } from './productMigration';
import { defaultBriefSchedule, defaultWatches, signalMeta, watchFromTemplate } from '@/product/catalog';
import { defaultConnections } from '@/product/integrations/adapters';
import { defaultWorld } from '@/product/integrations/world';
import { runMonitoring } from '@/product/engine/monitor';
import { effectiveActions, pendingApprovals } from '@/product/agent/decisions';
import { TOOL_NAMES } from '@/product/agent/tools';
import { RISK_OF } from '@/product/agent/actions';

/**
 * A real workspace saved by the pre-refactor build (product state v2, generated from commit 5501a8d):
 * the Sample workspace's default watches, one custom watch with thresholds, a full monitoring run,
 * and two human decisions (a MEDIUM action marked done, a HIGH action approved with an option).
 */
const v2 = JSON.parse(readFileSync('src/product/migrations/__fixtures__/product-state-v2.json', 'utf8'));

describe('stored workspace migration v2 → v3', () => {
  const s = migrateStoredProductState(v2)!;

  it('upgrades the version and keeps workspace settings', () => {
    expect(s.version).toBe(3);
    expect(s.workspace).toEqual(v2.workspace);
    expect(s.planner).toBe('deterministic');
    expect(s.clock).toBe(v2.clock);
  });

  it('watches become role-based — identical to the same watches created today', () => {
    const today = [...defaultWatches(), watchFromTemplate('w-custom', 'app_stability', { thresholds: { crash_free_sessions_ios: 0.5, checkout_conversion: 7 } })];
    expect(s.watches).toEqual(today);
  });

  it('no vendor-named signal, tool or action survives', () => {
    // Record references keep the source's own ids (e.g. "ga4.checkout_conversion") — that is provenance.
    // Names the engine reasons with must be role-based.
    const names = [
      ...s.watches.flatMap((w) => [...w.signals.map((x) => x.key), ...Object.keys(w.thresholds ?? {})]),
      ...s.result!.investigations.flatMap((i) => i.signals.map((x) => x.key)),
      ...s.result!.actions.flatMap((a) => [a.kind, a.id]),
      ...Object.keys(s.decisions),
    ];
    expect(names.join(' ')).not.toMatch(/ga4\.|app_store\.|google_play\.|jira\.issues|create_jira|link_issues|\breleases\b/);
    for (const i of s.result!.investigations) {
      for (const sig of i.signals) expect(signalMeta(sig.key).kind).toBeDefined();
      for (const step of i.trace) if (step.tool) expect(TOOL_NAMES).toContain(step.tool);
      for (const a of i.actions) expect(Object.keys(RISK_OF)).toContain(a.kind);
    }
  });

  it('every decision stays attached to its action', () => {
    const inv = s.result!.investigations.find((i) => i.area === 'checkout')!;
    const acts = effectiveActions(inv, s.decisions);
    expect(acts.find((a) => a.kind === 'create_incident')?.effective).toBe('done');
    expect(acts.find((a) => a.kind === 'pause_rollout')?.effective).toBe('approved');
    expect(Object.keys(s.decisions).every((id) => s.result!.actions.some((a) => a.id === id))).toBe(true);
    expect(pendingApprovals(s.result!.investigations, s.decisions).some((a) => a.kind === 'pause_rollout')).toBe(false);
  });

  it('decisions survive a fresh run of the role-based engine (action ids are stable)', async () => {
    const r = await runMonitoring({ world: defaultWorld(), watches: s.watches, connections: defaultConnections(), brief: defaultBriefSchedule() });
    for (const id of Object.keys(s.decisions)) expect(r.actions.map((a) => a.id)).toContain(id);
  });

  it('current workspaces pass through; unrecognisable data is refused, not half-loaded', () => {
    expect(migrateStoredProductState(s)).toEqual(s);
    expect(migrateStoredProductState({ version: 1, watches: [] })).toBeUndefined();
    expect(migrateStoredProductState({ version: 2 })).toBeUndefined();
    expect(migrateStoredProductState('nonsense')).toBeUndefined();
    expect(migrateStoredProductState(null)).toBeUndefined();
  });
});
