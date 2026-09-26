import { Check, Download, FlaskConical, Plus, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useProduct } from '@/state/productContext';
import { acceptedCount } from '@/product/imports/schemas';
import { connectedQuickStartState, historicalQuickStartRun } from '@/product/view/quickStart';
import { acknowledgeWelcome, isWelcomeAcknowledged, shouldShowFirstRunWelcome } from '@/state/firstRun';
import { Badge, Button, Card, cx } from './ui';

export const PRIVACY_NOTICE =
  'Your imported data is used to run investigations in this workspace and is stored in this browser. If AI planning is enabled, investigation context (including summaries of your evidence) may be sent to the configured model provider.';

/** "My data" workspaces: the four steps to a first investigation, with the next one highlighted. */
export function GettingStarted() {
  const { state, importedWorld, runMonitoring, running, plannerChoice, llmOption, setPlannerChoice } = useProduct();
  const accepted = (state.imports ?? []).reduce((a, d) => a + acceptedCount(d), 0);
  const steps = [
    { done: accepted > 0, title: 'Bring your product evidence', body: accepted ? `${accepted} records imported from ${(state.imports ?? []).length} file${(state.imports ?? []).length === 1 ? '' : 's'}.` : 'Upload CSV or JSON: metrics, issues, releases, customer feedback.' },
    { done: state.watches.length > 0, title: 'What should Jagr watch?', body: state.watches.length ? `${state.watches.map((w) => w.name).join(', ')}.` : 'Create a watch — e.g. Checkout health. Takes a minute.' },
    { done: true, title: 'Choose how Jagr investigates', body: '' },
    { done: !!state.result, title: 'Run your first investigation', body: state.result ? 'Done — see what needs your attention below.' : importedWorld && !importedWorld.world ? importedWorld.notes.at(-1) ?? '' : 'Jagr runs every watch over your data and opens investigations where something changed.' },
  ];
  const current = steps.findIndex((s) => !s.done);
  if (current === -1) return null;
  return (
    <Card className="mb-6">
      <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold">
        Get started <span className="font-normal text-ink-3">· about 5 minutes with your own data</span>
      </div>
      <ol className="grid gap-3 md:grid-cols-4">
        {steps.map((s, i) => (
          <li key={s.title} className={cx('rounded-lg border p-3', i === current ? 'border-accent bg-accent-soft/40' : 'border-line')}>
            <div className="flex items-center gap-2 text-[12px] font-semibold">
              <span className={cx('grid size-5 place-items-center rounded-full text-[12px]', s.done ? 'bg-ok text-surface' : 'bg-subtle text-ink-2 ring-1 ring-inset ring-line')}>{s.done ? <Check size={11} /> : i + 1}</span>
              {s.title}
            </div>
            {i === 2 ? (
              <div className="mt-2 space-y-1.5 text-[12px]">
                <select
                  aria-label="Planner"
                  value={plannerChoice === 'llm' && llmOption.available ? 'llm' : 'deterministic'}
                  onChange={(e) => setPlannerChoice(e.target.value as 'deterministic' | 'llm')}
                  className="h-7 w-full rounded border border-line bg-surface px-1.5 text-[12px] outline-none"
                >
                  <option value="deterministic">Deterministic</option>
                  <option value="llm" disabled={!llmOption.available}>
                    {llmOption.available ? `AI planner · ${llmOption.label}` : 'AI planner — not configured'}
                  </option>
                </select>
                {!llmOption.available && <p className="text-ink-3">AI planner unavailable — deterministic investigation active.</p>}
              </div>
            ) : (
              <p className="mt-1.5 text-[12px] text-ink-2">{s.body}</p>
            )}
            {i === current && i === 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Link to="/sources?upload=1" className="inline-flex h-7 items-center gap-1 rounded bg-ink px-2.5 text-[12px] font-medium text-canvas">
                  <Plus size={12} /> Add source
                </Link>
                <a href="/samples/metrics.csv" download className="inline-flex h-7 items-center gap-1 rounded border border-line px-2 text-[12px] text-ink-2 hover:bg-subtle">
                  <Download size={12} /> Sample files
                </a>
              </div>
            )}
            {i === current && i === 1 && (
              <Link to="/watches?new=1" className="mt-2 inline-flex h-7 items-center gap-1 rounded bg-ink px-2.5 text-[12px] font-medium text-canvas">
                <Plus size={12} /> Create watch
              </Link>
            )}
            {i === current && i === 3 && (
              <Button size="sm" variant="primary" icon={RefreshCw} className="mt-2" disabled={running || !steps[0].done || !steps[1].done} onClick={() => void runMonitoring().catch(() => undefined)}>
                {running ? 'Investigating…' : 'Run monitoring'}
              </Button>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** Connected server workspaces: the shortest truthful path to a first completed check. */
export function ConnectedWorkspaceQuickStart() {
  const { state, server, runMonitoring, running } = useProduct();
  if (!server) return null;
  const quickStart = connectedQuickStartState({ loading: server.loading, connections: server.connections, productConnections: state.connections, watches: state.watches, result: state.result, running, clock: state.clock, snapshotAt: server.snapshotAt });
  if (!quickStart.showChecklist) return null;

  const steps = [
    { done: quickStart.stage !== 'loading' && quickStart.stage !== 'source', title: 'Connect a live source', body: quickStart.stage === 'loading' ? 'Checking source readiness…' : quickStart.stage === 'source' ? 'Jagr needs a successfully verified evidence source before it can monitor your product.' : 'A live evidence source is verified.' },
    { done: quickStart.stage === 'run', title: 'Create a watch', body: quickStart.stage === 'watch' ? state.watches.length ? 'An active watch must use at least one verified source. Open Watches to resume or create one.' : quickStart.recommendedTemplate ? 'A watch supported by your verified source is ready to configure.' : 'No built-in watch matches the verified source yet. Open the watch creator to review the available questions.' : 'Your first watch is ready.' },
    { done: false, title: 'Run the first check', body: quickStart.running ? 'Jagr is checking your watch against the live source.' : 'Run now to confirm the setup. A quiet check is a successful result.' },
  ];
  const current = quickStart.stage === 'loading' || quickStart.stage === 'source' ? 0 : quickStart.stage === 'watch' ? 1 : 2;
  const watchHref = state.watches.length ? '/watches?from=quick-start' : quickStart.recommendedTemplate ? `/watches?new=1&template=${quickStart.recommendedTemplate}&from=quick-start` : '/watches?new=1&from=quick-start';

  return (
    <Card className="mb-6">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px] font-semibold">Quick Start <span className="font-normal text-ink-3">· connect, watch, then verify the first check</span></div>
      <ol className="grid gap-3 md:grid-cols-3">
        {steps.map((step, index) => (
          <li key={step.title} className={cx('rounded-lg border p-3', index === current ? 'border-accent bg-accent-soft/40' : 'border-line')}>
            <div className="flex items-center gap-2 text-[12px] font-semibold">
              <span className={cx('grid size-5 shrink-0 place-items-center rounded-full text-[12px]', step.done ? 'bg-ok text-surface' : 'bg-subtle text-ink-2 ring-1 ring-inset ring-line')}>{step.done ? <Check size={11} /> : index + 1}</span>
              {step.title}
            </div>
            <p className="mt-1.5 text-[12px] text-ink-2">{step.body}</p>
            {index === current && index === 0 && quickStart.stage !== 'loading' && <Link to="/sources?from=quick-start" className="mt-2 inline-flex h-7 items-center gap-1 rounded bg-ink px-2.5 text-[12px] font-medium text-canvas"><Plus size={12} /> Connect source</Link>}
            {index === current && index === 1 && <Link to={watchHref} className="mt-2 inline-flex h-7 items-center gap-1 rounded bg-ink px-2.5 text-[12px] font-medium text-canvas"><Plus size={12} /> Create watch</Link>}
            {index === current && index === 2 && <Button size="sm" variant="primary" icon={RefreshCw} className="mt-2" disabled={running} onClick={() => void runMonitoring().catch(() => undefined)}>{running ? 'Checking…' : 'Run monitoring'}</Button>}
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function FirstRunWelcome({ onContinue, onSkip }: { onContinue: () => void; onSkip: () => void }) {
  const reveal = (delay: string) => ({ '--welcome-delay': delay }) as CSSProperties;
  return (
    <Card className="mb-6 overflow-hidden">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.88fr)_minmax(390px,1.12fr)] lg:grid-rows-[auto_1fr] lg:gap-x-8 lg:gap-y-5">
        <div className="min-w-0 lg:self-end">
          <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-accent">Welcome to Jagr</p>
          <h2 className="mt-1.5 max-w-2xl text-[24px] leading-tight font-semibold tracking-[-0.025em] text-balance sm:mt-2 sm:text-[28px]">Jagr watches your product while you’re away.</h2>
          <p className="mt-2 max-w-xl text-[13px] leading-5 text-ink-2 sm:mt-3 sm:text-[14px] sm:leading-6">It detects meaningful changes, checks the evidence, and interrupts only when needed.</p>
        </div>

        <div aria-label="Conceptual example of how Jagr investigates" className="min-w-0 rounded-xl border border-line bg-subtle/40 p-3 sm:p-4 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3 sm:text-[11px] sm:tracking-[0.12em]">
            Conceptual example · not live data
          </div>
          <div className="mt-2 overflow-hidden rounded-lg border border-line bg-surface sm:mt-3">
            <div className="grid grid-cols-2 divide-x divide-line border-b border-line text-[11px] sm:text-[12px]">
              <div style={reveal('0ms')} className="welcome-reveal px-2.5 py-1.5 sm:px-3 sm:py-2">
                <div className="font-semibold uppercase tracking-[0.08em] text-ink-3">Connected</div>
                <div className="mt-0.5 text-ink">Analytics · Jira · Feedback</div>
              </div>
              <div style={reveal('450ms')} className="welcome-reveal px-2.5 py-1.5 sm:px-3 sm:py-2">
                <div className="font-semibold uppercase tracking-[0.08em] text-ink-3">Watching</div>
                <div className="mt-0.5 text-ink">Conversion rate</div>
              </div>
            </div>

            <div style={reveal('900ms')} className="welcome-reveal border-b border-high/30 bg-high-soft/55 px-2.5 py-2 sm:px-3 sm:py-2.5">
              <div className="flex items-center gap-2">
                <span aria-hidden className="size-2 shrink-0 rounded-full bg-high" />
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-high">Change detected</span>
              </div>
              <div className="mt-0.5 text-[14px] font-semibold text-ink sm:text-[15px]">Conversion −18%</div>
            </div>

            <div className="border-b border-line px-2.5 py-2 sm:px-3 sm:py-2.5">
              <div style={reveal('1350ms')} className="welcome-reveal flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-accent sm:text-[12px] sm:tracking-[0.08em]">
                <Search size={13} aria-hidden /> Investigating evidence
              </div>
              <ul className="mt-1.5 grid gap-1 text-[11px] sm:mt-2 sm:grid-cols-3 sm:gap-1.5 sm:text-[12px]">
                {[
                  { delay: '1750ms', label: 'Analytics', detail: 'confirmed' },
                  { delay: '2100ms', label: 'Jira', detail: 'no release' },
                  { delay: '2450ms', label: 'Feedback', detail: 'no spike' },
                ].map((evidence) => (
                  <li key={evidence.label} style={reveal(evidence.delay)} className="welcome-reveal flex min-w-0 items-center gap-1.5 rounded-md bg-subtle px-2 py-1 sm:items-start sm:py-1.5">
                    <Check size={12} aria-hidden className="shrink-0 text-ok sm:mt-0.5" />
                    <span className="min-w-0"><span className="font-medium text-ink">{evidence.label}</span><span className="text-ink-3"> · {evidence.detail}</span></span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="px-2.5 py-2 sm:px-3 sm:py-2.5">
              <div style={reveal('2850ms')} className="welcome-reveal flex items-start gap-2">
                <ShieldCheck size={15} aria-hidden className="mt-0.5 shrink-0 text-ok" />
                <div><span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3 sm:text-[11px]">Decision</span><div className="text-[13px] font-semibold text-ink sm:text-[14px]">No interruption needed</div><p className="text-[11px] text-ink-3 sm:text-[12px]">Not corroborated across sources.</p></div>
              </div>
              <div style={reveal('3250ms')} className="welcome-reveal mt-1.5 border-t border-line pt-1.5 text-[11px] text-ink-2 sm:mt-2 sm:pt-2 sm:text-[12px]"><span className="font-semibold uppercase tracking-[0.08em] text-ink-3">Brief</span><span className="ml-2">Recorded in your morning brief</span></div>
            </div>
          </div>
          <p className="mt-2 text-center text-[9px] font-semibold uppercase tracking-[0.04em] text-ink-3 sm:mt-3 sm:text-[11px] sm:tracking-[0.1em]">Connect → Watch → Investigate → Decide → Brief</p>
        </div>

        <div className="min-w-0 lg:self-start">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-ink"><ShieldCheck size={15} aria-hidden className="shrink-0 text-accent" /> Jagr investigates before interrupting.</p>
          <div className="mt-3 grid gap-2 sm:mt-4 sm:flex sm:flex-wrap sm:items-center">
            <Button className="w-full sm:w-auto" variant="primary" onClick={onContinue}>Set up my first watch</Button>
            <Link to="/demo" className="interactive inline-flex h-8.5 w-full items-center justify-center rounded-lg border border-line bg-surface px-3 text-[13px] font-medium hover:bg-subtle sm:w-auto">See Jagr in action</Link>
            <button type="button" className="interactive justify-self-center rounded px-2 py-1.5 text-[13px] text-ink-3 hover:text-ink" onClick={onSkip}>Skip for now</button>
          </div>
          <p className="mt-2 text-[11px] text-ink-3 sm:pl-[163px]">Demo Night · scripted replay</p>
        </div>
      </div>
    </Card>
  );
}

/** Welcome is presentation only; Quick Start remains the single activation state machine. */
export function ConnectedWorkspaceFirstRun() {
  const { state, server } = useProduct();
  const [acknowledgedWorkspace, setAcknowledgedWorkspace] = useState<string>();
  if (!server) return null;
  const acknowledged = acknowledgedWorkspace === server.workspaceId || isWelcomeAcknowledged(server.workspaceId);
  if (shouldShowFirstRunWelcome({ loading: server.loading, workspaceId: server.workspaceId, hasHistoricalRun: !!historicalQuickStartRun(state.result), acknowledged })) {
    const acknowledge = () => {
      acknowledgeWelcome(server.workspaceId);
      setAcknowledgedWorkspace(server.workspaceId);
    };
    return <FirstRunWelcome onContinue={acknowledge} onSkip={acknowledge} />;
  }
  return <ConnectedWorkspaceQuickStart />;
}

/** Where the workspace's data comes from — shown near every place data is presented. */
export function WorkspaceDataBadge() {
  const { mode, location } = useProduct();
  if (location === 'server') return <Badge tone="accent">{mode === 'connected' ? 'Live sources · server workspace' : mode === 'imported' ? 'Your data · server workspace' : 'Sample data · server workspace'}</Badge>;
  if (mode === 'imported') return <Badge tone="accent">Your data · browser-local</Badge>;
  return (
    <span className="inline-flex items-center gap-1">
      <Badge tone="info">Sample data · simulated</Badge>
    </span>
  );
}

/** Never wipes existing imports: an existing "my data" workspace is simply opened. */
export function TryYourOwnData() {
  const { createWorkspace, mode } = useProduct();
  const navigate = useNavigate();
  return (
    <Button
      icon={FlaskConical}
      onClick={() => {
        if (mode !== 'imported') createWorkspace('imported');
        navigate('/sources?upload=1');
      }}
    >
      Try your own data
    </Button>
  );
}
