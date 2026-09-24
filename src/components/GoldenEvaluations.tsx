import { CircleCheck, CircleX, Loader2, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { GOLDEN_CASES, metricMeetsTarget, runGoldenSuite, type GoldenReport, type Metric } from '@/product/evaluation/golden';
import { Badge, Button, Card, cx, SectionTitle } from './ui';

function fmt(m: Metric) {
  return `${Math.round(m.value * 100)}%`;
}

/** Golden set for the watch engine — runs the real engine over each case's fixture night, in the browser. */
export function GoldenEvaluations() {
  const [report, setReport] = useState<GoldenReport | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    setReport(await runGoldenSuite());
    setRunning(false);
  };
  useEffect(() => {
    void run();
  }, []);

  const fir = report?.metrics.find((m) => m.key === 'false_interruption_rate');
  const rest = report?.metrics.filter((m) => m.key !== 'false_interruption_rate') ?? [];

  return (
    <section className="mb-12">
      <SectionTitle
        hint="Ten golden cases replayed through the watch engine: detection, correlation, attention, deduplication, notification and scheduling. The same suite runs in npm test."
        action={
          <Button variant="primary" icon={running ? Loader2 : Play} onClick={run} disabled={running}>
            {running ? 'Running…' : 'Run golden set'}
          </Button>
        }
      >
        Watch engine — golden set
      </SectionTitle>

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <Card className={cx(fir && metricMeetsTarget(fir) ? 'border-ok/30' : fir ? 'border-crit/40' : '')}>
          <div className="text-[12px] font-semibold tracking-wide text-ink-3 uppercase">Most important</div>
          <div className="mt-1 text-[14px] font-semibold">False interruption rate</div>
          <div className={cx('tabular mt-2 text-[40px] leading-none font-semibold tracking-tight', fir && metricMeetsTarget(fir) ? 'text-ok' : 'text-crit')}>{fir ? fmt(fir) : '—'}</div>
          <p className="mt-2 text-[12.5px] text-ink-2">{fir?.detail ?? 'Running…'}</p>
          <p className="mt-2 text-[12px] text-ink-3">“Only interrupt me when it matters.” An email the PM didn’t need costs more trust than a finding that waits for the brief.</p>
          <div className="mt-4 border-t border-line pt-3 text-[13px]">
            {report ? (
              <>
                <span className="font-semibold">{report.passed}</span> of {report.cases.length} cases pass
              </>
            ) : (
              '—'
            )}
          </div>
        </Card>
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line shadow-card sm:grid-cols-3 xl:grid-cols-5">
          {rest.map((m) => (
            <div key={m.key} className="bg-surface px-4 py-3" title={m.detail}>
              <div className="truncate text-[11.5px] text-ink-3">{m.label}</div>
              <div className={cx('tabular mt-0.5 text-[20px] font-semibold', metricMeetsTarget(m) ? 'text-ink' : 'text-crit')}>{fmt(m)}</div>
              <div className="text-[11px] text-ink-3">target {m.higherIsBetter ? '≥' : '≤'} {Math.round(m.target * 100)}%</div>
            </div>
          ))}
          {!report && <div className="col-span-full bg-surface px-4 py-6 text-center text-[13px] text-ink-3">Running the golden set…</div>}
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-line bg-surface shadow-card">
        {GOLDEN_CASES.map((gc) => {
          const r = report?.cases.find((c) => c.id === gc.id);
          return (
            <details key={gc.id} className="group border-b border-line last:border-b-0">
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-4 py-3 hover:bg-subtle">
                <span className="tabular w-16 font-mono text-[12px] text-ink-3">{gc.id}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-medium">{gc.title}</span>
                  <span className="block text-[12px] text-ink-3">Expected: {gc.expected}</span>
                </span>
                {r ? <Badge tone={r.passed ? 'ok' : 'crit'}>{r.passed ? 'PASS' : 'FAIL'}</Badge> : <Badge>…</Badge>}
              </summary>
              <div className="border-t border-dashed border-line bg-canvas/50 px-4 py-3 text-[12.5px]">
                <p className="mb-2 text-ink-2">{gc.scenario}</p>
                <ul className="space-y-1">
                  {(r?.checks ?? []).map((c) => (
                    <li key={c.label} className="grid grid-cols-[18px_220px_1fr] gap-2 max-sm:grid-cols-[18px_1fr]">
                      {c.passed ? <CircleCheck size={14} className="mt-0.5 text-ok" /> : <CircleX size={14} className="mt-0.5 text-crit" />}
                      <span className="font-medium">{c.label}</span>
                      <span className="text-ink-2 max-sm:col-start-2">{c.detail}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          );
        })}
      </div>
      <p className="mt-2 text-[12px] text-ink-3">
        Honest caveat: these cases were written alongside the engine, so a perfect score shows the rules behave as designed — not that they generalise. Real calibration needs labelled incidents from live sources.
      </p>
    </section>
  );
}
