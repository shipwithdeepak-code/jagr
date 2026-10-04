import { createElement as h, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runScenario } from '@/agents/runScenario';
import { defaultSettings } from '@/domain/defaults';
import type { OvernightRun, Task } from '@/domain/types';
import { ProductContext, type ProductApi } from '@/state/productContext';
import { WorkspaceContext, type WorkspaceApi, type WorkspaceState } from '@/state/workspace';
import { EnvironmentContext, taskEnvironment, type AppEnvironment } from '@/state/environment';
import { demoReducer, initialDemoState } from '@/state/store';
import { visibleSimulatedTasks } from '@/state/customerBoundary';
import { InvestigationDetailPage } from './Investigations';
import { TasksPage } from './Tasks';

// Keep the real page selection and TaskDrawer handlers; replace only DOM portals
// and capture host clicks. Replay drawer state is advanced by its real list click.
const ui = vi.hoisted(() => ({ open: null as string | null, hooks: 0, clicks: [] as { label: string; click: () => void }[], rowClick: null as (() => void) | null, selected: null as Task | null }));
vi.mock('react/jsx-dev-runtime', async (original) => {
  const actual = await original<typeof import('react/jsx-dev-runtime')>();
  return { ...actual, jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
    const [type, rawProps] = args;
    const props = rawProps as { children?: any[]; onClick?: () => void };
    if (type === 'button' && Array.isArray(props.children) && props.children.some((child: any) => child?.props?.children === 'PAY-284')) ui.rowClick = props.onClick ?? null;
    return actual.jsxDEV(...args);
  } };
});
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  return { ...actual, useState: (initial: unknown) => {
    ui.hooks++;
    if (ui.hooks === 2 && initial === null) return [ui.open, (value: string | null) => { ui.open = value; }];
    return actual.useState(initial);
  } };
});
vi.mock('@/components/ui', async (original) => {
  const actual = await original<typeof import('@/components/ui')>();
  return { ...actual,
    Drawer: ({ open, title, children }: { open: boolean; title: ReactNode; children: ReactNode }) => open ? h('section', { 'data-drawer': true }, title, children) : null,
    Button: (props: Parameters<typeof actual.Button>[0]) => {
      if (props.onClick) ui.clicks.push({ label: String(props.children).trim(), click: () => props.onClick!({} as never) });
      return h(actual.Button, props);
    },
  };
});
vi.mock('@/components/work', async (original) => {
  const actual = await original<typeof import('@/components/work')>();
  return { ...actual, TaskDrawer: (props: Parameters<typeof actual.TaskDrawer>[0]) => { ui.selected = props.task; return h(actual.TaskDrawer, props); } };
});

let replay: OvernightRun;
let state: WorkspaceState;
let workspaceTask: Task;
let demoTask: Task;
const investigation = { id: 'workspace-investigation', dedupeKey: 'checkout-key', jagrPath: '/investigations/w/workspace-investigation', actions: [], signals: [{ key: 'conversion', magnitude: '−18%' }], area: 'checkout' };
function render(path: string, environment: AppEnvironment, location: 'browser' | 'server' = 'browser') {
  ui.hooks = 0; ui.clicks = []; ui.selected = null;
  const product = { location, state: { result: { investigations: [investigation] }, decisions: {} } } as unknown as ProductApi;
  const workspace = { state, setTaskStatus: (taskId, status, environment) => {
    state = demoReducer(state, { type: 'task_status', taskId, status, environment, event: { at: state.clock } as never });
  } } as WorkspaceApi;
  return renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] },
    h(EnvironmentContext.Provider, { value: { environment } }, h(ProductContext.Provider, { value: product },
      h(WorkspaceContext.Provider, { value: workspace }, h(Routes, undefined,
        h(Route, { path: '/investigations/:id', element: h(InvestigationDetailPage) }),
        h(Route, { path: '/tasks', element: h(TasksPage) })))))));
}

