import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CheckoutMappingFields, CheckoutMappingEditor } from './checkoutMapping';
import type { ConnectionView } from '@/product/connections/model';
describe('checkout mapping controls', () => {
  it('renders normal event, filter and threshold inputs with no JSON editor', () => {
    for (const source of ['amplitude', 'sentry']) {
      const html = renderToStaticMarkup(createElement(CheckoutMappingFields, { source, fields: { conversion: 'Buy', started: 'Checkout', query: 'level:error', threshold: '10' }, onChange: () => {} }));
      expect(html).not.toMatch(/textarea|JSON/); expect(html).toContain('baseline (%');
      expect(html).toContain(source === 'amplitude' ? 'What counts as conversion?' : 'Checkout error filter');
    }
  });
  it('keeps environment/member mappings read-only and explains shared scope', () => {
    const connection = { id: 'c', source: 'sentry', provider: 'sentry', managedBy: 'environment', config: { organization: 'acme', projects: [1], metrics: [{ kind: 'errors', key: 'errors', name: 'Errors', area: 'checkout', threshold: 100 }] } } as unknown as ConnectionView;
    const html = renderToStaticMarkup(createElement(CheckoutMappingEditor, { connection, workspaceId: 'w', canManage: false, refresh: async () => {}, onPending: () => {} }));
    expect(html).toContain('disabled'); expect(html).toContain('shared by all workspace watches'); expect(html).not.toContain('Save source mapping');
  });
});
