import { describe, expect, it } from 'vitest';
import { createMemoryPersistence } from '../ports/memory';
import type { WatchInvestigation } from '../types';
import { buildSnapshot } from './workspaceSnapshot';
import { FULL_DOCUMENT_CHAR_LIMIT, HistorySizeError } from '../ports/history';

const AT = '2026-09-25T10:00:00.000Z';

describe('paged workspace snapshot', () => {
  it('keeps complete logical history across pages and only reads recent watch-run audit entries', async () => {
    const { repos } = createMemoryPersistence();
    await repos.organizations.create({ id: 'org-snapshot', name: 'Snapshot', createdAt: AT });
    const ws = { id: 'ws-snapshot', organizationId: 'org-snapshot', name: 'Snapshot', mode: 'connected' as const, createdAt: AT, settings: { planner: 'deterministic' as const, aiEgressAllowed: false, timezone: 'UTC' }, brief: { enabled: false, time: '08:00', timezone: 'UTC' }, importedExportIds: [], version: 1 };
    await repos.workspaces.create(ws);
    for (let i = 0; i < 125; i++) {
      const id = `inv-${String(i).padStart(3, '0')}`;
      await repos.investigations.save(ws.id, { id, startedAt: AT, updatedAt: AT, trace: [], actions: [] } as unknown as WatchInvestigation);
      await repos.audit.append({ id: `audit-${id}`, workspaceId: ws.id, at: AT, actor: { ref: 'system', displayName: 'Jagr' }, action: 'monitor.watch', target: 'watch-1', detail: 'Run completed' });
    }
    let pages = 0;
    const scoped = { ...repos,
      investigations: { ...repos.investigations,
        list: async () => { throw new Error('full investigation list must not be used'); },
        page: async (...args: Parameters<typeof repos.investigations.page>) => { pages++; return repos.investigations.page(...args); },
      },
      audit: { ...repos.audit, list: async () => { throw new Error('full audit list must not be used'); } },
    };
    const snapshot = await buildSnapshot(scoped, ws, { role: 'owner', canApprove: true }, AT);
    expect(snapshot.investigations).toHaveLength(125);
    expect(new Set(snapshot.investigations.map((inv) => inv.id)).size).toBe(125);
    expect(snapshot.investigations.map((inv) => inv.id)).toEqual([...snapshot.investigations.map((inv) => inv.id)].sort());
    expect(snapshot.runs).toHaveLength(100);
    expect(pages).toBeGreaterThan(1);
    await expect(repos.investigations.page({ organizationId: 'another-org', workspaceId: ws.id })).rejects.toThrow('Workspace');
    await repos.investigations.save(ws.id, { id: 'oversized', startedAt: AT, updatedAt: AT, summary: 'x'.repeat(FULL_DOCUMENT_CHAR_LIMIT) } as unknown as WatchInvestigation);
    await expect(buildSnapshot(scoped, ws, { role: 'owner', canApprove: true }, AT)).rejects.toBeInstanceOf(HistorySizeError);
  });
});
