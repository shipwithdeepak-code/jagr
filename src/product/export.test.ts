import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultBriefSchedule, defaultWatches, EMAIL_FROM } from './catalog';
import { defaultConnections } from './integrations/adapters';
import { defaultWorld } from './integrations/world';
import { runMonitoring } from './engine/monitor';
import { decide } from './agent/decisions';
import { importFile } from './imports/schemas';
import { createMemoryPersistence } from './ports/memory';
import { manualClock } from './ports/clock';
import { commitServerImport, exportLocalWorkspace, exportServerWorkspace, ExportRefused, localWorkspaceFromExport, planImport, upgradeExport, type LocalWorkspaceSnapshot } from './export/workspace';
import { findSensitive } from './export/scan';
import type { WorkspaceExportV1 } from './export/v1';

const NOW = '2026-09-24T08:10:00.000Z';
const APP = '1.1.0';
const FIXTURE = 'src/product/export/__fixtures__/export-v1.sample.json';

async function sampleWorkspace(): Promise<LocalWorkspaceSnapshot> {
  const connections = defaultConnections();
  const result = await runMonitoring({ world: defaultWorld(), watches: defaultWatches(), connections, brief: defaultBriefSchedule() });
  const inv = result.investigations.find((i) => i.area === 'checkout')!;
  const pause = inv.actions.find((a) => a.kind === 'pause_rollout')!;
  const incident = inv.actions.find((a) => a.kind === 'create_incident')!;
  return {
    connections,
    watches: defaultWatches(),
    brief: defaultBriefSchedule(),
    result,
    clock: '2026-09-24T08:05:00.000Z',
    planner: 'deterministic',
    workspace: { mode: 'sample', createdAt: '2026-09-24T08:00:00.000Z' },
    decisions: {
      [pause.id]: decide(pause, { status: 'approved', at: '2026-09-24T08:07:00.000Z', optionId: pause.options?.[0]?.id, note: 'Pause Android only' }),
      [incident.id]: decide(incident, { status: 'done', at: '2026-09-24T08:06:00.000Z' }),
    },
  };
}

function myDataWorkspace(): LocalWorkspaceSnapshot {
  const csv = (f: string) => readFileSync(`public/samples/${f}`, 'utf8');
  const at = '2026-09-25T09:00:00.000Z';
  return {
    connections: defaultConnections(),
    watches: defaultWatches(),
    brief: defaultBriefSchedule(),
    clock: at,
    decisions: {},
    workspace: { mode: 'imported', createdAt: at },
    imports: [
      importFile('metrics', 'metrics.csv', csv('metrics.csv'), at),
      importFile('releases', 'releases.csv', csv('releases.csv'), at),
      importFile('changes', 'changes.csv', csv('changes.csv'), at),
      importFile('feedback', 'fb.csv', 'id,text,created_at,channel\nS-1,Card declined — reach me at jane.doe@example.com,2026-09-24T20:00:00Z,support\n', at),
    ],
  };
}

/** Ignore what legitimately differs between two exports of the same content: identity and origin. */
function normalized(d: WorkspaceExportV1) {
  const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
  return {
    ...d,
    exportId: '·',
    exportedAt: '·',
    producer: { ...d.producer, origin: '·' },
    workspace: { ...d.workspace, id: '·' },
    connections: byId(d.connections),
    watches: byId(d.watches),
    imports: byId(d.imports),
    investigations: byId(d.investigations),
    approvals: [...d.approvals].sort((a, b) => a.actionId.localeCompare(b.actionId)),
    notifications: byId(d.notifications),
  };
}

