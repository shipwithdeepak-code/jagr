import type { ActionDecision, BriefSchedule, EmailNotification, MonitoringResult, SourceConnection, Watch } from '../types';
import type { ImportedDataset } from '../imports/schemas';
import type { Actor, Connection, Decision, MetricDefinitionRecord, NotificationRecord, Repositories, Transactor, Workspace } from '../ports/persistence';
import type { Clock } from '../ports/clock';
import { BUILTIN_SOURCE_ROLES } from '../catalog';
import { isSourceId } from '../roles/types';
import { hashString } from '../lib/rng';
import { EXPORT_FORMAT, EXPORT_VERSION, WorkspaceExportV1Schema, type ExportApproval, type ExportConnection, type ExportNotification, type WorkspaceExportV1 } from './v1';
import { findSensitive, redactEmails, type Finding } from './scan';

/**
 * Workspace export and import.
 *
 *   EXPORT → (file / upload) → IMPORT DRY RUN → VALIDATION REPORT → USER CONFIRMATION → WRITE
 *
 * Both a browser-local workspace and a server workspace (through the Repositories port) map to and
 * from the same Workspace Export v1 document; neither side's storage shape leaks into it.
 */

// ─────────────────────────────────────────────────────────────
// Versioning: v1 → v2 → … Each step is a pure function; only v1 exists today.
// ─────────────────────────────────────────────────────────────

export type ExportMigration = (doc: Record<string, unknown>) => Record<string, unknown>;
/** EXPORT_MIGRATIONS[n] upgrades a version-n document to version n+1. */
export const EXPORT_MIGRATIONS: Record<number, ExportMigration> = {};

export type UpgradeResult = { ok: true; doc: Record<string, unknown>; from: number } | { ok: false; code: 'MALFORMED' | 'NOT_AN_EXPORT' | 'NEWER_VERSION' | 'NO_MIGRATION'; message: string };

export function upgradeExport(raw: unknown, current = EXPORT_VERSION, migrations = EXPORT_MIGRATIONS): UpgradeResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'MALFORMED', message: 'The file is not a JSON object.' };
  const doc = raw as Record<string, unknown>;
  if (doc.format !== EXPORT_FORMAT) return { ok: false, code: 'NOT_AN_EXPORT', message: `This is not a Jagr workspace export (expected format “${EXPORT_FORMAT}”).` };
  const v = doc.version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return { ok: false, code: 'MALFORMED', message: 'The export has no valid version number.' };
  if (v > current) return { ok: false, code: 'NEWER_VERSION', message: `This export is version ${v}, newer than this Jagr understands (version ${current}). Update Jagr, then import it again. Nothing was imported.` };
  let out = doc;
  for (let n = v; n < current; n++) {
    const step = migrations[n];
    if (!step) return { ok: false, code: 'NO_MIGRATION', message: `No upgrade path from export version ${n} to ${n + 1}.` };
    out = { ...step(out), version: n + 1 };
  }
  return { ok: true, doc: out, from: v };
}

// ─────────────────────────────────────────────────────────────
// Building an export (either side), with the non-negotiable scan.
// ─────────────────────────────────────────────────────────────

export class ExportRefused extends Error {
  constructor(readonly findings: Finding[]) {
    super(`Export refused: ${findings.length} field(s) would leak secret or personal data (${findings.slice(0, 3).map((f) => `${f.path}: ${f.reason}`).join('; ')}).`);
    this.name = 'ExportRefused';
  }
}

/** JSON with object keys sorted — the same content always hashes the same, whatever built it. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** Email addresses in free text are redacted; anything still sensitive refuses the export. */
function seal(doc: Omit<WorkspaceExportV1, 'exportId'>): WorkspaceExportV1 {
  // Canonical JSON: exactly what a file would hold (no undefined fields), so a round trip is byte-stable.
  const redacted = redactEmails(JSON.parse(JSON.stringify(doc)) as Omit<WorkspaceExportV1, 'exportId'>);
  const exportId = `exp_${Date.parse(doc.exportedAt).toString(36)}_${hashString(stableStringify(redacted)).toString(36)}`;
  const out: WorkspaceExportV1 = { ...redacted, exportId };
  const findings = findSensitive(out);
  if (findings.length) throw new ExportRefused(findings);
  return out;
}

