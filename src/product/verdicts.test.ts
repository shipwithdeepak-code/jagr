import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { verdictFingerprint } from './evaluation/verdicts';

/**
 * Regression lock: every golden, adversarial and planner verdict — and every investigation's
 * conclusion — must match the committed baseline. A refactor that changes names is fine; one that
 * changes a verdict fails here. Update deliberately with JAGR_UPDATE_VERDICTS=1 and explain why.
 */
const BASELINE = fileURLToPath(new URL('./evaluation/verdicts.baseline.json', import.meta.url));

describe('evaluation verdicts', () => {
  it('match the committed baseline', async () => {
    const now = JSON.parse(JSON.stringify(await verdictFingerprint()));
    if (process.env.JAGR_UPDATE_VERDICTS) writeFileSync(BASELINE, `${JSON.stringify(now, null, 1)}\n`);
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
    expect(now).toEqual(baseline);
  }, 120_000);
});
