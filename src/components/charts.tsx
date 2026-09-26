import { useId, useState } from 'react';
import type { MetricUnit, SeriesPoint } from '@/domain/types';
import { fmtMetric } from '@/lib/format';
import { fmtTime } from '@/lib/time';

/** Compact trend line for tables. Baseline drawn as a faint rule. */
export function Sparkline({ points, baseline, tone = 'neutral', width = 96, height = 24 }: { points: SeriesPoint[]; baseline?: number; tone?: 'bad' | 'neutral' | 'good'; width?: number; height?: number }) {
  if (points.length < 2) return <svg width={width} height={height} aria-hidden />;
  const values = points.map((p) => p.value);
  const lo = Math.min(...values, baseline ?? Infinity);
  const hi = Math.max(...values, baseline ?? -Infinity);
  const pad = (hi - lo) * 0.15 || 1;
  const y = (v: number) => height - 2 - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (height - 4);
  const x = (i: number) => (i / (points.length - 1)) * (width - 2) + 1;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const stroke = tone === 'bad' ? 'var(--crit)' : tone === 'good' ? 'var(--ok)' : 'var(--ink-3)';
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="overflow-visible">
      {baseline !== undefined && <line x1={0} x2={width} y1={y(baseline)} y2={y(baseline)} stroke="var(--line-strong)" strokeDasharray="2 2" />}
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(points.length - 1)} cy={y(values.at(-1)!)} r={2} fill={stroke} />
    </svg>
  );
}

export interface ChartMarker {
  at: string;
  label: string;
  tone?: 'release' | 'agent' | 'experiment';
}

/**
 * Metric over the night against its historical baseline band (±2σ), the PM's threshold,
 * and markers for releases and agent actions.
 */
export function SeriesChart({
  points,
  baseline,
  stdDev,
  thresholdPct,
  badDirection,
  unit,
  markers = [],
  height = 200,
  label,
}: {
  points: SeriesPoint[];
  baseline: number;
  stdDev: number;
  thresholdPct?: number;
  badDirection: 'up' | 'down';
  unit: MetricUnit;
  markers?: ChartMarker[];
  height?: number;
  label: string;
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = height;
  const M = { t: 16, r: 12, b: 24, l: 52 };
  if (points.length < 2) return null;

  const threshold = thresholdPct !== undefined ? baseline * (1 + ((badDirection === 'down' ? -1 : 1) * thresholdPct) / 100) : undefined;
  const values = [...points.map((p) => p.value), baseline + 2 * stdDev, baseline - 2 * stdDev, ...(threshold !== undefined ? [threshold] : [])];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo) * 0.12 || 1;
  const t0 = Date.parse(points[0].t);
  const t1 = Date.parse(points.at(-1)!.t);
  const x = (t: string) => M.l + ((Date.parse(t) - t0) / (t1 - t0 || 1)) * (W - M.l - M.r);
  const y = (v: number) => M.t + (1 - (v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - M.t - M.b);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const area = `${d}L${x(points.at(-1)!.t)},${H - M.b}L${x(points[0].t)},${H - M.b}Z`;
  const ticks = [lo, (lo + hi) / 2, hi];
  const xTicks = points.filter((_, i) => i % 4 === 0);
  const hp = hover !== null ? points[hover] : null;

  return (
    <figure className="w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full select-none"
        role="img"
        aria-label={`${label} over the night versus baseline`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          let best = 0;
          points.forEach((p, i) => {
            if (Math.abs(x(p.t) - px) < Math.abs(x(points[best].t) - px)) best = i;
          });
          setHover(best);
        }}
      >
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--ink)" stopOpacity="0.08" />
            <stop offset="100%" stopColor="var(--ink)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} stroke="var(--line)" />
            <text x={M.l - 8} y={y(t) + 4} textAnchor="end" fontSize="10.5" fill="var(--ink-3)" className="tabular">
              {fmtMetric(t, unit)}
            </text>
          </g>
        ))}
        <rect x={M.l} width={W - M.l - M.r} y={y(baseline + 2 * stdDev)} height={Math.max(1, y(baseline - 2 * stdDev) - y(baseline + 2 * stdDev))} fill="var(--ok)" opacity={0.09} />
        <line x1={M.l} x2={W - M.r} y1={y(baseline)} y2={y(baseline)} stroke="var(--ok)" strokeDasharray="4 3" opacity={0.8} />
        {threshold !== undefined && (
          <>
            <line x1={M.l} x2={W - M.r} y1={y(threshold)} y2={y(threshold)} stroke="var(--crit)" strokeDasharray="2 3" opacity={0.6} />
            <text x={W - M.r} y={y(threshold) - 4} textAnchor="end" fontSize="10" fill="var(--crit)">
              threshold
            </text>
          </>
        )}
        {markers.map((m, i) => {
          const mx = Math.max(M.l, Math.min(W - M.r, x(m.at)));
          const color = m.tone === 'release' ? 'var(--accent)' : m.tone === 'experiment' ? 'var(--high)' : 'var(--ink-3)';
          return (
            <g key={i}>
              <line x1={mx} x2={mx} y1={M.t} y2={H - M.b} stroke={color} strokeDasharray="3 3" />
              <text x={mx + 4} y={M.t + 10 + (i % 2) * 12} fontSize="10.5" fill={color} fontWeight={500}>
                {m.label}
              </text>
            </g>
          );
        })}
        <path d={area} fill={`url(#${id}-fill)`} />
        <path d={d} fill="none" stroke="var(--ink)" strokeWidth={1.75} strokeLinejoin="round" />
        {xTicks.map((p) => (
          <text key={p.t} x={x(p.t)} y={H - 6} textAnchor="middle" fontSize="10.5" fill="var(--ink-3)">
            {fmtTime(p.t)}
          </text>
        ))}
        {hp && (
          <g>
            <line x1={x(hp.t)} x2={x(hp.t)} y1={M.t} y2={H - M.b} stroke="var(--line-strong)" />
            <circle cx={x(hp.t)} cy={y(hp.value)} r={3.5} fill="var(--surface)" stroke="var(--ink)" strokeWidth={1.5} />
          </g>
        )}
      </svg>
      <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-3">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded bg-ink" /> {label}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-3 rounded bg-ok/20" /> Normal range (baseline ±2σ)
        </span>
        {hp && (
          <span className="tabular ml-auto font-medium text-ink">
            {fmtTime(hp.t)} · {fmtMetric(hp.value, unit)} ({(((hp.value - baseline) / baseline) * 100).toFixed(1)}% vs baseline)
          </span>
        )}
      </figcaption>
    </figure>
  );
}
