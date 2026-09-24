import type { ActionDecision, ProposedAction, TraceStep, WatchInvestigation } from '../types';
import { ApprovalRequiredError, executeAction } from './actions';

/**
 * Human decisions live outside the monitoring result (so a re-run never forgets them) and are
 * applied over it. Action ids are stable across runs: `act-<investigation>-<kind>`.
 */

export type EffectiveStatus = ProposedAction['status'] | ActionDecision['status'];

export interface EffectiveAction extends ProposedAction {
  effective: EffectiveStatus;
  decision?: ActionDecision;
}

export function effectiveActions(inv: WatchInvestigation, decisions: Record<string, ActionDecision>): EffectiveAction[] {
  return inv.actions.map((a) => {
    const decision = decisions[a.id];
    return { ...a, effective: a.status === 'executed' ? 'executed' : (decision?.status ?? a.status), decision };
  });
}

/**
 * Record a human decision. Approving (or marking a MEDIUM recommendation done) executes the
 * action through the same gate the agent uses; rejecting executes nothing.
 */
export function decide(action: ProposedAction, input: Omit<ActionDecision, 'result'>): ActionDecision {
  if (input.status === 'rejected') return { ...input, result: 'Rejected — nothing was executed.' };
  if (input.status === 'done' && (action.risk === 'HIGH' || action.risk === 'CRITICAL')) {
    throw new ApprovalRequiredError(action);
  }
  return { ...input, result: executeAction(action, input) };
}

const VERB: Record<ActionDecision['status'], string> = { approved: 'Approved', rejected: 'Rejected', done: 'Done' };

/** The investigation's trace with human decisions appended, so the audit trail is in one place. */
export function traceWithDecisions(inv: WatchInvestigation, decisions: Record<string, ActionDecision>): TraceStep[] {
  const pass = inv.trace.reduce((m, s) => Math.max(m, s.pass), 0);
  const human = inv.actions.flatMap((a): TraceStep[] => {
    const d = decisions[a.id];
    if (!d) return [];
    const option = a.options?.find((o) => o.id === d.optionId);
    return [
      {
        id: `${a.id}-human`,
        at: d.at,
        pass,
        kind: 'human',
        title: `${VERB[d.status]} by PM: ${option ? option.label : a.title}`,
        detail: [option && option.label !== a.title ? `Modified from “${a.title}”.` : '', d.note ? `Note: “${d.note}”` : ''].filter(Boolean).join(' ') || undefined,
        result: d.result,
        why: `${a.risk} risk — ${a.risk === 'HIGH' || a.risk === 'CRITICAL' ? 'Jagr cannot do this without a human.' : 'Jagr recommended it; a human chose to act.'}`,
      },
    ];
  });
  return [...inv.trace, ...human].sort((x, y) => x.at.localeCompare(y.at));
}

export function pendingApprovals(invs: WatchInvestigation[], decisions: Record<string, ActionDecision>): EffectiveAction[] {
  return invs.flatMap((i) => effectiveActions(i, decisions)).filter((a) => a.effective === 'awaiting_approval');
}
