import { Activity } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Signal, SignalCategory } from '@/domain/types';
import { fmtMetric, fmtPct } from '@/lib/format';
import { fmtTime } from '@/lib/time';
import { useWorkspace } from '@/state/workspace';
import { SeriesChart, Sparkline } from '@/components/charts';
import { Badge, Card, cx, Drawer, EmptyState, KeyValue, PageHeader, SeverityBadge, Tabs } from '@/components/ui';
import { RunButtons } from './Overview';

const CATEGORY_LABEL: Record<SignalCategory, string> = {
  conversion: 'Conversion',
  payments: 'Payments',
  revenue: 'Revenue',
  activation: 'Activation',
  retention: 'Retention',
  engagement: 'Engagement',
  support: 'Support',
  reliability: 'Reliability',
};
const ORDER: SignalCategory[] = ['conversion', 'payments', 'revenue', 'activation', 'retention', 'engagement', 'support', 'reliability'];

function StatusCell({ s }: { s: Signal }) {
  if (!s.watched) return <Badge>Not watched</Badge>;
  if (s.status === 'anomalous') return <SeverityBadge severity={s.severity} />;
  if (s.status === 'transient') return <Badge tone="info">Transient</Badge>;
  return <Badge tone="ok">Normal</Badge>;
}

export function SignalsPage() {
  const { state } = useWorkspace();
  const [filter, setFilter] = useState<'all' | 'anomalous'>('all');
  const [open, setOpen] = useState<Signal | null>(null);
  const run = state.run;

  if (!run) {
    return (
      <>
        <PageHeader title="Signals" description="Every metric JAGR monitors, compared with the same hours on the previous 28 nights." />
        <EmptyState icon={Activity} title="No readings yet" action={<div className="flex gap-2"><RunButtons /></div>}>
          JAGR reads 42 product, payment, support and reliability metrics every 30 minutes during the watch.
        </EmptyState>
      </>
    );
  }

  const signals = run.signals.filter((s) => filter === 'all' || s.status === 'anomalous' || s.status === 'transient');
  const inv = (s: Signal) => run.investigations.find((i) => i.signalIds.includes(s.id));

  return (
    <>
      <PageHeader
        title="Signals"
        description={`${run.stats.signalsMonitored} signals monitored · current = last 90 minutes of the watch · baseline = same hours, previous 28 nights. A signal is anomalous only if it breaches its threshold, is ≥3σ from normal, and persists for three buckets.`}
        actions={<Tabs value={filter} onChange={setFilter} items={[{ value: 'all', label: 'All' }, { value: 'anomalous', label: 'Anomalous & transient' }]} />}
      />
      <div className="space-y-6">
        {ORDER.map((cat) => {
          const rows = signals.filter((s) => s.category === cat);
          if (!rows.length) return null;
          return (
            <section key={cat}>
              <div className="mb-2 flex items-baseline gap-2">
                <h2 className="text-[13px] font-semibold">{CATEGORY_LABEL[cat]}</h2>
                <span className="text-[12px] text-ink-3">threshold {state.settings.thresholds[cat]}%</span>
              </div>
              <Card padded={false} className="overflow-x-auto">
                <table className="w-full min-w-[760px] table-fixed text-[13px]">
                  <thead className="border-b border-line bg-subtle/60 text-left text-[11.5px] text-ink-3">
                    <tr>
                      <th className="px-4 py-2 font-medium">Metric</th>
                      <th className="w-[130px] px-3 py-2 font-medium">Overnight</th>
                      <th className="w-[100px] px-3 py-2 text-right font-medium">Current</th>
                      <th className="w-[100px] px-3 py-2 text-right font-medium">Baseline</th>
                      <th className="w-[90px] px-3 py-2 text-right font-medium">Change</th>
                      <th className="w-[120px] px-3 py-2 font-medium">Severity</th>
                      <th className="w-[150px] px-4 py-2 font-medium">Timestamp</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((s) => {
                      const bad = s.badDirection === 'down' ? s.changePct < 0 : s.changePct > 0;
                      return (
                        <tr key={s.id} onClick={() => setOpen(s)} className={cx('cursor-pointer border-b border-line last:border-b-0 hover:bg-subtle', s.status === 'anomalous' && 'bg-crit-soft/30')}>
                          <td className="px-4 py-2.5 font-medium">{s.name}</td>
                          <td className="px-3 py-2.5"><Sparkline points={s.series} baseline={s.baseline.mean} tone={s.status === 'anomalous' ? 'bad' : 'neutral'} /></td>
                          <td className="tabular px-3 py-2.5 text-right">{fmtMetric(s.current, s.unit)}</td>
                          <td className="tabular px-3 py-2.5 text-right text-ink-3">{fmtMetric(s.baseline.mean, s.unit)}</td>
                          <td className={cx('tabular px-3 py-2.5 text-right font-medium', s.status === 'anomalous' ? 'text-crit' : bad && Math.abs(s.changePct) > s.thresholdPct / 2 ? 'text-high' : 'text-ink-2')}>{fmtPct(s.changePct)}</td>
                          <td className="px-3 py-2.5"><StatusCell s={s} /></td>
                          <td className="tabular px-4 py-2.5 text-[12px] text-ink-3">{fmtTime(s.observedAt)}{inv(s) && s.status !== 'normal' ? ' · investigated' : ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Card>
            </section>
          );
        })}
      </div>

      <Drawer open={!!open} onClose={() => setOpen(null)} title={open?.name} subtitle={open ? `${CATEGORY_LABEL[open.category]} · tier ${open.tier} · ${open.baseline.window}` : undefined} width="max-w-2xl">
        {open && (
          <>
            <SeriesChart points={open.series} baseline={open.baseline.mean} stdDev={open.baseline.stdDev} thresholdPct={open.thresholdPct} badDirection={open.badDirection} unit={open.unit} label={open.name} />
            <KeyValue
              className="mt-5"
              items={[
                { k: 'Status', v: <StatusCell s={open} /> },
                { k: 'Current (90 min)', v: fmtMetric(open.current, open.unit) },
                { k: 'Baseline', v: `${fmtMetric(open.baseline.mean, open.unit)} ± ${fmtMetric(open.baseline.stdDev, open.unit)} (1σ)` },
                { k: 'Change', v: `${fmtPct(open.changePct)} · z = ${open.zScore.toFixed(1)}` },
                { k: 'Threshold', v: `${open.thresholdPct}% in the ${open.badDirection === 'down' ? 'downward' : 'upward'} direction` },
                ...(open.note ? [{ k: 'Note', v: open.note }] : []),
                ...(inv(open) ? [{ k: 'Investigation', v: <Link className="font-medium text-accent hover:underline" to={`/investigations/${inv(open)!.id}`}>{inv(open)!.title}</Link> }] : []),
              ]}
            />
          </>
        )}
      </Drawer>
    </>
  );
}
