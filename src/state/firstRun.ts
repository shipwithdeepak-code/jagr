import type { ConnectionHealth } from '@/product/connections/model';

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const acknowledgedInTab = new Set<string>();
const keyFor = (workspaceId: string) => `jagr:first-run-welcome:${workspaceId}`;

const browserStorage = (): PreferenceStorage | undefined => {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
};

export function isWelcomeAcknowledged(workspaceId: string, storage: PreferenceStorage | undefined = browserStorage()): boolean {
  if (acknowledgedInTab.has(workspaceId)) return true;
  try {
    return storage?.getItem(keyFor(workspaceId)) === 'acknowledged';
  } catch {
    return false;
  }
}

export function acknowledgeWelcome(workspaceId: string, storage: PreferenceStorage | undefined = browserStorage()): void {
  acknowledgedInTab.add(workspaceId);
  try {
    storage?.setItem(keyFor(workspaceId), 'acknowledged');
  } catch {
    // A preference must not block onboarding; the in-memory acknowledgement lasts for this tab.
  }
}

export function shouldShowFirstRunWelcome(input: { loading: boolean; workspaceId: string; hasHistoricalRun: boolean; acknowledged?: boolean }): boolean {
  if (input.loading || input.hasHistoricalRun) return false;
  return !(input.acknowledged ?? isWelcomeAcknowledged(input.workspaceId));
}

export function isQuickStartOrigin(search: string): boolean {
  return new URLSearchParams(search).get('from') === 'quick-start';
}

export function shouldReturnToOverviewAfterConnection(search: string, health: ConnectionHealth): boolean {
  return isQuickStartOrigin(search) && health === 'healthy';
}
