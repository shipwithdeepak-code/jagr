import type { WatchInvestigation } from './types.js';

/** Presentation helpers shared by the Overview and the investigation page. Pure, no UI imports. */

/** "Checkout conversion dropped 18%" — the change itself, not the watch name. */
export function headlineOf(inv: WatchInvestigation): string {
  const p = inv.signals[0];
  const drop = p.magnitude.startsWith('−');
  if (p.key === 'feedback') return `${p.magnitude} about ${inv.area}`;
  if (p.key === 'work_items') return `${p.magnitude.replace('new issues', `new ${inv.area} issues`)} reported`;
  return `${p.label} ${drop ? (p.magnitude.endsWith('pts') ? 'fell' : 'dropped') : 'rose'} ${p.magnitude.replace(/^[−+]/, '')}`;
}

/** Baseline → current for the primary metric, read from its evidence (never recomputed). */
export function readingOf(inv: WatchInvestigation): { baseline: string; current: string; change: string } | undefined {
  const e = inv.evidence.find((x) => x.provider === inv.signals[0].provider && x.direction === 'degraded' && / vs .+ baseline/.test(x.statement));
  const m = e?.statement.match(/ is (\S+) vs (\S+) baseline \(([^)]+)\)/);
  return m ? { current: m[1], baseline: m[2], change: m[3] } : undefined;
}
