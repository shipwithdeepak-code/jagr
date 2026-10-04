import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ProductContext, type ProductApi } from '@/state/productContext';
import { WorkspaceContext, type WorkspaceApi } from '@/state/workspace';
import { initialDemoState } from '@/state/store';
import { watchFromTemplate, defaultBriefSchedule } from '@/product/catalog';
import { executionStatus } from '@/product/app/executionStatus';
import { AppShell } from './AppShell';
import { ManualCheckStatus } from './executionStatus';

// Capture the actual rendered button handlers, without replacing either control's implementation.
const captured = vi.hoisted(() => ({ buttons: [] as Record<string, unknown>[], navigate: vi.fn() }));
vi.mock('react/jsx-runtime', async (original) => {
  const runtime = await original<typeof import('react/jsx-runtime')>();
  const record = (type: unknown, props: unknown) => { if (type === 'button') captured.buttons.push(props as Record<string, unknown>); };
  return { ...runtime,
    jsx: (...args: Parameters<typeof runtime.jsx>) => { record(args[0], args[1]); return runtime.jsx(...args); },
    jsxs: (...args: Parameters<typeof runtime.jsxs>) => { record(args[0], args[1]); return runtime.jsxs(...args); },
  };
});
vi.mock('react/jsx-dev-runtime', async (original) => {
  const runtime = await original<typeof import('react/jsx-dev-runtime')>();
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
    if (args[0] === 'button') captured.buttons.push(args[1] as Record<string, unknown>);
    return runtime.jsxDEV(...args);
  } };
});
vi.mock('react-router-dom', async (original) => ({ ...await original<typeof import('react-router-dom')>(), useNavigate: () => captured.navigate }));
vi.mock('./WorkspaceMenu', async (original) => ({ ...await original<typeof import('./WorkspaceMenu')>(), WorkspaceSwitcher: () => null, AccountMenu: () => null }));

const NOW = '2026-10-04T08:00:00.000Z';
function setup() {
  const statusRead = vi.fn(async () => undefined);
  const workspaceRefresh = vi.fn(async () => undefined);
  const requestCheck = vi.fn(async () => undefined);
  const watch = watchFromTemplate('watch', 'checkout_health', { sources: ['amplitude'], metricKeys: ['checkout_conversion'] }, NOW);
  const queued = executionStatus({ workspaceId: 'ws', watchId: watch.id, executionKey: 'existing-check', requestedAt: NOW }, { state: 'queued', attempts: 0, createdAt: NOW, runAt: NOW }, null, NOW);
  const api = { location: 'server', mode: 'connected', running: false, runMonitoring: requestCheck,
    state: { version: 3, watches: [watch], connections: [], decisions: {}, stale: false, clock: NOW, brief: defaultBriefSchedule() },
    server: { workspaceId: 'ws', name: 'Test workspace', loading: false, connections: [{ kind: 'source', source: 'amplitude', roles: ['metrics'], health: 'healthy' }], executionStatuses: { 'existing-check': queued }, refreshExecutionStatus: statusRead, refresh: workspaceRefresh },
  } as unknown as ProductApi;
  const render = () => {
    captured.buttons = [];
    return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/watches'] },
      createElement(ProductContext.Provider, { value: api }, createElement(WorkspaceContext.Provider, { value: { state: initialDemoState() } as WorkspaceApi },
        createElement(AppShell, null, createElement(ManualCheckStatus))))));
  };
  render();
  const refresh = () => captured.buttons.find(b => b.children === 'Refresh status')!;
  const run = () => captured.buttons.find(b => b['aria-label'] === 'Run monitoring now')!;
  const click = (button: Record<string, unknown>) => (button.onClick as () => Promise<void>)();
  return { api, queued, statusRead, workspaceRefresh, requestCheck, render, refresh, run, click };
}

beforeEach(() => { captured.navigate.mockClear(); vi.stubGlobal('document', { documentElement: { dataset: { theme: 'light' } } }); });
afterEach(() => vi.unstubAllGlobals());

describe('requested-check controls are independent', () => {
  it('three refresh clicks read status only, preserve the queued identity and never navigate or request a check', async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) { await t.click(t.refresh()); t.render(); }
    expect(t.statusRead).toHaveBeenCalledTimes(3);
    expect(t.workspaceRefresh).not.toHaveBeenCalled();
    expect(t.requestCheck).not.toHaveBeenCalled();
    expect(captured.navigate).not.toHaveBeenCalled();
    expect(t.api.server!.executionStatuses).toEqual({ 'existing-check': t.queued });
    expect(t.run().disabled).toBe(false);
  });

  it('Run now explicitly requests one check and retains its existing navigation, without invoking refresh', async () => {
    const t = setup();
    await t.click(t.run());
    expect(t.requestCheck).toHaveBeenCalledTimes(1);
    expect(t.statusRead).not.toHaveBeenCalled();
    expect(t.workspaceRefresh).not.toHaveBeenCalled();
    expect(captured.navigate).toHaveBeenCalledExactlyOnceWith('/');
  });

  it('both controls are non-submit buttons and use distinct handlers', () => {
    const t = setup();
    expect(t.refresh().type).toBe('button');
    expect(t.run().type).toBe('button');
    expect(t.refresh().onClick).not.toBe(t.run().onClick);
    expect(t.render()).not.toContain('<form');
  });

  it('a failed status read never falls back to workspace refresh, Run now, or navigation', async () => {
    const t = setup();
    t.statusRead.mockRejectedValueOnce(new Error('status unavailable'));
    await expect(t.click(t.refresh())).rejects.toThrow('status unavailable');
    expect(t.requestCheck).not.toHaveBeenCalled();
    expect(t.workspaceRefresh).not.toHaveBeenCalled();
    expect(captured.navigate).not.toHaveBeenCalled();
    expect(t.api.server!.executionStatuses).toEqual({ 'existing-check': t.queued });
  });
});
