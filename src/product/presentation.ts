import type { WatchInvestigation } from './types.js';

/** Presentation helpers shared by the Overview and the investigation page. Pure, no UI imports. */

/** "Checkout conversion dropped 18%" — the change itself, not the watch name. */
export function headlineOf(inv: WatchInvestigation): string {
  const p = inv.signals[0];
  const drop = p.magnitude.startsWith('−');
  if (p.key === 'feedback') return `${p.magnitude} about ${inv.area}`;
  if (p.key === 'work_items') return `${p.magnitude.replace('new issues', `new ${inv.area} issues`)} reported`;
  if (p.key === 'changes') return `${p.label} failed`;
  return `${p.label} ${drop ? (p.magnitude.endsWith('pts') ? 'fell' : 'dropped') : 'rose'} ${p.magnitude.replace(/^[−+]/, '')}`;
}

/** Baseline → current for the primary metric, read from its evidence (never recomputed). */
export function readingOf(inv: WatchInvestigation): { baseline: string; current: string; change: string } | undefined {
  const e = inv.evidence.find((x) => x.provider === inv.signals[0].provider && x.direction === 'degraded' && / vs .+ baseline/.test(x.statement));
  const m = e?.statement.match(/ is (\S+) vs (\S+) baseline \(([^)]+)\)/);
  return m ? { current: m[1], baseline: m[2], change: m[3] } : undefined;
}

/**
 * Notification wording, made truthful at render time. Jagr has no email delivery: every notification it
 * records is `delivery: 'simulated_outbox'` (see EmailNotification), shown in Jagr and — on a server
 * workspace with Slack connected — posted there. The engine's trace and run outcomes, including those
 * stored with past investigations, still say "Emailed the PM" / "1 email sent". Stored records are never
 * rewritten; they are presented as what the system can actually establish: an alert was recorded.
 */
export function truthfulNotificationText(text: string): string;
export function truthfulNotificationText(text: string | undefined): string | undefined;
export function truthfulNotificationText(text: string | undefined): string | undefined {
  return text
    ?.replace(/^Emailed the PM: /, 'Alert recorded: ')
    .replace(/\b(\d+) emails? sent\b/g, (_m, n: string) => `${n} alert${n === '1' ? '' : 's'} recorded`)
    .replace(/\bno email\b/g, 'no alert')
    .replace(/^Email channel unavailable — notification not delivered/, 'Alert channel unavailable — alert not delivered');
}

/** A trace step with its notification wording made truthful (see truthfulNotificationText). */
export function presentTraceStep<T extends { kind: string; title: string }>(step: T): T {
  return step.kind === 'notify' ? { ...step, title: truthfulNotificationText(step.title) } : step;
}
