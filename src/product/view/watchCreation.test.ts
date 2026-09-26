import { describe, expect, it, vi } from 'vitest';
import { watchFromTemplate } from '../catalog';
import { createWatchWithState, initialWatchCreationState, persistWatchAndRefresh, WATCH_REFRESH_WARNING, type CreateWatchResult, type WatchCreationState } from './watchCreation';

const watch = watchFromTemplate('w-gh', 'github_changes', { sources: ['github'] });
const deferred = () => {
  let resolve!: (result: CreateWatchResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<CreateWatchResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe('awaited watch creation', () => {
  it('stays pending, non-dismissible, and without a runnable watch until persistence succeeds', async () => {
    const pending = deferred();
    let state: WatchCreationState = initialWatchCreationState;
    const persist = vi.fn(() => pending.promise);
    const attempt = createWatchWithState(watch, persist, (next) => { state = next; });

    expect(state).toEqual({ creating: true });
    expect(state.created).toBeUndefined();
    expect(state.creating).toBe(true); // The wizard disables Close, Back, and Escape from this state.

    pending.resolve({ ok: true });
    await attempt;
    expect(state).toEqual({ creating: false, created: watch });
    expect(persist).toHaveBeenCalledOnce();
  });

  it('shows the persistence error and never exposes Run when creation returns false', async () => {
    let state = initialWatchCreationState;
    await createWatchWithState(watch, async () => ({ ok: false, error: 'Server refused the watch.' }), (next) => { state = next; });
    expect(state).toEqual({ creating: false, error: 'Server refused the watch.' });
    expect(state.created).toBeUndefined();
  });

  it('turns rejection into a visible error and always clears pending state', async () => {
    const pending = deferred();
    let state = initialWatchCreationState;
    const attempt = createWatchWithState(watch, () => pending.promise, (next) => { state = next; });
    expect(state.creating).toBe(true);
    pending.reject(new Error('Network failed.'));
    await attempt;
    expect(state).toEqual({ creating: false, error: 'Network failed.' });
    expect(state.created).toBeUndefined();
  });

  it('preserves persistence success when the following snapshot refresh rejects', async () => {
    const persist = vi.fn(async () => undefined);
    const refresh = vi.fn(async (): Promise<boolean> => { throw new Error('Snapshot unavailable.'); });
    let state = initialWatchCreationState;
    await createWatchWithState(watch, () => persistWatchAndRefresh(persist, refresh), (next) => { state = next; });
    expect(state).toEqual({ creating: false, created: watch, warning: WATCH_REFRESH_WARNING });
    expect(persist).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });
});
