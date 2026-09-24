import { ArrowRight, Bot, Check, CircleCheck, FilePlus2, Info, Loader2, ShieldCheck, User, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Action, ApprovalRequest, Evidence, Task, TaskDescription, TaskDraft } from '@/domain/types';
import { SOURCE_LABELS, TEAMS } from '@/domain/defaults';
import { GATE_LABELS } from '@/agents/policy';
import { fmtConfidence } from '@/lib/format';
import { fmtDateTime, fmtTime } from '@/lib/time';
import { teamName, useWorkspace } from '@/state/workspace';
import { Badge, Button, Card, cx, Drawer, Eyebrow, KeyValue, Modal, Mono, RiskBadge, SimulationBadge, SourceChip } from './ui';
import { useToast } from './toast';

export function PriorityBadge({ p }: { p: Task['priority'] }) {
  return <Badge tone={p === 'P0' ? 'crit' : p === 'P1' ? 'high' : p === 'P2' ? 'med' : 'neutral'}>{p}</Badge>;
}

export function TaskStatusBadge({ status }: { status: Task['status'] }) {
  return <Badge tone={status === 'done' ? 'ok' : status === 'in_progress' ? 'info' : 'neutral'}>{status === 'todo' ? 'To do' : status === 'in_progress' ? 'In progress' : 'Done'}</Badge>;
}

export function CreatedByBadge({ by }: { by: Task['createdBy'] }) {
  return by === 'nightwatch' ? (
    <Badge tone="accent">
      <Bot size={11} /> AI-created
    </Badge>
  ) : (
    <Badge>
      <User size={11} /> Human
    </Badge>
  );
}

