import type { Task } from '@/domain/types';
import type { WatchInvestigation } from '@/product/types';
import type { EffectiveStatus } from '@/product/agent/decisions';
import { taskEnvironment, type AppEnvironment } from './environment';

/** The simulated tracker has no tenant identity: it must never supply server workspace tasks. */
export function visibleSimulatedTasks(tasks: Task[], environment: AppEnvironment, location: 'browser' | 'server', investigations: Pick<WatchInvestigation, 'id' | 'dedupeKey'>[]): Task[] {
  return tasks.filter((task) => environment === 'demo'
    ? taskEnvironment(task) === 'demo'
    : location === 'browser' && investigations.some((inv) => task.investigationId === inv.id && task.fingerprint === `watch:${inv.dedupeKey}`));
}

/** Existing action status records a recommendation/decision, never an external execution receipt. */
export function recordedActionLabel(status: EffectiveStatus): string {
  switch (status) {
    case 'recommended': return 'Recommended';
    case 'awaiting_approval': return 'Needs approval';
    case 'approved': return 'Approval recorded';
    case 'rejected': return 'Rejection recorded';
    case 'executed': return 'Recorded in Jagr';
    case 'done': return 'Decision recorded';
    default: return 'Draft';
  }
}

// Vite's existing build environment keeps quality tools available in development only.
export const internalToolsAvailable = import.meta.env.DEV;
