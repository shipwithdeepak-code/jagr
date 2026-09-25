import {
  Activity,
  BookOpen,
  FlaskConical,
  Binoculars,
  LayoutDashboard,
  ListChecks,
  Newspaper,
  RefreshCw,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Moon,
  Plug,
  Radar,
  ScrollText,
  Settings,
  ShieldCheck,
  Sun,
  Telescope,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { OvernightRun } from '@/domain/types';
import { useWorkspace } from '@/state/workspace';
import { pendingApprovals as pendingAgentApprovals } from '@/product/agent/decisions';
import { useProduct } from '@/state/productContext';
import { ENVIRONMENT, EnvironmentContext, environmentForPath, taskEnvironment, initialEnvironment, readStoredEnvironment, storeEnvironment, type AppEnvironment } from '@/state/environment';
import { Logo, LogoMark } from './Logo';
import { RunProgressPanel } from './runProgress';
import { RunPlayer } from './RunPlayer';
import { ShellContext } from './shell';
import { useToast } from './toast';
import { Button, cx, Modal } from './ui';

interface NavItem {
  to: string;
  group?: string;
  label: string;
  icon: LucideIcon;
  count?: number;
  alert?: boolean;
}

function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const explicit = document.documentElement.dataset.theme;
    if (explicit === 'light' || explicit === 'dark') return explicit;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('nightwatch:theme', next);
    } catch {
      /* ignore */
    }
    setTheme(next);
  };
  return { theme, toggle };
}

/**
 * Which planner investigates the simulated data. Small and unobtrusive: the simulation controls the
 * data, this controls the planner. Deterministic is the default; the LLM option names the real
 * provider/model from the server (never a key) or explains why it is unavailable.
 */
/** WORKSPACE | DEMO NIGHT — the only environment choice in the app. */
function EnvironmentSwitch({ value, onChange }: { value: AppEnvironment; onChange: (v: AppEnvironment) => void }) {
  return (
    <div role="radiogroup" aria-label="Environment" className="inline-flex rounded-lg border border-line bg-subtle p-0.5">
      {(['workspace', 'demo'] as const).map((e) => (
        <button
          key={e}
          role="radio"
          aria-checked={value === e}
          aria-label={ENVIRONMENT[e].label}
          onClick={() => onChange(e)}
          title={ENVIRONMENT[e].description}
          className={cx('h-6 rounded-md px-2 text-[12px] font-medium whitespace-nowrap', value === e ? 'bg-surface text-ink shadow-card' : 'text-ink-3 hover:text-ink')}
        >
          {ENVIRONMENT[e].label}
        </button>
      ))}
    </div>
  );
}

