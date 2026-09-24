import { z } from 'zod';
import type { BriefSchedule, EmailNotification, Watch, WatchInvestigation } from '../types';
import type { ImportedDataset } from '../imports/schemas';
import type { Actor, Connection, MetricDefinitionRecord } from '../ports/persistence';

/**
 * Jagr Workspace Export v1 — the portable representation of one workspace.
 *
 * Not derived from any database schema: it is the domain, serialised. It is the only path between a
 * browser-local workspace and a server workspace, and between backends. It never contains secrets,
 * secret references, tokens, sessions or email addresses; people appear as { ref, displayName }.
 * Connected sources carry their configuration and the evidence their investigations saw — not their
 * data — and arrive as "needs reconnection".
 */

export const EXPORT_FORMAT = 'jagr.workspace-export';
export const EXPORT_VERSION = 1;

export type ExportConnection = Omit<Connection, 'workspaceId' | 'secretRef' | 'lastError'>;

export interface ExportApproval {
  actionId: string;
  status: 'approved' | 'rejected' | 'done';
  at: string;
  optionId?: string;
  note?: string;
  result?: string;
  actor: Actor;
}

export interface ExportNotification {
  id: string;
  channel: string;
  dedupeKey: string;
  deliveredAt: string;
  status: 'delivered' | 'failed';
  investigationId?: string;
  /** Rendered content only — no recipient or sender addresses. */
  email?: Omit<EmailNotification, 'to' | 'from'>;
}

export interface WorkspaceExportV1 {
  format: typeof EXPORT_FORMAT;
  version: 1;
  exportId: string;
  exportedAt: string;
  producer: { app: 'jagr'; appVersion: string; origin: 'browser-local' | 'server' };
  workspace: {
    id: string;
    name: string;
    mode: 'imported' | 'sample' | 'connected';
    createdAt: string;
    settings: { planner: 'deterministic' | 'llm'; aiEgressAllowed: boolean; timezone: string };
    brief: BriefSchedule;
    /** The workspace's "now" (the Sample workspace runs on a simulated clock). */
    clock?: string;
  };
  connections: ExportConnection[];
  metricDefinitions: MetricDefinitionRecord[];
  watches: Watch[];
  /** User imports: the data is the source, so records (and rejected rows) are included. */
  imports: ImportedDataset[];
  /**
   * Investigations as the engine left them. `evidence` is the snapshot of what each saw (statements,
   * references, timing, gaps); `trace` is every step; `actions` are the proposed actions and drafts.
   */
  investigations: WatchInvestigation[];
  approvals: ExportApproval[];
  notifications: ExportNotification[];
}

// ─────────────────────────────────────────────────────────────
// Validation. The envelope is checked strictly; large domain objects are checked for the fields the
// importer relies on (ids and references) and otherwise carried as-is — the engine produced them.
// ─────────────────────────────────────────────────────────────

const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO 8601 timestamp');
const withId = z.object({ id: z.string().min(1) }).passthrough();
const actor = z.object({ ref: z.string().min(1), displayName: z.string() }).strict();

export const WorkspaceExportV1Schema = z
  .object({
    format: z.literal(EXPORT_FORMAT),
    version: z.literal(1),
    exportId: z.string().min(8),
    exportedAt: iso,
    producer: z.object({ app: z.literal('jagr'), appVersion: z.string(), origin: z.enum(['browser-local', 'server']) }).strict(),
    workspace: z
      .object({
        id: z.string().min(1),
        name: z.string(),
        mode: z.enum(['imported', 'sample', 'connected']),
        createdAt: iso,
        settings: z.object({ planner: z.enum(['deterministic', 'llm']), aiEgressAllowed: z.boolean(), timezone: z.string() }).strict(),
        brief: z.object({ enabled: z.boolean(), time: z.string().regex(/^\d{2}:\d{2}$/), timezone: z.string() }).strict(),
        clock: iso.optional(),
      })
      .strict(),
    connections: z.array(
      z
        .object({
          id: z.string().min(1),
          source: z.string().min(1),
          provider: z.string(),
          roles: z.array(z.enum(['metrics', 'changes', 'work_items', 'feedback', 'conversations', 'context'])),
          authKind: z.enum(['oauth', 'app_install', 'api_key', 'import', 'simulated', 'owner_env']),
          state: z.enum(['connected', 'simulated', 'imported', 'not_configured', 'unavailable', 'error', 'needs_reconnect']),
          detail: z.string(),
          label: z.object({ name: z.string(), short: z.string() }).optional(),
          config: z.record(z.string(), z.unknown()),
          externalAccount: z.string().optional(),
          freshAsOf: iso.optional(),
          lastSyncAt: iso.optional(),
          updatedAt: iso,
        })
        .strict(),
    ),
    metricDefinitions: z.array(z.object({ key: z.string().min(1), binding: z.object({ connectionId: z.string(), query: z.unknown() }) }).passthrough()),
    watches: z.array(withId.extend({ sources: z.array(z.string()), signals: z.array(z.object({ key: z.string() }).passthrough()) })),
    imports: z.array(withId.extend({ kind: z.enum(['metrics', 'issues', 'releases', 'changes', 'feedback']), rejected: z.array(z.unknown()) })),
    investigations: z.array(withId.extend({ watchId: z.string(), evidence: z.array(z.unknown()), trace: z.array(z.unknown()), actions: z.array(withId) })),
    approvals: z.array(z.object({ actionId: z.string().min(1), status: z.enum(['approved', 'rejected', 'done']), at: iso, optionId: z.string().optional(), note: z.string().optional(), result: z.string().optional(), actor }).strict()),
    notifications: z.array(
      z
        .object({
          id: z.string().min(1),
          channel: z.string().min(1),
          dedupeKey: z.string(),
          deliveredAt: iso,
          status: z.enum(['delivered', 'failed']),
          investigationId: z.string().optional(),
          email: z.record(z.string(), z.unknown()).optional(),
        })
        .strict(),
    ),
  })
  .strict();
