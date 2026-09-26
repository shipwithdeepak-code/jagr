import { CircleCheck, CircleX, FlaskConical, Loader2, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { defaultSettings } from '@/domain/defaults';
import { EVALUATION_SCENARIOS, runEvaluationSuite } from '@/evaluation/scenarios';
import { useWorkspace } from '@/state/workspace';
import { Badge, Button, Card, cx, PageHeader, SectionTitle, Stat, Tabs } from '@/components/ui';
import { EvaluationLab } from '@/components/evaluationLab';
import { PlannerEvaluations } from '@/components/PlannerEvaluations';

export function EvaluationsPage() {
  const { state, setEvaluation } = useWorkspace();
  const [policy, setPolicy] = useState<'default' | 'workspace'>('default');
  const [running, setRunning] = useState(false);
  const report = state.evaluation;

  const run = async (which = policy) => {
    setRunning(true);
    const r = await runEvaluationSuite(which === 'default' ? defaultSettings() : state.settings);
    setEvaluation(r);
    setRunning(false);
  };

  useEffect(() => {
    if (!state.evaluation) void run('default');
    // Only auto-run once, on first visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const t = report?.totals;
  return (
    <>
      <PageHeader
        title="Evaluation Lab"
        description="An agent that acts without evaluation isn’t something to trust. Every case replays a fixture night through the real engine and checks behaviour, not wording: did it catch real problems, stay quiet on noise, refuse to invent causes, and respect approval gates?"
      />

      <EvaluationLab />
      <PlannerEvaluations />

      <SectionTitle
        hint="The original demo-night orchestrator: autonomy policy, approval gates and a sabotaged planner."
        action={
          <div className="flex flex-wrap gap-2">
            <Tabs value={policy} onChange={setPolicy} items={[{ value: 'default', label: 'Default policy' }, { value: 'workspace', label: 'My settings' }]} />
            <Button variant="primary" icon={running ? Loader2 : Play} onClick={() => run()} disabled={running}>
              {running ? 'Running…' : 'Run evaluation suite'}
            </Button>
          </div>
        }
      >
        Demo night scenarios
      </SectionTitle>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line shadow-card sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: 'Scenarios', value: t?.scenarios ?? EVALUATION_SCENARIOS.length },
          { label: 'Passed', value: t?.passed ?? '—', tone: 'ok' as const },
          { label: 'Failed', value: t?.failed ?? '—', tone: t && t.failed > 0 ? ('crit' as const) : undefined },
          { label: 'False alerts', value: t?.falseAlerts ?? '—', tone: t && t.falseAlerts > 0 ? ('crit' as const) : undefined },
          { label: 'Missed issues', value: t?.missedIssues ?? '—', tone: t && t.missedIssues > 0 ? ('crit' as const) : undefined },
          { label: 'Approval violations', value: t?.approvalViolations ?? '—', tone: t && t.approvalViolations > 0 ? ('crit' as const) : undefined },
        ].map((s) => (
          <div key={s.label} className="bg-surface px-4 py-4">
            <Stat label={s.label} value={s.value} tone={s.tone} />
          </div>
        ))}
      </div>
      {report && (
        <p className="mt-2 text-[12px] text-ink-3">
          Last run against the {policy === 'default' ? 'default policy' : 'current workspace settings'} · deterministic simulation · the same suite runs in CI (<code className="font-mono">npm test</code>).
        </p>
      )}

      <div className="mt-8 space-y-3">
        <SectionTitle>Scenarios</SectionTitle>
        {EVALUATION_SCENARIOS.map((def) => {
          const r = report?.results.find((x) => x.scenarioId === def.id);
          return (
            <Card key={def.id} padded={false} className="overflow-hidden">
              <div className="flex flex-wrap items-start gap-3 px-4 py-4 sm:px-5">
                <span className="tabular font-mono text-[12px] text-ink-3">Scenario {def.number}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[16px] font-semibold tracking-tight">{def.name}</div>
                  <div className="text-[13px] text-ink-2">{def.description}</div>
                </div>
                {running ? (
                  <Badge>Running…</Badge>
                ) : r ? (
                  <Badge tone={r.passed ? 'ok' : 'crit'} className="text-[12px]">
                    {r.passed ? 'PASS' : 'FAIL'}
                  </Badge>
                ) : (
                  <Badge>Not run</Badge>
                )}
              </div>
              <div className="border-t border-line bg-canvas/50 px-4 py-3 sm:px-5">
                <div className="mb-2 text-[12px] font-medium text-ink-3">Expected</div>
                <ul className="grid gap-1.5">
                  {(r?.checks ?? def.expected.map((label) => ({ label, passed: undefined as boolean | undefined, detail: '' }))).map((c) => (
                    <li key={c.label} className="grid grid-cols-[18px_minmax(160px,240px)_1fr] items-start gap-2 text-[13px] max-sm:grid-cols-[18px_1fr]">
                      {c.passed === undefined ? <span className="mt-1.5 size-2 rounded-full bg-line-strong" /> : c.passed ? <CircleCheck size={15} className="mt-0.5 text-ok" /> : <CircleX size={15} className="mt-0.5 text-crit" />}
                      <span className="font-medium">{c.label}</span>
                      <span className={cx('text-ink-2 max-sm:col-start-2', !c.detail && 'hidden')}>{c.detail}</span>
                    </li>
                  ))}
                </ul>
                {r && (r.falseAlerts > 0 || r.approvalViolations > 0) && (
                  <div className="mt-2 text-[13px] text-crit">
                    {r.falseAlerts} false alerts · {r.approvalViolations} approval violations
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      <Card className="mt-8">
        <div className="flex items-start gap-3">
          <FlaskConical size={16} className="mt-0.5 text-ink-2" />
          <div className="grid gap-4 text-[13px] text-ink-2 md:grid-cols-3">
            <div>
              <div className="mb-1 font-medium text-ink">What’s measured</div>
              Behaviour, not prose: which findings were raised, what was filed, who was paged, what waited for approval. Wording can change without breaking the suite.
            </div>
            <div>
              <div className="mb-1 font-medium text-ink">How metrics are defined</div>
              False alert = a finding raised on a metric that wasn’t a real issue in that scenario. Missed issue = a real issue never raised. Approval violation = a gated action executed without an approved request.
            </div>
            <div>
              <div className="mb-1 font-medium text-ink">Why a sabotage test</div>
              Scenario 07 corrupts the planner on purpose. Guardrails that only live in the planner are guardrails the model can talk its way past; the executor enforces them independently.
            </div>
          </div>
        </div>
      </Card>
    </>
  );
}
