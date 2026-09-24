import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Architecture boundaries, enforced.
 *
 *   Browser (src/pages, src/components, src/state) ─┐
 *   api/** (host entry points) → server/** → src/product/** (portable core)
 *
 * The core imports nothing outside itself except zod; it never touches browser, Node, deployment or
 * database APIs (tsconfig.product.json compiles it without DOM or Node types). The investigation
 * engine asks for evidence by role, never by vendor.
 */

const ROOT = resolve(__dirname, '../..');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const code = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
const importsOf = (p: string) => [...readFileSync(p, 'utf8').matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

// testkit/ is test-support code (vitest) shared by connector test suites.
const core = walk(join(ROOT, 'src/product')).filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.includes('__fixtures__') && !p.includes('/testkit/'));

describe('portable core (src/product)', () => {
  it('imports only itself and zod — no browser, Node, deployment, database or auth SDKs', () => {
    const bad: string[] = [];
    for (const p of core) {
      for (const spec of importsOf(p)) {
        if (spec === 'zod') continue;
        if (!spec.startsWith('.')) {
          bad.push(`${relative(ROOT, p)} → ${spec}`);
          continue;
        }
        const target = resolve(dirname(p), spec);
        if (!target.startsWith(join(ROOT, 'src/product'))) bad.push(`${relative(ROOT, p)} → ${spec} (leaves the core)`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('uses no browser or process globals (the compiler enforces this too)', () => {
    const bad = core.filter((p) => /\b(localStorage|sessionStorage|navigator|document)\b|\bwindow\.(location|addEventListener|document|localStorage|fetch|setTimeout)\b|\bprocess\.env\b|(?<![.\w])fetch\(/.test(code(p))).map((p) => relative(ROOT, p));
    expect(bad).toEqual([]);
  });

  it('the investigation engine never names a vendor or a vendor source', () => {
    const engine = core.filter((p) => /src\/product\/(engine|roles|ports)\//.test(p) || /agent\/(investigator|tools|planner|plannerPrompt|plannerSchema|actions|decisions)\.ts$/.test(p) || /product\/(progress|presentation)\.ts$/.test(p));
    expect(engine.length).toBeGreaterThan(10);
    const bad = engine.flatMap((p) => {
      const hits = code(p).match(/'(jira|ga4|app_store|google_play|amplitude|github|intercom|slack|sentry|mixpanel)'|\b(Jira|GA4|App Store|Google Play|Play Store|Amplitude|GitHub|Intercom|Mixpanel|Sentry)\b/g);
      return hits ? [`${relative(ROOT, p)}: ${[...new Set(hits)].join(', ')}`] : [];
    });
    expect(bad).toEqual([]);
  });
});

describe('dependency direction', () => {
  const tsIn = (dir: string) => {
    try {
      return walk(join(ROOT, dir)).filter((p) => /\.tsx?$/.test(p));
    } catch {
      return [];
    }
  };

  it('server/** never imports the browser app', () => {
    const bad = tsIn('server').flatMap((p) => importsOf(p).filter((s) => /src\/(state|components|pages|domain|agents|simulation)\/|^@\/|react/.test(s)).map((s) => `${relative(ROOT, p)} → ${s}`));
    expect(bad).toEqual([]);
  });

  it('api/** only reaches inward (server/ and the core), never the browser app', () => {
    const bad = tsIn('api').flatMap((p) => importsOf(p).filter((s) => s.startsWith('.') && !/^\.\.\/(server|src\/product)\//.test(s)).map((s) => `${relative(ROOT, p)} → ${s}`));
    expect(bad).toEqual([]);
  });

  it('the core compiler config has no DOM or Node types', () => {
    const cfg = readFileSync(join(ROOT, 'tsconfig.product.json'), 'utf8');
    expect(cfg).toMatch(/"lib": \["ES2022"\]/);
    expect(cfg).toMatch(/"types": \[\]/);
  });
});
