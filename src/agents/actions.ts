import type {
  Action,
  ActionType,
  ApprovalRequest,
  Evidence,
  Hypothesis,
  Investigation,
  Priority,
  Severity,
  SourceKind,
  Task,
  TaskDraft,
  Team,
  WorkspaceSettings,
} from '@/domain/types';
import { fmtConfidence } from '@/lib/format';
import { fmtTime } from '@/lib/time';
import { ACTION_CATALOG, assertExecutable, assessRisk, evaluatePolicy, GuardrailViolation } from './policy';
import { callTool, type RunContext } from './context';
import { shortMetricName } from './hypotheses';

/**
 * Turning findings into work: plan candidate actions from the leading hypothesis, classify
 * risk, apply policy, then execute what's allowed and request approval for the rest.
 */

export interface ActionCandidate {
  type: ActionType;
  title: string;
  description: string;
  target?: string;
  context?: { providerShare?: number; blastRadius?: string };
}

const PROVIDER_LABEL: Record<string, string> = { klarna: 'Klarna', paypal: 'PayPal', card: 'Card', apple_pay: 'Apple Pay' };
const PROVIDER_SHARE: Record<string, number> = { klarna: 0.31, paypal: 0.24, card: 0.35, apple_pay: 0.1 };

export function planActions(inv: Investigation, leading: Hypothesis | undefined): ActionCandidate[] {
  if (inv.status === 'dismissed') return [];
  if (inv.status === 'insufficient_evidence' || !leading) {
    return [{ type: 'continue_monitoring', title: `Keep monitoring ${inv.title.toLowerCase()}`, description: 'Re-check every sweep and include it in the digest. JAGR will not assert a cause without evidence.' }];
  }

  const out: ActionCandidate[] = [
    { type: 'create_task', title: 'Create engineering task', description: `File a ${priorityFor(inv.severity, inv)} task for the owning team with the evidence attached.` },
  ];
  const confident = inv.confidenceBand === 'high' || inv.confidenceBand === 'medium';
  const critical = inv.severity === 'critical';

  if (critical && confident) {
    out.push({ type: 'create_incident_draft', title: 'Create incident draft', description: 'Prepare an incident record with timeline and evidence, ready for the incident commander to declare.' });
    out.push({ type: 'notify_oncall', title: 'Notify on-call', description: 'Alert the owning team’s on-call rotation with a link to the investigation.' });
  }
  if (!confident) return out;

  const version = leading.entities.find((e) => /^v\d/.test(e));
  switch (leading.type) {
    case 'provider_regression':
    case 'provider_outage': {
      const p = leading.entities[0];
      const label = PROVIDER_LABEL[p] ?? p;
      out.push({
        type: 'disable_payment_method',
        title: `Disable ${label} checkout`,
        description: `Temporarily hide ${label} at checkout so customers use a working method.`,
        target: p,
        context: { providerShare: PROVIDER_SHARE[p] },
      });
      if (version) {
        out.push({ type: 'rollback_release', title: `Roll back ${version} payment change`, description: `Revert the ${label} change shipped in ${version}.`, target: version, context: { blastRadius: `Reverts every change in ${version}` } });
      }
      if (critical) out.push({ type: 'customer_communication', title: 'Notify affected checkout customers', description: `Tell customers who hit ${label} errors that the issue is known and suggest another payment method.`, target: p });
      break;
    }
    case 'release_regression':
      if (version) out.push({ type: 'rollback_release', title: `Roll back ${version}`, description: `Redeploy the previous version.`, target: version, context: { blastRadius: `Reverts every change in ${version}` } });
      if (critical) out.push({ type: 'customer_communication', title: 'Post status-page update', description: 'Publish a customer-facing status update about degraded service.' });
      break;
    case 'experiment_effect':
      out.push({ type: 'pause_experiment', title: `Pause ${leading.entities[0]}`, description: `Return all users to control until Growth reviews the variant.`, target: leading.entities[0] });
      break;
    default:
      break;
  }
  return out;
}

export function priorityFor(severity: Severity, inv?: Pick<Investigation, 'evidence'>): Priority {
  if (severity === 'critical') return inv?.evidence.some((e) => e.kind === 'reliability_spike') ? 'P0' : 'P1';
  if (severity === 'high') return 'P2';
  return 'P3';
}

export function ownerFor(area: Hypothesis['area'], settings: WorkspaceSettings): string {
  return settings.owners.find((o) => o.area === area)?.teamId ?? 'product';
}

