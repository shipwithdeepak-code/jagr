import type { BriefItem, EmailNotification, MorningBriefDoc, SchedulerLogEntry, Watch, WatchInvestigation } from '../types';
import { ATTENTION_RANK, atLeast } from './attention';

/**
 * The morning brief summarises investigations, not metrics: what needs attention, what was
 * already emailed, and which watches were quiet.
 */
export function composeBrief(args: {
  at: string;
  since: string;
  watches: Watch[];
  investigations: WatchInvestigation[];
  emails: EmailNotification[];
  log: SchedulerLogEntry[];
}): MorningBriefDoc {
  const { at, since, watches } = args;
  const inWindow = (x: string) => x >= since && x <= at;
  const briefWatches = watches.filter((w) => w.status === 'active' && w.notificationPolicy.morningBrief);

  const relevant = args.investigations.filter((i) => inWindow(i.updatedAt) || inWindow(i.startedAt));
  const items: BriefItem[] = relevant
    .filter((i) => i.status !== 'DISMISSED')
    .filter((i) => {
      const owner = watches.find((w) => w.id === i.watchId);
      return owner ? atLeast(i.attention, owner.notificationPolicy.briefMin) : false;
    })
    .sort((a, b) => ATTENTION_RANK[b.attention] - ATTENTION_RANK[a.attention] || b.confidence - a.confidence)
    .map((i) => ({
      investigationId: i.id,
      attention: i.attention,
      title: i.title,
      summary: i.summary,
      confidence: i.confidence,
      status: i.status,
      emailedAt: args.emails.find((e) => e.investigationId === i.id)?.sentAt,
      watchNames: i.watchIds.map((id) => watches.find((w) => w.id === id)?.name ?? id),
    }));

  const owners = new Set(items.map((i) => relevant.find((r) => r.id === i.investigationId)!.watchId));
  const contributors = new Set(relevant.filter((r) => items.some((i) => i.investigationId === r.id)).flatMap((r) => r.watchIds));
  const deduplicated = briefWatches
    .filter((w) => !owners.has(w.id) && contributors.has(w.id))
    .map((w) => ({ watchName: w.name, linkedTo: relevant.find((r) => r.watchIds.includes(w.id) && r.watchId !== w.id)?.title ?? '' }));
  const quietWatches = briefWatches.filter((w) => !owners.has(w.id) && !contributors.has(w.id));

  // Meaningful changes: only those that are evidence in what is reported (no separate reads, no noise).
  const reportedInvs = items.map((i) => relevant.find((r) => r.id === i.investigationId)!);
  const seenChange = new Set<string>();
  const changes = reportedInvs
    .flatMap((inv) => inv.evidence.filter((e) => e.direction === 'change' && e.onsetAt).map((e) => ({ e, inv })))
    .filter(({ e }) => !seenChange.has(e.statement) && !!seenChange.add(e.statement))
    .map(({ e, inv }) => ({ title: e.statement.replace(/^[^:]{1,40}: /, ''), at: e.onsetAt!, source: e.provider, kind: e.changeKind, timing: e.timing, investigationId: inv.id }))
    .sort((a, b) => a.at.localeCompare(b.at));

  const n = items.length;
  const runs = args.log.filter((l) => l.type === 'watch_run' && inWindow(l.scheduledAt));
  const sources = new Set(briefWatches.flatMap((w) => w.sources));
  return {
    id: `brief-${at}`,
    generatedAt: at,
    window: { start: since, end: at },
    headline: n === 0 ? 'Nothing needs your attention.' : `${n} ${n === 1 ? 'thing needs' : 'things need'} your attention.`,
    items,
    quiet: {
      watchCount: quietWatches.length,
      watchNames: quietWatches.map((w) => w.name),
      note: quietWatches.length ? `${quietWatches.length} ${quietWatches.length === 1 ? 'watch' : 'watches'} checked. No meaningful changes.` : 'Every watch had something to report.',
    },
    deduplicated,
    ...(changes.length ? { changes } : {}),
    stats: {
      watchRuns: runs.length,
      sourcesChecked: sources.size,
      emailsSent: args.emails.filter((e) => e.kind === 'alert' && inWindow(e.sentAt)).length,
      dismissed: relevant.filter((i) => i.status === 'DISMISSED').length,
    },
  };
}
