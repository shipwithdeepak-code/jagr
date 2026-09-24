import type {
  ActionType,
  AlertSeverity,
  AutonomyLevel,
  AutonomyPolicy,
  GatedCategory,
  PolicyDecision,
  RiskLevel,
  Severity,
  WorkspaceSettings,
} from '@/domain/types';
import { severityRank } from './detection';

/**
 * Autonomy & risk policy.
 *
 * Every action type has a fixed risk level and a minimum autonomy level. Level-4 actions
 * (production, payments, pricing, refunds, customer communication) can only ever be
 * "require approval" or "disabled" — there is no setting that lets JAGR execute them alone.
 */

export interface ActionSpec {
  label: string;
  risk: RiskLevel;
  level: AutonomyLevel;
  gatedBy?: GatedCategory;
  reversibility: string;
}

export const ACTION_CATALOG: Record<ActionType, ActionSpec> = {
  continue_monitoring: { label: 'Continue monitoring', risk: 'low', level: 1, reversibility: 'No change made' },
  create_task: { label: 'Create engineering task', risk: 'low', level: 3, reversibility: 'Task can be closed' },
  create_incident_draft: { label: 'Create incident draft', risk: 'low', level: 3, reversibility: 'Draft only — not declared' },
  notify_oncall: { label: 'Notify on-call', risk: 'low', level: 3, reversibility: 'Internal notification' },
  draft_slack_message: { label: 'Draft Slack message', risk: 'low', level: 3, reversibility: 'Draft only — not sent' },
  add_evidence_to_issue: { label: 'Add evidence to issue', risk: 'low', level: 3, reversibility: 'Comment can be removed' },
  pause_experiment: { label: 'Pause experiment', risk: 'medium', level: 4, gatedBy: 'production_changes', reversibility: 'Re-enable the experiment' },
  customer_communication: { label: 'Customer communication', risk: 'medium', level: 4, gatedBy: 'customer_communications', reversibility: 'Cannot be unsent' },
  rollback_release: { label: 'Production rollback', risk: 'high', level: 4, gatedBy: 'production_changes', reversibility: 'Redeploy to restore' },
  disable_payment_method: { label: 'Disable payment method', risk: 'high', level: 4, gatedBy: 'payments', reversibility: 'Re-enable in payment config' },
  refund: { label: 'Issue refunds', risk: 'high', level: 4, gatedBy: 'refunds', reversibility: 'Cannot be reversed' },
  pricing_change: { label: 'Change pricing', risk: 'high', level: 4, gatedBy: 'pricing', reversibility: 'Revert price' },
  production_config_change: { label: 'Production configuration change', risk: 'high', level: 4, gatedBy: 'production_changes', reversibility: 'Revert config' },
};

export const AUTONOMY_LEVELS: { level: AutonomyLevel; name: string; description: string }[] = [
  { level: 0, name: 'Observe', description: 'Read product signals.' },
  { level: 1, name: 'Investigate', description: 'Query other systems and gather evidence.' },
  { level: 2, name: 'Recommend', description: 'Produce hypotheses and recommended actions.' },
  { level: 3, name: 'Execute low-risk', description: 'Create tasks and incident drafts, notify on-call, add evidence.' },
  { level: 4, name: 'Human approval', description: 'Production, payments, pricing, refunds and customer communication.' },
];

export const GATE_LABELS: Record<GatedCategory, string> = {
  production_changes: 'Production changes',
  customer_communications: 'Customer communications',
  payments: 'Payments',
  pricing: 'Pricing',
  refunds: 'Refunds',
};

export interface RiskAssessment {
  risk: RiskLevel;
  reasons: string[];
}

/** Risk is fixed per action type, then explained in context. */
export function assessRisk(type: ActionType, context: { providerShare?: number; blastRadius?: string }): RiskAssessment {
  const spec = ACTION_CATALOG[type];
  const reasons: string[] = [];
  if (spec.gatedBy === 'payments') reasons.push('Changes what customers can pay with');
  if (spec.gatedBy === 'production_changes') reasons.push('Changes production');
  if (spec.gatedBy === 'customer_communications') reasons.push('Customer-facing and cannot be unsent');
  if (context.providerShare) reasons.push(`Affects ~${Math.round(context.providerShare * 100)}% of checkout attempts`);
  if (context.blastRadius) reasons.push(context.blastRadius);
  if (spec.risk === 'low') reasons.push('Internal, reversible, no customer impact');
  return { risk: spec.risk, reasons };
}

