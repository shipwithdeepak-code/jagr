import type { NormalizedEvent } from '../events.js';
import type { SourceState, SourceTarget } from './persistence.js';

export type SourceEventDraft = Omit<NormalizedEvent, 'eventId' | 'schemaVersion' | 'organizationId' | 'workspaceId' | 'connectionId' | 'sourceTargetId' | 'provider' | 'observedAt'>;

export type SourceCheckResult =
  | { outcome: 'unchanged'; checkedAt: string; checkpoint: string; version: string }
  | { outcome: 'changed'; checkedAt: string; checkpoint: string; version: string; events: SourceEventDraft[] };

/** Portable observation boundary. Provider response handling stays behind this interface. */
export interface SourceChecker {
  check(target: SourceTarget, state: SourceState | null): Promise<SourceCheckResult>;
}
