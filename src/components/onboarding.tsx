import { Check, Download, FlaskConical, Plus, RefreshCw } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useProduct } from '@/state/productContext';
import { acceptedCount } from '@/product/imports/schemas';
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
