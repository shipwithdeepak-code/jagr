import type { ConnectionView } from '../connections/model.js';
import type { ProviderId } from '../types.js';
import { AmplitudeConfig } from '../integrations/connectors/amplitude.js';
import { SentryConfig } from '../integrations/connectors/sentry.js';

export const CHECKOUT_SOURCES: ProviderId[] = ['amplitude', 'sentry', 'github'];
export function checkoutConnections(connections: ConnectionView[]): ConnectionView[] {
  return connections.filter(c => CHECKOUT_SOURCES.includes(c.source as ProviderId) && c.provider === c.source && c.kind === 'source' && c.status === 'connected' && c.health === 'healthy');
}
export interface CheckoutMapping { conversion: string; started: string; query: string; threshold: string }
export function checkoutMapping(connection: ConnectionView): CheckoutMapping | undefined {
  if (connection.source === 'amplitude') {
    const parsed = AmplitudeConfig.safeParse(connection.config);
    if (!parsed.success) return undefined;
    const binding = parsed.data.metrics.find(m => m.kind === 'ratio' && m.area === 'checkout' && m.badDirection === 'down');
    return binding?.kind === 'ratio' ? { conversion: binding.numerator.event_type, started: binding.denominator.event_type, query: '', threshold: String(binding.threshold) } : { conversion: '', started: '', query: '', threshold: '10' };
  }
  if (connection.source === 'sentry') {
    const parsed = SentryConfig.safeParse(connection.config);
    if (!parsed.success) return undefined;
    const binding = parsed.data.metrics.find(m => m.kind === 'errors' && m.area === 'checkout');
    return { conversion: '', started: '', query: binding?.kind === 'errors' ? binding.query : 'transaction:/checkout*', threshold: String(binding?.threshold ?? 100) };
  }
  return undefined;
}
function newKey(metrics: { key: string }[], base: string): string {
  let key = base;
  for (let n = 2; metrics.some(m => m.key === key); n++) key = `${base}_${n}`;
  return key;
}
/** Retain other mappings, event filters and resource configuration. Existing connector schemas own validation. */
export function checkoutConfig(connection: ConnectionView, fields: CheckoutMapping): Record<string, unknown> {
  const threshold = Number(fields.threshold);
  if (connection.source === 'amplitude') {
    const config = AmplitudeConfig.parse(connection.config);
    if (!fields.conversion.trim() || !fields.started.trim()) throw new Error('Enter both checkout events.');
    const index = config.metrics.findIndex(m => m.kind === 'ratio' && m.area === 'checkout' && m.badDirection === 'down');
    const old = index >= 0 ? config.metrics[index] : undefined;
    const binding = old?.kind === 'ratio' ? { ...old, numerator: { ...old.numerator, event_type: fields.conversion.trim() }, denominator: { ...old.denominator, event_type: fields.started.trim() }, threshold } : { kind: 'ratio' as const, key: newKey(config.metrics, 'checkout_conversion'), name: 'Checkout conversion', area: 'checkout' as const, badDirection: 'down' as const, numerator: { event_type: fields.conversion.trim() }, denominator: { event_type: fields.started.trim() }, threshold };
    const metrics = [...config.metrics];
    if (index >= 0) metrics[index] = binding; else metrics.push(binding);
    return AmplitudeConfig.parse({ ...config, metrics });
  }
  if (connection.source === 'sentry') {
    const config = SentryConfig.parse(connection.config);
    const index = config.metrics.findIndex(m => m.kind === 'errors' && m.area === 'checkout');
    const old = index >= 0 ? config.metrics[index] : undefined;
    const binding = old?.kind === 'errors' ? { ...old, query: fields.query.trim(), threshold } : { kind: 'errors' as const, key: newKey(config.metrics, 'checkout_errors'), name: 'Checkout errors', area: 'checkout' as const, query: fields.query.trim(), measure: 'events' as const, threshold };
    const metrics = [...config.metrics];
    if (index >= 0) metrics[index] = binding; else metrics.push(binding);
    return SentryConfig.parse({ ...config, metrics });
  }
  throw new Error('Unsupported checkout mapping.');
}
export function checkoutSelectionBlocker(selected: ProviderId[], connections: ConnectionView[]): string | undefined {
  const available = checkoutConnections(connections);
  if (!selected.includes('amplitude')) return 'Select connected Amplitude to watch checkout conversion.';
  if (selected.some(source => !available.some(c => c.source === source))) return 'A selected source is unavailable. Check its connection in Sources.';
  return undefined;
}
export function checkoutBlocker(selected: ProviderId[], connections: ConnectionView[]): string | undefined {
  const available = checkoutConnections(connections);
  if (!selected.includes('amplitude')) return 'Select connected Amplitude to watch checkout conversion.';
  for (const source of selected) {
    const c = available.find(c => c.source === source);
    if (!c) return 'A selected source is unavailable. Check its connection in Sources.';
    if (source === 'github') continue;
    const fields = checkoutMapping(c);
    if (!fields) return 'The saved signal mapping is unavailable. Configure this connection in Sources.';
    try { checkoutConfig(c, fields); } catch { return 'Save a valid checkout signal mapping before creating the watch.'; }
    // A proposed default is not a persisted signal.
    const metrics = c.config.metrics as { kind: string; area?: string; badDirection?: string }[];
    if (!metrics.some(m => m.area === 'checkout' && (source === 'sentry' ? m.kind === 'errors' : m.kind === 'ratio' && m.badDirection === 'down'))) return 'Save a checkout signal mapping before creating the watch.';
  }
  return undefined;
}