function evidenceLines(list: Evidence[]): string[] {
  const out: string[] = [];
  const normals = list.filter((e) => e.kind === 'provider_normal').map((e) => e.title.replace(' normal', ''));
  for (const e of list) {
    switch (e.kind) {
      case 'provider_normal':
        if (e === list.find((x) => x.kind === 'provider_normal')) {
          const sorted = [...normals].sort((a, b) => (a === 'PayPal' ? -1 : b === 'PayPal' ? 1 : 0));
          out.push(`${sorted.length > 1 ? `${sorted.slice(0, -1).join(', ')} and ${sorted.at(-1)}` : sorted[0]} stable`);
        }
        break;
      case 'traffic_stable':
        out.push(e.title.replace(' normal', ' stable'));
        break;
      case 'deployment':
        out.push(`Release ${e.value} deployed at ${fmtTime(e.observedAt)}`);
        break;
      case 'merged_pr':
        out.push(`${e.title.split(':')[0]} merged at ${fmtTime(e.observedAt)} (${e.title.split(': ').slice(1).join(': ')})`);
        break;
      case 'support_cluster':
        out.push(`${e.value} related support complaints`);
        break;
      default:
        out.push(e.title);
    }
  }
  return out;
}

function nextStep(leading: Hypothesis | undefined, inv: Investigation): string {
  if (!leading || inv.status === 'insufficient_evidence') return 'Check for causes JAGR cannot observe (marketing changes, seasonality, data pipeline) and decide whether to keep monitoring.';
  const version = leading.entities.find((e) => /^v\d/.test(e));
  const pr = inv.evidence.find((e) => e.kind === 'merged_pr' && e.entities.includes(leading.entities[0]));
  switch (leading.type) {
    case 'provider_regression':
      return `Review payment release ${version ?? ''} and the ${PROVIDER_LABEL[leading.entities[0]] ?? leading.entities[0]} integration${pr ? ` (${pr.value})` : ''}.`.replace('  ', ' ');
    case 'provider_outage':
      return `Confirm with ${PROVIDER_LABEL[leading.entities[0]]} support and consider hiding the method at checkout.`;
    case 'release_regression':
      return `Review ${version} and decide on rollback.`;
    case 'experiment_effect':
      return `Growth to review ${leading.entities[0]} results and decide whether to pause the ramp.`;
    case 'demand_shift':
      return 'Check acquisition channels and campaigns for a traffic change.';
    case 'instrumentation':
      return 'Compare event volumes before and after the tracking change.';
    default:
      return 'Review the evidence.';
  }
}

export function buildTaskDraft(inv: Investigation, leading: Hypothesis | undefined, settings: WorkspaceSettings, kind: 'task' | 'incident' = 'task'): TaskDraft {
  const insufficient = inv.status === 'insufficient_evidence' || !leading;
  const supporting = inv.evidence.filter((e) => e.stance === 'supports' && e.kind !== 'anomaly');
  const sources = [...new Set(supporting.map((e) => e.source))] as SourceKind[];
  const primary = inv.impact[0];
  const secondary = inv.impact[1];
  const provider = leading?.type === 'provider_regression' || leading?.type === 'provider_outage' ? PROVIDER_LABEL[leading.entities[0]] : undefined;

  let title: string;
  if (insufficient) title = `Look into ${primary.label.toLowerCase()} decline (${primary.value})`;
  else if (leading!.type === 'provider_regression') title = `Investigate ${provider} checkout regression`;
  else if (leading!.type === 'provider_outage') title = `Mitigate ${provider} outage at checkout`;
  else if (leading!.type === 'release_regression') title = `Investigate regression from release ${leading!.entities[0]}`;
  else if (leading!.type === 'experiment_effect') title = `Review ${leading!.entities[0]} impact on ${shortMetricName(primary.label)}`;
  else title = `Investigate ${primary.label.toLowerCase()} ${primary.value}`;

  if (kind === 'incident') title = `[Draft] ${insufficient ? inv.title : leading!.statement}`;

  const ownerTeamId = ownerFor(insufficient ? (inv.impact.length ? areaOfInvestigation(inv) : 'engagement') : leading!.area, settings);
  return {
    investigationId: inv.id,
    kind,
    title,
    priority: kind === 'incident' ? (priorityFor(inv.severity, inv) === 'P0' ? 'P0' : 'P1') : priorityFor(inv.severity, inv),
    ownerTeamId,
    evidenceSourceCount: sources.length,
    fingerprint: `${kind}:${inv.fingerprint}`,
    description: {
      problem: `${primary.label} ${primary.value.startsWith('−') ? 'declined' : 'changed'} ${primary.value.replace('−', '')} overnight (${primary.detail}).`,
      impact: secondary ? `${secondary.label} ${secondary.value.startsWith('−') ? 'declined' : 'changed'} ${secondary.value.replace('−', '').replace('+', '')}.` : 'Impact limited to the metric above.',
      evidence: insufficient ? inv.evidence.filter((e) => e.kind !== 'anomaly').map((e) => e.title) : evidenceLines(supporting),
      hypothesis: insufficient ? 'Insufficient evidence — no cause identified.' : leading!.statement,
      confidence: insufficient ? 'Insufficient evidence' : fmtConfidence(inv.confidence),
      nextStep: nextStep(leading, inv),
      sources: insufficient ? [...new Set(inv.evidence.map((e) => e.source))] : sources,
    },
  };
}