export function levelEnabled(policy: AutonomyPolicy, level: AutonomyLevel): boolean {
  if (level === 0) return policy.observe;
  if (level === 1) return policy.observe && policy.investigate;
  if (level === 2) return policy.observe && policy.investigate && policy.recommend;
  return policy.observe && policy.investigate && policy.recommend;
}

export interface PolicyEvaluation {
  decision: PolicyDecision;
  reason: string;
}

/** Decide what JAGR may do with an action. Pure and exhaustively tested. */
export function evaluatePolicy(type: ActionType, severity: Severity, settings: WorkspaceSettings): PolicyEvaluation {
  const policy = settings.autonomy;
  const spec = ACTION_CATALOG[type];

  if (!levelEnabled(policy, Math.min(spec.level, 2) as AutonomyLevel)) {
    return { decision: 'not_permitted', reason: `Autonomy level "${AUTONOMY_LEVELS[Math.min(spec.level, 2)].name}" is turned off` };
  }

  if (spec.level === 4) {
    const gate = settings.autonomy.gates[spec.gatedBy!];
    return gate === 'require_approval'
      ? { decision: 'require_approval', reason: `${GATE_LABELS[spec.gatedBy!]} always require human approval` }
      : { decision: 'recommend_only', reason: `${GATE_LABELS[spec.gatedBy!]} are disabled for JAGR — recommendation only` };
  }

  switch (type) {
    case 'continue_monitoring':
      return { decision: 'execute', reason: 'Monitoring is always permitted' };
    case 'create_task': {
      if (!policy.createTasks) return { decision: 'draft', reason: 'Task creation is off — drafted for you to file' };
      const min = policy.autoFileMinSeverity;
      if (min === 'never') return { decision: 'draft', reason: 'Policy: draft tasks for review, never auto-file' };
      return severityRank(severity) >= severityRank(min as AlertSeverity)
        ? { decision: 'execute', reason: `Auto-file enabled for ${min} findings and above` }
        : { decision: 'draft', reason: `Auto-file starts at ${min} — drafted for you to file` };
    }
    case 'create_incident_draft':
      return policy.createIncidents
        ? { decision: 'execute', reason: 'Incident drafts are permitted (level 3)' }
        : { decision: 'recommend_only', reason: 'Incident drafts are turned off' };
    case 'add_evidence_to_issue':
      return policy.createTasks
        ? { decision: 'execute', reason: 'Updating issues is permitted (level 3)' }
        : { decision: 'recommend_only', reason: 'Task creation is off' };
    case 'notify_oncall': {
      const route = settings.escalation[severity as AlertSeverity];
      if (!settings.criticalEscalation) return { decision: 'recommend_only', reason: 'Critical escalation is turned off' };
      return route === 'immediate'
        ? { decision: 'execute', reason: `${severity} findings escalate immediately` }
        : { decision: 'recommend_only', reason: `${severity} findings go to the ${route.replace('_', ' ')}` };
    }
    case 'draft_slack_message':
      return { decision: 'execute', reason: 'Drafts are permitted (level 3)' };
    default:
      return { decision: 'recommend_only', reason: 'No policy permits execution' };
  }
}

export class GuardrailViolation extends Error {
  constructor(public readonly actionType: ActionType) {
    super(`Refused to execute ${actionType}: requires approved human sign-off`);
    this.name = 'GuardrailViolation';
  }
}

/**
 * Last line of defence, enforced at execution time independently of the planner:
 * a level-4 action cannot run without an approved approval record.
 */
export function assertExecutable(type: ActionType, approval?: { status: string }) {
  if (ACTION_CATALOG[type].level === 4 && approval?.status !== 'approved') throw new GuardrailViolation(type);
}
