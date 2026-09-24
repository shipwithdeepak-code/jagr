import type { ActionRisk, AttentionLevel } from '../types';

/**
 * NotificationChannel port — outbound messages. The message is domain-level; each channel renders
 * it (the in-app email renderer, Slack Block Kit). A channel never carries secrets, and approvals are
 * requested through it but decided in Jagr by a signed-in member.
 */

export interface NotificationMessage {
  kind: 'investigation_confirmed' | 'approval_requested' | 'morning_brief' | 'resolved';
  workspaceId: string;
  /** Idempotency: the same key is delivered at most once per channel. */
  dedupeKey: string;
  title: string;
  attention?: AttentionLevel;
  summary: string;
  observed: string[];
  inferred: string[];
  unknown: string[];
  links: { label: string; href: string }[];
  approval?: { actionId: string; risk: ActionRisk; what: string };
}

export interface DeliveryTarget {
  /** e.g. an in-app outbox, or a Slack channel id chosen by the user. */
  address: string;
}

export interface DeliveryReceipt {
  channel: string;
  dedupeKey: string;
  deliveredAt: string;
  status: 'delivered' | 'duplicate' | 'failed';
  detail?: string;
  /** The channel's own id for the message (e.g. a Slack ts), when it has one. */
  externalId?: string;
}

export interface NotificationChannel {
  readonly kind: string;
  send(msg: NotificationMessage, target: DeliveryTarget): Promise<DeliveryReceipt>;
}
