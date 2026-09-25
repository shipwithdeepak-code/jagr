import type { ActionDecision, AttentionLevel, EvidenceItem, ISO, ProviderId, SourceLink, WatchInvestigation } from '../types';
import { effectiveActions } from '../agent/decisions';
import { hypothesisLabel } from '../agent/investigator';

/**
 * The evidence chain — Jagr's signature view of an investigation: from the signal, through what was
 * observed and correlated, to what is inferred, what is unknown, how much attention it deserves,
 * what to do, and what waits for a human.
 *
 * Every link is taken from fields the engine recorded (evidence, observed / inferred / unknown,
 * attention, recommendation, action decisions). Nothing here generates reasoning text: this is
 * structured reasoning only, never a model's chain of thought.
 */

export const CHAIN_STAGES = ['signal', 'observed', 'correlated', 'inferred', 'assumed', 'unknown', 'attention', 'recommendation', 'approval'] as const;
export type ChainStage = (typeof CHAIN_STAGES)[number];

export const CHAIN_STAGE_LABEL: Record<ChainStage, string> = {
  signal: 'Signal',
  observed: 'Observed',
  correlated: 'Correlated',
  inferred: 'Inferred',
  assumed: 'Assumed',
  unknown: 'Unknown',
  attention: 'Attention',
  recommendation: 'Recommendation',
  approval: 'Approval',
};

/** Where a link came from. Sources are resolved to names and data modes by the UI. */
export interface ChainProvenance {
  sources: ProviderId[];
  /** Data mode recorded when the evidence was read (the snapshot) — authoritative over the current connection. */
  mode?: 'connected' | 'imported' | 'simulated';
  /** The source's data was complete only up to here when it was read. */
  freshAsOf?: ISO;
  at?: ISO;
  link?: SourceLink;
  /** How many source records back the statement. */
  records?: number;
  /** For "checked, nothing found": the query that came back empty. */
  query?: string;
}

export interface ChainLink {
  id: string;
  stage: ChainStage;
  text: string;
  /** Secondary fact — e.g. timing, the reason a level was chosen. Never speculative. */
  note?: string;
  /** A muted link: checked and normal, rather than a finding. */
  quiet?: boolean;
  provenance?: ChainProvenance;
  attention?: AttentionLevel;
  /** Approval links: awaiting, approved, rejected, done. */
  decision?: 'awaiting' | 'approved' | 'rejected' | 'done' | 'executed';
}

export interface EvidenceChain {
  links: ChainLink[];
  /** Stages present, in order. */
  stages: ChainStage[];
}

const prov = (e: EvidenceItem): ChainProvenance => ({
  sources: [e.provider],
  mode: e.provenance?.mode,
  freshAsOf: e.provenance?.freshAsOf,
  at: e.onsetAt,
  link: e.link,
  records: e.refs.length || undefined,
  query: e.query?.input,
});

