import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/components/AppShell';
import { ProductContext, type ProductApi } from '@/state/productContext';
import { WorkspaceContext, type WorkspaceApi } from '@/state/workspace';
import { EnvironmentContext, environmentForPath } from '@/state/environment';
import { initialDemoState } from '@/state/store';
import { runScenario } from '@/agents/runScenario';
import { composeBrief } from '@/product/engine/brief';
import { BriefsPage } from './Briefs';
import { DemoBriefPage, DemoInvestigationsPage } from './Overview';
import { TasksPage } from './Tasks';

vi.mock('@/components/WorkspaceMenu', async (original) => ({
  ...await original<typeof import('@/components/WorkspaceMenu')>(),
  WorkspaceSwitcher: () => null,
  AccountMenu: () => null,
}));

const AT = '2026-09-25T08:00:00.000Z';
const brief = composeBrief({ at: AT, since: '2026-09-24T08:00:00.000Z', watches: [], investigations: [], emails: [], log: [] });
function product(history = false): ProductApi {
  return {
    location: 'server', mode: 'connected', running: false,
    state: { version: 3, watches: [], connections: [], decisions: {}, stale: false, clock: AT,
      brief: { enabled: true, time: '08:00', timezone: 'UTC' },
      result: { window: brief.window, investigations: [], emails: [], briefs: [brief], log: [], connections: [], actions: [] },
    },
    server: { workspaceId: 'real-workspace', loading: false, connections: [], hasMonitoringHistory: history },
  } as unknown as ProductApi;
}
const demo = { state: initialDemoState() } as WorkspaceApi;
function render(node: ReactNode, path: string, api = product(), workspace = demo) {
  const url = new URL(path, 'https://jagr.test');
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] },
    createElement(ProductContext.Provider, { value: api },
      createElement(WorkspaceContext.Provider, { value: workspace },
        createElement(EnvironmentContext.Provider, { value: { environment: environmentForPath(url.pathname, url.search) } }, node)))));
}

beforeAll(() => vi.stubGlobal('document', { documentElement: { dataset: { theme: 'light' } } }));
afterAll(() => vi.unstubAllGlobals());

describe('real workspace briefs', () => {
  it('hides composed-only brief history and renders the exact empty state/actions', () => {
    const api = product();
    const html = render(createElement(BriefsPage), '/briefs', api);
    expect(html).toContain('No briefs yet');
    expect(html).toContain('Once you create a watch, Jagr will summarize what it found during each monitoring window.');
    expect(html).toContain('Set up your first watch');
    expect(html).toContain('href="/watches?new=1"');
    expect(html).toContain('See how Jagr works');
    expect(html).toContain('href="/demo"');
    for (const copy of ['Good morning.', 'Nothing needs your attention', 'Quiet', 'Nothing was monitored in this window.', 'Brief history']) expect(html).not.toContain(copy);
    expect(api.state.result!.briefs).toEqual([brief]); // Presentation never deletes stored history.
  });

  it('keeps real historical briefs, selections, alerts and existing actions', () => {
    const api = product(true);
    const html = render(createElement(BriefsPage), `/briefs?brief=${brief.id}`, api);
    expect(html).toContain('Brief history');
    expect(html).toContain('Good morning.');
    expect(html).toContain('href="/settings#monitoring"');
    expect(render(createElement(BriefsPage), '/briefs?tab=alerts', api)).toContain('No alerts');
    api.state.result!.briefs = [];
    expect(render(createElement(BriefsPage), '/briefs', api)).toContain('See what Jagr is watching');
  });

  it('leaves sample/imported brief behavior intact', () => {
    for (const mode of ['sample', 'imported'] as const) {
      const api = { ...product(), location: 'browser', mode } as ProductApi;
      expect(render(createElement(BriefsPage), '/briefs', api)).toContain('Good morning.');
    }
  });
});

describe('Demo Night navigation boundary', () => {
  const targets = ['/demo', '/signals', '/demo/investigations', '/demo/brief', '/tasks?env=demo', '/integrations', '/demo/settings'];
  it('shows only complete demo navigation on every direct child URL, with persistent context and return', () => {
    for (const path of targets) {
      const html = render(createElement(AppShell, null, 'Demo content'), path);
      const sidebar = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
      expect(sidebar).toContain('DEMO NIGHT');
      expect(sidebar).toContain('Scripted replay · Separate from your workspace');
      for (const target of targets) expect(sidebar).toContain(`href="${target}"`);
      for (const label of ['Replay', 'Signals', 'Investigations', 'Brief', 'Tasks', 'Integrations', 'Demo settings', 'Back to workspace']) expect(sidebar).toContain(`>${label}</span>`);
      for (const target of ['/watches', '/briefs', '/sources', '/investigations', '/approvals', '/tasks', '/settings']) expect(sidebar).not.toContain(`href="${target}"`);
      expect(html).toContain('DEMO · SCRIPTED REPLAY · No changes are made to your workspace');
      expect(sidebar).toContain('href="/"');
      expect(environmentForPath(new URL(path, 'https://jagr.test').pathname, new URL(path, 'https://jagr.test').search)).toBe('demo');
    }
  });

  it('keeps customer navigation outside demo and returns without changing workspace identity', () => {
    const api = product(true);
    const html = render(createElement(AppShell, null, 'Workspace content'), '/', api);
    for (const target of ['/watches', '/investigations', '/briefs', '/sources', '/approvals', '/tasks', '/settings']) expect(html).toContain(`href="${target}"`);
    expect(html).not.toContain('DEMO · SCRIPTED REPLAY');
    expect(api.server!.workspaceId).toBe('real-workspace');
  });

  it('reuses scripted replay brief/investigations and excludes real workspace tasks even with a foreign drawer ID', async () => {
    const state = initialDemoState();
    const run = await runScenario('checkout-regression', state.settings, { runId: 'ux-demo', seedTasks: state.tasks });
    const workspace = { state: { ...state, run, approvals: run.approvals,
      tasks: [...state.tasks, { ...state.tasks[0], id: 'REAL-TASK', title: 'Real workspace secret finding', fingerprint: 'watch:checkout:1' }],
    } } as WorkspaceApi;
    const api = product(true);
    expect(render(createElement(DemoBriefPage), '/demo/brief', api, workspace)).toContain(run.brief.headline!.statement);
    const investigations = render(createElement(DemoInvestigationsPage), '/demo/investigations', api, workspace);
    expect(investigations).toContain(run.investigations.find((i) => i.status !== 'dismissed')!.title.replaceAll('&', '&amp;'));
    expect(investigations).not.toContain('Real workspace secret finding');
    const tasks = render(createElement(TasksPage), '/tasks?env=demo&open=REAL-TASK', api, workspace);
    expect(tasks).not.toContain('Real workspace secret finding');
    expect(tasks).not.toContain('All environments');
    expect(api.state.result!.briefs).toEqual([brief]);
  });
});