describe('Workspace Export v1 — round trips', () => {
  it('browser-local → export → import → export is lossless', async () => {
    const first = exportLocalWorkspace(await sampleWorkspace(), { now: NOW, appVersion: APP });
    const plan = planImport(JSON.stringify(first), { alreadyImported: [] });
    expect(plan.report.problems).toEqual([]);
    const back = localWorkspaceFromExport(plan.doc!, { emailFrom: EMAIL_FROM });
    const second = exportLocalWorkspace(back, { now: NOW, appVersion: APP });
    expect(second).toEqual(first);
  });

  it('browser-local → export → server (in-memory repositories) → export is lossless', async () => {
    const first = exportLocalWorkspace(await sampleWorkspace(), { now: NOW, appVersion: APP });
    const { repos, tx } = createMemoryPersistence();
    const clock = manualClock('2026-09-25T10:00:00.000Z');
    const plan = planImport(first, { alreadyImported: [] });
    const ws = await commitServerImport(tx, plan, { workspaceId: 'ws-server-1', actor: { ref: 'user-1', displayName: 'Deepak' }, clock });
    expect(ws.importedFrom).toEqual({ exportId: first.exportId, workspaceId: 'local', origin: 'browser-local' });
    const second = await exportServerWorkspace(repos, 'ws-server-1', { clock, appVersion: APP });
    expect(normalized(second)).toEqual(normalized(first));
    expect((await repos.audit.list('ws-server-1')).map((a) => a.action)).toEqual(['workspace.imported']);
  });

  it('carries imported data and its rejected rows (the data is the source)', async () => {
    const doc = exportLocalWorkspace(myDataWorkspace(), { now: NOW, appVersion: APP });
    expect(doc.imports.map((d) => d.kind)).toEqual(['metrics', 'releases', 'changes', 'feedback']);
    expect(doc.imports.find((d) => d.kind === 'releases')!.rejected.length).toBeGreaterThan(0);
    const plan = planImport(doc, { alreadyImported: [] });
    expect(plan.report.counts).toMatchObject({ imports: 4, rejectedRows: doc.imports.reduce((a, d) => a + d.rejected.length, 0) });
    expect(plan.report.counts.importedRecords).toBeGreaterThan(50);
  });

  it('the committed sample export still imports, and re-exports identically', async () => {
    if (process.env.JAGR_UPDATE_FIXTURES || !existsSync(FIXTURE)) writeFileSync(FIXTURE, `${JSON.stringify(exportLocalWorkspace(await sampleWorkspace(), { now: NOW, appVersion: APP }), null, 1)}\n`);
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as WorkspaceExportV1;
    const plan = planImport(fixture, { alreadyImported: [] });
    expect(plan.report).toMatchObject({ ok: true, fromVersion: 1, problems: [] });
    const again = exportLocalWorkspace(localWorkspaceFromExport(plan.doc!, { emailFrom: EMAIL_FROM }), { now: fixture.exportedAt, appVersion: fixture.producer.appVersion });
    expect(again).toEqual(fixture);
  });
});

