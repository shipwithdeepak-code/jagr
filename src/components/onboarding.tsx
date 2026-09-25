import { ArrowRight, Check, Download, FlaskConical, Monitor, Moon, Plus, RefreshCw, Server, Upload } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useProduct } from '@/state/productContext';
import { acceptedCount } from '@/product/imports/schemas';
import { useServerSession } from '@/state/serverSession';
import { serverApi } from '@/state/serverApi';
import { Badge, Button, Card, cx } from './ui';

export const PRIVACY_NOTICE =
  'Your imported data is used to run investigations in this workspace and is stored in this browser. If AI planning is enabled, investigation context (including summaries of your evidence) may be sent to the configured model provider.';

/**
 * First run: what Jagr is, in one sentence, and the two real ways in.
 *   Server workspace — connect sources and let Jagr monitor on a schedule (sign in; shown whenever a
 *                      Jagr server with a sign-in provider is present).
 *   Local            — this browser only, with sample or imported data.
 * Demo night is a separate scripted replay, offered as a link, not as a third product.
 */
export function Welcome() {
  const { createWorkspace } = useProduct();
  const session = useServerSession();
  const navigate = useNavigate();
  const providers = session.server?.signIn ?? [];
  return (
    <div className="animate-fade-up mx-auto max-w-3xl py-6">
      <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.02em] text-balance sm:text-[40px] sm:leading-[1.1]">Your product keeps changing. Jagr watches it while you’re away.</h1>
      <p className="mt-4 max-w-2xl text-[16px] text-ink-2">It investigates meaningful changes across your tools and tells you what needs your attention — with the evidence, and with what it does not know.</p>

      <div className="mt-10 grid gap-8 md:grid-cols-2 md:gap-10">
        <section aria-labelledby="welcome-server">
          <h2 id="welcome-server" className="flex items-center gap-2 text-[16px] font-semibold">
            <Server size={16} aria-hidden className="text-ink-3" /> Server workspace
          </h2>
          <p className="mt-1 text-[14px] text-ink-2">Connect your sources and let Jagr monitor them on a schedule — without this browser open.</p>
          <div className="mt-4">
            {session.server === undefined ? (
              <p role="status" className="text-[13px] text-ink-3">Checking for a Jagr server…</p>
            ) : session.user ? (
              <div className="space-y-2">
                <p className="text-[13px] text-ink-2">Signed in as {session.user.displayName}.</p>
                {session.workspaces.map((w) => (
                  <Button key={w.id} variant="primary" className="w-full justify-between" onClick={() => session.open(w.id)}>
                    <span className="truncate">Open {w.name}</span> <ArrowRight size={14} aria-hidden />
                  </Button>
                ))}
                <Link to="/settings#workspace" className="interactive inline-flex h-8.5 w-full items-center justify-center rounded-lg border border-line bg-surface text-[13px] font-medium hover:bg-subtle">
                  Create a server workspace
                </Link>
              </div>
            ) : providers.length ? (
              <div className="flex flex-col gap-2">
                {providers.map((p, i) => (
                  <a key={p} href={serverApi.signInUrl(p, '/')} className={cx('interactive inline-flex h-9 items-center justify-center rounded-lg px-3 text-[14px] font-medium', i === 0 ? 'bg-ink text-canvas hover:opacity-90' : 'border border-line bg-surface hover:bg-subtle')}>
                    Continue with {p === 'google' ? 'Google' : p === 'github' ? 'GitHub' : p}
                  </a>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-ink-3">{session.server ? 'This Jagr server has no sign-in provider configured.' : 'Not available here: this copy of Jagr runs without a server.'}</p>
            )}
          </div>
        </section>

        <section aria-labelledby="welcome-local">
          <h2 id="welcome-local" className="flex items-center gap-2 text-[16px] font-semibold">
            <Monitor size={16} aria-hidden className="text-ink-3" /> Explore locally
          </h2>
          <p className="mt-1 text-[14px] text-ink-2">Runs in this browser with sample or imported data. No account; nothing leaves the browser unless you turn on AI planning.</p>
          <div className="mt-4 flex flex-col gap-2">
            <Button variant={providers.length && !session.user ? 'secondary' : 'primary'} className="h-9 w-full text-[14px]" onClick={() => createWorkspace('sample')}>
              Explore the sample workspace
            </Button>
            <Button
              className="h-9 w-full text-[14px]"
              icon={Upload}
              onClick={() => {
                createWorkspace('imported');
                navigate('/sources?upload=1');
              }}
            >
              Use my own data
            </Button>
          </div>
          <p className="mt-2 text-[13px] text-ink-3">The sample is a simulated night where checkout conversion drops 18% after a release — labelled simulated everywhere.</p>
        </section>
      </div>

      <p className="mt-12 border-t border-line pt-4 text-[13px] text-ink-3">
        <Moon size={13} aria-hidden className="mr-1 inline" />
        Want to see Jagr work first? <Link to="/demo" className="font-medium text-ink-2 underline-offset-2 hover:text-ink hover:underline">Watch Demo night</Link> — a 30-second scripted replay, separate from any workspace.
      </p>
    </div>
  );
}

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