function areaOfInvestigation(inv: Investigation): Hypothesis['area'] {
  const id = inv.primarySignalId.replace('sig-', '');
  if (id.startsWith('feature_') || id === 'dau' || id === 'sessions') return 'engagement';
  if (id.startsWith('activation')) return 'activation';
  if (id.includes('checkout') || id.includes('payment')) return 'payments';
  return 'growth';
}

// ─────────────────────────────────────────────────────────────
// Decide + execute
// ─────────────────────────────────────────────────────────────

export interface ActionOutcome {
  actions: Action[];
  approvals: ApprovalRequest[];
  tasks: Task[];
  drafts: TaskDraft[];
  notified: string[];
}

export interface DecideOptions {
  /** Test hook: simulate a faulty planner that marks gated actions executable. */
  plannerOverride?: (a: Action) => Action;
  skipTypes?: Set<string>;
}

export async function determineAndExecute(
  ctx: RunContext,
  inv: Investigation,
  leading: Hypothesis | undefined,
  candidates: ActionCandidate[],
  teams: Team[],
  opts: DecideOptions = {},
): Promise<ActionOutcome> {
  const out: ActionOutcome = { actions: [], approvals: [], tasks: [], drafts: [], notified: [] };

  for (const c of candidates) {
    const key = `${c.type}:${c.target ?? ''}`;
    if (opts.skipTypes?.has(key)) continue;
    const spec = ACTION_CATALOG[c.type];
    const risk = assessRisk(c.type, c.context ?? {});
    const policy = evaluatePolicy(c.type, inv.severity, ctx.settings);

    ctx.clock.advance(1);
    ctx.log({
      stage: 'risk',
      action: `Risk assessment: ${c.title}`,
      result: `${risk.risk.toUpperCase()} risk · level ${spec.level}${spec.gatedBy ? ` · gated by ${spec.gatedBy.replace('_', ' ')}` : ''}`,
      status: 'info',
      risk: risk.risk,
      investigationId: inv.id,
      input: risk.reasons.join('; '),
    });

    let action: Action = {
      id: ctx.nextId('act'),
      investigationId: inv.id,
      type: c.type,
      title: c.title,
      description: c.description,
      risk: risk.risk,
      requiredLevel: spec.level,
      gatedBy: spec.gatedBy,
      decision: policy.decision,
      decisionReason: policy.reason,
      status: 'recommended',
      target: c.target,
      createdAt: ctx.clock.now(),
    };
    if (opts.plannerOverride) action = opts.plannerOverride(action);

    ctx.log({
      stage: 'decide',
      action: `Decision: ${c.title}`,
      result: decisionLabel(action.decision),
      decision: action.decision,
      status: action.decision === 'require_approval' ? 'warning' : 'info',
      risk: action.risk,
      approvalStatus: action.decision === 'require_approval' ? 'required' : 'not_required',
      investigationId: inv.id,
      input: action.decisionReason,
    });

    if (action.decision === 'execute') {
      try {
        assertExecutable(action.type); // guardrail, independent of the planner
        await executeAllowedAction(ctx, inv, leading, action, teams, out);
      } catch (err) {
        if (err instanceof GuardrailViolation) {
          action.status = 'blocked';
          action.result = 'Blocked by guardrail: level-4 actions need an approved human sign-off';
          ctx.log({ stage: 'act', action: `Blocked: ${action.title}`, result: action.result, status: 'blocked', risk: action.risk, approvalStatus: 'required', investigationId: inv.id });
        } else {
          action.status = 'failed';
          action.result = err instanceof Error ? err.message : String(err);
          ctx.log({ stage: 'act', action: `Failed: ${action.title}`, result: action.result, status: 'error', investigationId: inv.id });
          if (action.type === 'create_task') out.drafts.push(buildTaskDraft(inv, leading, ctx.settings));
        }
      }
    } else if (action.decision === 'require_approval') {
      const approval = requestApproval(ctx, inv, action, c);
      action.status = 'pending_approval';
      action.approvalId = approval.id;
      out.approvals.push(approval);
    } else if (action.decision === 'draft') {
      action.status = 'drafted';
      action.result = 'Draft ready — file it from the investigation or Tasks';
      out.drafts.push(buildTaskDraft(inv, leading, ctx.settings));
    } else if (action.decision === 'not_permitted') {
      action.status = 'not_permitted';
    } else {
      action.status = 'recommended';
    }
    out.actions.push(action);
  }
  return out;
}

