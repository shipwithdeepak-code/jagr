import { ChevronRight, CircleCheck, CircleX, Loader2, Play, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { runAdversarialSuite, type AdversarialReport } from '@/product/evaluation/adversarial';
import { runGoldenSuite, type GoldenReport } from '@/product/evaluation/golden';
import { labDimensions, labScenarios, reproduceAdversarialCase, type LabDimension, type LabScenario, type LabStatus } from '@/product/view/evaluation';
import { defaultReplayPass } from '@/product/view/replay';
import type { SourceConnection, WatchInvestigation } from '@/product/types';
import { StatusBadge as EvalBadge } from './PlannerEvaluations';
import { AuditTrail } from './auditTrail';
import { LoadingState } from './primitives';
import { Badge, Button, cx, Tabs } from './ui';

const DIM_STATUS: Record<LabStatus, { label: string; tone: string; Icon: typeof CircleCheck }> = {
  holding: { label: 'Holding', tone: 'text-ok', Icon: CircleCheck },
  limitation: { label: 'Documented limitation', tone: 'text-high', Icon: TriangleAlert },
  regression: { label: 'Regression', tone: 'text-crit', Icon: CircleX },
  pending: { label: 'Running…', tone: 'text-ink-3', Icon: Loader2 },
};

type Filter = 'all' | 'attention' | 'golden' | 'adversarial';

/**
 * Evaluation Lab — the golden and adversarial suites, run in the browser through the real engine.
 * Every number is a count the evaluators produced; nothing is re-scored or rounded into a grade.
 */
export function EvaluationLab() {
  const [golden, setGolden] = useState<GoldenReport | null>(null);
  const [adversarial, setAdversarial] = useState<AdversarialReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const [g, a] = await Promise.all([runGoldenSuite(), runAdversarialSuite()]);
      setGolden(g);
      setAdversarial(a);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };
  useEffect(() => {
    void run();
  }, []);

  const dims = useMemo(() => labDimensions(golden, adversarial), [golden, adversarial]);
  const scenarios = useMemo(() => labScenarios(golden, adversarial), [golden, adversarial]);
  const regressions = scenarios.filter((s) => s.status === 'REGRESSION').length;
  const limitations = scenarios.filter((s) => s.status === 'INTENTIONAL_FAILURE').length;
  const shown = scenarios.filter((s) => (filter === 'all' ? true : filter === 'attention' ? s.status === 'REGRESSION' || s.status === 'INTENTIONAL_FAILURE' : s.suite === filter));

  return (
    <section aria-label="Evaluation Lab" className="mb-12">
      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-line bg-surface px-4 py-4 shadow-card sm:px-5">
        <div className="min-w-0 flex-1" role="status" aria-live="polite">
          {error ? (
            <p className="text-[13.5px] text-crit">The suites could not finish: {error}. Nothing below is a result — run them again.</p>
          ) : golden && adversarial ? (
            <p className="num text-[14px] text-ink">
              <span className="font-semibold">{golden.passed}</span> of {golden.cases.length} golden cases pass · <span className="font-semibold">{adversarial.passed}</span> of {adversarial.results.length} adversarial cases pass
              {limitations > 0 && <span className="text-high"> · {limitations} documented limitation{limitations === 1 ? '' : 's'}</span>}
              <span className={regressions ? 'text-crit' : 'text-ok'}> · {regressions} regression{regressions === 1 ? '' : 's'}</span>
            </p>
          ) : (
            <p className="text-[13.5px] text-ink-2">Running every case through the real engine…</p>
          )}
          <p className="mt-0.5 text-[12px] text-ink-3">Deterministic fixture nights, run in this browser. The same suites run in npm test.</p>
        </div>
        <Button variant="primary" icon={running ? Loader2 : Play} onClick={() => void run()} disabled={running}>
          {running ? 'Running…' : 'Run evaluations'}
        </Button>
      </div>

      <h2 className="mb-1 text-[13px] font-semibold tracking-tight">Dimensions</h2>
      <p className="mb-3 text-[12.5px] text-ink-3">Each dimension lists the measurements behind it, in the evaluators’ own counts. Different units are never added together.</p>
      <div className="stagger mb-10 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {dims.map((d, i) => (
          <DimensionCard key={d.key} d={d} index={i} />
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-semibold tracking-tight">Scenarios</h2>
          <p className="text-[12.5px] text-ink-3">Expected against actual, the checks as evidence, and the trace behind the verdict.</p>
        </div>
        <Tabs
          value={filter}
          onChange={setFilter}
          items={[
            { value: 'all', label: `All (${scenarios.length})` },
            { value: 'attention', label: `Failing (${regressions + limitations})` },
            { value: 'golden', label: 'Golden' },
            { value: 'adversarial', label: 'Adversarial' },
          ]}
        />
      </div>
      {!golden && !adversarial && running ? (
        <LoadingState label="Running the golden and adversarial sets…" />
      ) : shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-ink-2">{filter === 'attention' ? 'Every scenario passes — no regressions and no documented limitations failing.' : 'No scenarios in this view.'}</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
          {shown.map((s) => (
            <ScenarioRow key={s.id} s={s} />
          ))}
        </div>
      )}
      <p className="mt-3 text-[12px] text-ink-3">
        Honest caveat: these cases were written alongside the engine, so a clean run shows the rules behave as designed — not that they generalise. Real calibration needs labelled incidents from live sources.
      </p>
    </section>
  );
}

