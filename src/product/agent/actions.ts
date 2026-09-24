import type { ActionDecision, ActionKind, ActionRisk, AgentHypothesis, AttentionLevel, ProposedAction, WatchInvestigation } from '../types';
import { AREA_LABEL } from '../catalog';
import type { IssueRecord, ReleaseRecord } from '../integrations/types';
import { atLeast } from '../engine/attention';

/**
 * Risk-based autonomy.
 *
 *   LOW       → autonomous: Jagr does it (internal, reversible)
 *   MEDIUM    → recommend: Jagr suggests it; one click from the PM
 *   HIGH      → prepare + notify: prepared, but a human must approve it
 *   CRITICAL  → approval required: consequential; nothing happens without a human
 *
 * Rollbacks, rollout changes, customer communication, pricing, refunds and production
 * configuration are never autonomous — they are always HIGH or CRITICAL.
 */

export const AUTONOMY: Record<ActionRisk, ProposedAction['autonomy']> = {
  LOW: 'autonomous',
  MEDIUM: 'recommend',
  HIGH: 'prepare_and_notify',
  CRITICAL: 'approval_required',
};

export const RISK_OF: Record<ActionKind, ActionRisk> = {
  link_issues: 'LOW',
  create_jira_task: 'MEDIUM',
  create_jira_incident: 'MEDIUM',
  pause_rollout: 'HIGH',
  rollback_release: 'CRITICAL',
  notify_customers: 'CRITICAL',
};

export class ApprovalRequiredError extends Error {
  constructor(public readonly action: ProposedAction) {
    super(`"${action.title}" is ${action.risk} risk and cannot run without human approval`);
    this.name = 'ApprovalRequiredError';
  }
}

/** The one place actions execute. Enforced here, independently of whatever proposed the action. */
export function executeAction(action: ProposedAction, decision?: ActionDecision): string {
  const needsHuman = action.risk === 'HIGH' || action.risk === 'CRITICAL';
  if (needsHuman && decision?.status !== 'approved') throw new ApprovalRequiredError(action);
  if (action.risk === 'MEDIUM' && decision?.status !== 'approved' && decision?.status !== 'done') throw new ApprovalRequiredError(action);
  const option = action.options?.find((o) => o.id === decision?.optionId);
  switch (action.kind) {
    case 'link_issues':
      return `${action.result ?? 'Linked the related Jira issues to this investigation'} (simulated — no Jira write was made).`;
    case 'pause_rollout':
      return `${option?.label ?? action.title} — recorded in the simulated environment. No store rollout was changed.`;
    case 'rollback_release':
      return `${option?.label ?? action.title} — queued in the simulated environment. No production system was changed.`;
    case 'notify_customers':
      return `${option?.label ?? action.title} — recorded as sent in the simulation. No customer was contacted.`;
    default:
      return action.title.startsWith('Draft')
        ? `${action.title} — saved as a draft in Jagr. Not filed in any external tracker.`
        : `${action.title} — done in the simulated issue tracker.`;
  }
}

function make(inv: WatchInvestigation, kind: ActionKind, at: string, fields: Omit<ProposedAction, 'id' | 'investigationId' | 'kind' | 'risk' | 'autonomy' | 'status' | 'proposedAt'>): ProposedAction {
  const risk = RISK_OF[kind];
  return {
    id: `act-${inv.id}-${kind}`,
    investigationId: inv.id,
    kind,
    risk,
    autonomy: AUTONOMY[risk],
    status: risk === 'LOW' ? 'executed' : risk === 'MEDIUM' ? 'recommended' : 'awaiting_approval',
    proposedAt: at,
    ...fields,
  };
}

