import { afterEach, expect, it, vi } from 'vitest';
import { startWorkspaceRefresh } from './workspaceRefresh';

afterEach(() => vi.useRealTimers());
it('refreshes pending reads, backs off after ten minutes, and never overlaps a slow read', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const read = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
  const stop = startWorkspaceRefresh({ visible: () => true, pending: () => true, read, onError: vi.fn() });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(read).toHaveBeenCalledTimes(1);
  release();
  await vi.advanceTimersByTimeAsync(59_999);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
  stop(); release();
});
it('idles hidden tabs, refreshes ordinary snapshots once a minute, and cancels on workspace change', async () => {
  vi.useFakeTimers();
  let visible = false;
  const read = vi.fn(async () => undefined);
  const stop = startWorkspaceRefresh({ visible: () => visible, pending: () => false, read, onError: vi.fn() });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(read).not.toHaveBeenCalled();
  visible = true;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(read).toHaveBeenCalledTimes(1);
  stop();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(read).toHaveBeenCalledTimes(1);
});
it('retries read failures without requesting monitoring or inventing a result', async () => {
  vi.useFakeTimers();
  const onError = vi.fn();
  const read = vi.fn().mockRejectedValue(new Error('unavailable'));
  const stop = startWorkspaceRefresh({ visible: () => true, pending: () => true, read, onError });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(read).toHaveBeenCalledTimes(2);
  expect(onError).toHaveBeenCalledTimes(2);
  stop();
});
