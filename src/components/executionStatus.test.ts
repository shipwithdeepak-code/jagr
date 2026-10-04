import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProductContext, type ProductApi } from '@/state/productContext';
import { ManualCheckStatus } from './executionStatus';
import { executionStatus, type ExecutionResult } from '@/product/app/executionStatus';
import type { JobStatus } from '@/product/ports/jobs';

const NOW = '2026-09-25T10:00:00.000Z';
const identity = { workspaceId: 'w', watchId: 'watch', executionKey: 'key', requestedAt: NOW };
function render(job: JobStatus, result: ExecutionResult | null = null, error = false) {
  const status = executionStatus(identity, job, result, NOW);
  const value = { state: { watches: [{ id: 'watch', name: 'Checkout' }] }, server: { executionStatuses: { key: status }, executionStatusError: error, refresh: async () => undefined } } as unknown as ProductApi;
  return renderToStaticMarkup(createElement(ProductContext.Provider, { value }, createElement(MemoryRouter, null, createElement(ManualCheckStatus))));
}
const job: JobStatus = { state: 'queued', attempts: 0, createdAt: NOW, runAt: NOW };
describe('requested-check UI', () => {
  it.each(['queued', 'leased'] as const)('does not render completion, healthy, or external execution for %s', (state) => {
    const html = render({ ...job, state, leaseUntil: '2026-09-25T10:01:00.000Z' });
    expect(html).toContain(state === 'queued' ? 'Queued' : 'Checking');
    expect(html).not.toMatch(/Completed|Healthy|Change detected|No meaningful change|externally executed/);
  });
  it('shows a correlated investigation link only after settlement', () => {
    const result: ExecutionResult = { disposition: 'checked', classification: 'findings', coverage: 'incomplete', investigationIds: ['inv'], truncated: false };
    expect(render({ ...job, state: 'leased' }, result)).not.toContain('Open investigation');
    const html = render({ ...job, state: 'done' }, result);
    expect(html).toContain('Change detected');
    expect(html).toContain('coverage incomplete or unknown');
    expect(html).toContain('/investigations/w/inv');
    expect(html).not.toMatch(/caused|externally executed|Healthy/);
  });
  it('distinguishes quiet, gaps, unavailable, blocked, skipped and failure', () => {
    const checked: ExecutionResult = { disposition: 'checked', classification: 'no_meaningful_change', coverage: 'complete', investigationIds: [], truncated: false };
    expect(render({ ...job, state: 'done' }, checked)).toContain('No meaningful change');
    expect(render({ ...job, state: 'done' }, { ...checked, classification: 'inconclusive', coverage: 'unknown' })).toContain('evidence incomplete or unknown');
    expect(render({ ...job, state: 'done' })).toContain('check result unavailable');
    expect(render({ ...job, state: 'done' }, { disposition: 'blocked', reason: 'check_not_permitted' })).toContain('admission or entitlement');
    expect(render({ ...job, state: 'done' }, { disposition: 'skipped', reason: 'watch_inactive_or_missing' })).toContain('Check skipped');
    expect(render({ ...job, state: 'dead' })).toContain('Check failed');
  });
  it('qualifies retries, lease recovery, and unavailable status reads', () => {
    expect(render({ ...job, lastFailedAt: NOW })).toContain('retry scheduled');
    expect(render({ ...job, state: 'leased', leaseUntil: NOW })).toContain('awaiting worker recovery');
    expect(render(job, null, true)).toContain('Status unavailable');
    expect(render(job, null, true)).not.toContain('Check failed');
  });
});