describe('investigation task drawer environment isolation', () => {
  beforeAll(async () => { replay = await runScenario('checkout-regression', defaultSettings()); });
  beforeEach(() => {
    ui.open = null;
    demoTask = { ...replay.tasks.find((t) => t.id.startsWith('PAY-'))!, id: 'PAY-284', title: 'Demo checkout task', status: 'todo' };
    workspaceTask = { ...demoTask, title: 'Workspace checkout task', investigationId: investigation.id, fingerprint: `watch:${investigation.dedupeKey}` };
    state = { ...initialDemoState(), run: replay, tasks: [workspaceTask, demoTask], drafts: [], approvals: [] };
  });
  it('opens the demo investigation task and marks only the demo record done', () => {
    render(`/investigations/${demoTask.investigationId}`, 'demo');
    expect(ui.selected).toBeNull();
    expect(ui.rowClick).not.toBeNull();
    ui.rowClick!();
    const html = render(`/investigations/${demoTask.investigationId}`, 'demo');
    expect(html).toContain('Demo checkout task');
    expect(html).not.toContain('Workspace checkout task');
    expect(ui.selected).toBe(demoTask);
    ui.clicks.find((c) => c.label === 'Mark done')!.click();
    expect(state.tasks.find((t) => t === workspaceTask)).toBe(workspaceTask);
    expect(state.tasks.find((t) => taskEnvironment(t) === 'demo')?.status).toBe('done');
  });
  it.each(['demo', 'workspace'] as const)('direct %s task navigation selects and mutates only its environment', (environment) => {
    const other = environment === 'demo' ? workspaceTask : demoTask;
    render(`/tasks?open=PAY-284${environment === 'demo' ? '&env=demo' : ''}`, environment);
    expect(ui.selected).toBe(environment === 'demo' ? demoTask : workspaceTask);
    ui.clicks.find((c) => c.label === 'Mark done')!.click();
    expect(state.tasks).toContain(other);
    expect(other.status).toBe('todo');
    expect(state.tasks.find((t) => t !== other)?.status).toBe('done');
  });
  it.each(['demo', 'workspace'] as const)('reopens and starts work only in the selected %s environment', (environment) => {
    const selected = environment === 'demo' ? demoTask : workspaceTask;
    const other = environment === 'demo' ? workspaceTask : demoTask;
    selected.status = 'done';
    const path = `/tasks?open=PAY-284${environment === 'demo' ? '&env=demo' : ''}`;
    render(path, environment);
    ui.clicks.find((c) => c.label === 'Reopen')!.click();
    expect(state.tasks.find((t) => taskEnvironment(t) === environment)?.status).toBe('todo');
    render(path, environment);
    ui.clicks.find((c) => c.label === 'Start work')!.click();
    expect(state.tasks.find((t) => taskEnvironment(t) === environment)?.status).toBe('in_progress');
    expect(state.tasks).toContain(other);
    expect(other.status).toBe('todo');
  });
  it('has no drawer or mutation when only a workspace task matches the demo ID', () => {
    state.tasks = [workspaceTask]; ui.open = 'PAY-284';
    render(`/investigations/${demoTask.investigationId}`, 'demo');
    expect(ui.selected).toBeNull();
    expect(ui.clicks.some((c) => c.label === 'Mark done')).toBe(false);
    render('/tasks?env=demo&open=PAY-284', 'demo');
    expect(ui.selected).toBeNull();
  });
  it('has no workspace fallback to a demo task, including server navigation', () => {
    state.tasks = [demoTask];
    render('/tasks?open=PAY-284', 'workspace'); expect(ui.selected).toBeNull();
    state.tasks = [workspaceTask, demoTask];
    render('/tasks?open=PAY-284', 'workspace', 'server'); expect(ui.selected).toBeNull();
  });
  it('counts colliding records separately using the sidebar/list boundary', () => {
    expect(visibleSimulatedTasks(state.tasks, 'demo', 'browser', [investigation])).toEqual([demoTask]);
    expect(visibleSimulatedTasks(state.tasks, 'workspace', 'browser', [investigation])).toEqual([workspaceTask]);
    expect(visibleSimulatedTasks(state.tasks, 'workspace', 'server', [investigation])).toEqual([]);
  });
});
