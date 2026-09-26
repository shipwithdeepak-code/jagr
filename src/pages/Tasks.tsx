import { ArrowRight, ShieldCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Task } from '@/domain/types';
import { GATE_LABELS } from '@/agents/policy';
import { fmtDate, fmtTime } from '@/lib/time';
import { teamName, useWorkspace } from '@/state/workspace';
import { Badge, Card, cx, Mono, PageHeader, RiskBadge, SimulationBadge, Tabs } from '@/components/ui';
import { CreatedByBadge, PriorityBadge, TaskDraftCard, TaskDrawer, TaskStatusBadge } from '@/components/work';
import { EnvironmentBadge, useEnvironmentScope } from '@/components/product';
import { inScope, SCOPE_TABS, taskEnvironment } from '@/state/environment';
import { pendingApprovals } from '@/product/agent/decisions';
import { useProduct } from '@/state/productContext';

const COLS = 'md:grid-cols-[76px_1fr_92px_160px_100px_84px_130px_112px]';

export function TasksPage() {
  const { state } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const [who, setWho] = useState<'all' | 'nightwatch' | 'human'>('all');
  const [scope, setScope] = useEnvironmentScope();
  const product = useProduct();
  const openId = params.get('open');
  const openTask = state.tasks.find((t) => t.id === openId) ?? null;

  // Every task belongs to exactly one environment; the list shows the current one unless "All" is chosen.
  const tasks = state.tasks.filter((t) => inScope(taskEnvironment(t), scope) && (who === 'all' || t.createdBy === who));
  const showDemo = inScope('demo', scope);
  const workspaceApprovals = inScope('workspace', scope) ? pendingApprovals(product.state.result?.investigations ?? [], product.state.decisions) : [];
  const created = tasks.filter((t) => t.createdBy === 'nightwatch' && t.status === 'todo');
  const humanTodo = tasks.filter((t) => t.createdBy === 'human' && t.status === 'todo');
  const inProgress = tasks.filter((t) => t.status === 'in_progress');
  const done = tasks.filter((t) => t.status === 'done');
  const approvals = showDemo ? state.approvals.filter((a) => a.status === 'pending' || a.status === 'more_evidence_requested') : [];
  const invTitle = (id?: string) => state.run?.investigations.find((i) => i.id === id)?.title;

  const open = (id: string) => setParams({ open: id });

  return (
    <>
      <PageHeader
        title="Tasks"
        description="Work Jagr turned findings into, alongside the team’s own backlog. Issues live in a simulated issue tracker built behind the same interface a Linear or Jira connector would implement."
        actions={
          <>
            <SimulationBadge label="Simulated issue tracker" />
            <Tabs value={scope} onChange={setScope} items={SCOPE_TABS} />
            <Tabs value={who} onChange={setWho} items={[{ value: 'all', label: 'All' }, { value: 'nightwatch', label: 'Jagr' }, { value: 'human', label: 'Human' }]} />
          </>
        }
      />

      {showDemo && state.drafts.length > 0 && (
        <Section title="Drafted — ready to file" hint="Below the auto-file threshold, Jagr prepares the task and you decide.">
          <div className="space-y-3">
            {state.drafts.map((d) => <TaskDraftCard key={d.fingerprint} draft={d} compact />)}
          </div>
        </Section>
      )}

      <Section title="Created by Jagr" count={created.length} hint="Filed autonomously under the Level 3 policy.">
        <TaskTable tasks={created} onOpen={open} invTitle={invTitle} empty="Nothing new from Jagr. Run the overnight watch to see it file work." />
      </Section>

      <Section title="Needs approval" count={approvals.length + workspaceApprovals.length} hint="Consequential actions waiting on a human. Jagr will not proceed on its own.">
        {workspaceApprovals.length > 0 && (
          <Card padded={false} className="mb-3 overflow-hidden">
            {workspaceApprovals.map((a) => (
              <Link key={a.id} to={`/approvals#approve-${a.id}`} className={cx('grid grid-cols-1 gap-2 border-b border-line px-4 py-3 last:border-b-0 hover:bg-subtle md:items-center md:gap-3', COLS)}>
                <Mono className="text-ink-3">{a.kind.toUpperCase()}</Mono>
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-[14px] font-medium">{a.title} <EnvironmentBadge env="workspace" /></span>
                </span>
                <span><Badge tone={a.risk === 'CRITICAL' ? 'crit' : 'high'}>{a.risk} risk</Badge></span>
                <span className="text-[13px] text-ink-2">Risk policy</span>
                <span><Badge tone="accent">AI-requested</Badge></span>
                <span className="text-[13px] text-ink-2">{a.evidence.length} items</span>
                <span className="text-[13px] text-ink-3">Workspace investigation</span>
                <span className="flex items-center gap-1.5"><Badge tone="high"><ShieldCheck size={11} /> Awaiting you</Badge></span>
              </Link>
            ))}
          </Card>
        )}
        {approvals.length === 0 && workspaceApprovals.length === 0 ? (
          <EmptyRow>No actions waiting for approval.</EmptyRow>
        ) : approvals.length === 0 ? null : (
          <Card padded={false} className="overflow-hidden">
            {approvals.map((a) => (
              <Link key={a.id} to={`/approvals?env=demo#${a.id}`} className={cx('grid grid-cols-1 gap-2 border-b border-line px-4 py-3 last:border-b-0 hover:bg-subtle md:items-center md:gap-3', COLS)}>
                <Mono className="text-ink-3">{a.id.toUpperCase()}</Mono>
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-[14px] font-medium">{a.title} <EnvironmentBadge env="demo" /></span>
                  <span className="block truncate text-[12px] text-ink-3">{invTitle(a.investigationId)}</span>
                </span>
                <span><RiskBadge risk={a.risk} /></span>
                <span className="text-[13px] text-ink-2">{GATE_LABELS[a.gatedBy]}</span>
                <span><Badge tone="accent">AI-requested</Badge></span>
                <span className="text-[13px] text-ink-2">{a.evidenceSources.length} sources</span>
                <span className="text-[13px] text-ink-3">Linked investigation</span>
                <span className="flex items-center gap-1.5"><Badge tone="high"><ShieldCheck size={11} /> Awaiting you</Badge></span>
              </Link>
            ))}
          </Card>
        )}
      </Section>

      <Section title="In progress" count={inProgress.length}>
        <TaskTable tasks={inProgress} onOpen={open} invTitle={invTitle} empty="Nothing in progress." />
      </Section>

      {humanTodo.length > 0 && (
        <Section title="Team backlog" count={humanTodo.length} hint="Filed by people.">
          <TaskTable tasks={humanTodo} onOpen={open} invTitle={invTitle} empty="" />
        </Section>
      )}

      <Section title="Completed" count={done.length}>
        <TaskTable tasks={done} onOpen={open} invTitle={invTitle} empty="Nothing completed yet." />
      </Section>

      <TaskDrawer task={openTask} onClose={() => setParams({})} />
    </>
  );
}

