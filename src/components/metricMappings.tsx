import { Button } from './ui';

/** Presentation of existing connector bindings; server schemas remain the authority. */
export type MetricMapping = Record<string, unknown>;
export function initialMetricMappings(provider: string, config: Record<string, unknown>, existing: boolean): MetricMapping[] {
  if (existing && Array.isArray(config.metrics)) return config.metrics as MetricMapping[];
  return [provider === 'amplitude'
    ? { kind: 'ratio', key: 'checkout_conversion', name: 'Checkout conversion', area: 'checkout', badDirection: 'down', threshold: 10, numerator: { event_type: '' }, denominator: { event_type: '' } }
    : { kind: 'errors', key: 'payment_errors', name: 'Payment errors', area: 'checkout', query: '', measure: 'events', threshold: 10 }];
}

export function MetricMappings({ provider, value, onChange }: { provider: string; value: MetricMapping[]; onChange(value: MetricMapping[]): void }) {
  const amplitude = provider === 'amplitude';
  const update = (index: number, key: string, next: unknown) => onChange(value.map((m, i) => i === index ? { ...m, [key]: next } : m));
  const input = 'mt-1 w-full rounded border border-line bg-surface p-2 text-[13px]';
  return <section className="mt-4 space-y-4" aria-label="Metrics to investigate">
    <h3 className="font-semibold">What should Jagr investigate?</h3>
    <p className="text-[13px] text-ink-2">Define your actual product signals. Thresholds identify changes to investigate; statistical and persistence gates also apply.</p>
    {value.map((metric, index) => {
      const text = (key: string, label: string, numeric = false) => <label className="block text-[13px]">{label}<input className={input} type={numeric ? 'number' : 'text'} step={numeric ? 'any' : undefined} value={String(metric[key] ?? '')} onChange={(e) => update(index, key, numeric ? Number(e.target.value) : e.target.value)} /></label>;
      const select = (key: string, label: string, options: string[]) => <label className="block text-[13px]">{label}<select className={input} value={String(metric[key] ?? options[0])} onChange={(e) => update(index, key, e.target.value)}>{options.map((option) => <option key={option} value={option}>{option.replaceAll('_', ' ')}</option>)}</select></label>;
      const event = (key: string, label: string) => {
        const spec = (metric[key] ?? {}) as Record<string, unknown>;
        return <label className="block text-[13px]">{label}<input className={input} value={String(spec.event_type ?? '')} onChange={(e) => update(index, key, { ...spec, event_type: e.target.value })} />{Array.isArray(spec.filters) && spec.filters.length > 0 && <span className="text-ink-3">Existing event filters are retained.</span>}</label>;
      };
      return <fieldset key={index} className="space-y-3 rounded-lg border border-line p-3">
        <legend className="px-1 text-[13px] font-medium">Signal {index + 1}</legend>
        {text('name', 'Metric name')}{text('key', 'Metric identifier (lowercase, underscores)')}
        <label className="block text-[13px]">Metric type<select className={input} value={String(metric.kind)} onChange={(e) => {
          const kind = e.target.value;
          const shared = { key: metric.key, name: metric.name, threshold: metric.threshold, ...(metric.platform ? { platform: metric.platform } : {}) };
          const next = amplitude ? { ...shared, kind, area: metric.area ?? 'general', badDirection: metric.badDirection ?? 'down', ...(kind === 'ratio' ? { numerator: { event_type: '' }, denominator: { event_type: '' } } : { event: { event_type: '' }, measure: 'totals' }) }
            : { ...shared, kind, ...(kind === 'errors' ? { area: metric.area ?? 'general', query: '', measure: 'events' } : { of: 'session' }) };
          onChange(value.map((m, i) => i === index ? next : m));
        }}>{(amplitude ? ['ratio', 'count'] : ['errors', 'crash_free']).map((kind) => <option key={kind} value={kind}>{kind === 'ratio' ? 'Conversion ratio (unique users)' : kind.replaceAll('_', ' ')}</option>)}</select></label>
        {(amplitude || metric.kind === 'errors') && select('area', 'Product area', ['checkout', 'signup', 'search', 'stability', 'general'])}
        {amplitude ? <>{select('badDirection', 'Investigate when the metric moves', ['down', 'up'])}{metric.kind === 'ratio' ? <>{event('numerator', 'Successful event name')}{event('denominator', 'Started event name')}<p className="text-[12px] text-ink-3">Unique users completing the successful event divided by unique users starting. This is a ratio, not an ordered funnel.</p></> : <>{event('event', 'Event name')}{select('measure', 'Count', ['totals', 'uniques'])}</>}</>
          : metric.kind === 'errors' ? <>{text('query', 'Sentry search query (empty means all errors)')}{select('measure', 'Measure', ['events', 'users'])}</> : select('of', 'Crash-free rate', ['session', 'user'])}
        {text('threshold', metric.kind === 'crash_free' ? 'Decline threshold (percentage points)' : 'Change threshold (%)', true)}
        {value.length > 1 && <Button size="sm" onClick={() => onChange(value.filter((_, i) => i !== index))}>Remove signal {index + 1}</Button>}
      </fieldset>;
    })}
    <Button size="sm" disabled={value.length >= (amplitude ? 25 : 15)} onClick={() => onChange([...value, { ...initialMetricMappings(provider, {}, false)[0], key: '', name: '' }])}>Add metric</Button>
  </section>;
}
