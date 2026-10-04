import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { seedTasks } from '@/domain/defaults';
import { ProductContext, type ProductApi } from './productContext';
import { WorkspaceContext, type WorkspaceApi } from './workspace';
import { EnvironmentContext } from './environment';
import { demoReducer, initialDemoState } from './store';
import { TasksPage } from '@/pages/Tasks';
import { AiEgressSetting } from '@/components/serverWorkspace';
import type { MonitoringResult, WatchInvestigation } from '@/product/types';
import { PlannerSetting } from '@/pages/Settings';
import { visibleSimulatedTasks, recordedActionLabel } from './customerBoundary';

const inv = { id: 'real-investigation', dedupeKey: 'real-key' };
const localTask = { ...seedTasks()[0], id: 'PAY-285', investigationId: inv.id, fingerprint: `watch:${inv.dedupeKey}` };
const tasks = [...seedTasks(), localTask];
function product(location: 'browser' | 'server'): ProductApi {
  return { location, state: { version: 3, connections: [], watches: [], decisions: {}, clock: '', stale: false }, llmOption: { available: false, label: '', reason: 'No LLM provider configured' }, plannerChoice: 'deterministic', running: false } as unknown as ProductApi;
}
function renderTasks(environment: 'workspace' | 'demo', location: 'browser' | 'server', path = '/tasks'): string {
  const demo = { state: { ...initialDemoState(), tasks } } as WorkspaceApi;
  return renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] },
    h(EnvironmentContext.Provider, { value: { environment } },
      h(ProductContext.Provider, { value: product(location) },
        h(WorkspaceContext.Provider, { value: demo }, h(TasksPage))))));
}

describe('customer/demo data boundary', () => {
  it('never supplies global simulated tracker tasks to a server workspace, even with matching investigation IDs', () => {
    expect(visibleSimulatedTasks(tasks, 'workspace', 'server', [inv])).toEqual([]);
  });
  it('only includes simulated work linked to the currently open browser investigation', () => {
    expect(visibleSimulatedTasks(tasks, 'workspace', 'browser', [inv])).toEqual([localTask]);
    expect(visibleSimulatedTasks(tasks, 'workspace', 'browser', [])).toEqual([]);
    expect(visibleSimulatedTasks(tasks, 'workspace', 'browser', [{ ...inv, id: 'other' }])).toEqual([]);
  });
  it('keeps seeded/demo tasks available exclusively in the replay', () => {
    expect(visibleSimulatedTasks(tasks, 'demo', 'server', [])).toEqual(seedTasks());
  });
  it('renders clean server Tasks without demo backlog or a cross-environment task drawer', () => {
    const html = renderTasks('workspace', 'server', '/tasks?open=PAY-285');
    expect(html).toContain('No recommendations yet');
    expect(html).not.toContain('PAY-285');
    expect(html).not.toContain('PAY-279');
    expect(html).not.toContain('Retry Apple Pay');
    expect(html).not.toContain('All environments');
  });
  it('preserves actual workspace recommendations and recorded decisions on server Tasks', () => {
    const p = product('server');
    const investigation = { ...inv, jagrPath: '/investigations/w/real-investigation', actions: [{ id: 'real-action', title: 'Review customer checkout evidence', status: 'recommended', risk: 'MEDIUM' }] } as unknown as WatchInvestigation;
    p.state.result = { investigations: [investigation] } as MonitoringResult;
    const html = renderToStaticMarkup(h(MemoryRouter, undefined, h(ProductContext.Provider, { value: p }, h(WorkspaceContext.Provider, { value: { state: initialDemoState() } as WorkspaceApi }, h(TasksPage)))));
    expect(html).toContain('Review customer checkout evidence');
    expect(html).toContain('Recommended');
    expect(html).not.toContain('PAY-279');
  });
  it('renders a saved AI policy disabled when no provider is available, without altering it', () => {
    const p = product('server');
    p.server = { role: 'owner', settings: { aiEgressAllowed: true } } as ProductApi['server'];
    const html = renderToStaticMarkup(h(ProductContext.Provider, { value: p }, h(AiEgressSetting)));
    expect(html).toContain('saved policy preference');
    expect(html).toContain('AI planning is currently unavailable');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-checked="true"');
    expect(p.server?.settings.aiEgressAllowed).toBe(true);
  });
  it('renders simulated demo work honestly without leaking a browser watch task', () => {
    const html = renderTasks('demo', 'server', '/tasks?env=demo&open=PAY-285');
    expect(html).toContain('PAY-279');
    expect(html).toContain('Simulated tasks');
    expect(html).not.toContain('PAY-285');
    expect(html).not.toContain('AI-created');
  });
  it('replaying and editing a colliding demo task ID preserves browser workspace work', () => {
    const workspaceTask = { ...localTask, id: 'PAY-284' };
    const demoTask = { ...seedTasks()[0], id: 'PAY-284', status: 'todo' as const };
    const before = { ...initialDemoState(), tasks: [workspaceTask] };
    const replay = { tasks: [demoTask], approvals: [], drafts: [] } as unknown as import('@/domain/types').OvernightRun;
    const after = demoReducer(before, { type: 'run_completed', run: replay });
    expect(after.tasks.find((t) => t.fingerprint === workspaceTask.fingerprint)).toBe(workspaceTask);
    const event = { at: before.clock } as import('@/domain/types').AgentEvent;
    const edited = demoReducer(after, { type: 'task_status', taskId: 'PAY-284', status: 'done', environment: 'demo', event });
    expect(edited.tasks.find((t) => t.fingerprint === workspaceTask.fingerprint)).toBe(workspaceTask);
    expect(edited.tasks.find((t) => !t.fingerprint)?.status).toBe('done');
    expect(before.tasks).toEqual([workspaceTask]);
  });
  it('records action state without claiming external completion' , () => {
    expect(recordedActionLabel('recommended')).toBe('Recommended');
    expect(recordedActionLabel('awaiting_approval')).toBe('Needs approval');
    expect(recordedActionLabel('approved')).toBe('Approval recorded');
    for (const status of ['executed', 'done', 'approved'] as const) expect(recordedActionLabel(status)).not.toMatch(/completed|created externally|done by/i);
  });
  it('explains a complete deterministic investigation and unavailable AI step selection', () => {
    const html = renderToStaticMarkup(h(ProductContext.Provider, { value: product('browser') }, h(PlannerSetting)));
    expect(html).toContain('Predictable, auditable, and available by default');
    expect(html).toContain('The deterministic planner can perform the complete investigation');
    expect(html).toContain('No AI provider is configured');
    expect(html).toMatch(/disabled=""[^>]*type="radio"|type="radio"[^>]*disabled=""/);
  });
});
