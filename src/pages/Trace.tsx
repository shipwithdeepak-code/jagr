import { Ban, ChevronDown, ChevronRight, CircleAlert, CircleCheck, CircleDot, ScrollText, TriangleAlert, User } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AgentEvent, AgentStage } from '@/domain/types';
import { fmtTime } from '@/lib/time';
import { allEvents, useWorkspace } from '@/state/workspace';
import { Badge, Card, cx, EmptyState, Mono, PageHeader, Select, Tabs } from '@/components/ui';
import { RunButtons } from './Overview';

const STAGES: { value: AgentStage | 'all'; label: string }[] = [
  { value: 'all', label: 'All stages' },
  { value: 'detect', label: 'Detect' },
  { value: 'investigate', label: 'Investigate' },
  { value: 'evidence', label: 'Evidence' },
  { value: 'hypothesis', label: 'Hypothesis' },
  { value: 'confidence', label: 'Confidence' },
  { value: 'risk', label: 'Risk' },
  { value: 'decide', label: 'Decide' },
  { value: 'act', label: 'Act' },
  { value: 'approval', label: 'Approval' },
  { value: 'human', label: 'Human' },
];

export function StatusIcon({ status, agent }: { status: AgentEvent['status']; agent?: AgentEvent['agent'] }) {
  if (agent === 'you') return <User size={14} className="text-accent" />;
  if (status === 'ok') return <CircleCheck size={14} className="text-ok" />;
  if (status === 'warning') return <TriangleAlert size={14} className="text-high" />;
  if (status === 'error') return <CircleAlert size={14} className="text-crit" />;
  if (status === 'blocked') return <Ban size={14} className="text-crit" />;
  return <CircleDot size={14} className="text-ink-3" />;
}

export function TracePage() {
  const { state } = useWorkspace();
  const [tab, setTab] = useState<'trace' | 'audit'>('trace');
  const [stage, setStage] = useState<AgentStage | 'all'>('all');
  const [showRoutine, setShowRoutine] = useState(false);
  const events = useMemo(() => allEvents(state), [state]);

  if (!state.run) {
    return (
      <>
        <PageHeader title="Agent Trace" description="A timestamped record of every step JAGR takes: tool calls, results, decisions and approvals." />
        <EmptyState icon={ScrollText} title="No trace yet" action={<div className="flex gap-2"><RunButtons /></div>}>
          Run the overnight watch and every sweep, query, hypothesis and decision will appear here.
        </EmptyState>
      </>
    );
  }

  const filtered = events.filter((e) => (stage === 'all' || e.stage === stage) && (showRoutine || !e.routine || stage !== 'all'));
  const routineCount = events.filter((e) => e.routine).length;

  return (
    <>
      <PageHeader
        title="Agent Trace"
        description={`${state.run.id} · ${events.length} events from ${fmtTime(state.run.startedAt)} to ${fmtTime(state.run.endedAt)}. Nothing here is summarised after the fact — this is what the agent did, in order.`}
        actions={<Tabs value={tab} onChange={setTab} items={[{ value: 'trace', label: 'Trace' }, { value: 'audit', label: 'Audit log' }]} />}
      />
      {tab === 'trace' ? (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Select label="Filter by stage" value={stage} onChange={setStage} options={STAGES} />
            <label className="inline-flex items-center gap-2 text-[12.5px] text-ink-2">
              <input type="checkbox" checked={showRoutine} onChange={(e) => setShowRoutine(e.target.checked)} className="accent-[var(--ink)]" />
              Show {routineCount} routine events (quiet sweeps, signal collection)
            </label>
          </div>
          <Card padded={false} className="overflow-hidden">
            <div className="hidden grid-cols-[76px_104px_1fr_210px_28px] gap-3 border-b border-line bg-subtle/60 px-4 py-2 text-[11.5px] font-medium text-ink-3 md:grid">
              <span>Time</span>
              <span>Stage</span>
              <span>Agent action · result</span>
              <span>Source / tool</span>
              <span>Status</span>
            </div>
            {filtered.map((e) => <TraceRow key={e.id} e={e} />)}
          </Card>
        </>
      ) : (
        <AuditTable events={events} />
      )}
    </>
  );
}

