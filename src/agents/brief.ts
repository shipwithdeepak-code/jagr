import type {
  Action,
  AgentEvent,
  ApprovalRequest,
  BriefEvidenceItem,
  BriefNotDone,
  Evidence,
  EvidenceKind,
  Investigation,
  MorningBrief,
  Signal,
  Task,
} from '@/domain/types';
import { severityRank } from './detection';
import { ACTION_CATALOG } from './policy';

const EVIDENCE_ORDER: EvidenceKind[] = [
  'driver_moved',
  'provider_outlier',
  'provider_normal',
  'traffic_stable',
  'traffic_drop',
  'experiment_result',
  'experiment_change',
  'segment_concentrated',
  'support_cluster',
  'deployment',
  'reliability_spike',
  'merged_pr',
  'provider_error_signature',
];

const TOOL_PHRASES: Record<string, (inv: Investigation) => string> = {
  'analytics.decompose': (inv) => (inv.playbook === 'purchase_funnel' ? 'Investigated checkout funnel' : `Decomposed ${inv.title.split(' ')[0].toLowerCase()} by driver and segment`),
  'payments.getProviderBreakdown': () => 'Compared payment providers',
  'github.listDeployments': () => 'Reviewed recent releases',
  'support.searchTickets': (inv) => (inv.relatedTicketIds.length ? 'Reviewed support complaints' : 'Checked support for related complaints'),
  'experiments.listActiveExperiments': () => 'Checked active experiments',
};

function briefEvidence(inv: Investigation): BriefEvidenceItem[] {
  const pick: Evidence[] = [];
  for (const kind of EVIDENCE_ORDER) {
    for (const e of inv.evidence.filter((x) => x.kind === kind && x.stance !== 'contradicts')) {
      // Keep the brief tight: one "normal" provider (prefer PayPal), one PR.
      if (kind === 'provider_normal' && pick.some((p) => p.kind === 'provider_normal')) continue;
      if (kind === 'driver_moved' && pick.some((p) => p.kind === 'driver_moved')) continue;
      if (kind === 'merged_pr' && pick.some((p) => p.kind === 'merged_pr' || p.kind === 'deployment')) continue;
      if (kind === 'provider_error_signature' && pick.length >= 6) continue;
      pick.push(e);
    }
  }
  const normals = inv.evidence.filter((e) => e.kind === 'provider_normal');
  const paypal = normals.find((e) => e.entities.includes('paypal'));
  const ordered = pick.map((e) => (e.kind === 'provider_normal' && paypal ? paypal : e));
  return ordered.slice(0, 6).map((e) => ({
    label: labelFor(e),
    value: e.value ?? '',
    tone: e.kind === 'provider_normal' || e.kind === 'traffic_stable' || e.kind === 'segment_concentrated' ? 'neutral' : 'bad',
    source: e.source,
  }));
}

function labelFor(e: Evidence): string {
  switch (e.kind) {
    case 'driver_moved':
    case 'reliability_spike':
      return e.title.replace(/\s[+−-][\d.,]+(%| pts)$/, '');
    case 'provider_outlier':
      return e.title.replace(/\s[+−-][\d.,]+ pts$/, '');
    case 'provider_normal':
      return e.title.replace(' normal', '');
    case 'traffic_stable':
    case 'traffic_drop':
      return e.title.replace(/ (normal|[+−-][\d.]+%)$/, '');
    case 'support_cluster':
      return 'Support complaints';
    case 'deployment':
      return 'Recent release';
    case 'experiment_result':
      return 'Variant vs control';
    case 'experiment_change':
      return 'Experiment change';
    case 'segment_concentrated':
      return 'Affected segment';
    default:
      return e.title;
  }
}

export function summariseInvestigation(inv: Investigation): string {
  const leading = inv.hypotheses.find((h) => h.id === inv.leadingHypothesisId);
  switch (inv.status) {
    case 'concluded':
      return `Likely related to ${lowerFirst(leading?.statement ?? 'an unidentified cause')}.`;
    case 'low_confidence':
      return `Possibly ${lowerFirst(leading?.statement ?? 'unexplained')} — confidence is low, so Nightwatch filed work but did not recommend production changes.`;
    case 'insufficient_evidence':
      return 'Insufficient evidence. No release, experiment, provider or support signal explains the change.';
    case 'dismissed':
      return 'Recovered on its own with no corroborating evidence. No action taken.';
    default:
      return 'Investigation in progress.';
  }
}