const emailContent = (e: EmailNotification): Omit<EmailNotification, 'to' | 'from'> => {
  const { to: _to, from: _from, ...rest } = e;
  void _to;
  void _from;
  return rest;
};

const exportConnection = (c: Connection): ExportConnection => {
  const { workspaceId: _w, secretRef: _s, lastError: _e, ...rest } = c;
  void _w;
  void _s;
  void _e;
  return rest;
};

// ── Browser-local workspace ──────────────────────────────────

/** The parts of a browser-local product workspace that an export carries. Structurally matches the UI's stored state. */
export interface LocalWorkspaceSnapshot {
  connections: SourceConnection[];
  watches: Watch[];
  brief: BriefSchedule;
  result?: MonitoringResult;
  clock: string;
  decisions: Record<string, ActionDecision>;
  planner?: 'deterministic' | 'llm';
  workspace?: { mode: 'sample' | 'imported'; createdAt: string };
  imports?: ImportedDataset[];
  importedExportIds?: string[];
}

/** The one person a browser-local workspace has. */
export const LOCAL_ACTOR: Actor = { ref: 'local-user', displayName: 'You (this browser)' };

const localConnection = (c: SourceConnection, updatedAt: string): Connection => ({
  id: c.provider,
  workspaceId: 'local',
  source: c.provider as Connection['source'],
  provider: c.state === 'imported' ? 'import' : c.state === 'simulated' ? 'simulated' : c.provider,
  roles: isSourceId(c.provider) ? BUILTIN_SOURCE_ROLES[c.provider] : [],
  authKind: c.state === 'imported' ? 'import' : 'simulated',
  state: c.state,
  detail: c.detail,
  label: c.label,
  config: {},
  freshAsOf: c.freshAsOf,
  updatedAt: c.updatedAt || updatedAt,
});

export function exportLocalWorkspace(s: LocalWorkspaceSnapshot, opts: { now: string; appVersion: string }): WorkspaceExportV1 {
  const mode = s.workspace?.mode ?? 'sample';
  const investigations = s.result?.investigations ?? [];
  return seal({
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: opts.now,
    producer: { app: 'jagr', appVersion: opts.appVersion, origin: 'browser-local' },
    workspace: {
      id: 'local',
      name: mode === 'imported' ? 'My data' : 'Sample workspace',
      mode,
      createdAt: s.workspace?.createdAt ?? s.clock,
      settings: { planner: s.planner ?? 'deterministic', aiEgressAllowed: true, timezone: s.brief.timezone },
      brief: s.brief,
      clock: s.clock,
    },
    connections: s.connections.filter((c) => c.provider !== 'email').map((c) => exportConnection(localConnection(c, s.clock))),
    metricDefinitions: [],
    watches: s.watches,
    imports: s.imports ?? [],
    investigations,
    approvals: Object.entries(s.decisions).map(([actionId, d]): ExportApproval => ({ actionId, status: d.status, at: d.at, optionId: d.optionId, note: d.note, result: d.result, actor: LOCAL_ACTOR })),
    notifications: (s.result?.emails ?? []).map((e): ExportNotification => ({ id: e.id, channel: 'in_app', dedupeKey: e.id, deliveredAt: e.sentAt, status: 'delivered', investigationId: e.investigationId, email: emailContent(e) })),
  });
}

/** Credentials never travel: anything that was connected arrives needing reconnection. */
const arriving = (state: SourceConnection['state']): SourceConnection['state'] => (state === 'connected' ? 'needs_reconnect' : state);

