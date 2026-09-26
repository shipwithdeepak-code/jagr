import type { ConnectionView } from '../connections/model.js';
import type { ISO, MonitoringResult, SchedulerLogEntry, SourceConnection, Watch, WatchInvestigation, WatchTemplateId } from '../types.js';
import { roleForSignal, WATCH_TEMPLATES, WIZARD_TEMPLATES } from '../catalog.js';
import { firstCompatibleTemplate } from './watchWizard.js';
import { watchCardStatus } from './watchCard.js';

export type ConnectedQuickStartStage = 'loading' | 'source' | 'watch' | 'run' | 'quiet' | 'investigation';

export interface ConnectedQuickStartState {
  stage: ConnectedQuickStartStage;
  /** Completion states are rendered by Overview itself, so the setup checklist disappears naturally. */
  showChecklist: boolean;
  running: boolean;
  recommendedTemplate?: WatchTemplateId;
  investigation?: WatchInvestigation;
  lastRun?: SchedulerLogEntry;
  nextRun?: ISO;
}

export interface ConnectedQuickStartInput {
  loading: boolean;
  connections: ConnectionView[];
  productConnections: SourceConnection[];
  watches: Watch[];
  result?: MonitoringResult;
  running: boolean;
  clock: ISO;
  snapshotAt?: ISO;
}

/** Derived activation state only: no onboarding flags, persistence, or synthetic results. */
export function connectedQuickStartState(input: ConnectedQuickStartInput): ConnectedQuickStartState {
  // Completion is historical and monotonic: current source/watch changes must never restart onboarding.
  const lastRun = [...(input.result?.log ?? [])]
    .filter((entry) => entry.type === 'watch_run' && !!entry.watchId)
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
    .at(-1);
  if (lastRun) {
    const investigationIds = new Set(lastRun.investigationIds);
    const investigation = [...(input.result?.investigations ?? [])].filter((candidate) => investigationIds.has(candidate.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const cards = input.watches.map((watch) => watchCardStatus(watch, { location: 'server', result: input.result, clock: input.clock, snapshotAt: input.snapshotAt }));
    const nextRun = cards.map((card) => card.nextRun).filter((at): at is ISO => !!at).sort()[0];
    return investigation
      ? { stage: 'investigation', showChecklist: false, running: false, investigation, lastRun, nextRun }
      : { stage: 'quiet', showChecklist: false, running: false, lastRun, nextRun };
  }

  if (input.loading) return { stage: 'loading', showChecklist: true, running: false };

  const healthySources = input.connections.filter((c) => c.kind === 'source' && c.health === 'healthy');
  const healthyIds = new Set(healthySources.map((c) => c.source));
  if (!healthyIds.size) return { stage: 'source', showChecklist: true, running: false };

  const healthyConnections = input.productConnections.filter((c) => healthyIds.has(c.provider));
  const templates = WIZARD_TEMPLATES.map((id) => WATCH_TEMPLATES.find((template) => template.id === id)!).filter(Boolean);
  const recommendedTemplate = firstCompatibleTemplate(templates, healthyConnections, { location: 'server' });
  const runnable = input.watches.some(
    (watch) => watch.status === 'active' && healthySources.some((source) => watch.sources.includes(source.source as SourceConnection['provider']) && watch.signals.some((signal) => source.roles.includes(roleForSignal(signal.key)))),
  );
  return runnable ? { stage: 'run', showChecklist: true, running: input.running, recommendedTemplate } : { stage: 'watch', showChecklist: true, running: false, recommendedTemplate };
}

/** Run outcomes already name unavailable evidence; preserve that distinction instead of claiming quiet. */
export function runHasEvidenceGap(outcome: string): boolean {
  return /\bunavailable\b|\bcould not (?:read|check)\b|\bno (?:change )?source to read\b/i.test(outcome);
}