/** Decide what Jagr should do about an investigation. Pure: the same investigation gives the same proposals. */
export function proposeActions(args: {
  inv: WatchInvestigation;
  hypotheses: AgentHypothesis[];
  attention: AttentionLevel;
  issues: IssueRecord[];
  releases: ReleaseRecord[];
  at: string;
  /** 'imported': issues came from the user's file — nothing to link or file in an external tracker. */
  issueSource?: 'imported';
}): ProposedAction[] {
  const { inv, hypotheses, attention, issues, releases, at } = args;
  const imported = args.issueSource === 'imported';
  if (!atLeast(attention, 'MEDIUM')) return [];
  const out: ProposedAction[] = [];
  const area = AREA_LABEL[inv.area].toLowerCase();
  const supporting = inv.evidence.filter((e) => e.direction === 'degraded' || e.direction === 'change').map((e) => e.statement);
  const release = hypotheses.find((h) => h.kind === 'release_related');
  const releaseLive = !!release && release.status !== 'ruled_out' && (release.strength === 'moderate' || release.strength === 'strong');
  const version = inv.releaseAssociation?.version;
  // Never propose writing to a source Jagr knows is down as if it would just work.
  const jiraDown = imported || inv.evidence.some((e) => e.provider === 'jira' && e.direction === 'gap');
  const jiraNote = imported
    ? ' Jira is not connected to this workspace: Jagr prepares it as a draft you can copy into your tracker.'
    : jiraDown
      ? ' Jira is unavailable right now: Jagr holds this as a draft and files it once Jira responds.'
      : '';

  const product = issues.filter((i) => !i.labels.includes('payment-provider'));
  if (product.length) {
    out.push(
      make(inv, 'link_issues', at, {
        title: `Link ${product.length} ${imported ? 'imported' : 'Jira'} ${product.length === 1 ? 'issue' : 'issues'} to this investigation`,
        why: 'These issues describe the same problem; linking them saves triage from rediscovering it.',
        evidence: product.slice(0, 4).map((i) => `${i.id}: ${i.title}`),
        whatWillHappen: imported ? `Links ${product.map((i) => i.id).join(', ')} to this investigation inside Jagr. Nothing is written to an external tracker.` : `Adds a comment with the Jagr investigation link to ${product.map((i) => i.id).join(', ')}.`,
        whatCouldGoWrong: 'Minimal — a comment can be deleted. No status, owner or priority changes.',
        reversible: true,
        result: `Linked ${product.map((i) => i.id).join(', ')} to this investigation`,
      }),
    );
  }

  if (atLeast(attention, 'HIGH')) {
    out.push(
      make(inv, 'create_jira_incident', at, {
        title: `${jiraDown ? 'Draft' : 'Open'} a Jira incident for the ${area} degradation`,
        why: `${inv.attention} attention: a core ${area} degradation corroborated across sources needs an owner now.`,
        evidence: supporting.slice(0, 5),
        whatWillHappen: `Creates an incident ticket with the evidence, the timeline and a link back to this investigation.${jiraNote}`,
        whatCouldGoWrong: 'Starts the incident process for something that might resolve on its own.',
        reversible: true,
      }),
    );
  } else {
    out.push(
      make(inv, 'create_jira_task', at, {
        title: `${jiraDown ? 'Draft' : 'Create'} a Jira task to look into the ${area} change`,
        why: 'Persistent, but not strong enough to interrupt anyone — worth a look during working hours.',
        evidence: supporting.slice(0, 4),
        whatWillHappen: `Creates a task in the owning team’s backlog with the evidence attached.${jiraNote}`,
        whatCouldGoWrong: 'Adds backlog noise if the change turns out to be a measurement artifact.',
        reversible: true,
      }),
    );
  }

  const staged = releases.find((r) => r.version === version && r.rollout && /staged|phased/i.test(r.rollout));
  if (atLeast(attention, 'HIGH') && releaseLive && staged) {
    out.push(
      make(inv, 'pause_rollout', at, {
        title: `Pause the ${version} rollout`,
        why: `The ${area} degradation began ${inv.releaseAssociation?.minutesBeforeOnset} minutes after ${version} started rolling out. Pausing limits exposure while the team investigates — it does not assume the release is the cause.`,
        evidence: supporting.slice(0, 5),
        whatWillHappen: `Halts further rollout of ${version}; users who already have it keep it.`,
        whatCouldGoWrong: 'If the release is not the cause, fixes shipped in it are delayed and the degradation continues.',
        reversible: true,
        options: [
          { id: 'android', label: `Pause the Android staged rollout of ${version}`, description: 'Stops the 20% Google Play rollout from growing.' },
          { id: 'both', label: `Pause Android and iOS rollouts of ${version}`, description: 'Also pauses the App Store phased release.' },
        ],
      }),
    );
  }

  if (attention === 'CRITICAL') {
    if (releaseLive && version) {
      out.push(
        make(inv, 'rollback_release', at, {
          title: `Roll back ${version}`,
          why: 'Severe customer impact that began right after the release. A rollback is the fastest way to test whether the release is involved.',
          evidence: supporting.slice(0, 5),
          whatWillHappen: `Redeploys the previous version on every platform.`,
          whatCouldGoWrong: `Reverts every change in ${version}, including unrelated fixes; if the release is not the cause, users lose those fixes and the incident continues.`,
          reversible: false,
          options: [
            { id: 'all', label: `Roll back ${version} on all platforms`, description: 'Web, iOS and Android.' },
            { id: 'web', label: `Roll back ${version} on web only`, description: 'Smaller blast radius; mobile users unaffected.' },
          ],
        }),
      );
    }
    out.push(
      make(inv, 'notify_customers', at, {
        title: `Tell affected customers about the ${area} problem`,
        why: 'Customers are failing at a core step right now and support contacts are rising.',
        evidence: supporting.slice(0, 4),
        whatWillHappen: 'Shows a status message to customers in the affected flow.',
        whatCouldGoWrong: 'Cannot be unsent; an inaccurate message damages trust more than silence.',
        reversible: false,
        options: [
          { id: 'banner', label: 'In-app status banner', description: 'Visible only to customers in the affected flow.' },
          { id: 'status_page', label: 'Public status page update', description: 'Visible to everyone.' },
        ],
      }),
    );
  }
  return out;
}
