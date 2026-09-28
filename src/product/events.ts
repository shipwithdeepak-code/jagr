import type { ISO } from './types.js';

/** Bounded, tenant-scoped observation shared by source checking and affected watches. */
export interface NormalizedEvent {
  eventId: string;
  schemaVersion: 1;
  organizationId: string;
  workspaceId: string;
  connectionId: string;
  sourceTargetId: string;
  provider: string;
  type: string;
  occurredAt: ISO;
  observedAt: ISO;
  dedupeKey: string;
  provenance: { externalId?: string; url?: string };
  payload?: unknown;
}

/** Durable reference carried by an investigation; the canonical payload remains in this repository. */
export interface NormalizedEventRef {
  eventId: string;
  sourceTargetId: string;
  provider: string;
  type: string;
  occurredAt: ISO;
}

export const normalizedEventRef = (event: NormalizedEvent): NormalizedEventRef => ({
  eventId: event.eventId,
  sourceTargetId: event.sourceTargetId,
  provider: event.provider,
  type: event.type,
  occurredAt: event.occurredAt,
});

export function defineNormalizedEvent(event: NormalizedEvent): NormalizedEvent {
  for (const [key, value] of Object.entries(event)) {
    if (key !== 'payload' && key !== 'provenance' && (value === undefined || value === '')) throw new Error(`Normalized event ${key} is required.`);
  }
  if (event.schemaVersion !== 1) throw new Error('Unsupported normalized event schema version.');
  if (JSON.stringify(event.payload ?? null).length > 16_384) throw new Error('Normalized event payload exceeds 16 KB.');
  return event;
}