function Section({ title, count, hint, children }: { title: string; count?: number; hint?: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-[13px] font-semibold">{title}</h2>
        {count !== undefined && <span className="tabular text-[12px] text-ink-3">{count}</span>}
        {hint && <span className="hidden text-[13px] text-ink-3 sm:inline">— {hint}</span>}
      </div>
      {children}
    </section>
  );
}

function EmptyRow({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-line-strong px-4 py-5 text-center text-[13px] text-ink-3">{children}</div>;
}

function TaskTable({ tasks, onOpen, invTitle, empty }: { tasks: Task[]; onOpen: (id: string) => void; invTitle: (id?: string) => string | undefined; empty: string }) {
  if (!tasks.length) return empty ? <EmptyRow>{empty}</EmptyRow> : null;
  return (
    <Card padded={false} className="overflow-hidden">
      <div className={cx('hidden gap-3 border-b border-line bg-subtle/60 px-4 py-2 text-[12px] font-medium text-ink-3 md:grid', COLS)}>
        <span>ID</span>
        <span>Title</span>
        <span>Priority</span>
        <span>Owner</span>
        <span>Created by</span>
        <span>Evidence</span>
        <span>Investigation</span>
        <span>Status</span>
      </div>
      {tasks.map((t) => (
        <button key={t.id} onClick={() => onOpen(t.id)} className={cx('grid w-full grid-cols-1 gap-2 border-b border-line px-4 py-3 text-left last:border-b-0 hover:bg-subtle md:items-center md:gap-3', COLS)}>
          <Mono className="text-ink-2">{t.id}</Mono>
          <span className="min-w-0">
            <span className="flex items-center gap-2 text-[14px] font-medium">
              <span className="truncate">{t.title}</span>
              {t.kind === 'incident' && <Badge tone="crit">Incident draft</Badge>}
              <EnvironmentBadge env={taskEnvironment(t)} />
            </span>
            <span className="block text-[12px] text-ink-3">{fmtDate(t.createdAt)} {fmtTime(t.createdAt)}</span>
          </span>
          <span><PriorityBadge p={t.priority} /></span>
          <span className="truncate text-[13px] text-ink-2">{teamName(t.ownerTeamId)}</span>
          <span><CreatedByBadge by={t.createdBy} /></span>
          <span className="text-[13px] text-ink-2">{t.evidenceSourceCount} {t.evidenceSourceCount === 1 ? 'source' : 'sources'}</span>
          <span className="truncate text-[13px] text-ink-3">{invTitle(t.investigationId) ? 'Linked investigation' : t.createdBy === 'nightwatch' ? 'Earlier night' : '—'}</span>
          <span className="flex items-center justify-between gap-2">
            <TaskStatusBadge status={t.status} />
            <ArrowRight size={13} className="text-ink-3 max-md:hidden" />
          </span>
        </button>
      ))}
    </Card>
  );
}