function PlannerSwitch() {
  const { plannerChoice, llmOption, setPlannerChoice, running } = useProduct();
  const value = plannerChoice === 'llm' && llmOption.available ? 'llm' : 'deterministic';
  return (
    <label className="hidden items-center gap-1.5 text-[12px] text-ink-3 md:flex" title={llmOption.available ? 'Choose which planner investigates this workspace’s data. The policy validator, tools and approvals are the same either way.' : llmOption.reason}>
      Planner
      <select
        aria-label="Planner"
        value={value}
        disabled={running}
        onChange={(e) => setPlannerChoice(e.target.value as 'deterministic' | 'llm')}
        className="h-7 max-w-[210px] rounded-md border border-line bg-surface px-1.5 text-[12px] text-ink outline-none focus:border-accent"
      >
        <option value="deterministic">Deterministic</option>
        <option value="llm" disabled={!llmOption.available}>
          {llmOption.available ? llmOption.label : `Configured LLM — ${llmOption.reason ?? 'No LLM provider configured.'}`}
        </option>
      </select>
    </label>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { state, runOvernight, commitRun, reset } = useWorkspace();
  const product = useProduct();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, toggle } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  // Desktop sidebar can collapse to icons; a per-browser preference, like the theme.
  const [collapsed, setCollapsedState] = useState(() => {
    try {
      return localStorage.getItem('jagr:sidebar') === 'collapsed';
    } catch {
      return false;
    }
  });
  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    try {
      localStorage.setItem('jagr:sidebar', v ? 'collapsed' : 'expanded');
    } catch {
      /* preference only */
    }
  };
  const [player, setPlayer] = useState<{ run: OvernightRun; mode: 'demo' | 'quick' } | null>(null);
  const [confirmDemo, setConfirmDemo] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => setMenuOpen(false), [location.pathname]);
  // WORKSPACE vs DEMO NIGHT — derived from where the user is; shared pages keep the previous one.
  const [env, setEnv] = useState<AppEnvironment>(() => initialEnvironment(location.pathname, readStoredEnvironment()));
  useEffect(() => setEnv((prev) => environmentForPath(location.pathname, prev)), [location.pathname]);
  useEffect(() => storeEnvironment(env), [env]);
  // Badges count the current environment only — never a silent mix of Workspace and Demo night.
  const pendingApprovals =
    env === 'workspace'
      ? pendingAgentApprovals(product.state.result?.investigations ?? [], product.state.decisions).length
      : state.approvals.filter((a) => a.status === 'pending' || a.status === 'more_evidence_requested').length;
  const openTasks = state.tasks.filter((t) => t.status !== 'done' && taskEnvironment(t) === env).length;
  const switchEnv = (next: AppEnvironment) => {
    setEnv(next);
    navigate(ENVIRONMENT[next].home);
  };

  const watchFindings = product.state.result?.investigations.filter((i) => i.status !== 'DISMISSED' && i.attention !== 'LOW').length ?? 0;

  const primary: NavItem[] = [
    { to: '/', label: 'Overview', icon: LayoutDashboard },
    { to: '/investigations', label: 'Investigations', icon: Telescope, count: watchFindings || undefined, alert: watchFindings > 0 },
    { to: '/watches', label: 'Watches', icon: Binoculars, count: product.state.watches.filter((w) => w.status === 'active').length || undefined },
    { to: '/sources', label: 'Sources', icon: Plug },
  ];
  const workspaceNav: NavItem[] = [
    { to: '/briefs', label: 'Briefs', icon: Newspaper },
    { to: '/tasks', label: 'Tasks', icon: ListChecks, count: openTasks || undefined },
    { to: '/approvals', label: 'Approvals', icon: ShieldCheck, count: pendingApprovals || undefined, alert: pendingApprovals > 0 },
  ];
  const system: NavItem[] = [
    { to: '/trace', label: 'Agent Trace', icon: ScrollText },
    { to: '/evaluations', label: 'Evaluations', icon: FlaskConical },
    { to: '/settings', label: 'Settings', icon: Settings },
    { to: '/about', label: 'About this build', icon: BookOpen },
  ];
  const demo: NavItem[] = [
    { to: '/demo', label: 'Demo night', icon: Moon },
    { to: '/signals', label: 'Signals', icon: Activity },
  ];

  const startRun = useCallback(async () => {
    setRunning(true);
    try {
      const run = await runOvernight();
      setPlayer({ run, mode: 'quick' });
    } finally {
      setRunning(false);
    }
  }, [runOvernight]);

  const startDemo = useCallback(async () => {
    setConfirmDemo(false);
    reset();
    const run = await runOvernight(true);
    navigate('/demo');
    setPlayer({ run, mode: 'demo' });
  }, [reset, runOvernight, navigate]);

  const requestDemo = () => {
    if (state.humanEvents.length > 0 || state.runCount > 0) setConfirmDemo(true);
    else void startDemo();
  };

  const finishPlayer = () => {
    if (!player) return;
    commitRun(player.run);
    const b = player.run.brief;
    setPlayer(null);
    navigate('/demo');
    toast({ tone: b.counts.critical ? 'warning' : 'success', title: 'Morning brief ready', body: `${b.counts.critical} critical · ${b.counts.attention} need attention · ${b.counts.normal} normal` });
  };

  const renderSidebar = (compact: boolean) => (
    <nav className={cx('flex h-full flex-col gap-0.5 overflow-y-auto py-4', compact ? 'px-2' : 'px-3')} aria-label="Main">
      <div className={cx('mb-4 flex items-center', compact ? 'justify-center' : 'justify-between px-2')}>
        {compact ? <LogoMark /> : <Logo />}
        <button className="interactive rounded-md p-1 text-ink-3 hover:bg-subtle lg:hidden" onClick={() => setMenuOpen(false)} aria-label="Close menu">
          <X size={16} />
        </button>
      </div>
      {!compact && (
        <div className="mb-3 px-2.5 text-[11.5px] leading-snug text-ink-3">
          <span className="font-medium text-ink-2">Tempo · Product</span>
          <br />
          {env === 'demo' ? 'Demo night · simulated replay' : product.location === 'server' ? `${product.server?.name ?? 'Server workspace'} · ${product.mode === 'connected' ? 'live sources' : product.mode === 'imported' ? 'imported data' : 'sample'}` : product.mode === 'imported' ? 'Your data · browser-local' : product.mode === 'sample' ? 'Sample data · simulated' : 'Not set up yet'}
        </div>
      )}
      {primary.map((it) => (
        <NavRow key={it.to} item={it} compact={compact} />
      ))}
      <NavGroup label="Workspace" compact={compact} />
      {workspaceNav.map((it) => (
        <NavRow key={it.to} item={it} compact={compact} />
      ))}
      <NavGroup label="System" compact={compact} />
      {system.map((it) => (
        <NavRow key={it.to} item={it} compact={compact} />
      ))}
      <NavGroup label="Demo night" compact={compact} />
      {demo.map((it) => (
        <NavRow key={it.to} item={it} compact={compact} />
      ))}
      <div className="mt-auto flex flex-col gap-0.5 pt-4">
        <button onClick={toggle} title={compact ? (theme === 'dark' ? 'Light theme' : 'Dark theme') : undefined} className={cx('interactive flex h-8 items-center gap-2.5 rounded-lg text-[13px] text-ink-2 hover:bg-subtle hover:text-ink', compact ? 'justify-center' : 'px-2.5')} aria-label="Toggle theme">
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          {!compact && (theme === 'dark' ? 'Light theme' : 'Dark theme')}
        </button>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={cx('interactive hidden h-8 items-center gap-2.5 rounded-lg text-[13px] text-ink-2 hover:bg-subtle hover:text-ink lg:flex', compact ? 'justify-center' : 'px-2.5')}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand sidebar' : undefined}
        >
          {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          {!compact && 'Collapse'}
        </button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-dvh bg-canvas">
      <aside className={cx('fixed inset-y-0 left-0 z-30 hidden border-r border-line bg-canvas transition-[width] duration-200 ease-out motion-reduce:transition-none lg:block', collapsed ? 'w-16' : 'w-60')}>{renderSidebar(collapsed)}</aside>
      {menuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/30" onClick={() => setMenuOpen(false)} />
          <aside className="animate-slide-in absolute inset-y-0 left-0 w-72 border-r border-line bg-canvas">{renderSidebar(false)}</aside>
        </div>
      )}

      <div className={cx('transition-[padding] duration-200 ease-out motion-reduce:transition-none', collapsed ? 'lg:pl-16' : 'lg:pl-60')}>
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-canvas/85 px-4 backdrop-blur sm:px-6">
          <button className="-ml-1 rounded-md p-1.5 text-ink-2 hover:bg-subtle lg:hidden" onClick={() => setMenuOpen(true)} aria-label="Open menu">
            <Menu size={18} />
          </button>
          <div className="lg:hidden">
            <span className="max-[400px]:hidden">
              <Logo />
            </span>
            <span className="hidden max-[400px]:block">
              <LogoMark />
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-ink-3">
            <EnvironmentSwitch value={env} onChange={switchEnv} />
            <span
              className={cx('hidden items-center gap-1.5 rounded-md border border-dashed px-2 py-0.5 sm:inline-flex', env === 'demo' ? 'border-high/50 text-high' : 'border-line-strong')}
              title={ENVIRONMENT[env].description}
            >
              <span className={cx('size-1.5 rounded-full', env === 'demo' ? 'bg-high' : 'bg-info')} />
              {env === 'workspace' && product.location === 'server' ? (product.mode === 'connected' ? 'Live sources · server' : 'Server workspace') : env === 'workspace' && !product.mode ? 'Not set up yet' : env === 'workspace' && product.mode === 'imported' ? 'Your data · browser-local' : ENVIRONMENT[env].badge}
            </span>
            {env === 'workspace' && product.mode && (
              <span className="hidden truncate xl:inline">
                {(() => {
                  const n = product.state.watches.filter((w) => w.status === 'active').length;
                  return `${n} ${n === 1 ? 'watch' : 'watches'}`;
                })()}
              </span>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {env === 'workspace' ? (
              <>
                <PlannerSwitch />
                {/* Overview owns its own Run button; before a workspace exists there is nothing to run. */}
                {location.pathname !== '/' && product.mode && (
                <Button
                  variant="primary"
                  icon={RefreshCw}
                  aria-label="Run monitoring"
                  disabled={product.running || !product.mode || (product.mode === 'imported' && !product.state.watches.length)}
                  title={product.mode === 'imported' && !product.state.watches.length ? 'Create a watch first' : undefined}
                  onClick={async () => {
                    let r;
                    try {
                      r = await product.runMonitoring();
                    } catch (e) {
                      toast({ tone: 'warning', title: 'The run did not complete', body: (e as Error).message });
                      return;
                    }
                    navigate('/');
                    toast(
                      product.location === 'server'
                        ? { tone: 'success', title: 'Monitoring complete', body: product.mode === 'connected' ? 'Active watches ran against your live sources on the server.' : 'Watches ran on the server over this workspace’s data.' }
                        : product.mode === 'imported'
                        ? r
                          ? { tone: 'success', title: 'Monitoring complete', body: `Watches ran over your imported data (${r.investigations.length} investigation${r.investigations.length === 1 ? '' : 's'}).` }
                          : { tone: 'warning', title: 'Nothing to investigate yet', body: 'Import metrics, issues or feedback first.' }
                        : { tone: 'success', title: 'Monitoring complete', body: 'Watches ran 18:00 → 08:00 on simulated sources. Brief generated at 08:00.' },
                    );
                  }}
                >
                  <span className="max-sm:sr-only">{product.running ? 'Running…' : 'Run monitoring'}</span>
                </Button>
                )}
              </>
            ) : (
              <>
                <span className="hidden text-[12px] text-ink-3 lg:inline">Scripted replay — the planner switch applies to the workspace</span>
                <Button variant="primary" icon={Radar} onClick={requestDemo}>
                  Reset &amp; replay
                </Button>
              </>
            )}
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1180px] px-4 py-6 sm:px-6 sm:py-8">
          {env === 'workspace' && product.server?.error && (
            <p role="alert" className="mb-4 rounded-lg border border-crit/40 bg-crit-soft px-3 py-2 text-[13px] text-crit">
              The Jagr server reported a problem: {product.server.error}
            </p>
          )}
          {env === 'workspace' && product.progress && (
            <div className="mb-6">
              <RunProgressPanel progress={product.progress} planner={product.plannerChoice === 'llm' && product.llmOption.available ? `AI planner · ${product.llmOption.label}` : 'Deterministic planner'} />
            </div>
          )}
          <ShellContext.Provider value={{ startRun: () => void startRun(), requestDemo, running }}>
            <EnvironmentContext.Provider value={{ environment: env }}>{children}</EnvironmentContext.Provider>
          </ShellContext.Provider>
        </main>
      </div>

      {player && <RunPlayer run={player.run} mode={player.mode} onDone={finishPlayer} onClose={finishPlayer} />}

      <Modal
        open={confirmDemo}
        onClose={() => setConfirmDemo(false)}
        title="Reset and replay Demo night?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDemo(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void startDemo()}>
              Reset and replay
            </Button>
          </>
        }
      >
        This clears Demo night’s scripted run, its tasks, approval decisions and settings, then replays the night from 6:00 PM. Your workspace — watches, monitoring runs, investigations, their decisions, tasks filed from them and the planner selection — is not affected.
      </Modal>
    </div>
  );
}

