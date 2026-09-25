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
 * MANUAL responsive regression pass — never part of `npm test`.
 *
 *   npm run build && JAGR_LIVE_EVAL=1 npx vitest run scripts/eval/qa.ui.live.ts --reporter=verbose
 *
 * Every product surface at 390 / 768 / 1024 / 1440 px, in a browser (sample) workspace and in a server
 * workspace: no horizontal overflow, no page errors, and each surface's key content present. Same
 * stand-ins as eval:ui (a test identity provider and scripted Jira responses), nothing else.
 */

const require = createRequire(import.meta.url);
const WIDTHS = [390, 768, 1024, 1440];
/**
 * Known, pre-existing issues this pass reports but does not fail on. Each was confirmed present before V1.2
 * (measured on 8418358) and lives in code this regression must not change.
 */
const KNOWN = [/390px \/investigations: horizontal overflow 4px — div\.mt-4 "Run Overnight/];
const SHOTS = process.env.JAGR_UI_SHOTS ?? '/tmp';

test('responsive regression', { timeout: 900_000 }, async () => {
  if (!existsSync('dist/index.html')) throw new Error('Run `npm run build` first.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { chromium } = require(join(execSync('npm root -g').toString().trim(), 'playwright')) as { chromium: { launch(): Promise<any> } };
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
  const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.csv': 'text/csv' };
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(`${page.url()} · ${e.message}`));
  const problems: string[] = [];
  const checked: string[] = [];

  // Surfaces and the content each must show.
  const surfaces = (inv: string) => [
    { path: '/', expect: /Overview|investigation/i },
    { path: '/sources', expect: /Sources/ },
    { path: '/investigations', expect: /Investigations/ },
    { path: `/investigations/w/${inv}`, expect: /Evidence/ },
    { path: '/trace', expect: /Agent Trace|trace/i },
    { path: '/briefs', expect: /brief/i },
    { path: '/evaluations', expect: /Evaluation/i },
    { path: '/watches', expect: /Watches/ },
    { path: '/approvals', expect: /Approvals/ },
    { path: '/settings', expect: /Settings/ },
  ];

  async function sweep(label: string, inv: string) {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      for (const s of surfaces(inv)) {
        await page.goto(`${base}${s.path}`);
        await page.locator('main').first().waitFor();
        await page.waitForTimeout(s.path === '/evaluations' ? 2500 : 400);
        const text = await page.locator('main').innerText();
        if (!s.expect.test(text)) problems.push(`${label} ${width}px ${s.path}: expected ${s.expect}`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 1) {
          // Name the widest offender, so an overflow can be traced to its component.
          const culprit = await page.evaluate(() => {
            const vw = window.innerWidth;
            let worst: { el: string; right: number } = { el: '', right: 0 };
            for (const el of Array.from(document.querySelectorAll('main *'))) {
              const r = el.getBoundingClientRect();
              if (r.right > vw + 1 && r.right > worst.right) worst = { el: `${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').split(' ').slice(0, 4).join('.')} "${(el.textContent ?? '').trim().slice(0, 40)}"`, right: Math.round(r.right) };
            }
            return worst.el ? `${worst.el} (right edge ${worst.right}px)` : 'outside <main>';
          });
          problems.push(`${label} ${width}px ${s.path}: horizontal overflow ${overflow}px — ${culprit}`);
        }
        checked.push(`${label} ${width} ${s.path}`);
        if ((width === 390 || width === 1440) && s.path.startsWith('/investigations/w/')) await page.screenshot({ path: `${SHOTS}/qa-${label}-${width}-investigation.png`, fullPage: true });
      }
    }
  }

  try {
    // ── Browser workspace (sample data) ──
    await page.goto(`${base}/`);
    await page.getByRole('button', { name: 'Open sample workspace' }).click();
    await page.locator('a[href^="/investigations/w/"]').first().waitFor({ timeout: 60_000 });
    const sampleInv = ((await page.locator('a[href^="/investigations/w/"]').first().getAttribute('href')) ?? '').split('/').pop()!;
    // Investigation page: evidence chain and replay come from the stored investigation.
    await page.goto(`${base}/investigations/w/${sampleInv}`);
    await page.getByText(/Evidence/).first().waitFor();
    await page.waitForTimeout(500);
    const invText = await page.locator('main').innerText();
    for (const marker of [/Signal/i, /Observed/i, /Unknown/i, /Replay/i]) if (!marker.test(invText)) problems.push(`browser investigation: missing ${marker}`);
    await sweep('browser', sampleInv);
    // Demo night: its own environment, unaffected by the workspace.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/demo`);
    await page.locator('main').first().waitFor();
    if (!/Demo night/i.test(await page.locator('body').innerText())) problems.push('demo: "Demo night" not shown');

    // ── Server workspace (live sources, scripted Jira) ──
    await page.goto(`${base}/settings`);
    await page.getByRole('link', { name: /Sign in with test/ }).click();
    await page.getByText('Signed in as Ana').waitFor();
    await page.getByLabel('New server workspace').fill('Acme checkout');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.getByText('Server workspace · Acme checkout').first().waitFor();
    const wsId = await page.evaluate(() => localStorage.getItem('jagr:server-workspace'));
    await page.evaluate(async (ws: string) => {
      const csrf = decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('jagr_csrf='))!.slice(10));
      const h = { 'content-type': 'application/json', 'x-jagr-csrf': csrf };
      await fetch(`/api/workspaces/${ws}/connections`, { method: 'PUT', headers: h, body: JSON.stringify({ provider: 'jira', config: { site: 'https://acme.atlassian.net', project: 'SHOP' }, credential: { email: 'svc@acme.test', apiToken: 'ATATT-qa-token' } }) });
      await fetch(`/api/workspaces/${ws}/watches`, { method: 'POST', headers: h, body: JSON.stringify({ templateId: 'customer_issues', sources: ['jira'] }) });
      await fetch(`/api/workspaces/${ws}/runs`, { method: 'POST', headers: h });
    }, wsId as string);
    await page.goto(`${base}/investigations`);
    await page.locator('a[href^="/investigations/w/"]').first().waitFor({ timeout: 30_000 });
    const serverInv = ((await page.locator('a[href^="/investigations/w/"]').first().getAttribute('href')) ?? '').split('/').pop()!;
    await page.goto(`${base}/investigations/w/${serverInv}`);
    await page.getByText(/Evidence/).first().waitFor();
    await page.waitForTimeout(500);
    const sText = await page.locator('main').innerText();
    if (!/Data:\s*LIVE/.test(sText)) problems.push('server investigation: not labelled LIVE');
    if (/ATATT-qa-token|svc@acme\.test/.test(await page.content())) problems.push('server: credential or account email reached the page');
    await sweep('server', serverInv);
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\nQA: ${checked.length} page views · ${problems.length} problem(s) · ${errors.length} page error(s)\n${[...problems, ...errors].join('\n')}\n`);
  expect(errors).toEqual([]);
  expect(problems.filter((p) => !KNOWN.some((k) => k.test(p)))).toEqual([]);
});