function lowerFirst(s: string) {
  return /^[A-Z][a-z]/.test(s) && !/^(Klarna|PayPal|Apple|Card)/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

export function generateMorningBrief(args: {
  runId: string;
  generatedAt: string;
  window: { start: string; end: string };
  signals: Signal[];
  investigations: Investigation[];
  actions: Action[];
  approvals: ApprovalRequest[];
  tasks: Task[];
  events: AgentEvent[];
}): MorningBrief {
  const { signals, investigations, actions, events } = args;
  const watched = signals.filter((s) => s.watched);
  const open = investigations.filter((i) => i.status !== 'dismissed').sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const critical = open.filter((i) => i.severity === 'critical');
  const attention = open.filter((i) => i.severity !== 'critical');
  const anomalous = watched.filter((s) => s.status === 'anomalous');
  const head = open[0];

  const did: string[] = [];
  const didNot: BriefNotDone[] = [];
  const escalations: string[] = [];

  if (head) {
    const invEvents = events.filter((e) => e.investigationId === head.id);
    const seen = new Set<string>();
    for (const e of invEvents) {
      const phrase = e.tool && TOOL_PHRASES[e.tool]?.(head);
      if (phrase && !seen.has(phrase) && e.status === 'ok') {
        seen.add(phrase);
        did.push(phrase);
      }
    }
    if (head.hypotheses.length) did.push(`Correlated evidence across ${head.sourcesQueried.length} sources`);
    for (const a of actions.filter((x) => x.investigationId === head.id)) {
      if (a.status !== 'executed') continue;
      if (a.type === 'create_task') did.push(`Created engineering task ${a.taskId}`);
      if (a.type === 'create_incident_draft') did.push(`Created incident draft ${a.taskId}`);
      if (a.type === 'notify_oncall') did.push(`Notified on-call (${a.result?.split(' ')[0]})`);
    }
    for (const a of actions.filter((x) => x.investigationId === head.id && ACTION_CATALOG[x.type].level === 4)) {
      const label = a.type === 'disable_payment_method' ? `${a.title.replace('Disable ', '').replace(' checkout', '')} disablement` : ACTION_CATALOG[a.type].label;
      didNot.push({
        label,
        status: 'Not performed',
        reason: a.decision === 'require_approval' ? 'Requires human approval' : a.decisionReason,
        approvalId: a.approvalId,
      });
    }
  }

  for (const a of actions.filter((x) => x.type === 'notify_oncall' && x.status === 'executed')) {
    escalations.push(a.result ?? 'On-call notified');
  }

  const primary = head ? signals.find((s) => s.id === head.primarySignalId) : undefined;

  return {
    runId: args.runId,
    generatedAt: args.generatedAt,
    window: args.window,
    counts: {
      critical: critical.length,
      attention: attention.length,
      normal: watched.length - anomalous.length,
      signals: watched.length,
      anomalies: anomalous.length,
      dismissed: investigations.filter((i) => i.status === 'dismissed').length,
    },
    headline:
      head && primary
        ? {
            investigationId: head.id,
            severity: head.severity,
            metricName: primary.name,
            changePct: primary.changePct,
            confidence: head.status === 'insufficient_evidence' ? undefined : head.confidence,
            statement: summariseInvestigation(head),
            status: head.status,
          }
        : undefined,
    evidence: head ? briefEvidence(head) : [],
    did,
    didNot,
    findings: open.map((i) => ({
      investigationId: i.id,
      severity: i.severity,
      title: i.title,
      summary: summariseInvestigation(i),
      confidence: i.status === 'insufficient_evidence' ? undefined : i.confidence,
      status: i.status,
      route: i.escalation,
    })),
    escalations,
    quiet: open.length === 0,
  };
}
