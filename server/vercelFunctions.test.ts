import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Vercel runs each api/* function as Node ESM, file by file, without a bundler: a relative import must
 * name the file it loads (`./clock.js`), or the function fails to load in production while every local
 * check (Vite, vitest, tsc with bundler resolution) passes. Walk everything the functions can reach.
 */

const root = resolve(__dirname, '..');
const SPEC = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\2/g;

function resolveTs(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec).replace(/\.js$/, '');
  return [`${base}.ts`, `${base}.tsx`].find((c) => existsSync(c) && statSync(c).isFile());
}

function functionGraph() {
  const entries = readdirSync(resolve(root, 'api')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  const queue = entries.map((f) => resolve(root, 'api', f));
  const seen = new Set<string>();
  const problems: string[] = [];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, , , spec] of readFileSync(file, 'utf8').matchAll(SPEC)) {
      const where = `${relative(root, file)} → ${spec}`;
      if (spec.startsWith('@/')) problems.push(`${where} (path aliases are not resolved at runtime)`);
      if (!spec.startsWith('.')) continue;
      if (!spec.endsWith('.js')) problems.push(`${where} (needs a .js extension)`);
      const target = resolveTs(file, spec);
      if (!target) problems.push(`${where} (does not resolve to a .ts file)`);
      else queue.push(target);
    }
  }
  return { files: seen.size, problems };
}

describe('Vercel functions', () => {
  it('every module an api/* function reaches loads under Node ESM (explicit .js specifiers, no aliases)', () => {
    const { files, problems } = functionGraph();
    expect(files).toBeGreaterThan(50); // the server graph, not just the entry files
    expect(problems).toEqual([]);
  });
});
