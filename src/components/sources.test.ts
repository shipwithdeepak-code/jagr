import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SourceView } from '@/product/view/sources';
import { ProviderLogo } from './product';
import { SourceCard } from './sources';

const sentry: SourceView = {
  id: 'sentry',
  name: 'Sentry',
  short: 'Sentry',
  group: 'connected',
  state: 'connected',
  roles: ['metrics', 'changes', 'work_items'],
  detail: 'Credential verified',
  health: 'healthy',
  healthDetail: 'Credential verified',
  impact: 'Available to investigations.',
  actions: [],
};

describe('source identity', () => {
  it('uses localized brand geometry for every authoritative source except the declared Amplitude fallback', () => {
    for (const provider of ['jira', 'ga4', 'app_store', 'google_play', 'github', 'intercom', 'sentry', 'slack']) {
      expect(renderToStaticMarkup(createElement(ProviderLogo, { provider }))).toContain(`data-source-logo="${provider}"`);
    }
  });

  it('pairs the decorative vendor mark with authoritative capability and health text', () => {
    const html = renderToStaticMarkup(createElement('ul', undefined, createElement(SourceCard, { view: sentry })));
    expect(html).toContain('data-source-logo="sentry"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('Sentry');
    expect(html).toContain('Metrics');
    expect(html).toContain('Changes');
    expect(html).toContain('Work items');
    expect(html).toContain('Healthy — credential verified');
  });

  it('uses the restrained existing icon fallback when no local vendor mark is available', () => {
    const html = renderToStaticMarkup(createElement(ProviderLogo, { provider: 'amplitude' }));
    expect(html).toContain('<svg');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('data-source-logo');
  });

  it('retains natural multicolor treatment for logos that depend on it for recognition', () => {
    const slack = renderToStaticMarkup(createElement(ProviderLogo, { provider: 'slack' }));
    expect(slack).toContain('#E01E5A');
    expect(slack).toContain('#36C5F0');
    expect(slack).toContain('#2EB67D');
    expect(slack).toContain('#ECB22E');

    const play = renderToStaticMarkup(createElement(ProviderLogo, { provider: 'google_play' }));
    expect(play).toContain('#FFCC00');
    expect(play).toContain('#00A173');
    expect(play).toContain('#00A6ED');
    expect(play).toContain('#F34A46');
  });
});
