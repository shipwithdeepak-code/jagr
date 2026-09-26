import { describe, expect, it } from 'vitest';
import { BUILTIN_SOURCE_ROLES, watchFromTemplate } from '../catalog';
import type { ConnectionView } from '../connections/model';
import type { ConnectionHealth } from '../connections/model';
import type { MonitoringResult, ProviderId, SourceConnection, WatchInvestigation } from '../types';
import { connectedQuickStartState, runHasEvidenceGap, type ConnectedQuickStartInput } from './quickStart';

const AT = '2026-09-25T10:00:00.000Z';
const source = (health: ConnectionHealth, provider = 'github'): ConnectionView => ({
  id: `conn-${provider}`, provider, source: provider, displayName: provider, roles: BUILTIN_SOURCE_ROLES[provider as keyof typeof BUILTIN_SOURCE_ROLES] ?? [], kind: 'source', managedBy: 'workspace', authKind: 'api_key', status: health === 'needs_reconnect' ? 'needs_reconnect' : health === 'error' ? 'error' : health === 'degraded' ? 'unavailable' : 'connected', health, healthDetail: health, needsReconnect: health === 'needs_reconnect', capabilities: [], config: {}, createdAt: AT, updatedAt: AT,
});
const productSource = (provider: ProviderId = 'github'): SourceConnection => ({ provider, state: 'connected', detail: 'Connected', updatedAt: AT });
const watch = watchFromTemplate('w-gh', 'github_changes', { sources: ['github'] }, AT);
const runResult = (investigations: WatchInvestigation[] = []): MonitoringResult => ({
  window: { start: AT, end: AT }, investigations, emails: [], briefs: [], connections: [productSource()], actions: [],
  log: [{ jobId: 'run-1', type: 'watch_run', watchId: watch.id, scheduledAt: AT, outcome: 'GitHub: 0 deployments, 0 releases', investigationIds: investigations.map((i) => i.id), emailIds: [] }],
});
const input = (over: Partial<ConnectedQuickStartInput> = {}): ConnectedQuickStartInput => ({ loading: false, connections: [source('healthy')], productConnections: [productSource()], watches: [], running: false, clock: AT, snapshotAt: AT, ...over });

describe('connected workspace Quick Start state', () => {
  it('waits for the authoritative server snapshot', () => {
    expect(connectedQuickStartState(input({ loading: true, connections: [] })).stage).toBe('loading');
  });

  it('requires a healthy evidence source', () => {
    expect(connectedQuickStartState(input({ connections: [] })).stage).toBe('source');
    for (const health of ['unverified', 'stale', 'degraded', 'needs_reconnect', 'error'] as const) {
      expect(connectedQuickStartState(input({ connections: [source(health)] })).stage).toBe('source');
    }
  });

  it('recommends the first compatible template only after a source is healthy', () => {
    const state = connectedQuickStartState(input());
    expect(state).toMatchObject({ stage: 'watch', recommendedTemplate: 'github_changes', showChecklist: true });
  });

  it('asks a persisted watch that has never run to run its first check', () => {
    expect(connectedQuickStartState(input({ watches: [watch] }))).toMatchObject({ stage: 'run', running: false, showChecklist: true });
  });

  it('does not qualify an active watch when its healthy source cannot serve any watch signal', () => {
    const incompatible = watchFromTemplate('w-issues', 'customer_issues', { sources: ['amplitude'] }, AT);
    expect(connectedQuickStartState(input({ connections: [source('healthy', 'amplitude')], productConnections: [productSource('amplitude')], watches: [incompatible] }))).toMatchObject({ stage: 'watch', showChecklist: true });
  });

  it('does not advance for paused watches or watches backed only by unhealthy sources', () => {
    expect(connectedQuickStartState(input({ watches: [{ ...watch, status: 'paused' }] })).stage).toBe('watch');
    const jiraWatch = watchFromTemplate('w-jira', 'customer_issues', { sources: ['jira'] }, AT);
    expect(connectedQuickStartState(input({ watches: [jiraWatch] })).stage).toBe('watch');
    expect(connectedQuickStartState(input({ connections: [source('healthy', 'jira')], productConnections: [productSource('jira')], watches: [jiraWatch] })).stage).toBe('run');
  });

  it('uses only healthy sources when healthy and unhealthy connections are mixed', () => {
    const jiraWatch = watchFromTemplate('w-jira', 'customer_issues', { sources: ['jira'] }, AT);
    const connections = [source('healthy', 'github'), source('degraded', 'jira')];
    const productConnections = [productSource('github'), productSource('jira')];
    expect(connectedQuickStartState(input({ connections, productConnections, watches: [jiraWatch] })).stage).toBe('watch');
    expect(connectedQuickStartState(input({ connections, productConnections, watches: [watch] })).stage).toBe('run');
  });

  it('uses the same run stage with concise running feedback', () => {
    expect(connectedQuickStartState(input({ watches: [watch], running: true }))).toMatchObject({ stage: 'run', running: true, showChecklist: true });
  });

  it('recognizes a quiet attributed run as successful completion and hides setup', () => {
    expect(connectedQuickStartState(input({ watches: [watch], result: runResult() }))).toMatchObject({ stage: 'quiet', showChecklist: false, lastRun: { watchId: 'w-gh' } });
  });

  it('recognizes a real investigation and exposes only its canonical path', () => {
    const investigation = { id: 'inv-1', updatedAt: AT, jagrPath: '/investigations/w/inv-1' } as WatchInvestigation;
    expect(connectedQuickStartState(input({ watches: [watch], result: runResult([investigation]) }))).toMatchObject({ stage: 'investigation', showChecklist: false, investigation: { jagrPath: '/investigations/w/inv-1' } });
  });

  it('never associates a newer unrelated investigation with the completed run', () => {
    const related = { id: 'inv-related', updatedAt: AT, jagrPath: '/investigations/w/inv-related' } as WatchInvestigation;
    const unrelated = { id: 'inv-unrelated', updatedAt: '2026-09-25T11:00:00.000Z', jagrPath: '/investigations/w/inv-unrelated' } as WatchInvestigation;
    const result = runResult([related]);
    result.investigations.push(unrelated);
    expect(connectedQuickStartState(input({ watches: [watch], result }))).toMatchObject({ stage: 'investigation', investigation: { id: 'inv-related' } });
  });

  it('keeps completed workspaces out of Quick Start', () => {
    expect(connectedQuickStartState(input({ watches: [watch], result: runResult() })).showChecklist).toBe(false);
  });

  it('completion survives unhealthy sources, watch deletion, and snapshot refresh', () => {
    const result = runResult();
    expect(connectedQuickStartState(input({ connections: [source('stale')], watches: [watch], result })).showChecklist).toBe(false);
    expect(connectedQuickStartState(input({ connections: [source('degraded')], watches: [watch], result })).showChecklist).toBe(false);
    expect(connectedQuickStartState(input({ watches: [], result })).showChecklist).toBe(false);
    expect(connectedQuickStartState(input({ loading: true, watches: [watch], result })).showChecklist).toBe(false);
  });

  it('distinguishes a recorded evidence gap from a genuine quiet outcome', () => {
    expect(runHasEvidenceGap('All signals within normal range')).toBe(false);
    expect(runHasEvidenceGap('All signals within normal range · Jira unavailable')).toBe(true);
    expect(runHasEvidenceGap('No change source to read')).toBe(true);
  });
});
