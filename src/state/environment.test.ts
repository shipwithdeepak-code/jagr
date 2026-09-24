import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Task } from '@/domain/types';
import { ENVIRONMENT, ENVIRONMENT_STORAGE_KEY, environmentForPath, inScope, initialEnvironment, parseStoredEnvironment, readStoredEnvironment, storeEnvironment, taskEnvironment } from './environment';
import { demoReducer, initialDemoState, isWorkspaceTask, resetDemoState } from './store';
import { llmAvailability } from './plannerConfig';
import { createPlannerHandler } from '@/product/agent/providers/server';

/**
 * WORKSPACE vs DEMO NIGHT. The environment decides which DATA you are looking at; the planner
 * switch (workspace only) decides who plans the investigation. They are independent.
 * Planner-specific behaviour (fallback, validator parity, key isolation, approvals) is covered
 * end to end in src/product/demoPlanner.test.ts.
 */

describe('environment semantics', () => {
  it('1 · workspace routes are the Workspace', () => {
    for (const p of ['/', '/investigations', '/investigations/w/wi-checkout-1930', '/watches', '/sources', '/sources/jira/issue/PAY-512', '/briefs']) {
      expect(environmentForPath(p, 'demo')).toBe('workspace');
    }
  });

  it('2 · demo routes are Demo night', () => {
    for (const p of ['/demo', '/signals', '/integrations', '/investigations/inv-klarna-1']) {
      expect(environmentForPath(p, 'workspace')).toBe('demo');
    }
  });

  it('3 · Workspace → Demo night and 4 · Demo night → Workspace; shared pages keep where you came from', () => {
    let env = environmentForPath('/');
    expect(env).toBe('workspace');
    env = environmentForPath('/trace', env);
    expect(env).toBe('workspace');
    env = environmentForPath('/demo', env);
    expect(env).toBe('demo');
    env = environmentForPath('/approvals', env);
    expect(env).toBe('demo');
    env = environmentForPath('/watches', env);
    expect(env).toBe('workspace');
    expect(ENVIRONMENT.workspace.home).toBe('/');
    expect(ENVIRONMENT.demo.home).toBe('/demo');
  });

  it('12 · labels are honest: the workspace says "Simulated sources", never "Demo"; Demo night says simulated replay', () => {
    expect(ENVIRONMENT.workspace.badge).toBe('Simulated sources');
    expect(`${ENVIRONMENT.workspace.label} ${ENVIRONMENT.workspace.badge}`).not.toMatch(/demo/i);
    expect(ENVIRONMENT.demo.badge).toMatch(/Demo night/);
    expect(ENVIRONMENT.demo.badge).toMatch(/simulated/i);
    expect(ENVIRONMENT.demo.description).toMatch(/replay/i);
  });

  it('no UI text still presents "Demo Mode" or a "demo environment" as if it were a global mode', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f) && !/\.test\.|\.live\./.test(f) && /Demo Mode|demo environment/i.test(readFileSync(p, 'utf8'))) offenders.push(p);
      }
    };
    walk('src');
    expect(offenders).toEqual([]);
  });
});

describe('demo / workspace data boundary', () => {
  const workspaceTask = { ...initialDemoState().tasks[0], id: 'TASK-W1', fingerprint: 'watch:checkout:2026-09-23' } as Task;
  const demoTask = { ...initialDemoState().tasks[0], id: 'TASK-D1', fingerprint: 'demo:klarna' } as Task;

  it('5 · Demo reset clears Demo night data but keeps tasks filed from workspace investigations', () => {
    const before = { ...initialDemoState(), runCount: 3, tasks: [...initialDemoState().tasks, workspaceTask, demoTask] };
    const after = resetDemoState(before);
    expect(after.runCount).toBe(0);
    expect(after.tasks.some((t) => t.id === 'TASK-W1')).toBe(true);
    expect(after.tasks.some((t) => t.id === 'TASK-D1')).toBe(false);
    expect(demoReducer(before, { type: 'reset' }).tasks.some((t) => t.id === 'TASK-W1')).toBe(true);
    expect(isWorkspaceTask(workspaceTask)).toBe(true);
    expect(isWorkspaceTask(demoTask)).toBe(false);
  });

  it('13 · the Demo night store never touches workspace state (separate store, no imports, no shared key)', () => {
    const demoStore = readFileSync('src/state/store.tsx', 'utf8');
    expect(demoStore).not.toMatch(/jagr:product|productContext|\/product\/|useProduct/);
    const productStore = readFileSync('src/state/product.tsx', 'utf8');
    expect(productStore).toMatch(/const KEY = 'jagr:product:v2'/);
    expect(productStore).not.toMatch(/nightwatch:workspace/);
  });

  it('6 · planner selection is a preference: the workspace reset keeps it, and Demo reset cannot reach it', () => {
    const productStore = readFileSync('src/state/product.tsx', 'utf8');
    expect(productStore).toMatch(/const fresh = \{ \.\.\.initial\(\), planner: ref\.current\.planner \}/);
    expect(JSON.stringify(resetDemoState(initialDemoState()))).not.toMatch(/"planner"/);
  });
});

