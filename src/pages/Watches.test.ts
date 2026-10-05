import { describe, expect, it, vi } from 'vitest';
import type { Watch } from '@/product/types';
import type { ConnectionView } from '@/product/connections/model';
import { effectiveMetricThreshold, ruleText, runCreatedWatch } from './Watches';

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

const watch = { sources: ['amplitude'] } as Pick<Watch, 'sources' | 'thresholds'>;
const amplitude = {
  id: 'conn-amplitude', provider: 'amplitude', source: 'amplitude', displayName: 'Amplitude', kind: 'source', status: 'connected', health: 'healthy', managedBy: 'workspace',
  config: { metrics: [{ kind: 'ratio', key: 'checkout_conversion', threshold: 10 }] },
} as unknown as ConnectionView;

describe('effective metric threshold rendering', () => {
  it('uses the connected Amplitude binding instead of the static sample default', () => {
    const threshold = effectiveMetricThreshold('checkout_conversion', watch, [amplitude]);
    expect(threshold).toBe(10);
    expect(ruleText('checkout_conversion', watch.thresholds, threshold)).toBe('drops more than 10% vs baseline');
  });

  it('uses a valid watch override before the connected binding', () => {
    const overridden = { ...watch, thresholds: { checkout_conversion: 12 } };
    const threshold = effectiveMetricThreshold('checkout_conversion', overridden, [amplitude]);
    expect(threshold).toBe(12);
    expect(ruleText('checkout_conversion', overridden.thresholds, threshold)).toBe('drops more than 12% vs baseline');
  });
});
