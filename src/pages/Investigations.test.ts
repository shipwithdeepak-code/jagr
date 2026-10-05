import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { MetricEvaluationSummary, ProviderId, SchedulerLogEntry } from '@/product/types';
import { ProductContext, type ProductApi } from '@/state/productContext';
import { InvestigationsPage } from './Investigations';

function render(log: SchedulerLogEntry[], search = '') {
  const api = { location: 'server', mode: 'connected', running: false,
    state: { watches: [{ id: 'watch' }], result: { investigations: [], log } },
  } as unknown as ProductApi;
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/investigations' + search] },
    createElement(ProductContext.Provider, { value: api }, createElement(InvestigationsPage))));
}
function entry(classification: 'no_meaningful_change' | 'inconclusive', failures: ProviderId[] = [], at = '2026-10-05T13:05:00Z'): SchedulerLogEntry {
  return { jobId: at, outcome: '', investigationIds: [], emailIds: [], type: 'watch_run', watchId: 'watch', scheduledAt: at,
    check: { findings: false, classification, coverage: classification === 'inconclusive' ? 'incomplete' : 'complete', sourceFailures: failures, metrics: [] },
  };
}
describe('investigation empty state uses persisted monitoring evidence', () => {
  it('reports normal only when the latest check has complete evidence', () => {
    const html = render([entry('no_meaningful_change')]);
    expect(html).toContain('No investigations yet');
    expect(html).toContain('find an issue in the latest monitoring checks');
  });
  it('recognizes sufficient metric evidence when overall freshness coverage is unknown', () => {
    const run = entry('no_meaningful_change');
    run.check!.coverage = 'unknown';
    run.check!.metrics = [{ coverage: 'complete', finalDecision: 'normal' } as MetricEvaluationSummary];
    expect(render([run])).toContain('find an issue in the latest monitoring checks');
  });
  it('reports inconclusive and a useful next step rather than a negative finding', () => {
    const html = render([entry('inconclusive')]);
    expect(html).toContain('Monitoring was inconclusive');
    expect(html).toContain('Check the source data or run again when enough data is available.');
    expect(html).not.toContain('found no meaningful change');
  });
  it('reports source failure separately even when there are no investigations', () => {
    const html = render([entry('inconclusive', ['amplitude'])]);
    expect(html).toContain('Monitoring couldn');
    expect(html).toContain('read every required source');
    expect(html).not.toContain('find an issue in the latest monitoring checks');
  });
  it('uses the latest check, not an older normal result or array order', () => {
    expect(render([entry('inconclusive'), entry('no_meaningful_change', [], '2026-10-05T09:00:00Z')])).toContain('Monitoring was inconclusive');
  });
  it('does not infer normal from historical records without diagnostics', () => {
    const old = entry('no_meaningful_change'); delete old.check;
    const html = render([old]);
    expect(html).toContain('does not establish');
    expect(html).not.toContain('find an issue in the latest monitoring checks');
  });
  it('keeps the closed filter distinct from a monitoring verdict', () => {
    expect(render([entry('inconclusive')], '?status=closed')).toContain('Nothing closed yet');
  });
});