export function decisionLabel(d: Action['decision']): string {
  return {
    execute: 'Execute (permitted, low risk)',
    draft: 'Draft for human to file',
    require_approval: 'HUMAN APPROVAL REQUIRED',
    recommend_only: 'Recommend only',
    not_permitted: 'Not permitted by policy',
  }[d];
}

async function executeAllowedAction(ctx: RunContext, inv: Investigation, leading: Hypothesis | undefined, action: Action, teams: Team[], out: ActionOutcome) {
  const tracker = ctx.adapters.issueTracker;
  switch (action.type) {
    case 'create_task':
    case 'create_incident_draft': {
      const kind = action.type === 'create_incident_draft' ? 'incident' : 'task';
      const draft = buildTaskDraft(inv, leading, ctx.settings, kind);
      const existing = await callTool(
        ctx,
        { tool: 'issueTracker.findOpenByFingerprint', source: 'issue_tracker', stage: 'act', action: 'Checked for an existing open issue', input: draft.fingerprint, investigationId: inv.id, routine: true },
        () => tracker.findOpenByFingerprint(draft.fingerprint),
        (v) => (v ? `Found ${v.id}` : 'None found'),
      );
      if (!existing.ok) throw new Error(existing.error);
      if (existing.value) {
        const updated = await tracker.addComment(existing.value.id, { at: ctx.clock.now(), author: 'nightwatch', body: `Seen again tonight. ${draft.description.evidence.join(' · ')}` });
        action.status = 'executed';
        action.taskId = updated.id;
        action.result = `Already open as ${updated.id} — added tonight's evidence instead of filing a duplicate`;
        ctx.log({ stage: 'act', action: `Updated ${updated.id}`, tool: 'issueTracker.addComment', result: action.result, status: 'ok', risk: 'low', approvalStatus: 'not_required', investigationId: inv.id });
        out.tasks.push(updated);
        return;
      }
      const created = await callTool(
        ctx,
        { tool: 'issueTracker.createIssue', source: 'issue_tracker', stage: 'act', action: kind === 'incident' ? 'Created incident draft' : 'Created engineering task', input: `${draft.title} · ${draft.priority} · ${teams.find((t) => t.id === draft.ownerTeamId)?.name}`, investigationId: inv.id },
        () => tracker.createIssue(draft, ctx.clock.now()),
        (v) => `${v.id} — ${v.title}`,
      );
      if (!created.ok) throw new Error(`Issue tracker unavailable: ${kind} not filed`);
      action.status = 'executed';
      action.taskId = created.value.id;
      action.result = `${created.value.id} created in ${tracker.label.toLowerCase()}`;
      out.tasks.push(created.value);
      return;
    }
    case 'notify_oncall': {
      const owner = leading ? ownerFor(leading.area, ctx.settings) : 'product';
      const team = teams.find((t) => t.id === owner);
      const rotation = team?.onCall ?? 'oncall';
      const res = await callTool(
        ctx,
        { tool: 'notifications.notifyOnCall', source: 'notifications', stage: 'act', action: `Notified ${rotation}`, input: inv.title, investigationId: inv.id },
        () => ctx.adapters.notifications.notifyOnCall(rotation, `${inv.title}. ${leading?.statement ?? ''} (${fmtConfidence(inv.confidence)})`, ctx.clock.now()),
        () => `Critical finding sent to #${rotation} (simulated)`,
      );
      if (!res.ok) throw new Error('Notification channel unavailable');
      action.status = 'executed';
      action.result = `#${rotation} notified at ${fmtTime(ctx.clock.now())} (simulated)`;
      out.notified.push(rotation);
      return;
    }
    case 'continue_monitoring':
      action.status = 'executed';
      action.result = 'Will re-check every sweep; included in the daily digest';
      ctx.log({ stage: 'act', action: 'Continue monitoring', result: action.result, status: 'ok', risk: 'low', approvalStatus: 'not_required', investigationId: inv.id });
      return;
    default:
      action.status = 'executed';
      action.result = 'Draft saved';
  }
}

