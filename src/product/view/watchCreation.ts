import type { Watch } from '../types.js';

export type CreateWatchResult = { ok: true; warning?: string } | { ok: false; error: string };

export interface WatchCreationState {
  creating: boolean;
  created?: Watch;
  error?: string;
  warning?: string;
}

export const initialWatchCreationState: WatchCreationState = { creating: false };

/** One awaited creation attempt; the UI remains pending until persistence succeeds or fails. */
export async function createWatchWithState(
  watch: Watch,
  persist: (watch: Watch) => Promise<CreateWatchResult>,
  update: (state: WatchCreationState) => void,
): Promise<void> {
  update({ creating: true });
  let final: WatchCreationState = { creating: false, error: 'The watch could not be created.' };
  try {
    const result = await persist(watch);
    final = result.ok ? { creating: false, created: watch, ...(result.warning ? { warning: result.warning } : {}) } : { creating: false, error: result.error };
  } catch (error) {
    final = { creating: false, error: (error as Error).message || 'The watch could not be created.' };
  } finally {
    update(final);
  }
}

export const WATCH_REFRESH_WARNING = 'The watch was created, but Jagr could not refresh the workspace. Close this dialog and refresh; do not create the watch again.';

/** Persistence is authoritative; a later snapshot failure must not turn success into a retryable creation error. */
export async function persistWatchAndRefresh(persist: () => Promise<void>, refresh: () => Promise<boolean>): Promise<Extract<CreateWatchResult, { ok: true }>> {
  await persist();
  try {
    return (await refresh()) ? { ok: true } : { ok: true, warning: WATCH_REFRESH_WARNING };
  } catch {
    return { ok: true, warning: WATCH_REFRESH_WARNING };
  }
}
