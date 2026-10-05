import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { expect, it } from 'vitest';
import fixture from '@/product/export/__fixtures__/export-v1.sample.json';
import type { WatchInvestigation } from '@/product/types';
import { ProductContext, type ProductApi } from '@/state/productContext';
import { WorkspaceContext, type WorkspaceApi } from '@/state/workspace';
import { initialDemoState } from '@/state/store';
import { WatchInvestigationPage } from './WatchInvestigation';

it('shows evidence and feedback without simulated execution controls in a real workspace', () => {
  const inv = fixture.investigations[0] as unknown as WatchInvestigation;
  const api = { location: 'server', server: { workspaceId: 'customer' }, running: false,
    state: { watches: fixture.watches, connections: [], decisions: {}, result: { investigations: [inv], emails: [] } },
  } as unknown as ProductApi;
  const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [`/investigations/${inv.id}`] },
    createElement(ProductContext.Provider, { value: api },
      createElement(WorkspaceContext.Provider, { value: { state: initialDemoState() } as WorkspaceApi },
        createElement(Routes, null, createElement(Route, { path: '/investigations/:id', element: createElement(WatchInvestigationPage) }))))));
  for (const text of ['What is not known', 'What to do', 'Recommendations only.', 'Was this useful?', 'Save feedback']) expect(html).toContain(text);
  for (const text of ['Do it', 'Already completed', 'Review approval', 'view in Tasks', 'Approve &amp; execute']) expect(html).not.toContain(text);
  expect(html).toContain('Jagr does not create external tasks');
  expect(html).toContain(inv.recommendedNextStep.replaceAll('&', '&amp;'));
});
