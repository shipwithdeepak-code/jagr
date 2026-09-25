import type { ActionDecision, AttentionLevel, InvestigationState, ISO, MorningBriefDoc, SignalKey, Watch, WatchInvestigation } from '../types.js';
import { effectiveActions } from '../agent/decisions.js';
import { headlineOf } from '../presentation.js';

/**
 * The morning brief as a PM reads it: what needs attention (what changed, what Jagr found, what is
 * uncertain, what to do next), then what was quiet. Every line comes from the stored brief and the
 * investigations it references — nothing is summarised by a model here.
 */

export interface BriefItemView {
  investigationId: string;
  attention: AttentionLevel;
  status: InvestigationState;
  headline: string;
  whatChanged: string;
  found: string[];
  uncertainty: string;
  next: string;
  watchNames: string[];
  emailedAt?: ISO;
  approvalsWaiting: number;
}

export interface BriefView {
  id: string;
  generatedAt: ISO;
  window: { start: ISO; end: ISO };
  /** "2 things need your attention." / "Nothing needs your attention." — from the brief itself. */
  headline: string;
  items: BriefItemView[];
  quiet: {
    /** Monitored signals in the brief's watches that are not part of anything reported. */
    signals: number;
    watches: string[];
    note: string;
  };
  deduplicated: MorningBriefDoc['deduplicated'];
  stats: MorningBriefDoc['stats'];
  /** Changes that are evidence in the reported items, with their timing kind. */
  changes: NonNullable<MorningBriefDoc['changes']>;
}

const bare = (s: string) => {
  const t = s.replace(/^[^:]{1,40}: /, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

function whatChanged(inv: WatchInvestigation): string {
  const lead = inv.signals[0];
  const rel = inv.releaseAssociation;
  const since = `${lead.label} ${lead.magnitude} since ${lead.onsetAt.slice(11, 16)} UTC.`;
  if (!rel) return since;
  return `${since} ${rel.kind && rel.kind !== 'release' ? rel.version : `Release ${rel.version}`} preceded it by ${rel.minutesBeforeOnset} min — timing, not a cause.`;
}

function foundOf(inv: WatchInvestigation): string[] {
  const lead = inv.signals[0];
  const primary = inv.evidence.find((e) => e.direction === 'degraded' && e.provider === lead.provider && lead.key.startsWith('metric:'));
  return inv.evidence.filter((e) => e !== primary && e.direction === 'degraded').slice(0, 3).map((e) => bare(e.statement));
}

const signalId = (key: SignalKey, area: string | undefined) => (key.startsWith('metric:') ? key : `${key}:${area ?? '*'}`);

export function briefView(
  brief: MorningBriefDoc,
  opts: {
    investigations: WatchInvestigation[];
    watches: Watch[];
    decisions: Record<string, ActionDecision>;
    /** Whether a signal can actually be read in this workspace (e.g. the metric is in the imported data). */
    evaluable?: (key: SignalKey) => boolean;
  },
): BriefView {
  const byId = new Map(opts.investigations.map((i) => [i.id, i]));
  const items: BriefItemView[] = brief.items.flatMap((it) => {
    const inv = byId.get(it.investigationId);
    if (!inv) return [];
    return [
      {
        investigationId: it.investigationId,
        attention: it.attention,
        status: it.status,
        headline: headlineOf(inv),
        whatChanged: whatChanged(inv),
        found: foundOf(inv),
        uncertainty: inv.uncertainty,
        next: inv.recommendedNextStep,
        watchNames: it.watchNames,
        emailedAt: it.emailedAt,
        approvalsWaiting: effectiveActions(inv, opts.decisions).filter((a) => a.effective === 'awaiting_approval').length,
      },
    ];
  });

  // Quiet: every signal the brief's watches monitored that is not part of a reported investigation.
  const briefWatches = opts.watches.filter((w) => w.status === 'active' && w.notificationPolicy.morningBrief);
  const reported = new Set(items.flatMap((it) => byId.get(it.investigationId)!.signals.map((s) => signalId(s.key, s.area))));
  const monitored = new Set(
    briefWatches.flatMap((w) =>
      w.signals
        .filter((s) => s.key !== 'changes' && (!opts.evaluable || opts.evaluable(s.key)))
        .flatMap((s) => (s.key.startsWith('metric:') ? [s.key] : [signalId(s.key, s.area === '*' ? '*' : s.area ?? w.area)])),
    ),
  );
  // A work-item / feedback signal watched across every area is quiet only if no area of it was reported.
  const quietSignals = [...monitored].filter((id) => !reported.has(id) && !(id.endsWith(':*') && [...reported].some((r) => r.startsWith(id.slice(0, -1)))));

  return {
    id: brief.id,
    generatedAt: brief.generatedAt,
    window: brief.window,
    headline: brief.headline,
    items,
    quiet: {
      signals: quietSignals.length,
      watches: brief.quiet.watchNames,
      note: brief.quiet.note,
    },
    deduplicated: brief.deduplicated,
    stats: brief.stats,
    changes: brief.changes ?? [],
  };
}
