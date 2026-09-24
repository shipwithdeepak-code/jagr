import { fmtTime } from '@/lib/time';
import type { EmailButton, EmailNotification, Watch, WatchInvestigation } from '../types';
import { DEMO_RECIPIENT, EMAIL_FROM } from '../catalog';
import { ATTENTION_RANK, atLeast } from './attention';

/**
 * Notification policy and email composition. The email is a decision surface:
 * what changed, what Jagr found, the likely explanation, what's uncertain, the next step,
 * and direct links into Jagr and into each source.
 */

export interface NotifyDecision {
  send: boolean;
  trigger?: EmailNotification['trigger'];
  reason: string;
}

export function decideNotification(inv: WatchInvestigation, watch: Watch): NotifyDecision {
  const already = inv.notifiedLevels.reduce((m, l) => Math.max(m, ATTENTION_RANK[l]), -1);
  if (ATTENTION_RANK[inv.attention] <= already) return { send: false, reason: 'Already notified at this level — deduplicated.' };
  if (inv.attention === 'CRITICAL') return { send: true, trigger: already >= 0 ? 'escalated' : 'immediate', reason: 'Critical — notify immediately, without waiting for confirmation.' };
  if (inv.status !== 'CONFIRMED') return { send: false, reason: 'Waiting for the next run to confirm before interrupting.' };
  if (!atLeast(inv.attention, watch.notificationPolicy.interruptAt)) {
    return { send: false, reason: `${inv.attention} is below this watch's interrupt level (${watch.notificationPolicy.interruptAt}) — morning brief only.` };
  }
  return { send: true, trigger: already >= 0 ? 'escalated' : 'confirmed', reason: `${inv.attention} and confirmed — notify.` };
}

function subjectFor(inv: WatchInvestigation): string {
  const p = inv.signals[0];
  const drop = p.magnitude.startsWith('−');
  let core: string;
  if (p.key.endsWith('.reviews')) core = `${p.magnitude} mention ${inv.area}`;
  else if (p.key === 'jira.issues') core = `${p.magnitude.replace('new issues', `new ${inv.area} issues`)} in Jira`;
  else if (p.magnitude.endsWith('pts')) core = `${p.label} ${drop ? 'fell' : 'rose'} ${p.magnitude.replace(/^[−+]/, '')}`;
  else core = `${p.label} ${drop ? 'dropped' : 'rose'} ${p.magnitude.replace(/^[−+]/, '')}`;
  return `${inv.attention === 'CRITICAL' ? '[Critical] ' : ''}Jagr: ${core}`;
}

export function emailButtons(inv: WatchInvestigation): EmailButton[] {
  const buttons: EmailButton[] = [{ label: 'Open investigation', href: inv.jagrPath, kind: 'jagr', simulated: false }];
  const order = ['jira', 'ga4', 'app_store', 'google_play'] as const;
  const labels: Record<(typeof order)[number], string> = { jira: 'Open Jira', ga4: 'Open Analytics', app_store: 'Open App Store', google_play: 'Open Play Store' };
  for (const p of order) {
    const link = inv.sourceLinks.find((l) => l.provider === p);
    if (link) buttons.push({ label: labels[p], href: link.href, kind: 'source', provider: p, simulated: link.simulated });
  }
  return buttons;
}

export function composeAlert(inv: WatchInvestigation, trigger: EmailNotification['trigger'], at: string, recipient = DEMO_RECIPIENT): EmailNotification {
  const p = inv.signals[0];
  const arrow = p.magnitude.startsWith('−') ? '↓' : '↑';
  const found = inv.evidence.filter((e) => e.direction === 'degraded' || e.direction === 'change').map((e) => e.statement);
  const gaps = inv.evidence.filter((e) => e.direction === 'gap').map((e) => e.statement);
  return {
    id: `mail-${inv.id}-${inv.attention.toLowerCase()}`,
    kind: 'alert',
    investigationId: inv.id,
    watchId: inv.watchId,
    to: recipient,
    from: EMAIL_FROM,
    subject: subjectFor(inv),
    sentAt: at,
    trigger,
    attention: inv.attention,
    sections: {
      whatChanged: `${p.label} ${arrow}${p.magnitude.replace(/^[−+]/, '')} since ${fmtTime(p.onsetAt)}.`,
      whatJagrFound: [...found, ...gaps].slice(0, 6),
      likelyExplanation: inv.likelyExplanation,
      uncertainty: inv.uncertainty,
      recommendedNextStep: inv.recommendedNextStep,
    },
    buttons: emailButtons(inv),
    delivery: 'simulated_outbox',
  };
}