/** Strip the "Source: " prefix the engine puts on statements — provenance shows the source separately. */
const bare = (s: string) => {
  const t = s.replace(/^[^:]{1,40}: /, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Minutes between a finding and the signal's onset, from the finding's own time. */
const minutesBefore = (at: ISO | undefined, onset: ISO) => (at ? Math.round((Date.parse(onset) - Date.parse(at)) / 60_000) : undefined);

export function buildEvidenceChain(inv: WatchInvestigation, decisions: Record<string, ActionDecision>): EvidenceChain {
  const links: ChainLink[] = [];
  const lead = inv.signals[0];

  // SIGNAL — what crossed the line.
  links.push({ id: 'signal', stage: 'signal', text: `${lead.label} ${lead.magnitude}`, note: `Since ${lead.onsetAt.slice(11, 16)} UTC`, provenance: { sources: [lead.provider], at: lead.onsetAt, records: lead.refs.length || undefined } });

  // OBSERVED — factual findings, in time order; the primary metric reading is the signal itself.
  const primary = inv.evidence.find((e) => e.direction === 'degraded' && e.provider === lead.provider && lead.key.startsWith('metric:'));
  const findings = inv.evidence.filter((e) => e !== primary && (e.direction === 'degraded' || e.direction === 'change')).sort((a, b) => (a.onsetAt ?? '').localeCompare(b.onsetAt ?? ''));
  const rel = inv.releaseAssociation;
  for (const e of findings) {
    const before = e.direction === 'change' ? minutesBefore(e.onsetAt, lead.onsetAt) : undefined;
    const timing = before !== undefined && before > 0 ? `${before} min before the change began` : undefined;
    links.push({ id: `obs-${e.id}`, stage: 'observed', text: bare(e.statement), note: timing, provenance: prov(e) });
  }
  for (const e of inv.evidence.filter((x) => x.direction === 'stable')) {
    links.push({ id: `obs-${e.id}`, stage: 'observed', text: bare(e.statement), quiet: true, provenance: prov(e) });
  }

  // CORRELATED — independent sources moving together, and timing. Association, never causation.
  const corroborating = [...new Set(inv.correlatedProviders)];
  if (corroborating.length > 1) {
    links.push({ id: 'corr-sources', stage: 'correlated', text: `${corroborating.length} independent sources moved together`, provenance: { sources: corroborating } });
  }
  if (rel) {
    links.push({ id: 'corr-timing', stage: 'correlated', text: `Began ${rel.minutesBeforeOnset} min after ${rel.version}`, note: 'A timing relationship, not a cause.', provenance: { sources: [], at: rel.releasedAt } });
  }

  // INFERRED — Jagr's reading of the facts, and the explanation with the most support.
  inv.inferred.forEach((t, i) => links.push({ id: `inf-${i}`, stage: 'inferred', text: t }));
  const leading = [...inv.agentHypotheses]
    .filter((h) => h.status === 'supported' || h.status === 'contested' || h.status === 'open')
    .sort((a, b) => ['strong', 'moderate', 'weak', 'none'].indexOf(a.strength) - ['strong', 'moderate', 'weak', 'none'].indexOf(b.strength))[0];
  if (leading && leading.strength !== 'none') {
    links.push({ id: 'inf-leading', stage: 'inferred', text: `Leading explanation: ${hypothesisLabel(leading.kind)}`, note: `${leading.strength.charAt(0).toUpperCase() + leading.strength.slice(1)} evidence — how much independent evidence lines up, not a probability.` });
  }

  // ASSUMED — premises the reasoning takes as given without having checked them (recorded with the investigation).
  (inv.assumptions ?? []).forEach((t, i) => links.push({ id: `asm-${i}`, stage: 'assumed', text: t, quiet: true }));

  // UNKNOWN — what is not established, and what could not be checked.
  inv.unknowns.forEach((t, i) => links.push({ id: `unk-${i}`, stage: 'unknown', text: t }));
  for (const e of inv.evidence.filter((x) => x.direction === 'gap')) {
    links.push({ id: `unk-${e.id}`, stage: 'unknown', text: bare(e.statement), provenance: prov(e) });
  }

  // ATTENTION — how much it deserves, and why.
  links.push({ id: 'attention', stage: 'attention', text: inv.attention, attention: inv.attention, note: inv.attentionReason });

  // RECOMMENDATION — the next step.
  links.push({ id: 'recommendation', stage: 'recommendation', text: inv.recommendedNextStep });

  // APPROVAL — what waits for a human, and what the human decided.
  const gated = effectiveActions(inv, decisions).filter((a) => a.risk === 'HIGH' || a.risk === 'CRITICAL');
  if (!gated.length) {
    links.push({ id: 'approval-none', stage: 'approval', text: 'Nothing needs approval', note: 'No HIGH or CRITICAL action was proposed.', quiet: true });
  }
  for (const a of gated) {
    const decision = a.effective === 'awaiting_approval' ? 'awaiting' : a.effective === 'approved' || a.effective === 'rejected' || a.effective === 'done' || a.effective === 'executed' ? a.effective : 'awaiting';
    const option = a.decision?.optionId ? a.options?.find((o) => o.id === a.decision!.optionId)?.label : undefined;
    const state = decision === 'awaiting' ? 'Waiting for your approval' : decision === 'approved' ? `Approved${option ? ` — ${option}` : ''}` : decision === 'rejected' ? 'Rejected' : 'Done';
    links.push({ id: `appr-${a.id}`, stage: 'approval', text: a.title, note: `${a.risk} risk · ${state}`, decision });
  }

  return { links, stages: CHAIN_STAGES.filter((s) => links.some((l) => l.stage === s)) };
}
