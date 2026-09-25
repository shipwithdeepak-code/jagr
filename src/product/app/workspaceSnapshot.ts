import type { ActionDecision, BriefSchedule, EmailNotification, ISO, MonitoringResult, MorningBriefDoc, ProviderId, SourceConnection, Watch, WatchInvestigation } from '../types.js';
import type { Decision, Membership, Repositories, Workspace } from '../ports/persistence.js';
import type { ImportedDataset } from '../imports/schemas.js';
import { connectionView, type ConnectionView } from '../connections/model.js';

/**
 * A server workspace as the browser sees it: everything the product UI renders, and nothing it must
 * not see (no secret refs, no credentials, no email addresses, no other workspace's data).
 *
 * The browser maps it onto the SAME state shape a browser-local workspace uses
 * (`productStateFromSnapshot`), so pages, the engine's records and the approval rules are shared —
 * a server workspace is not a second product with different semantics.
 */
export interface WorkspaceSnapshot {
  workspace: { id: string; name: string; mode: Workspace['mode']; createdAt: ISO; settings: Workspace['settings']; brief: BriefSchedule; version: number };
  membership: Pick<Membership, 'role' | 'canApprove'>;
  connections: ConnectionView[];
  watches: Watch[];
  investigations: WatchInvestigation[];
  decisions: (ActionDecision & { actionId: string; decidedBy?: string })[];
  /** In-app alerts (rendered content only) and the outbound delivery log. */
  notifications: { id: string; channel: string; deliveredAt: ISO; status: 'sending' | 'delivered' | 'failed'; investigationId?: string; detail?: string; email?: Omit<EmailNotification, 'to' | 'from'> }[];
  /** Imported workspaces: the stored datasets. */
  imports: ImportedDataset[];
  /** Morning briefs as composed (most recent last). */
  briefs: MorningBriefDoc[];
  /** The time the server read this snapshot. */
  at: ISO;
}

export async function buildSnapshot(repos: Repositories, ws: Workspace, membership: Pick<Membership, 'role' | 'canApprove'>, at: ISO): Promise<WorkspaceSnapshot> {
  const [connections, watches, investigations, decisions, notifications, imports, briefs] = await Promise.all([
    repos.connections.list(ws.id),
    repos.watches.list(ws.id),
    repos.investigations.list(ws.id),
    repos.decisions.list(ws.id),
    repos.notifications.list(ws.id),
    ws.mode === 'imported' ? repos.imports.list(ws.id) : Promise.resolve([]),
    repos.briefs.list(ws.id),
  ]);
  return {
    workspace: { id: ws.id, name: ws.name, mode: ws.mode, createdAt: ws.createdAt, settings: ws.settings, brief: ws.brief, version: ws.version },
    membership: { role: membership.role, canApprove: membership.canApprove },
    connections: connections.map((c) => connectionView(c, at)),
    watches,
    investigations,
    decisions: decisions.map(({ decidedBy, ...d }: Decision) => ({ ...d, decidedBy: decidedBy?.displayName })),
    notifications: notifications.map((n) => ({ id: n.id, channel: n.channel, deliveredAt: n.deliveredAt, status: n.status, investigationId: n.investigationId, detail: n.detail, email: n.email })),
    imports,
    briefs: briefs.slice(-14),
    at,
  };
}

/** The browser-local state shape a snapshot maps onto (a subset of the UI's ProductState). */
export interface SnapshotState {
  connections: SourceConnection[];
  watches: Watch[];
  brief: BriefSchedule;
  result?: MonitoringResult;
  clock: ISO;
  decisions: Record<string, ActionDecision>;
  planner: 'deterministic' | 'llm';
  imports: ImportedDataset[];
}

/**
 * Where the investigated data came from, and who planned — from facts only: a connected workspace reads
 * only its connected sources (sample and imported data are never mixed in), and each investigation's
 * trace records the planner that chose its tools.
 */
function plannerInfo(s: WorkspaceSnapshot): NonNullable<MonitoringResult['planner']> {
  const data = s.workspace.mode === 'connected' ? 'live' : s.workspace.mode === 'imported' ? 'imported' : 'simulated';
  const usedModel = s.investigations.some((i) => i.trace.some((t) => t.planner?.type === 'LLM' && t.planner.validator === 'APPROVED'));
  return usedModel
    ? { mode: 'llm', data, label: 'AI planner', reason: 'Planned on the Jagr server; every proposal checked by the policy validator.' }
    : { mode: 'deterministic', data, label: 'Deterministic planner', reason: 'Planned on the Jagr server.' };
}

export function productStateFromSnapshot(s: WorkspaceSnapshot, defaults: { emailFrom: string }): SnapshotState {
  const connections: SourceConnection[] = [
    ...s.connections.map((c) => ({ provider: c.source as ProviderId, state: c.status, detail: c.healthDetail, updatedAt: c.updatedAt, label: { name: c.displayName, short: c.displayName }, freshAsOf: c.freshAsOf })),
    // Alerts are shown in Jagr, and sent to Slack when a Slack channel is connected. Email delivery is not built.
    { provider: 'email', state: 'simulated', detail: 'Alerts are shown in Jagr (and sent to Slack when connected). Email delivery is not built.', updatedAt: s.at },
  ];
  const emails: EmailNotification[] = s.notifications.filter((n) => n.email).map((n) => ({ ...(n.email as Omit<EmailNotification, 'to' | 'from'>), to: '', from: defaults.emailFrom }));
  const invs = s.investigations;
  const starts = invs.map((i) => i.startedAt).sort();
  const ends = invs.map((i) => i.updatedAt).sort();
  return {
    connections,
    watches: s.watches,
    brief: s.workspace.brief,
    clock: ends[ends.length - 1] ?? s.at,
    decisions: Object.fromEntries(s.decisions.map(({ actionId, decidedBy: _d, ...d }) => (void _d, [actionId, d]))),
    planner: s.workspace.settings.planner,
    imports: s.imports,
    // A quiet morning is a result too: a brief with nothing to report still renders.
    result: invs.length || s.briefs.length ? { window: { start: starts[0] ?? s.briefs[0]?.window.start ?? s.at, end: ends[ends.length - 1] ?? s.at }, investigations: invs, emails, briefs: s.briefs, log: [], connections, actions: invs.flatMap((i) => i.actions), planner: plannerInfo(s) } : undefined,
  };
}
