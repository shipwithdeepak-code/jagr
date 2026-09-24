import { CircleCheck, CircleX, Loader2, Play, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ADVERSARIAL_CASES, DIMENSION_LABEL, evalStatus, runAdversarialSuite, type AdversarialReport } from '@/product/evaluation/adversarial';
import { StatusBadge } from './PlannerEvaluations';
import { Badge, Button, cx, SectionTitle } from './ui';

/** Cases where the obvious answer is wrong. Built to find failure modes — known failures are shown, not hidden. */
export function AdversarialEvaluations() {
  const [report, setReport] = useState<AdversarialReport | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    setReport(await runAdversarialSuite());
    setRunning(false);
  };
  useEffect(() => {
    void run();
  }, []);

  const known = report?.results.filter((r) => r.knownFailure && !r.passed).length ?? 0;

  return (
    <section className="mb-12">
      <SectionTitle
        hint="Each case is built so the obvious answer is wrong: blame the release, invent missing data, page someone for noise, open a duplicate, run the risky fix. Every case also checks for causal language and ungrounded evidence. The same suite runs in npm test."
        action={
          <Button variant="primary" icon={running ? Loader2 : Play} onClick={run} disabled={running}>
            {running ? 'Running…' : 'Run adversarial set'}
          </Button>
        }
      >
        Agent — adversarial set
      </SectionTitle>

      <div className="mb-4 flex flex-wrap items-center gap-3 text-[13px]">
        {report ? (
          <>
            <span>
              <span className="font-semibold">{report.passed}</span> of {report.results.length} cases pass
            </span>
            {known > 0 && (
              <Badge tone="high">
                <TriangleAlert size={11} className="mr-1 inline" />
                {known} intentional failure{known === 1 ? '' : 's'} — documented limitations, not tuned away
              </Badge>
            )}
          </>
        ) : (
          <span className="text-ink-3">Running…</span>
        )}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line shadow-card sm:grid-cols-3 xl:grid-cols-5">
        {(report?.byDimension ?? []).map((d) => (
          <div key={d.dimension} className="bg-surface px-4 py-3">
            <div className="truncate text-[11.5px] text-ink-3">{DIMENSION_LABEL[d.dimension]}</div>
            <div className={cx('tabular mt-0.5 text-[20px] font-semibold', d.passed === d.total ? 'text-ink' : 'text-crit')}>
              {d.passed}/{d.total}
            </div>
            <div className="text-[11px] text-ink-3">checks pass</div>
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
        {ADVERSARIAL_CASES.map((c) => {
          const r = report?.results.find((x) => x.id === c.id);
          return (
            <details key={c.id} className="group border-b border-line last:border-b-0" open={!!r && !r.passed}>
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-4 py-3 hover:bg-subtle">
                <span className="tabular w-16 font-mono text-[12px] text-ink-3">{c.id}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-medium">{c.title}</span>
                  <span className="block text-[12px] text-ink-3">Trap: {c.trap}</span>
                </span>
                {r ? <StatusBadge status={evalStatus(r)} /> : <Badge>…</Badge>}
              </summary>
              <div className="border-t border-dashed border-line bg-canvas/50 px-4 py-3 text-[12.5px]">
                {c.knownFailure && <p className="mb-2 rounded-lg bg-high-soft px-3 py-2 text-ink">{c.knownFailure}</p>}
                <ul className="space-y-1">
                  {(r?.checks ?? []).map((k) => (
                    <li key={k.label} className="grid grid-cols-[18px_150px_220px_1fr] gap-2 max-md:grid-cols-[18px_1fr]">
                      {k.passed ? <CircleCheck size={14} className="mt-0.5 text-ok" /> : <CircleX size={14} className="mt-0.5 text-crit" />}
                      <span className="text-ink-3 max-md:hidden">{DIMENSION_LABEL[k.dimension]}</span>
                      <span className="font-medium">{k.label}</span>
                      <span className="text-ink-2 max-md:col-start-2">{k.detail}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}
