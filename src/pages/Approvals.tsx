import { Lock, ShieldCheck } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useWorkspace } from '@/state/workspace';
import { AUTONOMY_LEVELS, GATE_LABELS } from '@/agents/policy';
import { Card, EmptyState, PageHeader, SectionTitle } from '@/components/ui';
import { ApprovalCard } from '@/components/work';
import { RunButtons } from './Overview';

export function ApprovalsPage() {
  const { state } = useWorkspace();
  const { hash } = useLocation();
  const evidence = state.run?.investigations.flatMap((i) => i.evidence) ?? [];
  const pending = state.approvals.filter((a) => a.status === 'pending' || a.status === 'more_evidence_requested');
  const decided = state.approvals.filter((a) => a.status === 'approved' || a.status === 'rejected');

  useEffect(() => {
    if (hash) setTimeout(() => document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }, [hash]);

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Level-4 actions — production changes, payments, pricing, refunds and customer communication — are never executed by JAGR alone. They wait here with the evidence behind them."
      />

      <Card className="mb-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center">
          <div className="flex items-start gap-3 md:w-1/2">
            <Lock size={16} className="mt-0.5 shrink-0 text-ink-2" />
            <div className="text-[13px] text-ink-2">
              <span className="font-medium text-ink">Why a human is required.</span> These actions affect customers or money and some cannot be undone. JAGR can be confident about a cause and still be wrong about the right remedy. Approval here updates the simulated environment only.
            </div>
          </div>
          <ol className="grid flex-1 grid-cols-5 gap-1 text-center text-[11px]">
            {AUTONOMY_LEVELS.map((l) => (
              <li key={l.level} className={l.level === 4 ? 'rounded-md bg-high-soft px-1 py-1.5 text-high' : 'rounded-md bg-subtle px-1 py-1.5 text-ink-2'}>
                <div className="font-semibold">L{l.level}</div>
                <div className="truncate">{l.name}</div>
              </li>
            ))}
          </ol>
        </div>
      </Card>

      <SectionTitle hint={`${pending.length} waiting`}>Action requests</SectionTitle>
      {pending.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="Nothing waiting for approval" action={!state.run ? <div className="flex gap-2"><RunButtons /></div> : undefined}>
          {state.run ? 'Every consequential action from last night has been decided.' : 'When JAGR recommends a production, payment or customer-facing action, it lands here instead of being executed.'}
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {pending.map((a) => <ApprovalCard key={a.id} approval={a} evidence={evidence} />)}
        </div>
      )}

      {decided.length > 0 && (
        <div className="mt-10">
          <SectionTitle hint="Recorded in the audit log.">Decided</SectionTitle>
          <div className="space-y-4">
            {decided.map((a) => <ApprovalCard key={a.id} approval={a} evidence={evidence} />)}
          </div>
        </div>
      )}

      <p className="mt-8 text-[12.5px] text-ink-3">
        Gates are configured in <Link to="/settings" className="text-accent hover:underline">Settings</Link>. Each gate ({Object.values(GATE_LABELS).join(', ')}) can require approval or be disabled entirely — it can never be set to execute autonomously.
      </p>
    </>
  );
}
