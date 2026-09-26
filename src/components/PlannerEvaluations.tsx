import { CircleCheck, CircleX, Loader2, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DIMENSION_LABEL, evalStatus, type EvalStatus } from '@/product/evaluation/adversarial';
import { PLANNER_CASES, runPlannerSuite, type PlannerCaseResult } from '@/product/evaluation/plannerEval';
import { Badge, Button, SectionTitle } from './ui';

export function StatusBadge({ status }: { status: EvalStatus }) {
  return <Badge tone={status === 'PASS' ? 'ok' : status === 'INTENTIONAL_FAILURE' ? 'high' : 'crit'}>{status === 'INTENTIONAL_FAILURE' ? 'INTENTIONAL FAILURE' : status}</Badge>;
}

/** Model proposes, policy disposes: the boundary around the planner, attacked with scripted planners. */
export function PlannerEvaluations() {
  const [results, setResults] = useState<PlannerCaseResult[] | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    setResults((await runPlannerSuite()).results);
    setRunning(false);
  };
  useEffect(() => {
    void run();
  }, []);

  const count = (s: EvalStatus) => results?.filter((r) => evalStatus(r) === s).length ?? 0;

  return (
    <section className="mb-12">
      <SectionTitle
        hint="Each case drives the real investigation loop with a scripted planner that behaves well or badly — hallucinated tools, unavailable sources, actions instead of tools, causal claims, malformed output, timeouts. The policy validator, the deterministic fallback and the trace must hold. Scripted planners are test doubles, not models: this measures the boundary around a model, not a model's judgement."
        action={
          <Button variant="primary" icon={running ? Loader2 : Play} onClick={run} disabled={running}>
            {running ? 'Running…' : 'Run planner set'}
          </Button>
        }
      >
        Model planner — policy boundary
      </SectionTitle>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-[13px]">
        {results ? (
          <>
            <span><span className="font-semibold">{count('PASS')}</span> pass</span>
            <span><span className="font-semibold">{count('INTENTIONAL_FAILURE')}</span> intentional failures</span>
            <span className={count('REGRESSION') ? 'font-semibold text-crit' : ''}>{count('REGRESSION')} regressions</span>
          </>
        ) : (
          <span className="text-ink-3">Running…</span>
        )}
      </div>
      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
        {PLANNER_CASES.map((c) => {
          const r = results?.find((x) => x.id === c.id);
          return (
            <details key={c.id} className="group border-b border-line last:border-b-0" open={!!r && !r.passed}>
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-4 py-3 hover:bg-subtle">
                <span className="tabular w-16 font-mono text-[12px] text-ink-3">{c.id}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-medium">{c.title}</span>
                  <span className="block text-[12px] text-ink-3">Attack: {c.attack}</span>
                </span>
                {r ? <StatusBadge status={evalStatus(r)} /> : <Badge>…</Badge>}
              </summary>
              <div className="border-t border-dashed border-line bg-canvas/50 px-4 py-3 text-[13px]">
                {c.knownFailure && <p className="mb-2 rounded-lg bg-high-soft px-3 py-2 text-ink">{c.knownFailure}</p>}
                {r && <p className="mb-2 text-[12px] text-ink-3">{r.plannerLabel}</p>}
                <ul className="space-y-1">
                  {(r?.checks ?? []).map((k) => (
                    <li key={k.label} className="grid grid-cols-[18px_150px_260px_1fr] gap-2 max-md:grid-cols-[18px_1fr]">
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
