import type { ISO } from '../types.js';

/** Organization-owned commercial state. Provider billing details deliberately stay optional. */
export interface Subscription {
  organizationId: string;
  planId: string;
  status: 'active' | 'trialing' | 'past_due' | 'paused' | 'canceled';
  periodStart?: ISO;
  periodEnd?: ISO;
  provider?: string;
  externalRef?: string;
  createdAt: ISO;
  updatedAt: ISO;
}

export type UsageKind = 'investigation_execution' | 'source_check' | 'planner_execution';

/** Immutable usage fact. `id` is the durable operation identity and is unique within an organization. */
export interface UsageEvent {
  id: string;
  organizationId: string;
  workspaceId?: string;
  kind: UsageKind;
  amount: number;
  periodStart: ISO;
  periodEnd: ISO;
  occurredAt: ISO;
}