describe('model configuration', () => {
  const key = 'AIzaSECRET-config-test';

  it('7 · the Gemini option shows exactly the model configured in LLM_MODEL', async () => {
    for (const model of ['gemini-3.1-flash-lite', 'some-future-model-id']) {
      const health = (await createPlannerHandler({ LLM_PROVIDER: 'gemini', LLM_MODEL: model, LLM_API_KEY: key })({ method: 'GET', path: '/health' })).body;
      expect(llmAvailability(health as never)).toEqual({ available: true, label: `Gemini · ${model}` });
      expect(JSON.stringify(health)).not.toContain(key);
    }
  });

  it('7b · other providers show their configured model too; no provider → option disabled', async () => {
    const claude = (await createPlannerHandler({ LLM_PROVIDER: 'anthropic', LLM_MODEL: 'claude-x', ANTHROPIC_API_KEY: key })({ method: 'GET', path: '/health' })).body;
    expect(llmAvailability(claude as never).label).toBe('Claude · claude-x');
    const openai = (await createPlannerHandler({ LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-x', OPENAI_API_KEY: key })({ method: 'GET', path: '/health' })).body;
    expect(llmAvailability(openai as never).label).toBe('OpenAI · gpt-x');
    const none = (await createPlannerHandler({})({ method: 'GET', path: '/health' })).body;
    expect(llmAvailability(none as never)).toMatchObject({ available: false, reason: 'No LLM provider configured.' });
  });

  it('8 · no Gemini model id is hard-coded in application code', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f) && !/\.test\.|\.live\./.test(f) && /gemini-\d/.test(readFileSync(p, 'utf8'))) hits.push(p);
      }
    };
    walk('src');
    expect(hits).toEqual([]);
  });
});

describe('environment persistence (full page reload)', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };

  it('reload on Workspace stays Workspace; reload on Demo night stays Demo night (on shared pages too)', () => {
    const s = memory();
    storeEnvironment('workspace', s);
    expect(initialEnvironment('/approvals', readStoredEnvironment(s))).toBe('workspace');
    storeEnvironment('demo', s);
    expect(s.m.get(ENVIRONMENT_STORAGE_KEY)).toBe('demo');
    expect(initialEnvironment('/approvals', readStoredEnvironment(s))).toBe('demo');
    expect(initialEnvironment('/tasks', readStoredEnvironment(s))).toBe('demo');
    // A route that belongs to one environment still wins over the stored value.
    expect(initialEnvironment('/watches', readStoredEnvironment(s))).toBe('workspace');
    expect(initialEnvironment('/demo', 'workspace')).toBe('demo');
  });

  it('missing, invalid or unreadable stored value → Workspace', () => {
    expect(parseStoredEnvironment(null)).toBe('workspace');
    expect(parseStoredEnvironment(undefined)).toBe('workspace');
    expect(parseStoredEnvironment('DEMO_NIGHT')).toBe('workspace');
    expect(parseStoredEnvironment('{"env":"demo"}')).toBe('workspace');
    expect(readStoredEnvironment(memory())).toBe('workspace');
    const broken = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceeded'); } };
    expect(readStoredEnvironment(broken)).toBe('workspace');
    expect(() => storeEnvironment('demo', broken)).not.toThrow();
  });

  it('stores only the environment name — nothing else', () => {
    const s = memory();
    storeEnvironment('demo', s);
    expect([...s.m.entries()]).toEqual([[ENVIRONMENT_STORAGE_KEY, 'demo']]);
  });
});

describe('tasks and approvals have an explicit environment identity', () => {
  const tasks = [
    { id: 'W-1', fingerprint: 'watch:checkout:2026-09-23' },
    { id: 'W-2', fingerprint: 'watch:signup:2026-09-24' },
    { id: 'D-1', fingerprint: 'klarna-regression' },
    { id: 'D-2', fingerprint: undefined },
  ];
  const visible = (scope: 'workspace' | 'demo' | 'all') => tasks.filter((t) => inScope(taskEnvironment(t), scope)).map((t) => t.id);

  it('Workspace does not show Demo night tasks as if they were Workspace tasks', () => {
    expect(visible('workspace')).toEqual(['W-1', 'W-2']);
  });

  it('Demo night does not show Workspace tasks as if they were Demo night tasks', () => {
    expect(visible('demo')).toEqual(['D-1', 'D-2']);
  });

  it('"All environments" is explicit and still labels each record', () => {
    expect(visible('all')).toEqual(['W-1', 'W-2', 'D-1', 'D-2']);
    expect(tasks.map((t) => taskEnvironment(t))).toEqual(['workspace', 'workspace', 'demo', 'demo']);
  });

  it('pages default to the current environment and render approvals by environment, not mixed', () => {
    const product = readFileSync('src/components/product.tsx', 'utf8');
    expect(product).toMatch(/useState<EnvironmentScope>\(environment\)/);
    const approvals = readFileSync('src/pages/Approvals.tsx', 'utf8');
    expect(approvals).toMatch(/showWorkspace && \(/);
    expect(approvals).toMatch(/showDemo && \(/);
    const tasksPage = readFileSync('src/pages/Tasks.tsx', 'utf8');
    expect(tasksPage).toMatch(/inScope\(taskEnvironment\(t\), scope\)/);
    expect(tasksPage).toMatch(/<EnvironmentBadge env=\{taskEnvironment\(t\)\} \/>/);
    const shell = readFileSync('src/components/AppShell.tsx', 'utf8');
    expect(shell).toMatch(/Badges count the current environment only/);
  });
});
