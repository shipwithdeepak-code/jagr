import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useProduct } from '@/state/productContext';
import { Card, PageHeader, Toggle } from '@/components/ui';
import { AccountPanel, AiEgressSetting, WorkspacePanel } from '@/components/serverWorkspace';
import { WorkspaceTransfer } from '@/components/workspaceTransfer';

const TIMEZONES = ['UTC', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Kolkata'];

/**
 * Settings for the open workspace — never for Demo night (that has its own settings page), and
 * opening this page never changes which environment the app is in.
 */
export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="How this workspace monitors, notifies and plans investigations. Demo night has its own settings." />
      <div className="space-y-8">
        <Section id="workspace" title="Workspace" hint="The workspace these settings apply to.">
          <WorkspacePanel />
        </Section>
        <Section id="monitoring" title="Monitoring" hint="Each watch sets its own frequency and thresholds. The morning brief runs on its own schedule.">
          <BriefSchedule />
        </Section>
        <Section id="notifications" title="Notifications" hint="Where Jagr tells you about findings.">
          <NotificationChannels />
        </Section>
        <Section id="ai" title="AI" hint="Which planner chooses the next check during an investigation, and whether this workspace may use an AI provider. Every proposal passes the same policy validator either way.">
          <div className="space-y-3">
            <PlannerSetting />
            <AiEgressSetting />
          </div>
        </Section>
        <Section id="data" title="Data">
          <WorkspaceTransfer />
        </Section>
        <Section id="account" title="Account" hint="Who is signed in on this browser.">
          <AccountPanel />
        </Section>
      </div>
    </>
  );
}

function Section({ id, title, hint, children }: { id: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20">
      <h2 id={`${id}-title`} className="text-[16px] font-semibold tracking-tight">
        {title}
      </h2>
      {hint && <p className="mt-0.5 mb-3 max-w-2xl text-[13px] text-ink-2">{hint}</p>}
      {!hint && <div className="mb-3" />}
      {children}
    </section>
  );
}

function BriefSchedule() {
  const { state, setBrief, location } = useProduct();
  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[14px] font-medium">Morning brief</div>
          <p className="text-[13px] text-ink-2">What needs your attention, and what stayed quiet — once a day.</p>
        </div>
        <Toggle checked={state.brief.enabled} onChange={(v) => setBrief({ ...state.brief, enabled: v })} label="Send a morning brief" />
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-[13px] text-ink-2" htmlFor="brief-time">
          Time
          <input id="brief-time" type="time" value={state.brief.time} disabled={!state.brief.enabled} onChange={(e) => e.target.value && setBrief({ ...state.brief, time: e.target.value })} className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-2 text-[14px] text-ink disabled:opacity-50" />
        </label>
        <label className="block text-[13px] text-ink-2" htmlFor="brief-tz">
          Timezone
          <select id="brief-tz" value={state.brief.timezone} disabled={!state.brief.enabled} onChange={(e) => setBrief({ ...state.brief, timezone: e.target.value })} className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-2 text-[14px] text-ink disabled:opacity-50">
            {TIMEZONES.map((tz) => (
              <option key={tz}>{tz}</option>
            ))}
          </select>
        </label>
      </div>
      {location === 'browser' && <p className="mt-3 text-[13px] text-ink-3">The sample night runs 18:00–08:05 UTC; a brief scheduled outside that window appears after the next sample night.</p>}
    </Card>
  );
}

/** Only channels that actually deliver are offered; email delivery is not built, so it is not promised. */
function NotificationChannels() {
  const { location, server } = useProduct();
  const channels = server?.connections.filter((c) => c.kind === 'channel') ?? [];
  return (
    <Card padded={false} className="divide-y divide-line">
      <Row title="In Jagr" status="Always on" body="Findings appear on the Overview, in Investigations and in the morning brief." />
      {location === 'server' ? (
        channels.length ? (
          channels.map((c) => <Row key={c.id} title={c.displayName} status={c.health === 'healthy' ? 'Connected' : c.health.replace('_', ' ')} body={`Alerts and the morning brief are posted here${c.account ? ` (${c.account})` : ''}.`} />)
        ) : (
          <Row title="Slack" status="Not connected" body={<>Post alerts and the morning brief to a Slack channel. <Link to="/sources" className="font-medium text-accent hover:underline">Connect Slack in Sources</Link>.</>} />
        )
      ) : (
        <Row title="Slack" status="Server workspaces" body="Sending alerts to Slack needs a server workspace — sign in under Account below." />
      )}
      <Row title="Email" status="Not available" body="Jagr does not send email yet. Alerts are shown in Jagr and, when connected, in Slack." />
    </Card>
  );
}

function Row({ title, status, body }: { title: string; status: string; body: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium">{title}</div>
        <p className="text-[13px] text-ink-2">{body}</p>
      </div>
      <span className="text-[13px] text-ink-3">{status}</span>
    </div>
  );
}

function PlannerSetting() {
  const { plannerChoice, llmOption, setPlannerChoice, running, location, server } = useProduct();
  const value = plannerChoice === 'llm' && llmOption.available ? 'llm' : 'deterministic';
  const egressOff = location === 'server' && server && !server.settings.aiEgressAllowed;
  return (
    <Card>
      <fieldset>
        <legend className="sr-only">Planner</legend>
        <div className="space-y-2">
          <label className="flex items-start gap-3 text-[14px]">
            <input type="radio" name="planner" className="mt-1 accent-[var(--ink)]" checked={value === 'deterministic'} disabled={running} onChange={() => setPlannerChoice('deterministic')} />
            <span>
              <span className="font-medium">Deterministic planner</span>
              <span className="block text-[13px] text-ink-2">Fixed investigation rules. Nothing leaves this workspace.</span>
            </span>
          </label>
          <label className="flex items-start gap-3 text-[14px]">
            <input type="radio" name="planner" className="mt-1 accent-[var(--ink)]" checked={value === 'llm'} disabled={running || !llmOption.available || !!egressOff} onChange={() => setPlannerChoice('llm')} />
            <span>
              <span className="font-medium">AI planner</span>
              <span className="block text-[13px] text-ink-2">
                {!llmOption.available ? (llmOption.reason ?? 'No AI provider is configured on this server.') : egressOff ? 'Turned off for this workspace: AI planning is not allowed (see below).' : `${llmOption.label}. Investigation context, including summaries of evidence, is sent to this provider.`}
              </span>
            </span>
          </label>
        </div>
      </fieldset>
    </Card>
  );
}