export function requestApproval(ctx: RunContext, inv: Investigation, action: Action, c: ActionCandidate): ApprovalRequest {
  const supporting = inv.evidence.filter((e) => e.stance === 'supports');
  const sources = [...new Set(supporting.map((e) => e.source))] as SourceKind[];
  const approval: ApprovalRequest = {
    id: ctx.nextId('apr'),
    actionId: action.id,
    investigationId: inv.id,
    actionType: action.type,
    title: action.title,
    risk: action.risk,
    gatedBy: action.gatedBy!,
    reason: approvalReason(inv, action),
    evidenceIds: supporting.map((e) => e.id),
    evidenceSources: sources,
    potentialImpact: potentialImpact(action, c),
    reversibility: ACTION_CATALOG[action.type].reversibility,
    confidence: inv.confidence ?? 0,
    requestedAt: ctx.clock.now(),
    status: 'pending',
    supplementalEvidence: [],
    fingerprint: `${action.type}:${action.target ?? ''}:${inv.fingerprint}`,
  };
  ctx.log({
    stage: 'approval',
    action: `Requested approval: ${action.title}`,
    result: `${action.risk.toUpperCase()} risk — waiting for a human`,
    status: 'warning',
    risk: action.risk,
    approvalStatus: 'pending',
    investigationId: inv.id,
  });
  return approval;
}

/** Keep a pending request current when the investigation is refreshed (reason, evidence, confidence). */
export function refreshApproval(inv: Investigation, a: ApprovalRequest): ApprovalRequest {
  if (a.status !== 'pending') return a;
  const supporting = inv.evidence.filter((e) => e.stance === 'supports');
  return {
    ...a,
    reason: approvalReason(inv, { type: a.actionType, target: a.fingerprint.split(':')[1] || undefined }),
    evidenceIds: supporting.map((e) => e.id),
    evidenceSources: [...new Set(supporting.map((e) => e.source))] as SourceKind[],
    confidence: inv.confidence ?? a.confidence,
  };
}

function approvalReason(inv: Investigation, action: Pick<Action, 'type' | 'target'>): string {
  const outlier = inv.evidence.find((e) => e.kind === 'provider_outlier');
  const driver = inv.evidence.find((e) => e.kind === 'driver_moved');
  switch (action.type) {
    case 'disable_payment_method':
      return `Elevated ${PROVIDER_LABEL[action.target ?? ''] ?? 'provider'} failures (${outlier?.value}) correlate with the ${driver ? `${driver.title.replace(/\s[+−-][\d.]+(%| pts)$/, '').toLowerCase()} decline (${driver.value})` : 'conversion decline'}.`;
    case 'rollback_release':
      return `${action.target} shipped inside the first degraded window and is the leading explanation (${fmtConfidence(inv.confidence)}).`;
    case 'customer_communication':
      return `Customers are hitting errors at checkout; ${inv.relatedTicketIds.length} have already contacted support.`;
    case 'pause_experiment':
      return `${action.target} variant is underperforming control since tonight's ramp.`;
    default:
      return inv.conclusion;
  }
}

function potentialImpact(action: Action, c: ActionCandidate): string {
  switch (action.type) {
    case 'disable_payment_method':
      return `${PROVIDER_LABEL[action.target ?? '']} customers (~${Math.round((c.context?.providerShare ?? 0) * 100)}% of checkout attempts) would not see the option and may be unable to complete checkout.`;
    case 'rollback_release':
      return `Reverts all changes in ${action.target}, including unrelated work shipped in the same release.`;
    case 'customer_communication':
      return 'A customer-facing message is sent and cannot be recalled.';
    case 'pause_experiment':
      return 'All users return to control; the experiment loses tonight’s data.';
    default:
      return 'Changes production behaviour.';
  }
}