function NavRow({ item, compact = false }: { item: NavItem; compact?: boolean }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      title={compact ? item.label : undefined}
      aria-label={compact ? (item.count !== undefined ? `${item.label} (${item.count})` : item.label) : undefined}
      className={({ isActive }) =>
        cx(
          'interactive relative flex h-8 items-center gap-2.5 rounded-lg text-[13px] transition-colors',
          compact ? 'justify-center' : 'px-2.5',
          isActive ? 'bg-surface font-medium text-ink shadow-card ring-1 ring-line' : 'text-ink-2 hover:bg-subtle hover:text-ink',
        )
      }
    >
      <Icon size={15} className="shrink-0" />
      {!compact && <span className="truncate">{item.label}</span>}
      {compact && item.count !== undefined && <span aria-hidden className={cx('absolute top-1 right-1.5 size-1.5 rounded-full', item.alert ? 'bg-high' : 'bg-ink-3')} />}
      {!compact && item.count !== undefined && (
        <span className={cx('tabular ml-auto rounded-md px-1.5 text-[11px] font-medium', item.alert ? 'bg-high-soft text-high' : 'text-ink-3')}>{item.count}</span>
      )}
    </NavLink>
  );
}

function NavGroup({ label, compact = false }: { label: string; compact?: boolean }) {
  if (compact) return <div className="mx-2 mt-3 mb-2 border-t border-line" role="separator" aria-label={label} />;
  return <div className="mt-4 mb-1 px-2.5 text-[10.5px] font-semibold tracking-[0.08em] text-ink-3 uppercase">{label}</div>;
}