function TraceRow({ e }: { e: AgentEvent }) {
  const [open, setOpen] = useState(false);
  const expandable = !!(e.input || e.output || e.decision);
  return (
    <div className={cx('border-b border-line last:border-b-0', e.agent === 'you' && 'bg-accent-soft/30')}>
      <button
        onClick={() => expandable && setOpen(!open)}
        className={cx('grid w-full grid-cols-[62px_1fr_20px] items-start gap-3 px-4 py-2.5 text-left md:grid-cols-[76px_104px_1fr_210px_28px]', expandable && 'hover:bg-subtle')}
      >
        <span className="tabular font-mono text-[12px] text-ink-3">{fmtTime(e.at, true)}</span>
        <span className="hidden md:block">
          <Badge tone={e.agent === 'you' ? 'accent' : e.status === 'warning' || e.status === 'blocked' ? 'high' : 'neutral'}>{e.agent === 'you' ? 'You' : e.stage}</Badge>
        </span>
        <span className="min-w-0 text-[13px]">
          <span className="font-medium">{e.action}</span>
          <span className="block text-ink-2">{e.result}</span>
          {e.investigationId && (
            <Link to={`/investigations/${e.investigationId}`} onClick={(ev) => ev.stopPropagation()} className="text-[11.5px] text-ink-3 hover:text-accent">
              {e.investigationId}
            </Link>
          )}
        </span>
        <span className="hidden truncate md:block">{e.tool ? <Mono className="text-ink-2">{e.tool}</Mono> : <span className="text-[12px] text-ink-3">—</span>}</span>
        <span className="flex items-center gap-1">
          <StatusIcon status={e.status} agent={e.agent} />
          {expandable && (open ? <ChevronDown size={12} className="text-ink-3" /> : <ChevronRight size={12} className="text-ink-3" />)}
        </span>
      </button>
      {open && (
        <div className="grid gap-2 border-t border-dashed border-line bg-canvas/60 px-4 py-3 text-[12.5px] md:pl-[196px]">
          {e.input && <Field k="Input" v={e.input} />}
          {e.output && e.output !== e.result && <Field k="Output" v={e.output} />}
          {e.decision && <Field k="Decision" v={e.decision} />}
          {e.risk && <Field k="Risk" v={e.risk} />}
          {e.approvalStatus && <Field k="Approval" v={e.approvalStatus.replace('_', ' ')} />}
          {e.durationMs !== undefined && <Field k="Duration" v={`${(e.durationMs / 1000).toFixed(0)}s (simulated)`} />}
        </div>
      )}
    </div>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid grid-cols-[80px_1fr] gap-3">
      <span className="text-ink-3">{k}</span>
      <span className="font-mono text-[12px] break-words">{v}</span>
    </div>
  );
}

/** The formal audit record: every consequential event with its governance fields. */
export function AuditTable({ events }: { events: AgentEvent[] }) {
  const rows = events.filter((e) => !e.routine && ['decide', 'act', 'approval', 'human', 'risk', 'hypothesis', 'confidence', 'start', 'brief'].includes(e.stage));
  if (!rows.length) return <Card><p className="text-[13px] text-ink-3">No audit events yet.</p></Card>;
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-card">
      <table className="w-full min-w-[980px] text-left text-[12.5px]">
        <thead className="border-b border-line bg-subtle/60 text-[11.5px] text-ink-3">
          <tr>
            {['Timestamp', 'Agent', 'Action', 'Tool', 'Input', 'Output', 'Decision', 'Risk', 'Approval'].map((h) => (
              <th key={h} className="px-3 py-2 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <Fragment key={e.id}>
              <tr className={cx('border-b border-line align-top last:border-b-0', e.agent === 'you' && 'bg-accent-soft/30')}>
                <td className="tabular px-3 py-2 font-mono whitespace-nowrap text-ink-3">{fmtTime(e.at, true)}</td>
                <td className="px-3 py-2 whitespace-nowrap">{e.agent === 'you' ? <Badge tone="accent">You</Badge> : <Badge>JAGR</Badge>}</td>
                <td className="px-3 py-2 font-medium">{e.action}</td>
                <td className="px-3 py-2">{e.tool ? <Mono className="text-ink-2">{e.tool}</Mono> : '—'}</td>
                <td className="max-w-[220px] px-3 py-2 text-ink-2">{e.input ?? '—'}</td>
                <td className="max-w-[240px] px-3 py-2 text-ink-2">{e.output ?? e.result}</td>
                <td className="px-3 py-2 whitespace-nowrap">{e.decision ? e.decision.replace(/_/g, ' ') : '—'}</td>
                <td className="px-3 py-2">{e.risk ? <Badge tone={e.risk === 'high' ? 'crit' : e.risk === 'medium' ? 'high' : 'ok'}>{e.risk}</Badge> : '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {e.approvalStatus ? (
                    <Badge tone={e.approvalStatus === 'approved' ? 'ok' : e.approvalStatus === 'pending' || e.approvalStatus === 'required' ? 'high' : e.approvalStatus === 'rejected' ? 'crit' : 'neutral'}>{e.approvalStatus.replace('_', ' ')}</Badge>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