export function localWorkspaceFromExport(doc: WorkspaceExportV1, defaults: { emailFrom: string }): LocalWorkspaceSnapshot {
  const invs = doc.investigations;
  const starts = invs.map((i) => i.startedAt).sort();
  const ends = invs.map((i) => i.updatedAt).sort();
  const clock = doc.workspace.clock ?? doc.exportedAt;
  const emails: EmailNotification[] = doc.notifications
    .filter((n) => n.email)
    .map((n) => ({ ...(n.email as Omit<EmailNotification, 'to' | 'from'>), to: '', from: defaults.emailFrom }));
  const connections: SourceConnection[] = doc.connections.map((c) => ({ provider: c.source as SourceConnection['provider'], state: arriving(c.state), detail: c.state === 'connected' ? `${c.detail} — reconnect to read it again (credentials are never exported)` : c.detail, updatedAt: c.updatedAt, label: c.label, freshAsOf: c.freshAsOf }));
  return {
    connections: [...connections, { provider: 'email', state: 'simulated', detail: 'Emails are rendered in Jagr, never delivered.', updatedAt: clock }],
    watches: doc.watches,
    brief: doc.workspace.brief,
    clock,
    planner: doc.workspace.settings.planner,
    workspace: { mode: doc.workspace.mode === 'imported' ? 'imported' : 'sample', createdAt: doc.workspace.createdAt },
    imports: doc.imports,
    decisions: Object.fromEntries(doc.approvals.map((a) => [a.actionId, { status: a.status, at: a.at, optionId: a.optionId, note: a.note, result: a.result }])),
    result: invs.length
      ? { window: { start: starts[0], end: ends[ends.length - 1] }, investigations: invs, emails, briefs: [], log: [], connections, actions: invs.flatMap((i) => i.actions) }
      : undefined,
    importedExportIds: [doc.exportId],
  };
}

// ── Server workspace (Repositories port) ─────────────────────

export async function exportServerWorkspace(repos: Repositories, workspaceId: string, opts: { clock: Clock; appVersion: string }): Promise<WorkspaceExportV1> {
  const ws = await repos.workspaces.get(workspaceId);
  if (!ws) throw new Error(`Workspace ${workspaceId} not found.`);
  const [connections, metricDefinitions, watches, imports, investigations, decisions, notifications] = await Promise.all([
    repos.connections.list(workspaceId),
    repos.metricDefs.list(workspaceId),
    repos.watches.list(workspaceId),
    repos.imports.list(workspaceId),
    repos.investigations.list(workspaceId),
    repos.decisions.list(workspaceId),
    repos.notifications.list(workspaceId),
  ]);
  const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
  return seal({
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: opts.clock.now(),
    producer: { app: 'jagr', appVersion: opts.appVersion, origin: 'server' },
    workspace: { id: ws.id, name: ws.name, mode: ws.mode, createdAt: ws.createdAt, settings: ws.settings, brief: ws.brief, clock: (await repos.cursors.get(workspaceId, 'workspace.clock')) ?? undefined },
    connections: byId(connections).map(exportConnection),
    metricDefinitions: [...metricDefinitions].sort((a, b) => a.key.localeCompare(b.key)),
    watches: byId(watches),
    imports: byId(imports),
    investigations: byId(investigations),
    approvals: [...decisions].sort((a, b) => a.actionId.localeCompare(b.actionId)).map((d): ExportApproval => ({ actionId: d.actionId, status: d.status, at: d.at, optionId: d.optionId, note: d.note, result: d.result, actor: d.decidedBy ?? { ref: 'unknown', displayName: 'Unknown' } })),
    notifications: byId(notifications).map((n): ExportNotification => ({ id: n.id, channel: n.channel, dedupeKey: n.dedupeKey, deliveredAt: n.deliveredAt, status: n.status, investigationId: n.investigationId, email: n.email })),
  });
}

// ─────────────────────────────────────────────────────────────
// Dry run: parse, upgrade, validate, check references and duplicates. Writes nothing.
// ─────────────────────────────────────────────────────────────

