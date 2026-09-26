import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * CI runs typecheck and tests with no production configuration: no secrets, no database URL, no deploy,
 * and nothing shared with the scheduler workflow.
 */

const ci = readFileSync('.github/workflows/ci.yml', 'utf8');

describe('CI workflow', () => {
  it('runs on pushes to main and pull requests: npm ci, typecheck, tests', () => {
    expect(ci).toMatch(/push:\n\s+branches: \[main\]/);
    expect(ci).toMatch(/pull_request:/);
    expect(ci).toMatch(/runs-on: ubuntu-latest/);
    const runs = [...ci.matchAll(/- run: (.+)/g)].map((m) => m[1]);
    expect(runs).toEqual(['npm ci', 'npm run typecheck', 'npm test']);
  });

  it('uses no secrets or production configuration, and never deploys', () => {
    expect(ci).not.toMatch(/secrets\./);
    expect(ci).not.toMatch(/DATABASE_URL|CRON_SECRET|JAGR_APP_URL|JAGR_SESSION_SECRET|JAGR_SECRET_KEY|JAGR_LIVE_EVAL=/);
    expect(ci).not.toMatch(/vercel|deploy\b|\/api\/cron/i);
    expect(ci).toMatch(/permissions:\n\s+contents: read/);
  });
});
