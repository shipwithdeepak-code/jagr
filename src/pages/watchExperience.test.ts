import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { ProductContext, type ProductApi } from '@/state/productContext';
import { watchFromTemplate, defaultBriefSchedule } from '@/product/catalog';
import { executionStatus } from '@/product/app/executionStatus';
import { ConnectedWorkspaceQuickStart } from '@/components/onboarding';
import { WatchesPage } from './Watches';
import type { SchedulerLogEntry } from '@/product/types';

const at = '2026-10-05T10:00:00Z';
function product() {
  const watch = watchFromTemplate('watch', 'checkout_health', { sources: ['amplitude'], metricKeys: ['checkout_conversion'] }, at);
  const api = { location: 'server', mode: 'connected', running: false,
    state: { version: 3, watches: [watch], connections: [], clock: at, stale: false, decisions: {}, brief: defaultBriefSchedule() },
    server: { workspaceId: 'ws', snapshotAt: at, connections: [{ source: 'amplitude', kind: 'source', roles: ['metrics'], health: 'healthy' }], loading: false },
  } as unknown as ProductApi;
  return api;
}
function render(api: ProductApi, Component: ComponentType = WatchesPage) {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ProductContext.Provider, { value: api }, createElement(Component))));
}
it('presents automatic delegation separately from a requested queued check', () => {
  const api = product();
  api.server!.executionStatuses = { key: executionStatus({ workspaceId: 'ws', watchId: 'watch', executionKey: 'key', requestedAt: at }, { state: 'queued', attempts: 0, createdAt: at, runAt: at }, null, at) };
  const html = render(api);
  expect(html).toContain('Watching · awaiting first check');
  expect(html).toContain('Queued — waiting to check');
  expect(html).toContain('Results update automatically');
  expect(html).toContain('Next scheduled check');
  expect(html).not.toContain('Healthy');
  expect(html).not.toContain('No important change detected');
});
it('does not require Run Now to complete connected onboarding', () => {
  const html = render(product(), ConnectedWorkspaceQuickStart);
  expect(html).toContain('Jagr checks automatically');
  expect(html).toContain('Check now is optional');
  expect(html).toContain('See what Jagr is watching');
  expect(html).not.toContain('Run the first check');
  expect(html).not.toContain('Run monitoring');
});
it('shows persisted source failure as a gap and warns about stale checks', () => {
  const api = product();
  api.server!.snapshotAt = '2026-10-06T10:00:00Z';
  api.state.result = { log: [{ watchId: 'watch', scheduledAt: at, outcome: 'inconclusive', check: { findings: false, classification: 'inconclusive', coverage: 'incomplete', sourceFailures: ['amplitude'], metrics: [] }, investigationIds: [], emailIds: [] } as unknown as SchedulerLogEntry], investigations: [] } as unknown as NonNullable<ProductApi['state']['result']>;
  const html = render(api);
  expect(html).toContain('Source unavailable');
  expect(html).toContain('automatic checks may be delayed');
  expect(html).not.toContain('No important change detected');
});
it('never promises automatic live monitoring for an imported workspace', () => {
  const api = product();
  api.mode = 'imported';
  const html = render(api);
  expect(html).toContain('Check your sample or imported evidence on demand');
  expect(html).not.toContain('Watching · awaiting first check');
});
