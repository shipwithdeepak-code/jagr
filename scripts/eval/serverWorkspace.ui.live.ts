import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { expect, test } from 'vitest';
import type { IdentityProvider } from '../../src/product/ports/identity';
import type { HttpRequest } from '../../src/product/ports/http';
import { scriptedHttp, type Reply } from '../../src/product/testkit/connectorContract';
import { freshPglite } from '../../server/postgres/pglite';
import { createRuntime } from '../../server/runtime';
import { createApp } from '../../server/app';
import { serveApi } from '../../server/http/api';

/**
 * MANUAL browser check of the server-workspace path — never part of `npm test`.
 *
 *   npm run build && JAGR_LIVE_EVAL=1 npx vitest run scripts/eval/serverWorkspace.ui.live.ts
 *
 * Serves the built app and the real API (Postgres via PGlite, real connectors, real secret store) and
 * drives Chromium through: sign in → create a server workspace → connect Jira from the Sources page →
 * create a watch → run → open the investigation. Two things are stand-ins, and only here: the identity
 * provider (a test one that signs in "Ana" without Google/GitHub) and Jira's responses (scripted in
 * Jira's documented shape). Needs Playwright (globally installed) and a Chromium.
 */

const require = createRequire(import.meta.url);
const playwrightPath = join(execSync('npm root -g').toString().trim(), 'playwright');
const SHOTS = process.env.JAGR_UI_SHOTS ?? '/tmp';

test('server workspace in the browser', { timeout: 180_000 }, async () => {
  if (!existsSync('dist/index.html')) throw new Error('Run `npm run build` first.');
  // Playwright is not a project dependency (manual check only): loaded from the global install, loosely typed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { chromium } = require(playwrightPath) as { chromium: { launch(): Promise<any> } };
  const now = Date.now();
  const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString().replace('Z', '+0000');
  const issues = [55, 45, 35, 20, 10].map((m, i) => ({ key: `SHOP-${400 + i}`, fields: { summary: `Checkout payment fails on submit (${i + 1})`, created: at(m), issuetype: { name: 'Bug' }, priority: { name: 'High' }, components: [{ name: 'Checkout' }], labels: [], versions: [] } }));
  const jira = (u: URL, init?: HttpRequest): Reply | undefined => {
    if (u.hostname !== 'acme.atlassian.net') return undefined;
    if (u.pathname === '/rest/api/3/project/SHOP') return { body: { key: 'SHOP' } };
    if (u.pathname === '/rest/api/3/search/jql' && init?.method === 'POST') return { body: { issues, isLast: true } };
    if (u.pathname === '/rest/api/3/project/SHOP/versions') return { body: [] };
    return undefined;
  };

  let base = '';
  const idp: IdentityProvider = { id: 'test', authorizationUrl: ({ state }) => `${base}/api/auth/test/callback?code=ana&state=${state}`, exchange: async () => ({ provider: 'test', subject: 'ana-1', emailVerified: true, displayName: 'Ana' }) };
  const rt = await createRuntime({ JAGR_SESSION_SECRET: randomBytes(32).toString('hex'), JAGR_SECRET_KEY: randomBytes(32).toString('base64'), JAGR_APP_URL: 'http://127.0.0.1' }, { sql: await freshPglite(), identity: { test: idp }, http: scriptedHttp(jira).http });
  const app = createApp(rt);
  const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.csv': 'text/csv', '.json': 'application/json' };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path.startsWith('/api/')) return void serveApi(app, req, res);
    const file = join('dist', path);
    const target = path !== '/' && existsSync(file) ? file : 'dist/index.html';
    res.setHeader('content-type', TYPES[extname(target)] ?? 'application/octet-stream');
    res.end(readFileSync(target));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  try {
    // 1. Sign in and create a server workspace.
    await page.goto(`${base}/settings`);
    await page.getByText('Where this workspace lives').waitFor();
    await page.getByRole('link', { name: /Sign in with test/ }).click();
    await page.getByText('Signed in as Ana').waitFor();
    await page.getByLabel('New server workspace').fill('Acme checkout');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.getByText('Server workspace · Acme checkout').first().waitFor();
    await page.screenshot({ path: `${SHOTS}/jagr-1-settings.png`, fullPage: true });

    // 2. Connect Jira from the Sources page.
    await page.goto(`${base}/sources`);
    await page.getByText('Connect a source').waitFor();
    const jiraCard = page.locator('div', { has: page.getByText('Jira', { exact: true }) }).filter({ has: page.getByRole('button', { name: 'Connect' }) }).last();
    await jiraCard.getByRole('button', { name: 'Connect' }).click();
    await page.getByLabel('Configuration (non-secret)').fill(JSON.stringify({ site: 'https://acme.atlassian.net', project: 'SHOP' }));
    await page.getByLabel('Atlassian account email').fill('svc@acme.test');
    await page.getByLabel('API token').fill('ATATT-ui-test-token');
    await page.getByRole('button', { name: 'Connect and test' }).click();
    await page.getByText('Last successful check').first().waitFor();
    const sourcesText = await page.locator('main').innerText();
    expect(sourcesText).not.toContain('ATATT-ui-test-token');
    expect(sourcesText).toContain('acme.atlassian.net · SHOP');
    await page.screenshot({ path: `${SHOTS}/jagr-2-sources.png`, fullPage: true });

    // 3. A watch (through the API from the page, the same call the Watches page makes), then Run.
    await page.evaluate(async () => {
      const csrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('jagr_csrf='))!.slice(10));
      const ws = localStorage.getItem('jagr:server-workspace');
      const r = await fetch(`/api/workspaces/${ws}/watches`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-jagr-csrf': csrf }, body: JSON.stringify({ templateId: 'customer_issues', sources: ['jira'] }) });
      if (!r.ok) throw new Error(`watch: ${r.status}`);
    });
    await page.goto(`${base}/`);
    await page.getByRole('button', { name: 'Run monitoring' }).first().click();
    await page.getByText(/Monitoring complete|investigation/i).first().waitFor({ timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/jagr-3-overview.png`, fullPage: true });

    // 4. The investigation, with evidence from the connected source (not simulated).
    await page.goto(`${base}/investigations`);
    const link = page.locator('a[href^="/investigations/w/"]').first();
    await link.waitFor();
    await link.click();
    await page.getByText(/SHOP-40\d/).first().waitFor();
    const inv = await page.locator('main').innerText();
    expect(inv).not.toMatch(/SIMULATED SOURCE/);
    expect(inv).toMatch(/Data:\s*LIVE/);
    expect(inv).not.toMatch(/Data:\s*SIMULATED/);
    await page.screenshot({ path: `${SHOTS}/jagr-4-investigation.png`, fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    server.close();
  }
});
