import { describe, expect, it } from 'vitest';
import type { MonitoringResult } from '@/product/types';
import { historicalQuickStartRun } from '@/product/view/quickStart';
import { acknowledgeWelcome, isQuickStartOrigin, isWelcomeAcknowledged, shouldReturnToOverviewAfterConnection, shouldShowFirstRunWelcome } from './firstRun';

const runResult = (): MonitoringResult => ({
  window: { start: '2026-09-25T09:00:00.000Z', end: '2026-09-25T10:00:00.000Z' },
  investigations: [], emails: [], briefs: [], connections: [], actions: [],
  log: [{ jobId: 'run-1', type: 'watch_run', watchId: 'watch-1', scheduledAt: '2026-09-25T10:00:00.000Z', outcome: 'quiet', investigationIds: [], emailIds: [] }],
});

const memoryStorage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
};

describe('connected workspace first-run welcome', () => {
  it('shows only after authoritative history loads for an eligible workspace', () => {
    expect(shouldShowFirstRunWelcome({ loading: true, workspaceId: 'eligible', hasHistoricalRun: false, acknowledged: false })).toBe(false);
    expect(shouldShowFirstRunWelcome({ loading: false, workspaceId: 'eligible', hasHistoricalRun: false, acknowledged: false })).toBe(true);
  });

  it('acknowledgement hides Welcome and remains scoped to the workspace', () => {
    const storage = memoryStorage();
    acknowledgeWelcome('workspace-a', storage);
    expect(isWelcomeAcknowledged('workspace-a', storage)).toBe(true);
    expect(isWelcomeAcknowledged('workspace-b', storage)).toBe(false);
    expect(shouldShowFirstRunWelcome({ loading: false, workspaceId: 'workspace-a', hasHistoricalRun: false, acknowledged: true })).toBe(false);
  });

  it('historical attributed watch evidence always suppresses Welcome', () => {
    expect(historicalQuickStartRun(runResult())).toBeDefined();
    expect(shouldShowFirstRunWelcome({ loading: false, workspaceId: 'new-browser', hasHistoricalRun: !!historicalQuickStartRun(runResult()), acknowledged: false })).toBe(false);
  });

  it('keeps a current-tab acknowledgement when localStorage throws', () => {
    const unavailable = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    acknowledgeWelcome('storage-blocked', unavailable);
    expect(isWelcomeAcknowledged('storage-blocked', unavailable)).toBe(true);
  });

  it('recognizes only the explicit Quick Start return marker', () => {
    expect(isQuickStartOrigin('?from=quick-start')).toBe(true);
    expect(isQuickStartOrigin('?from=elsewhere')).toBe(false);
    expect(isQuickStartOrigin('')).toBe(false);
  });

  it('returns from source setup only for a healthy Quick Start connection', () => {
    expect(shouldReturnToOverviewAfterConnection('?from=quick-start', 'healthy')).toBe(true);
    for (const health of ['unverified', 'stale', 'degraded', 'needs_reconnect', 'error'] as const) {
      expect(shouldReturnToOverviewAfterConnection('?from=quick-start', health)).toBe(false);
    }
    expect(shouldReturnToOverviewAfterConnection('', 'healthy')).toBe(false);
  });
});
