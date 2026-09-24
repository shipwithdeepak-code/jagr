import type { AdapterSet } from '@/adapters/types';
import type { ApprovalRequest, Evidence, Investigation } from '@/domain/types';
import { fmtPts } from '@/lib/format';
import { addMinutes, fmtTime } from '@/lib/time';
import { assertExecutable } from './policy';

/**
 * What happens after a human responds to an approval request.
 */

const PROVIDER_LABEL: Record<string, string> = { klarna: 'Klarna', paypal: 'PayPal', card: 'Cards', apple_pay: 'Apple Pay' };

/**
 * Execute an approved action. In this build every consequential action runs against the simulated
 * environment only — no production system is touched. The guardrail is still enforced here.
 */
export function executeApprovedAction(approval: ApprovalRequest, at: string): string {
  assertExecutable(approval.actionType, approval);
  switch (approval.actionType) {
    case 'disable_payment_method':
      return `${approval.title.replace('Disable ', '')} disabled in the simulated payment configuration at ${fmtTime(at)}. No production system was changed.`;
    case 'rollback_release':
      return `Rollback queued in the simulated deploy pipeline at ${fmtTime(at)}. No production system was changed.`;
    case 'customer_communication':
      return `Customer message recorded as sent in the simulation at ${fmtTime(at)}. No customer was contacted.`;
    case 'pause_experiment':
      return `Experiment paused in the simulated experiment platform at ${fmtTime(at)}. No production system was changed.`;
    default:
      return `Executed in simulation at ${fmtTime(at)}.`;
  }
}

/**
 * "Request more evidence": Nightwatch runs targeted follow-up queries for this specific action
 * and attaches what it finds to the request, so the approver can decide with more context.
 */
export async function gatherSupplementalEvidence(
  approval: ApprovalRequest,
  inv: Investigation,
  adapters: AdapterSet,
  asOf: string,
): Promise<{ evidence: Evidence[]; notes: string[] }> {
  const out: Evidence[] = [];
  const notes: string[] = [];
  const mk = (key: string, e: Omit<Evidence, 'id' | 'stance' | 'observedAt' | 'observationIds'>): Evidence => ({
    id: `${approval.id}:more:${key}`,
    stance: 'context',
    observedAt: asOf,
    observationIds: [],
    ...e,
  });

  try {
    if (approval.actionType === 'disable_payment_method' || approval.actionType === 'customer_communication') {
      const provider = approval.fingerprint.split(':')[1] || 'klarna';
      const lastHour = await adapters.payments.getProviderBreakdown({ start: addMinutes(asOf, -60), end: asOf });
      const p = lastHour.find((x) => x.provider === provider);
      if (p) {
        out.push(
          mk('last-hour', {
            kind: 'provider_outlier',
            source: 'payments',
            title: `${p.label} still failing in the last hour`,
            detail: `${p.label} error rate over the last 60 minutes is ${p.errorRate.toFixed(1)}% (${fmtPts(p.errorRate - p.baselineErrorRate)} vs baseline) — the problem is not recovering on its own.`,
            value: `${p.errorRate.toFixed(1)}%`,
            strength: 1,
            entities: [provider],
          }),
        );
        const others = lastHour.filter((x) => x.provider !== provider);
        const share = p.attempts / Math.max(1, lastHour.reduce((a, x) => a + x.attempts, 0));
        out.push(
          mk('fallback', {
            kind: 'provider_normal',
            source: 'payments',
            title: 'Alternatives are healthy',
            detail: `${others.map((o) => `${o.label} ${o.errorRate.toFixed(1)}%`).join(', ')}. ${PROVIDER_LABEL[provider]} carried ${Math.round(share * 100)}% of attempts; those customers would need another method.`,
            value: `${Math.round(share * 100)}% share`,
            strength: 1,
            entities: others.map((o) => o.provider),
          }),
        );
      }
    }

    if (approval.actionType === 'rollback_release') {
      const version = approval.fingerprint.split(':')[1];
      const release = inv.releases.find((r) => r.version === version);
      if (release) {
        const unrelated = release.pullRequests.filter((p) => !p.relevant);
        out.push(
          mk('blast-radius', {
            kind: 'merged_pr',
            source: 'github',
            title: `Rollback also reverts ${unrelated.length} unrelated PR${unrelated.length === 1 ? '' : 's'}`,
            detail: `${version} contains ${release.pullRequests.length} PRs. Rolling back also reverts: ${unrelated.map((p) => `#${p.number} ${p.title}`).join('; ') || 'nothing else'}. A targeted revert of the implicated PR would have a smaller blast radius.`,
            value: `${release.pullRequests.length} PRs`,
            strength: 1,
            entities: [version],
          }),
        );
      }
    }

    if (approval.actionType === 'pause_experiment') {
      const exps = await adapters.experiments.listActiveExperiments(asOf);
      const exp = exps.find((e) => e.name === approval.fingerprint.split(':')[1]);
      const control = exp?.results.find((r) => r.variant === 'control');
      const variant = exp?.results.find((r) => r.variant !== 'control');
      if (exp && control && variant) {
        out.push(
          mk('exp-sample', {
            kind: 'experiment_result',
            source: 'experiments',
            title: `${(control.users + variant.users).toLocaleString('en-US')} users in the comparison`,
            detail: `Control ${control.value}% (${control.users.toLocaleString('en-US')} users) vs ${variant.variant} ${variant.value}% (${variant.users.toLocaleString('en-US')} users). Pausing affects iOS onboarding only; web and Android are not enrolled.`,
            value: `${variant.value}% vs ${control.value}%`,
            strength: 1,
            entities: [exp.name],
          }),
        );
      }
    }

    const tickets = await adapters.support.searchTickets({ start: inv.onsetAt ?? addMinutes(asOf, -600), end: addMinutes(asOf, 1) });
    const related = tickets.filter((t) => inv.relatedTicketIds.includes(t.id));
    if (related.length) {
      out.push(
        mk('tickets', {
          kind: 'support_cluster',
          source: 'support',
          title: `Latest customer report: ${related.at(-1)!.id}`,
          detail: `"${related.at(-1)!.subject}" at ${fmtTime(related.at(-1)!.createdAt)}. ${related.length} related tickets in total.`,
          value: String(related.length),
          strength: 1,
          entities: ['customers'],
        }),
      );
    }
  } catch (err) {
    notes.push(`A follow-up query failed: ${err instanceof Error ? err.message : String(err)}. Nightwatch attached what it could.`);
  }

  if (!out.length) notes.push('No additional evidence was available for this action.');
  return { evidence: out, notes };
}
