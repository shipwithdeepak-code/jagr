import type { MetricUnit } from '@/domain/types';

export function fmtMetric(value: number, unit: MetricUnit): string {
  switch (unit) {
    case 'percent':
      return `${value < 1 ? value.toFixed(2) : value.toFixed(1)}%`;
    case 'currency':
      return `$${value >= 1000 ? Math.round(value).toLocaleString('en-US') : value.toFixed(2)}`;
    case 'ms':
      return `${Math.round(value).toLocaleString('en-US')} ms`;
    case 'minutes':
      return `${value.toFixed(1)} min`;
    case 'score':
      return value.toFixed(2);
    case 'count':
    default:
      return Math.round(value).toLocaleString('en-US');
  }
}

export function fmtPct(value: number, digits = 1): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(digits)}%`;
}

export function fmtPts(value: number, digits = 0): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(digits)} pts`;
}

export function fmtConfidence(c: number | undefined): string {
  if (c === undefined) return '—';
  return `${Math.round(c * 100)}%`;
}

export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
