import { describe, expect, it } from 'vitest';
import type { MetricDefinition, SeriesPoint } from '@/domain/types';
import { addMinutes } from '@/lib/time';
import { METRIC_CATALOG, metricDefinition } from '@/simulation/catalog';
import { classifySeverity, clusterAnomalies, evaluateSignal } from './detection';

const START = '2026-09-23T18:00:00.000Z';
const def: MetricDefinition = { id: 'conv', name: 'Conversion', description: '', category: 'conversion', unit: 'percent', badDirection: 'down', tier: 1, area: 'growth' };
const baseline = { mean: 10, stdDev: 0.1, window: 'test', samples: 28 };
const series = (values: number[]): SeriesPoint[] => values.map((value, i) => ({ t: addMinutes(START, i * 30), value }));

describe('anomaly detection', () => {
  it('flags a persistent drop past threshold and z-score as anomalous', () => {
    const s = evaluateSignal(def, series([10, 10, 8.8, 8.8, 8.8]), baseline, 5, START, true);
    expect(s.status).toBe('anomalous');
    expect(s.changePct).toBeCloseTo(-12);
    expect(s.severity).toBe('critical');
    expect(s.onsetAt).toBe(addMinutes(START, 60));
  });

  it('only watches a single bad bucket (persistence rule)', () => {
    const s = evaluateSignal(def, series([10, 10, 10, 10, 8.5]), baseline, 5, START, true);
    expect(s.status).toBe('watching');
    expect(s.severity).toBe('normal');
  });

  it('ignores moves in the good direction', () => {
    const s = evaluateSignal(def, series([10, 11.5, 11.5, 11.5]), baseline, 5, START, true);
    expect(s.status).toBe('normal');
  });

  it('does not alert on moves inside normal variance (z < 3)', () => {
    const noisy = { ...baseline, stdDev: 1 };
    const s = evaluateSignal(def, series([10, 9.4, 9.4, 9.4]), noisy, 5, START, true);
    expect(s.status).toBe('normal');
  });

  it('classifies severity from tier and threshold ratio', () => {
    expect(classifySeverity(1, 11.8, 5)).toBe('critical');
    expect(classifySeverity(2, 6.4, 4)).toBe('high');
    expect(classifySeverity(3, 9.2, 8)).toBe('medium');
    expect(classifySeverity(3, 4, 8)).toBe('normal');
  });
});

describe('prioritisation', () => {
  it('groups related anomalies under the outcome metric at the top of the metric tree', () => {
    const defs = METRIC_CATALOG.map(metricDefinition);
    const mk = (id: string, change: number, onset: string) => {
      const d = defs.find((x) => x.id === id)!;
      return { ...evaluateSignal(d, series([1, 1, 1]), { mean: 1, stdDev: 0.01, window: '', samples: 28 }, 5, START, true), changePct: change, severity: 'critical' as const, status: 'anomalous' as const, onsetAt: onset };
    };
    const clusters = clusterAnomalies(
      [mk('payment_failure_rate', 300, START), mk('checkout_conversion', -14, START), mk('subscription_conversion', -11.8, START), mk('feature_export', -9, addMinutes(START, 360))],
      defs,
    );
    expect(clusters).toHaveLength(2);
    expect(clusters[0].primary.metricId).toBe('subscription_conversion');
    expect(clusters[0].members.map((m) => m.metricId)).toEqual(['subscription_conversion', 'checkout_conversion', 'payment_failure_rate']);
  });
});
