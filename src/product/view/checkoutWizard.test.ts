import { describe, expect, it } from 'vitest';
import type { ConnectionView } from '../connections/model';
import { checkoutBlocker, checkoutConfig, checkoutConnections, checkoutMapping } from './checkoutWizard';
import { AmplitudeConfig } from '../integrations/connectors/amplitude';
import { SentryConfig } from '../integrations/connectors/sentry';
const amplitude = { metrics: [{ kind: 'ratio', key: 'my_conversion', name: 'Conversion', area: 'checkout', badDirection: 'down', threshold: 10, numerator: { event_type: 'Bought', filters: [{ subprop_type: 'event', subprop_key: 'country', subprop_op: 'is', subprop_value: ['US'] }] }, denominator: { event_type: 'Started' } }] };
const sentry = { organization: 'acme', projects: [123], metrics: [{ kind: 'errors', key: 'my_errors', name: 'Errors', area: 'checkout', threshold: 100, query: 'transaction:/checkout*' }] };
export const connection = (source: string, config: Record<string, unknown> = source === 'amplitude' ? amplitude : source === 'sentry' ? sentry : {}) => ({ id: `stable-${source}`, provider: source, source, displayName: 'same display name', kind: 'source', status: 'connected', health: 'healthy', config, managedBy: 'workspace' } as ConnectionView);
describe('connected checkout wizard', () => {
  it('offers all three verified sources by stable identity, never disconnected or unhealthy sources', () => {
    const list = ['amplitude', 'sentry', 'github'].map(s => connection(s));
    expect(checkoutConnections(list).map(c => c.id)).toEqual(['stable-amplitude', 'stable-sentry', 'stable-github']);
    for (const health of ['unverified', 'stale', 'degraded', 'needs_reconnect', 'error', 'not_configured'] as const) expect(checkoutConnections([{ ...list[0], health }])).toEqual([]);
    expect(checkoutConnections([{ ...list[0], status: 'not_configured' }])).toEqual([]);
    expect(checkoutConnections([{ ...list[0], provider: 'github' }])).toEqual([]);
  });
  it('requires Amplitude and persisted mappings, rejects missing and unavailable selected sources', () => {
    const list = ['amplitude', 'sentry', 'github'].map(s => connection(s));
    expect(checkoutBlocker(['amplitude', 'sentry', 'github'], list)).toBeUndefined();
    expect(checkoutBlocker(['sentry'], list)).toMatch(/Amplitude/);
    expect(checkoutBlocker(['amplitude', 'github'], [list[0]])).toMatch(/unavailable/);
    expect(checkoutBlocker(['amplitude'], [connection('amplitude', { metrics: [{ kind: 'count', key: 'other_metric', name: 'Other', area: 'general', badDirection: 'up', threshold: 10, event: { event_type: 'Event' } }] })])).toMatch(/Save/);
    expect(checkoutBlocker(['amplitude'], [connection('amplitude', {})])).toMatch(/unavailable/);
  });
  it('maps normal fields to connector schemas while preserving keys, filters and other metrics', () => {
    const c = connection('amplitude'); const fields = checkoutMapping(c)!;
    const output = AmplitudeConfig.parse(checkoutConfig(c, { ...fields, conversion: 'OrderCompleted', threshold: '12' }));
    expect(output.metrics[0]).toMatchObject({ key: 'my_conversion', numerator: { event_type: 'OrderCompleted', filters: amplitude.metrics[0].numerator.filters }, denominator: { event_type: 'Started' }, threshold: 12 });
    const errors = SentryConfig.parse(checkoutConfig(connection('sentry'), { ...checkoutMapping(connection('sentry'))!, query: 'level:error', threshold: '250' }));
    expect(errors.metrics[0]).toMatchObject({ key: 'my_errors', query: 'level:error', threshold: 250 });
    expect(errors.projects).toEqual([123]);
  });
  it('adds only the missing checkout mapping without overwriting a colliding stable key', () => {
    const c = connection('sentry', { ...sentry, metrics: [{ ...sentry.metrics[0], area: 'general', key: 'checkout_errors' }] });
    const result = SentryConfig.parse(checkoutConfig(c, checkoutMapping(c)!));
    expect(result.metrics).toHaveLength(2); expect(result.metrics[0]).toMatchObject({ area: 'general', key: 'checkout_errors' }); expect(result.metrics[1].key).toBe('checkout_errors_2');
  });
  it.each(['0', '-1', '101', 'Infinity', 'NaN'])('rejects invalid conversion threshold %s', threshold => {
    const c = connection('amplitude'); expect(() => checkoutConfig(c, { ...checkoutMapping(c)!, threshold })).toThrow();
  });
  it('rejects empty events, overlong error filters, unsupported config, and metric capacity overflow', () => {
    const c = connection('amplitude'); expect(() => checkoutConfig(c, { ...checkoutMapping(c)!, conversion: ' ' })).toThrow();
    const e = connection('sentry'); expect(() => checkoutConfig(e, { ...checkoutMapping(e)!, query: 'x'.repeat(201) })).toThrow();
    expect(() => checkoutConfig(connection('github'), checkoutMapping(c)!)).toThrow();
    const full = connection('sentry', { ...sentry, metrics: Array.from({ length: 15 }, (_, i) => ({ ...sentry.metrics[0], key: `metric_${i}`, area: 'general' })) }); expect(() => checkoutConfig(full, checkoutMapping(full)!)).toThrow();
  });
});
