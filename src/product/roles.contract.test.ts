import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SourceConnection } from './types';
import { createRegistry, defaultConnections } from './integrations/adapters';
import { defaultWorld, WORLD_START } from './integrations/world';
import { buildImportedWorld } from './imports/world';
import { importFile } from './imports/schemas';
import type { SourceId } from './roles/types';
import { roleSourceContract } from './testkit/roleContract';

const window = { start: WORLD_START, end: '2026-09-24T08:00:00.000Z' };
const sample = (id: SourceId, conns = defaultConnections()) => createRegistry(defaultWorld(), conns).registry.get(id)!;
const down = (id: SourceId, state: 'unavailable' | 'error') => defaultConnections().map((c): SourceConnection => (c.provider === id ? { ...c, state, detail: 'simulated outage' } : c));

for (const id of ['jira', 'ga4', 'app_store', 'google_play'] as const) {
  roleSourceContract({ name: `Sample workspace · ${id}`, make: () => sample(id), window, broken: (state) => sample(id, down(id, state)) });
}

const csv = (f: string) => readFileSync(`public/samples/${f}`, 'utf8');
const imported = () => {
  const at = '2026-09-25T09:00:00.000Z';
  const ds = [importFile('metrics', 'metrics.csv', csv('metrics.csv'), at), importFile('issues', 'issues.csv', csv('issues.csv'), at), importFile('releases', 'releases.csv', csv('releases.csv'), at), importFile('feedback', 'reviews.csv', csv('reviews.csv'), at)];
  const w = buildImportedWorld(ds, at);
  return createRegistry(w.world!, w.connections).registry;
};
for (const id of ['ga4', 'jira', 'app_store'] as const) {
  roleSourceContract({ name: `My data (imported) · ${id}`, make: () => imported().get(id)!, window: { start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' } });
}

describe('source registry', () => {
  const reg = createRegistry(defaultWorld(), defaultConnections()).registry;

  it('resolves roles, not vendors: each role maps to the sources that implement it, in registry order', () => {
    expect(reg.withRole('changes').map((s) => s.id)).toEqual(['jira', 'app_store', 'google_play']);
    expect(reg.withRole('work_items').map((s) => s.id)).toEqual(['jira']);
    expect(reg.withRole('feedback').map((s) => s.id)).toEqual(['app_store', 'google_play']);
    expect(reg.withRole('conversations')).toEqual([]);
    expect(reg.withRole('context')).toEqual([]);
  });

  it('finds the source for a metric, within a watch', () => {
    expect(reg.metricSource('checkout_conversion')?.source).toBe('ga4');
    expect(reg.metricSource('crash_free_sessions_android')?.source).toBe('google_play');
    expect(reg.metricSource('checkout_conversion', ['jira'])).toBeUndefined();
  });

  it('imported records are labelled as imports in their provenance', async () => {
    const s = imported().get('jira')!;
    const [item] = await s.work_items!.getWorkItems({ window: { start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' } });
    expect(item.provenance).toMatchObject({ mode: 'imported', provider: 'import' });
  });
});