export interface ImportReport {
  ok: boolean;
  /** Version the file was written in (it may have been upgraded). */
  fromVersion?: number;
  exportId?: string;
  workspaceName?: string;
  counts: { connections: number; needsReconnection: number; metricDefinitions: number; watches: number; imports: number; importedRecords: number; rejectedRows: number; investigations: number; actions: number; approvals: number; notifications: number };
  /** Why the import cannot go ahead. Non-empty → ok is false. */
  problems: { path: string; message: string }[];
  /** Things the user should know before confirming. */
  warnings: string[];
}

export interface ImportPlan {
  report: ImportReport;
  /** Present only when report.ok. */
  doc?: WorkspaceExportV1;
}

const zeroCounts = (): ImportReport['counts'] => ({ connections: 0, needsReconnection: 0, metricDefinitions: 0, watches: 0, imports: 0, importedRecords: 0, rejectedRows: 0, investigations: 0, actions: 0, approvals: 0, notifications: 0 });

/**
 * Validate an export for import. `alreadyImported` is the set of export ids the target has already
 * taken in (importing the same export twice is refused).
 */
export function planImport(input: string | unknown, target: { alreadyImported: readonly string[] }): ImportPlan {
  const fail = (path: string, message: string): ImportPlan => ({ report: { ok: false, counts: zeroCounts(), problems: [{ path, message }], warnings: [] } });
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      return fail('$', 'The file is not valid JSON.');
    }
  }
  const up = upgradeExport(raw);
  if (!up.ok) return fail('$.version', up.message);
  const parsed = WorkspaceExportV1Schema.safeParse(up.doc);
  if (!parsed.success) {
    return { report: { ok: false, fromVersion: up.from, counts: zeroCounts(), problems: parsed.error.issues.slice(0, 20).map((i) => ({ path: `$.${i.path.join('.')}`, message: i.message })), warnings: [] } };
  }
  const doc = parsed.data as unknown as WorkspaceExportV1;
  const problems: ImportReport['problems'] = [];
  const warnings: string[] = [];

  // Never import something that carries secrets or personal data, whoever produced it.
  for (const f of findSensitive(doc)) problems.push({ path: f.path, message: `Refused: ${f.reason}.` });
  if (target.alreadyImported.includes(doc.exportId)) problems.push({ path: '$.exportId', message: 'This export has already been imported here. Importing it twice would duplicate the workspace.' });

  // References must resolve.
  const actionIds = new Set(doc.investigations.flatMap((i) => i.actions.map((a) => a.id)));
  doc.approvals.forEach((a, i) => {
    if (!actionIds.has(a.actionId)) problems.push({ path: `$.approvals[${i}].actionId`, message: `Approval for “${a.actionId}”, which is not an action in this export.` });
  });
  const invIds = new Set(doc.investigations.map((i) => i.id));
  doc.notifications.forEach((n, i) => {
    if (n.investigationId && !invIds.has(n.investigationId)) problems.push({ path: `$.notifications[${i}].investigationId`, message: `Notification for unknown investigation “${n.investigationId}”.` });
  });
  const connIds = new Set(doc.connections.map((c) => c.id));
  doc.metricDefinitions.forEach((d, i) => {
    if (!connIds.has(d.binding.connectionId)) problems.push({ path: `$.metricDefinitions[${i}].binding.connectionId`, message: `Metric “${d.key}” is bound to unknown connection “${d.binding.connectionId}”.` });
  });
  const dup = (xs: string[], what: string, path: string) => {
    const seen = new Set<string>();
    for (const x of xs) {
      if (seen.has(x)) problems.push({ path, message: `Duplicate ${what} “${x}”.` });
      seen.add(x);
    }
  };
  dup(doc.watches.map((w) => w.id), 'watch id', '$.watches');
  dup(doc.investigations.map((i) => i.id), 'investigation id', '$.investigations');
  dup(doc.connections.map((c) => c.id), 'connection id', '$.connections');
  const watchIds = new Set(doc.watches.map((w) => w.id));
  const orphaned = doc.investigations.filter((i) => !watchIds.has(i.watchId)).length;
  if (orphaned) warnings.push(`${orphaned} investigation(s) belong to a watch that is not in the export; they are kept as history.`);

  const reconnect = doc.connections.filter((c) => c.state === 'connected' || c.state === 'needs_reconnect');
  if (reconnect.length) warnings.push(`${reconnect.length} connected source(s) (${reconnect.map((c) => c.source).join(', ')}) will need reconnecting — credentials are never exported.`);
  if (up.from < EXPORT_VERSION) warnings.push(`Upgraded from export version ${up.from} to ${EXPORT_VERSION}.`);

  const records = (d: ImportedDataset) => d.metrics.length + d.issues.length + d.releases.length + (d.changes?.length ?? 0) + d.feedback.length;
  const counts: ImportReport['counts'] = {
    connections: doc.connections.length,
    needsReconnection: reconnect.length,
    metricDefinitions: doc.metricDefinitions.length,
    watches: doc.watches.length,
    imports: doc.imports.length,
    importedRecords: doc.imports.reduce((a, d) => a + records(d), 0),
    rejectedRows: doc.imports.reduce((a, d) => a + d.rejected.length, 0),
    investigations: doc.investigations.length,
    actions: actionIds.size,
    approvals: doc.approvals.length,
    notifications: doc.notifications.length,
  };
  const ok = problems.length === 0;
  return { report: { ok, fromVersion: up.from, exportId: doc.exportId, workspaceName: doc.workspace.name, counts, problems, warnings }, doc: ok ? doc : undefined };
}

