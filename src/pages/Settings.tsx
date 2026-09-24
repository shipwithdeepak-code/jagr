import { Lock, RotateCcw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { AlertSeverity, EscalationRoute, GatedCategory, GateSetting, SignalCategory, WatchArea, WorkspaceSettings } from '@/domain/types';
import { AREA_LABELS, TEAMS } from '@/domain/defaults';
import { AUTONOMY_LEVELS, GATE_LABELS } from '@/agents/policy';
import { useWorkspace } from '@/state/workspace';
import { Badge, Button, Card, cx, Modal, PageHeader, Select, Toggle } from '@/components/ui';
import { useToast } from '@/components/toast';

const WATCH: { key: WatchArea; label: string; category?: SignalCategory; hint: string }[] = [
  { key: 'activation', label: 'Activation', category: 'activation', hint: 'Activation by platform, onboarding, signups' },
  { key: 'conversion', label: 'Conversion', category: 'conversion', hint: 'Subscription & checkout funnel, trials' },
  { key: 'retention', label: 'Retention', category: 'retention', hint: 'D1 / D7 / D30, reactivation' },
  { key: 'revenue', label: 'Revenue', category: 'revenue', hint: 'Gross revenue, ARPU, refunds, cancellations' },
  { key: 'payment_failures', label: 'Payment failures', category: 'payments', hint: 'Failure rate, chargebacks, retries' },
  { key: 'support_volume', label: 'Support volume', category: 'support', hint: 'Tickets, response time, CSAT' },
  { key: 'engagement', label: 'Engagement', category: 'engagement', hint: 'Active users, sessions, feature usage' },
  { key: 'reliability', label: 'Reliability', category: 'reliability', hint: 'API errors & latency, crash rates' },
  { key: 'releases', label: 'Releases', hint: 'Correlate deploys and merged PRs during investigations' },
  { key: 'experiments', label: 'Experiments', hint: 'Correlate experiment ramps and results' },
];

const ROUTES: { value: EscalationRoute; label: string }[] = [
  { value: 'immediate', label: 'Immediate' },
  { value: 'morning_brief', label: 'Morning brief' },
  { value: 'daily_digest', label: 'Daily digest' },
  { value: 'none', label: 'No interruption' },
];

export function SettingsPage() {
  const { state, updateSettings, reset } = useWorkspace();
  const toast = useToast();
  const [confirmReset, setConfirmReset] = useState(false);
  const s = state.settings;

  const save = (next: WorkspaceSettings, description: string) => {
    updateSettings(next, description);
    toast({ tone: 'success', title: 'Saved', body: `${description}. Applies to the next overnight run.` });
  };

  const a = s.autonomy;
  const setAutonomy = (patch: Partial<WorkspaceSettings['autonomy']>, description: string) => save({ ...s, autonomy: { ...a, ...patch } }, description);

  return (
    <>
      <PageHeader title="Settings" description="What Nightwatch watches, who owns what, how much it may do on its own, and when it interrupts people. Changes apply to the next run and are recorded in the audit log." />

      <div className="space-y-6">
        <Panel title="What Nightwatch watches" hint="Thresholds are the relative move (in the bad direction) required before a signal can be anomalous.">
          <div className="divide-y divide-line">
            {WATCH.map((w) => (
              <div key={w.key} className="flex flex-wrap items-center gap-3 py-2.5">
                <input
                  type="checkbox"
                  id={`watch-${w.key}`}
                  checked={s.watch[w.key]}
                  onChange={(e) => save({ ...s, watch: { ...s.watch, [w.key]: e.target.checked } }, `${w.label} ${e.target.checked ? 'watched' : 'not watched'}`)}
                  className="size-4 accent-[var(--ink)]"
                />
                <label htmlFor={`watch-${w.key}`} className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-medium">{w.label}</span>
                  <span className="block text-[12px] text-ink-3">{w.hint}</span>
                </label>
                {w.category && (
                  <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
                    Threshold
                    <input
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      value={s.thresholds[w.category]}
                      onChange={(e) => {
                        const v = Math.max(1, Math.min(100, Number(e.target.value) || 1));
                        updateSettings({ ...s, thresholds: { ...s.thresholds, [w.category!]: v } });
                      }}
                      onBlur={() => save(s, `${w.label} threshold set to ${s.thresholds[w.category!]}%`)}
                      className="tabular h-8 w-16 rounded-lg border border-line bg-surface px-2 text-right text-[13px]"
                      aria-label={`${w.label} threshold`}
                    />
                    %
                  </label>
                )}
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Who owns what" hint="Nightwatch files work to the team that owns the implicated component — not the metric that moved.">
          <div className="grid gap-3 sm:grid-cols-2">
            {s.owners.map((o) => (
              <div key={o.area} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
                <span className="text-[13.5px] font-medium">{AREA_LABELS[o.area]}</span>
                <span className="flex items-center gap-2 text-ink-3">
                  →
                  <Select
                    label={`Owner for ${AREA_LABELS[o.area]}`}
                    value={o.teamId}
                    onChange={(teamId) => save({ ...s, owners: s.owners.map((x) => (x.area === o.area ? { ...x, teamId } : x)) }, `${AREA_LABELS[o.area]} now owned by ${TEAMS.find((t) => t.id === teamId)?.name}`)}
                    options={TEAMS.map((t) => ({ value: t.id, label: t.name }))}
                  />
                </span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Autonomy policy" hint="Each level requires the ones below it. Turning one off disables everything above.">
          <div className="divide-y divide-line">
            <PolicyRow level={0} label="Observe" desc="Read product signals" checked={a.observe} onChange={(v) => setAutonomy({ observe: v }, `Observe ${v ? 'on' : 'off'}`)} />
            <PolicyRow level={1} label="Investigate" desc="Query other systems for evidence" checked={a.investigate} disabled={!a.observe} onChange={(v) => setAutonomy({ investigate: v }, `Investigate ${v ? 'on' : 'off'}`)} />
            <PolicyRow level={2} label="Recommend" desc="Form hypotheses and recommend actions" checked={a.recommend} disabled={!a.investigate} onChange={(v) => setAutonomy({ recommend: v }, `Recommend ${v ? 'on' : 'off'}`)} />
            <PolicyRow level={3} label="Create tasks" desc="File engineering tasks in the issue tracker" checked={a.createTasks} disabled={!a.recommend} onChange={(v) => setAutonomy({ createTasks: v }, `Create tasks ${v ? 'on' : 'off'}`)}>
              <Select
                label="Auto-file tasks for"
                value={a.autoFileMinSeverity}
                onChange={(v) => setAutonomy({ autoFileMinSeverity: v }, `Auto-file tasks: ${v}`)}
                options={[
                  { value: 'critical', label: 'Auto-file critical; draft the rest' },
                  { value: 'high', label: 'Auto-file high and above' },
                  { value: 'medium', label: 'Auto-file medium and above' },
                  { value: 'never', label: 'Draft only — I file them' },
                ]}
              />
            </PolicyRow>
            <PolicyRow level={3} label="Create incidents" desc="Draft incident records for critical findings" checked={a.createIncidents} disabled={!a.recommend} onChange={(v) => setAutonomy({ createIncidents: v }, `Create incidents ${v ? 'on' : 'off'}`)} />
            {(Object.keys(GATE_LABELS) as GatedCategory[]).map((g) => (
              <div key={g} className="flex flex-wrap items-center gap-3 py-3">
                <Badge tone="high">L4</Badge>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[13.5px] font-medium">
                    {GATE_LABELS[g]} <Lock size={12} className="text-ink-3" />
                  </div>
                  <div className="text-[12px] text-ink-3">Hard limit: can require approval or be disabled — never autonomous.</div>
                </div>
                <Select<GateSetting>
                  label={`${GATE_LABELS[g]} policy`}
                  value={a.gates[g]}
                  onChange={(v) => setAutonomy({ gates: { ...a.gates, [g]: v } }, `${GATE_LABELS[g]}: ${v === 'require_approval' ? 'requires approval' : 'disabled'}`)}
                  options={[
                    { value: 'require_approval', label: 'Requires approval' },
                    { value: 'disabled', label: 'Disabled — recommend only' },
                  ]}
                />
              </div>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-5 gap-1 text-center text-[11px]">
            {AUTONOMY_LEVELS.map((l) => (
              <div key={l.level} className="rounded-md bg-subtle px-1 py-1.5" title={l.description}>
                <div className="font-semibold text-ink">L{l.level} {l.name}</div>
                <div className="hidden text-ink-3 sm:block">{l.description}</div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Escalation" hint="How each severity reaches people. Critical + Immediate notifies the owning team’s on-call (simulated).">
          <div className="grid gap-3 sm:grid-cols-2">
            {(['critical', 'high', 'medium', 'low'] as AlertSeverity[]).map((sev) => (
              <div key={sev} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
                <span className="text-[13.5px] font-medium capitalize">{sev}</span>
                <Select label={`${sev} escalation`} value={s.escalation[sev]} onChange={(v) => save({ ...s, escalation: { ...s.escalation, [sev]: v } }, `${sev} → ${ROUTES.find((r) => r.value === v)?.label}`)} options={ROUTES} />
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Schedule">
          <div className="grid gap-4 sm:grid-cols-3">
            <TimeField label="Watch starts" value={s.schedule.start} onChange={(v) => save({ ...s, schedule: { ...s.schedule, start: v } }, `Watch starts ${v}`)} />
            <TimeField label="Watch ends" value={s.schedule.end} onChange={(v) => save({ ...s, schedule: { ...s.schedule, end: v } }, `Watch ends ${v}`)} />
            <TimeField label="Morning briefing" value={s.schedule.briefAt} onChange={(v) => save({ ...s, schedule: { ...s.schedule, briefAt: v } }, `Morning brief at ${v}`)} />
          </div>
          <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5">
            <div>
              <div className="text-[13.5px] font-medium">Critical escalation</div>
              <div className="text-[12px] text-ink-3">Allow Nightwatch to notify on-call during the night for critical findings.</div>
            </div>
            <Toggle checked={s.criticalEscalation} onChange={(v) => save({ ...s, criticalEscalation: v }, `Critical escalation ${v ? 'on' : 'off'}`)} label="Critical escalation" />
          </div>
          <p className="mt-3 text-[12px] text-ink-3">The demo night is simulated at a fixed 18:00 → 08:00 window; schedule changes are stored for a real deployment’s scheduler.</p>
        </Panel>

        <Panel title="Workspace">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-[13px] text-ink-2">Restore default settings and the demo backlog, and clear tonight’s run, decisions and evaluation results.</div>
            <Button variant="danger" icon={RotateCcw} onClick={() => setConfirmReset(true)}>
              Reset workspace
            </Button>
          </div>
        </Panel>
      </div>

      <Modal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset the workspace?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmReset(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => { reset(); setConfirmReset(false); toast({ tone: 'info', title: 'Workspace reset' }); }}>Reset</Button>
          </>
        }
      >
        This clears the simulated workspace stored in this browser. It does not affect any external system.
      </Modal>
    </>
  );
}

function Panel({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Card>
      <div className="mb-3">
        <h2 className="text-[14px] font-semibold tracking-tight">{title}</h2>
        {hint && <p className="mt-0.5 text-[12.5px] text-ink-3">{hint}</p>}
      </div>
      {children}
    </Card>
  );
}

function PolicyRow({ level, label, desc, checked, onChange, disabled, children }: { level: number; label: string; desc: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; children?: ReactNode }) {
  return (
    <div className={cx('flex flex-wrap items-center gap-3 py-3', disabled && 'opacity-50')}>
      <Badge tone={level === 3 ? 'accent' : 'neutral'}>L{level}</Badge>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium">{label}</div>
        <div className="text-[12px] text-ink-3">{desc}</div>
      </div>
      {children}
      <span className="w-8 text-right text-[12px] font-medium text-ink-2">{checked ? 'ON' : 'OFF'}</span>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} label={label} />
    </div>
  );
}

function TimeField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-[12.5px] text-ink-3">{label}</span>
      <input type="time" value={value} onChange={(e) => e.target.value && onChange(e.target.value)} className="tabular mt-1 h-9 w-full rounded-lg border border-line bg-surface px-2 text-[14px]" />
    </label>
  );
}