function DimensionCard({ d, index }: { d: LabDimension; index: number }) {
  const st = DIM_STATUS[d.status];
  return (
    <article className="min-w-0 rounded-xl border border-line bg-surface p-4 shadow-card" style={{ ['--i' as string]: index }}>
      <h3 className="text-[13.5px] font-semibold tracking-tight">{d.label}</h3>
      <p className={cx('mt-1 inline-flex items-center gap-1.5 text-[12px] font-medium', st.tone)}>
        <st.Icon size={13} aria-hidden className={d.status === 'pending' ? 'animate-spin motion-reduce:animate-none' : undefined} />
        {st.label}
      </p>
      <ul className="mt-3 space-y-2">
        {d.measurements.map((m) => (
          <li key={`${m.suite}-${m.label}`} className="text-[12px] leading-snug">
            <span className="flex items-center gap-1.5 font-medium text-ink">
              {m.ok ? <CircleCheck size={12} aria-hidden className="shrink-0 text-ok" /> : m.limitation ? <TriangleAlert size={12} aria-hidden className="shrink-0 text-high" /> : <CircleX size={12} aria-hidden className="shrink-0 text-crit" />}
              {m.label}
              <span className="font-normal text-ink-3">· {m.suite}</span>
            </span>
            <span className="mt-0.5 block pl-[18px] text-ink-2">{m.text}</span>
          </li>
        ))}
        {!d.measurements.length && <li className="text-[12px] text-ink-3">Waiting for the suites to finish.</li>}
      </ul>
    </article>
  );
}

function ScenarioRow({ s }: { s: LabScenario }) {
  return (
    <details className="group border-b border-line last:border-b-0" open={s.status === 'REGRESSION'}>
      <summary className="interactive flex cursor-pointer list-none items-start gap-3 px-4 py-3 hover:bg-subtle/60 sm:px-5 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={14} aria-hidden className="mt-1 shrink-0 text-ink-3 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="num font-mono text-[11.5px] text-ink-3">{s.id}</span>
            <span className="text-[13.5px] font-medium">{s.title}</span>
            <span className="text-[11.5px] text-ink-3">{s.suite}</span>
          </span>
          <span className="mt-0.5 block text-[12px] text-ink-3">Expected: {s.expected}</span>
        </span>
        <span className="shrink-0">{s.status === 'pending' ? <Badge>…</Badge> : <EvalBadge status={s.status} />}</span>
      </summary>
      <div className="space-y-4 border-t border-dashed border-line bg-canvas/50 px-4 py-4 text-[12.5px] sm:px-5">
        {s.knownFailure && <p className="rounded-lg bg-high-soft px-3 py-2 text-ink">{s.knownFailure}</p>}
        <dl className="grid gap-x-5 gap-y-2 sm:grid-cols-[110px_minmax(0,1fr)]">
          <dt className="text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">Scenario</dt>
          <dd className="text-ink-2">{s.scenario}</dd>
          <dt className="text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">Expected</dt>
          <dd className="text-ink">{s.expected}</dd>
          <dt className="text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">Actual</dt>
          <dd className="text-ink">{s.actual || '—'}</dd>
        </dl>
        <div>
          <h4 className="mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">Evidence · checks</h4>
          <ul className="space-y-1">
            {s.checks.map((c) => (
              <li key={c.label} className="grid grid-cols-[18px_minmax(0,1fr)] gap-2 sm:grid-cols-[18px_220px_minmax(0,1fr)]">
                {c.passed ? <CircleCheck size={14} aria-label="passed" className="mt-0.5 text-ok" /> : <CircleX size={14} aria-label="failed" className="mt-0.5 text-crit" />}
                <span className="font-medium">{c.label}</span>
                <span className="text-ink-2 max-sm:col-start-2">{c.detail}</span>
              </li>
            ))}
          </ul>
        </div>
        <RelevantTrace s={s} />
      </div>
    </details>
  );
}

function TraceOf({ inv, connections }: { inv: WatchInvestigation; connections: SourceConnection[] }) {
  const pass = defaultReplayPass(inv);
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <p className="border-b border-line px-4 py-2 text-[12px] text-ink-2 sm:px-5">
        <span className="font-medium text-ink">{inv.title}</span> · {inv.attention} · pass {pass}
      </p>
      <div className="max-h-80 overflow-y-auto">
        <AuditTrail steps={inv.trace.filter((t) => t.pass === pass)} stateOf={(p) => connections.find((c) => c.provider === p)?.state} />
      </div>
    </div>
  );
}

function RelevantTrace({ s }: { s: LabScenario }) {
  const [repro, setRepro] = useState<{ investigation?: WatchInvestigation; connections: SourceConnection[] } | 'loading' | 'error' | null>(null);
  const heading = <h4 className="mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">Relevant trace</h4>;
  if (!s.reproducible) {
    return (
      <div>
        {heading}
        {s.trace && s.connections ? <TraceOf inv={s.trace} connections={s.connections} /> : <p className="text-ink-2">No investigation was opened in this run, so there is no trace. {s.status === 'PASS' ? 'That is the expected behaviour here.' : ''}</p>}
      </div>
    );
  }
  return (
    <div>
      {heading}
      {repro === null ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            onClick={async () => {
              setRepro('loading');
              try {
                setRepro(await reproduceAdversarialCase(s.id));
              } catch {
                setRepro('error');
              }
            }}
          >
            Show trace
          </Button>
          <span className="text-[12px] text-ink-3">The suite keeps verdicts, not runs. This re-runs the case’s fixture night — the same deterministic run.</span>
        </div>
      ) : repro === 'loading' ? (
        <LoadingState label="Re-running this case’s fixture night…" />
      ) : repro === 'error' ? (
        <p className="text-crit">The case could not be re-run in this browser.</p>
      ) : repro.investigation ? (
        <TraceOf inv={repro.investigation} connections={repro.connections} />
      ) : (
        <p className="text-ink-2">No investigation was opened in this case, so there is no trace.</p>
      )}
    </div>
  );
}
