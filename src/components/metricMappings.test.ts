import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AmplitudeConfig } from '@/product/integrations/connectors/amplitude';
import { SentryConfig } from '@/product/integrations/connectors/sentry';
import { initialMetricMappings, MetricMappings } from './metricMappings';

describe('PM metric setup', () => {
  it('requires actual Amplitude event names and describes ratios without claiming ordered funnels', () => {
    const metrics = initialMetricMappings('amplitude', {}, false);
    expect(AmplitudeConfig.safeParse({ region: 'us', metrics }).success).toBe(false);
    const configured = [{ ...metrics[0], numerator: { event_type: 'Order Completed' }, denominator: { event_type: 'Checkout Started' } }];
    expect(AmplitudeConfig.safeParse({ region: 'us', metrics: configured }).success).toBe(true);
    const html = renderToStaticMarkup(createElement(MetricMappings, { provider: 'amplitude', value: configured, onChange: vi.fn() }));
    expect(html).toContain('Successful event name');
    expect(html).toContain('Started event name');
    expect(html).toContain('not an ordered funnel');
    expect(html).not.toContain('JSON');
  });
  it('exposes Sentry query and threshold using the existing schema', () => {
    const metrics = initialMetricMappings('sentry', {}, false);
    expect(SentryConfig.safeParse({ organization: 'acme', projects: [42], metrics }).success).toBe(true);
    const html = renderToStaticMarkup(createElement(MetricMappings, { provider: 'sentry', value: metrics, onChange: vi.fn() }));
    expect(html).toContain('Sentry search query (empty means all errors)');
    expect(html).toContain('Change threshold (%)');
  });
  it('keeps existing mappings, event filters, platform and multiple metrics intact', () => {
    const metrics = [{ kind: 'count', key: 'orders', name: 'Orders', platform: 'ios', event: { event_type: 'Order', filters: [{ subprop_key: 'payment', subprop_value: ['Klarna'] }] } }, { kind: 'ratio', key: 'signup_conversion' }];
    expect(initialMetricMappings('amplitude', { metrics }, true)).toEqual(metrics);
    const html = renderToStaticMarkup(createElement(MetricMappings, { provider: 'amplitude', value: metrics, onChange: vi.fn() }));
    expect(html).toContain('Existing event filters are retained');
    expect(html).toContain('Signal 2');
  });
});
