import type { WatchInvestigation } from '../types';

/**
 * What an investigation's reasoning takes as given without having checked it. Derived only from the
 * evidence it actually used (its snapshot) — so a reader can see which premises a conclusion rests
 * on. Deterministic statements, never generated reasoning.
 *
 *   FACT / OBSERVED  — evidence items (what a source showed, with provenance)
 *   INFERENCE        — `inferred`, hypotheses
 *   ASSUMPTION       — this list
 *   UNKNOWN          — `unknowns` and gap evidence
 */
export function assumptionsOf(inv: Pick<WatchInvestigation, 'evidence' | 'releaseAssociation' | 'area'>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };
  for (const e of inv.evidence) {
    const v = e.provenance?.values;
    if (v && e.direction !== 'gap') push(`${v.metric}: its baseline (${v.baselineWindow.charAt(0).toLowerCase()}${v.baselineWindow.slice(1)}) is taken as normal for this time.`);
  }
  if (inv.evidence.some((e) => /:(issues|no_issues|reviews|no_reviews):/.test(e.id)))
    push(`Issues and feedback are matched to ${inv.area} by their wording, components, labels and tags; an item described differently may be missed.`);
  if (inv.evidence.some((e) => e.direction === 'change' && e.timing === 'planned'))
    push('A planned release date is bookkeeping: it is not taken as the time users received the change.');
  if (inv.releaseAssociation)
    push(
      inv.releaseAssociation.timing === 'reported'
        ? `The reported time of ${inv.releaseAssociation.version} is taken as when it happened.`
        : 'Timestamps from different sources are taken as accurate to the minute when their timing is compared.',
    );
  if (inv.evidence.some((e) => e.provenance?.mode === 'imported')) push('Imported files are taken as complete for the period they cover.');
  return out;
}