export function TaskDescriptionView({ d }: { d: TaskDescription }) {
  return (
    <div className="space-y-4 text-[13.5px]">
      <Block label="Problem">{d.problem}</Block>
      <Block label="Impact">{d.impact}</Block>
      <Block label="Evidence">
        {d.evidence.length ? (
          <ul className="space-y-1">
            {d.evidence.map((e) => (
              <li key={e} className="flex gap-2">
                <span className="mt-2 size-1 shrink-0 rounded-full bg-ink-3" />
                {e}
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-ink-3">None attached</span>
        )}
      </Block>
      <Block label="Hypothesis">{d.hypothesis}</Block>
      <Block label="Confidence">{d.confidence}</Block>
      <Block label="Recommended next step">{d.nextStep}</Block>
      <Block label="Sources">
        <div className="flex flex-wrap gap-3">
          {d.sources.length ? d.sources.map((s) => <SourceChip key={s} source={s} className="text-ink-2" />) : <span className="text-ink-3">—</span>}
        </div>
      </Block>
    </div>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Eyebrow className="mb-1">{label}</Eyebrow>
      <div className="text-ink">{children}</div>
    </div>
  );
}

/** A task Nightwatch prepared but did not file — the PM reviews and clicks Create Task. */
export function TaskDraftCard({ draft, compact }: { draft: TaskDraft; compact?: boolean }) {
  const { createTaskFromDraft, state } = useWorkspace();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Task | null>(null);
  const [expanded, setExpanded] = useState(!compact);
  const prefix = TEAMS.find((t) => t.id === draft.ownerTeamId)?.keyPrefix ?? 'NW';
  const trackerDown = state.settings.integrations.issue_tracker === 'unavailable';

  const create = async () => {
    setBusy(true);
    const task = await createTaskFromDraft(draft);
    setBusy(false);
    if (task) {
      setCreated(task);
      toast({ tone: 'success', title: `Task created — ${task.id}`, body: `${task.title} · ${teamName(task.ownerTeamId)} · simulated issue tracker` });
    } else {
      toast({ tone: 'warning', title: 'Task not created', body: 'The issue tracker is unavailable. The draft is kept — try again once it reconnects.' });
    }
  };

  if (created) {
    return (
      <Card className="border-ok/30">
        <div className="flex items-center gap-2 text-[13.5px]">
          <CircleCheck size={16} className="text-ok" />
          <span className="font-medium">Task created.</span>
          <Mono>{created.id}</Mono>
          <span className="text-ink-2">{created.title}</span>
          <Link to={`/tasks?open=${created.id}`} className="ml-auto inline-flex items-center gap-1 text-[12.5px] font-medium text-accent hover:underline">
            View in Tasks <ArrowRight size={12} />
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <Card padded={false} className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-subtle/60 px-4 py-2.5">
        <FilePlus2 size={14} className="text-ink-2" />
        <span className="text-[12px] font-semibold tracking-wide text-ink-2 uppercase">Create {draft.kind === 'incident' ? 'incident' : 'task'}</span>
        <SimulationBadge label="Simulated issue tracker" />
        <span className="ml-auto text-[12px] text-ink-3">Drafted by Nightwatch</span>
      </div>
      <div className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-mono text-[12px] text-ink-3">{prefix}-···</div>
            <div className="text-[16px] font-semibold tracking-tight">{draft.title}</div>
          </div>
          <div className="flex items-center gap-2">
            <PriorityBadge p={draft.priority} />
            <Badge>{teamName(draft.ownerTeamId)}</Badge>
          </div>
        </div>
        {expanded ? (
          <div className="mt-4">
            <TaskDescriptionView d={draft.description} />
          </div>
        ) : (
          <p className="mt-2 line-clamp-2 text-[13px] text-ink-2">{draft.description.problem} {draft.description.hypothesis}</p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button variant="primary" icon={busy ? Loader2 : FilePlus2} onClick={create} disabled={busy}>
            {busy ? 'Creating…' : 'Create Task'}
          </Button>
          {compact && (
            <Button variant="ghost" onClick={() => setExpanded((e) => !e)}>
              {expanded ? 'Hide details' : 'Show full description'}
            </Button>
          )}
          {trackerDown && <span className="text-[12px] text-high">Issue tracker simulated as unavailable — creation will fail.</span>}
        </div>
      </div>
    </Card>
  );
}

/** Full task view, including why Nightwatch created it. */
export function TaskDrawer({ task, onClose }: { task: Task | null; onClose: () => void }) {
  const { state, setTaskStatus } = useWorkspace();
  if (!task) return null;
  const inv = state.run?.investigations.find((i) => i.id === task.investigationId);
  const action: Action | undefined = state.run?.actions.find((a) => a.taskId === task.id && (a.type === 'create_task' || a.type === 'create_incident_draft'));
  const humanFiled = state.humanEvents.find((e) => e.output === task.id && e.tool === 'issueTracker.createIssue');
  return (
    <Drawer
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Mono className="text-ink-3">{task.id}</Mono> {task.title}
        </span>
      }
      subtitle={`${teamName(task.ownerTeamId)} · created ${fmtDateTime(task.createdAt)} · simulated issue tracker`}
    >
      <div className="flex flex-wrap gap-1.5">
        <PriorityBadge p={task.priority} />
        <TaskStatusBadge status={task.status} />
        <CreatedByBadge by={task.createdBy} />
        {task.kind === 'incident' && <Badge tone="crit">Incident draft</Badge>}
        <Badge>{task.evidenceSourceCount} evidence sources</Badge>
      </div>

      {task.createdBy === 'nightwatch' && (
        <div className="mt-5 rounded-xl border border-accent/25 bg-accent-soft/50 p-4">
          <div className="flex items-center gap-2 text-[13px] font-semibold">
            <Info size={14} className="text-accent" /> Why Nightwatch created this
          </div>
          <KeyValue
            className="mt-3"
            items={[
              { k: 'Finding', v: inv ? <Link className="font-medium text-accent hover:underline" to={`/investigations/${inv.id}`}>{inv.title}</Link> : task.investigationId ? 'From an earlier night' : '—' },
              { k: 'Leading hypothesis', v: task.description.hypothesis },
              { k: 'Confidence', v: task.description.confidence },
              { k: 'Policy decision', v: action ? action.decisionReason : humanFiled ? 'Drafted by Nightwatch, filed by you' : 'Filed on an earlier night' },
              { k: 'Autonomy level', v: 'Level 3 — execute low-risk actions' },
            ]}
          />
        </div>
      )}

      <div className="mt-6">
        <TaskDescriptionView d={task.description} />
      </div>

      {task.comments.length > 0 && (
        <div className="mt-6">
          <Eyebrow className="mb-2">Activity</Eyebrow>
          <ul className="space-y-2">
            {task.comments.map((c, i) => (
              <li key={i} className="rounded-lg border border-line bg-canvas/60 p-3 text-[13px]">
                <div className="mb-0.5 text-[12px] text-ink-3">
                  {c.author === 'nightwatch' ? 'Nightwatch' : 'You'} · {fmtTime(c.at)}
                </div>
                {c.body}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-2 border-t border-line pt-4">
        {task.status !== 'in_progress' && task.status !== 'done' && (
          <Button onClick={() => setTaskStatus(task.id, 'in_progress')}>Start work</Button>
        )}
        {task.status !== 'done' && (
          <Button variant="success" icon={Check} onClick={() => setTaskStatus(task.id, 'done')}>
            Mark done
          </Button>
        )}
        {task.status === 'done' && <Button onClick={() => setTaskStatus(task.id, 'todo')}>Reopen</Button>}
      </div>
    </Drawer>
  );
}

// ─────────────────────────────────────────────────────────────
// Approvals
// ─────────────────────────────────────────────────────────────

export function ApprovalCard({ approval, evidence }: { approval: ApprovalRequest; evidence: Evidence[] }) {
  const { approve, reject, requestMoreEvidence } = useWorkspace();
  const toast = useToast();
  const [confirm, setConfirm] = useState<'approve' | 'reject' | null>(null);
  const [loading, setLoading] = useState(false);
  const decided = approval.status === 'approved' || approval.status === 'rejected';
  const cited = evidence.filter((e) => approval.evidenceIds.includes(e.id));

  const more = async () => {
    setLoading(true);
    await requestMoreEvidence(approval.id);
    setLoading(false);
    toast({ tone: 'info', title: 'Nightwatch gathered more evidence', body: 'Follow-up queries were attached to the request.' });
  };

  return (
    <article id={approval.id} className={cx('scroll-mt-20 overflow-hidden rounded-xl border bg-surface shadow-card', decided ? 'border-line' : approval.risk === 'high' ? 'border-crit/30' : 'border-high/30')}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-subtle/60 px-4 py-2.5 sm:px-5">
        <ShieldCheck size={14} className="text-ink-2" />
        <span className="text-[12px] font-semibold tracking-wide text-ink-2 uppercase">Action request</span>
        <RiskBadge risk={approval.risk} />
        <Badge>{GATE_LABELS[approval.gatedBy]}</Badge>
        <span className="ml-auto text-[12px] text-ink-3">Requested {fmtTime(approval.requestedAt)} · Level 4 — human approval</span>
      </div>
      <div className="p-4 sm:p-5">
        <h3 className="text-[18px] font-semibold tracking-tight">{approval.title}</h3>
        <KeyValue
          className="mt-4"
          items={[
            { k: 'Reason', v: approval.reason },
            { k: 'Evidence', v: `${approval.evidenceSources.length} sources · ${cited.length} observations (${approval.evidenceSources.map((s) => SOURCE_LABELS[s]).join(', ')})` },
            { k: 'Confidence', v: fmtConfidence(approval.confidence) },
            { k: 'Potential impact', v: approval.potentialImpact },
            { k: 'Reversibility', v: approval.reversibility },
          ]}
        />
        {cited.length > 0 && (
          <details className="group mt-4 rounded-lg border border-line">
            <summary className="cursor-pointer list-none px-3 py-2 text-[12.5px] font-medium text-ink-2 hover:text-ink">Show cited evidence ({cited.length})</summary>
            <ul className="divide-y divide-line border-t border-line">
              {cited.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-3 px-3 py-2 text-[12.5px]">
                  <span>{e.title}</span>
                  <SourceChip source={e.source} className="shrink-0" />
                </li>
              ))}
            </ul>
          </details>
        )}
        {approval.supplementalEvidence.length > 0 && (
          <div className="mt-4 rounded-lg border border-info/25 bg-info-soft/50 p-3">
            <div className="mb-2 text-[12px] font-semibold text-info">Additional evidence gathered on request</div>
            <ul className="space-y-2">
              {approval.supplementalEvidence.map((e) => (
                <li key={e.id} className="text-[13px]">
                  <div className="font-medium">{e.title}</div>
                  <div className="text-ink-2">{e.detail}</div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {decided ? (
          <div className={cx('mt-5 rounded-lg px-3 py-2.5 text-[13px]', approval.status === 'approved' ? 'bg-ok-soft text-ok' : 'bg-subtle text-ink-2')}>
            <span className="font-semibold">{approval.status === 'approved' ? 'Approved' : 'Rejected'}</span> by you at {fmtTime(approval.decidedAt!)}.{' '}
            {approval.executionResult ?? approval.decisionNote}
          </div>
        ) : (
          <div className="mt-5 flex flex-wrap gap-2">
            <Button variant="success" icon={Check} onClick={() => setConfirm('approve')}>
              Approve
            </Button>
            <Button variant="danger" icon={X} onClick={() => setConfirm('reject')}>
              Reject
            </Button>
            <Button icon={loading ? Loader2 : undefined} onClick={more} disabled={loading}>
              {loading ? 'Gathering…' : 'Request More Evidence'}
            </Button>
          </div>
        )}
      </div>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'approve' ? `Approve: ${approval.title}?` : `Reject: ${approval.title}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            {confirm === 'approve' ? (
              <Button
                variant="success"
                onClick={() => {
                  approve(approval.id);
                  setConfirm(null);
                  toast({ tone: 'success', title: 'Approved — executed in simulation', body: 'Recorded in the audit log. No production system was changed.' });
                }}
              >
                Approve
              </Button>
            ) : (
              <Button
                variant="danger"
                onClick={() => {
                  reject(approval.id);
                  setConfirm(null);
                  toast({ tone: 'info', title: 'Rejected', body: 'Nightwatch will not perform this action. Recorded in the audit log.' });
                }}
              >
                Reject
              </Button>
            )}
          </>
        }
      >
        {confirm === 'approve' ? (
          <>
            {approval.potentialImpact} <br />
            <br />
            In this demo environment approval updates the <strong>simulated</strong> state only. The decision is recorded in the audit log.
          </>
        ) : (
          'Nightwatch will not perform this action for this finding. The rejection is recorded in the audit log and shown in the brief.'
        )}
      </Modal>
    </article>
  );
}