/**
 * Write a validated plan into a server workspace, in one transaction. The target gets a new
 * workspace id and remembers where it came from; record ids inside it are preserved so traces,
 * evidence and approvals stay linked. Connected sources arrive as `needs_reconnect`.
 */
export async function commitServerImport(tx: Transactor, plan: ImportPlan, opts: { workspaceId: string; actor: Actor; clock: Clock }): Promise<Workspace> {
  if (!plan.report.ok || !plan.doc) throw new Error('Cannot import: the dry run reported problems.');
  const doc = plan.doc;
  return tx.run(async (repos) => {
    // Re-check inside the transaction: another import of the same export may have landed meanwhile.
    for (const w of await repos.workspaces.list()) {
      if (w.importedExportIds.includes(doc.exportId)) throw new Error('This export has already been imported here.');
    }
    const now = opts.clock.now();
    const ws: Workspace = {
      id: opts.workspaceId,
      name: doc.workspace.name,
      mode: doc.workspace.mode,
      createdAt: doc.workspace.createdAt,
      settings: doc.workspace.settings,
      brief: doc.workspace.brief,
      importedFrom: { exportId: doc.exportId, workspaceId: doc.workspace.id, origin: doc.producer.origin },
      importedExportIds: [doc.exportId],
      version: 1,
    };
    await repos.workspaces.create(ws);
    if (doc.workspace.clock) await repos.cursors.set(ws.id, 'workspace.clock', doc.workspace.clock);
    for (const c of doc.connections) await repos.connections.save(ws.id, { ...c, workspaceId: ws.id, state: arriving(c.state) });
    for (const d of doc.metricDefinitions) await repos.metricDefs.save(ws.id, d as MetricDefinitionRecord);
    for (const w of doc.watches) await repos.watches.save(ws.id, w);
    for (const d of doc.imports) await repos.imports.save(ws.id, d);
    for (const i of doc.investigations) await repos.investigations.save(ws.id, i);
    for (const a of doc.approvals) await repos.decisions.put(ws.id, { actionId: a.actionId, status: a.status, at: a.at, optionId: a.optionId, note: a.note, result: a.result, decidedBy: a.actor } satisfies Decision);
    for (const n of doc.notifications) await repos.notifications.add(ws.id, { ...n, email: n.email } satisfies NotificationRecord);
    await repos.audit.append({ id: `audit-import-${doc.exportId}`, workspaceId: ws.id, at: now, actor: opts.actor, action: 'workspace.imported', target: doc.exportId, detail: `From ${doc.producer.origin} workspace “${doc.workspace.name}” (${plan.report.counts.investigations} investigations, ${plan.report.counts.watches} watches).` });
    return ws;
  });
}
