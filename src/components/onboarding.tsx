import { ArrowRight, Check, Database, Download, FlaskConical, Moon, Plus, RefreshCw, Upload } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useProduct } from '@/state/productContext';
import { acceptedCount } from '@/product/imports/schemas';
import { Badge, Button, Card, cx } from './ui';

export const PRIVACY_NOTICE =
  'Your imported data is used to run investigations in this workspace and is stored in this browser. If AI planning is enabled, investigation context (including summaries of your evidence) may be sent to the configured model provider.';

export const SAMPLE_FILES = [
  { href: '/samples/metrics.csv', label: 'metrics.csv' },
  { href: '/samples/issues.csv', label: 'issues.csv' },
  { href: '/samples/releases.csv', label: 'releases.csv' },
  { href: '/samples/reviews.csv', label: 'reviews.csv' },
];

const LOOP = ['Watch', 'Detect', 'Investigate', 'Correlate', 'Assess', 'Notify', 'Approve', 'Act'];

/** First run: what Jagr is (30 seconds), and three ways in. */
export function Welcome() {
  const { createWorkspace } = useProduct();
  const navigate = useNavigate();
  return (
    <div className="animate-fade-up mx-auto max-w-3xl py-4">
      <Badge tone="accent">An autonomous product investigator for PMs</Badge>
      <h1 className="mt-4 text-[32px] leading-[1.1] font-semibold tracking-[-0.025em] sm:text-[40px]">Your product keeps moving after you leave. Jagr investigates what changed.</h1>
      <p className="mt-4 max-w-2xl text-[15.5px] text-ink-2">
        Product signals live across analytics, tickets, releases and customer feedback. Jagr is not another dashboard: it notices a meaningful change, gathers evidence across them, tests competing explanations, separates what it observed from what it inferred and what it doesn’t know — and only interrupts you when it matters. Anything consequential waits for your approval.
      </p>
      <ol className="mt-5 flex flex-wrap items-center gap-1.5 text-[12px] font-medium text-ink-2">
        {LOOP.map((s, i) => (
          <li key={s} className="flex items-center gap-1.5">
            {i > 0 && <ArrowRight size={11} className="text-ink-3" />}
            <span className="rounded-md bg-subtle px-2 py-0.5 ring-1 ring-inset ring-line">{s}</span>
          </li>
        ))}
      </ol>

      <div className="mt-8 grid gap-3 md:grid-cols-3">
        <Card className="ring-2 ring-accent/40 md:col-span-1">
          <Upload size={18} className="text-accent" />
          <div className="mt-2 text-[15px] font-semibold">Use my own data</div>
          <p className="mt-1 text-[12.5px] text-ink-2">Upload CSV or JSON — metrics, issues, releases, customer feedback — and let Jagr investigate it.</p>
          <Button
            variant="primary"
            className="mt-3 w-full"
            onClick={() => {
              createWorkspace('imported');
              navigate('/sources?upload=1');
            }}
          >
            Start with my data
          </Button>
        </Card>
        <Card>
          <Database size={18} className="text-ink-2" />
          <div className="mt-2 text-[15px] font-semibold">Explore a sample workspace</div>
          <p className="mt-1 text-[12.5px] text-ink-2">A simulated night where checkout conversion drops 18% after a release. Clearly labelled simulated.</p>
          <Button className="mt-3 w-full" onClick={() => createWorkspace('sample')}>
            Open sample workspace
          </Button>
        </Card>
        <Card>
          <Moon size={18} className="text-ink-2" />
          <div className="mt-2 text-[15px] font-semibold">Watch Demo night</div>
          <p className="mt-1 text-[12.5px] text-ink-2">A 30-second scripted replay of the original agent. Separate from your workspace.</p>
          <Link to="/demo" className="mt-3 inline-flex h-8.5 w-full items-center justify-center rounded-lg border border-line bg-surface text-[13px] font-medium shadow-card hover:bg-subtle">
            Open Demo night
          </Link>
        </Card>
      </div>
      <p className="mt-6 text-[12px] text-ink-3">
        This workspace lives in this browser only (no account). {PRIVACY_NOTICE.replace('Your imported data is used to run investigations in this workspace and is stored in this browser. ', '')}
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
          <li key={s.title} className={cx('rounded-xl border p-3', i === current ? 'border-accent bg-accent-soft/40' : 'border-line')}>
            <div className="flex items-center gap-2 text-[12px] font-semibold">
              <span className={cx('grid size-5 place-items-center rounded-full text-[11px]', s.done ? 'bg-ok text-surface' : 'bg-subtle text-ink-2 ring-1 ring-inset ring-line')}>{s.done ? <Check size={11} /> : i + 1}</span>
              {s.title}
            </div>
            {i === 2 ? (
              <div className="mt-2 space-y-1.5 text-[12px]">
                <select
                  aria-label="Planner"
                  value={plannerChoice === 'llm' && llmOption.available ? 'llm' : 'deterministic'}
                  onChange={(e) => setPlannerChoice(e.target.value as 'deterministic' | 'llm')}
                  className="h-7 w-full rounded-md border border-line bg-surface px-1.5 text-[12px] outline-none"
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
                <Link to="/sources?upload=1" className="inline-flex h-7 items-center gap-1 rounded-md bg-ink px-2.5 text-[12px] font-medium text-canvas">
                  <Plus size={12} /> Add source
                </Link>
                <a href="/samples/metrics.csv" download className="inline-flex h-7 items-center gap-1 rounded-md border border-line px-2 text-[12px] text-ink-2 hover:bg-subtle">
                  <Download size={12} /> Sample files
                </a>
              </div>
            )}
            {i === current && i === 1 && (
              <Link to="/watches?new=1" className="mt-2 inline-flex h-7 items-center gap-1 rounded-md bg-ink px-2.5 text-[12px] font-medium text-canvas">
                <Plus size={12} /> Create watch
              </Link>
            )}
            {i === current && i === 3 && (
              <Button size="sm" variant="primary" icon={RefreshCw} className="mt-2" disabled={running || !steps[0].done || !steps[1].done} onClick={() => void runMonitoring()}>
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
  const { mode } = useProduct();
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
