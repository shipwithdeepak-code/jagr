import { describe, expect, it, vi } from 'vitest';
import { runCreatedWatch } from './Watches';

describe('onboarding-originated watch run', () => {
  it('returns only after monitoring succeeds', async () => {
    const returned = vi.fn();
    await runCreatedWatch(async () => undefined, returned);
    expect(returned).toHaveBeenCalledOnce();
  });

  it('does not return when monitoring fails', async () => {
    const returned = vi.fn();
    await expect(runCreatedWatch(async () => { throw new Error('run failed'); }, returned)).rejects.toThrow('run failed');
    expect(returned).not.toHaveBeenCalled();
  });
});