describe('Workspace Export v1 — what never leaves', () => {
  it('no secrets, tokens, sessions or email addresses; people are { ref, displayName }', async () => {
    const doc = exportLocalWorkspace(await sampleWorkspace(), { now: NOW, appVersion: APP });
    expect(findSensitive(doc)).toEqual([]);
    const text = JSON.stringify(doc);
    expect(text).not.toMatch(/@tempo\.example|@jagr\.example/);
    expect(doc.approvals.every((a) => Object.keys(a.actor).sort().join() === 'displayName,ref')).toBe(true);
    for (const n of doc.notifications) expect(n.email && ('to' in n.email || 'from' in n.email)).toBe(false);
  });

  it('customer email addresses in imported text are redacted', () => {
    const doc = exportLocalWorkspace(myDataWorkspace(), { now: NOW, appVersion: APP });
    const text = JSON.stringify(doc);
    expect(text).not.toMatch(/jane\.doe@example\.com/);
    expect(text).toMatch(/reach me at \[email removed\]/);
  });

  it('anything that looks like a credential makes the export fail closed', async () => {
    const ws = await sampleWorkspace();
    ws.connections = ws.connections.map((c) => (c.provider === 'jira' ? { ...c, detail: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456' } : c));
    expect(() => exportLocalWorkspace(ws, { now: NOW, appVersion: APP })).toThrow(ExportRefused);
  });

  it('an export tampered with to carry a secret is refused on import', async () => {
    const doc = exportLocalWorkspace(await sampleWorkspace(), { now: NOW, appVersion: APP });
    const tampered = { ...doc, connections: doc.connections.map((c, i) => (i === 0 ? { ...c, config: { apiKey: 'AK-123456' } } : c)) };
    const plan = planImport(tampered, { alreadyImported: [] });
    expect(plan.report.ok).toBe(false);
    expect(plan.report.problems.map((p) => p.path)).toContain('$.connections[0].config.apiKey');
  });

  it('Demo night is never part of an export', async () => {
    const text = JSON.stringify(exportLocalWorkspace(await sampleWorkspace(), { now: NOW, appVersion: APP }));
    expect(text).not.toMatch(/nightwatch|"humanEvents"|"drafts"|TASK-/);
  });
});

describe('Workspace Export v1 — import rules', () => {
  it('connected sources arrive as "needs reconnection" (credentials never travel)', async () => {
    const doc = exportLocalWorkspace(await sampleWorkspace(), { now: NOW, appVersion: APP });
    const live: WorkspaceExportV1 = { ...doc, connections: [...doc.connections, { ...doc.connections[0], id: 'conn-gh', source: 'github', provider: 'github', roles: ['changes'], authKind: 'app_install', state: 'connected', detail: 'acme/checkout', config: { repos: ['acme/checkout'] } }] };
    const plan = planImport(live, { alreadyImported: [] });
    expect(plan.report.counts.needsReconnection).toBe(1);
    expect(plan.report.warnings.join(' ')).toMatch(/1 connected source\(s\) \(github\) will need reconnecting/);
    const { repos, tx } = createMemoryPersistence();
    await commitServerImport(tx, plan, { workspaceId: 'ws-1', actor: { ref: 'u1', displayName: 'U' }, clock: manualClock(NOW) });
    expect((await repos.connections.get('ws-1', 'conn-gh'))?.state).toBe('needs_reconnect');
    expect(localWorkspaceFromExport(plan.doc!, { emailFrom: EMAIL_FROM }).connections.find((c) => c.provider === 'github')?.state).toBe('needs_reconnect');
  });

  it('importing the same export twice is refused — in the dry run and inside the write', async () => {
    const doc = exportLocalWorkspace(await sampleWorkspace(), { now: NOW, appVersion: APP });
    expect(planImport(doc, { alreadyImported: [doc.exportId] }).report.problems[0].message).toMatch(/already been imported/);
    const { tx } = createMemoryPersistence();
    const clock = manualClock(NOW);
    const plan = planImport(doc, { alreadyImported: [] });
    await commitServerImport(tx, plan, { workspaceId: 'ws-1', actor: { ref: 'u1', displayName: 'U' }, clock });
    // A second attempt whose dry run raced ahead of the first write is still refused.
    await expect(commitServerImport(tx, plan, { workspaceId: 'ws-2', actor: { ref: 'u1', displayName: 'U' }, clock })).rejects.toThrow(/already been imported/);
  });

  it('a newer, unknown version is refused clearly and nothing is imported', async () => {
    const doc = exportLocalWorkspace(await sampleWorkspace(), { now: NOW, appVersion: APP });
    const plan = planImport({ ...doc, version: 2 }, { alreadyImported: [] });
    expect(plan.report.ok).toBe(false);
    expect(plan.doc).toBeUndefined();
    expect(plan.report.problems[0].message).toMatch(/version 2, newer than this Jagr understands \(version 1\)\. Update Jagr/);
  });

  it('malformed exports are refused with where and why', async () => {
    const doc = exportLocalWorkspace(await sampleWorkspace(), { now: NOW, appVersion: APP });
    expect(planImport('{nope', { alreadyImported: [] }).report.problems[0].message).toMatch(/not valid JSON/);
    expect(planImport({ format: 'something-else', version: 1 }, { alreadyImported: [] }).report.problems[0].message).toMatch(/not a Jagr workspace export/);
    expect(planImport({ ...doc, watches: 'many' }, { alreadyImported: [] }).report.problems[0].path).toBe('$.watches');
    expect(planImport({ ...doc, workspace: { ...doc.workspace, brief: { ...doc.workspace.brief, time: '8am' } } }, { alreadyImported: [] }).report.problems[0].path).toBe('$.workspace.brief.time');
    const orphan = planImport({ ...doc, approvals: [...doc.approvals, { ...doc.approvals[0], actionId: 'act-nowhere' }] }, { alreadyImported: [] });
    expect(orphan.report.problems.map((p) => p.message).join(' ')).toMatch(/not an action in this export/);
    const dupe = planImport({ ...doc, watches: [...doc.watches, doc.watches[0]] }, { alreadyImported: [] });
    expect(dupe.report.problems.map((p) => p.message).join(' ')).toMatch(/Duplicate watch id/);
    expect(planImport({ ...doc, surprise: true }, { alreadyImported: [] }).report.ok).toBe(false);
  });

  it('the upgrade chain applies each step in order (v1 → v2 → v3), and refuses gaps', () => {
    const v1 = { format: 'jagr.workspace-export', version: 1, a: 1 };
    const migrations = { 1: (d: Record<string, unknown>) => ({ ...d, b: 2 }), 2: (d: Record<string, unknown>) => ({ ...d, a: undefined, c: (d.a as number) + (d.b as number) }) };
    const up = upgradeExport(v1, 3, migrations);
    expect(up).toMatchObject({ ok: true, from: 1, doc: { version: 3, b: 2, c: 3 } });
    expect(upgradeExport(v1, 3, { 1: migrations[1] })).toMatchObject({ ok: false, code: 'NO_MIGRATION' });
    expect(upgradeExport({ ...v1, version: 3 }, 3, migrations)).toMatchObject({ ok: true, from: 3 });
  });
});
