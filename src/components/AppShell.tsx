import {
  Activity,
  ArrowLeft,
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
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { OvernightRun } from '@/domain/types';
import { useWorkspace } from '@/state/workspace';
import { pendingApprovals as pendingAgentApprovals } from '@/product/agent/decisions';
import { useProduct } from '@/state/productContext';
import { EnvironmentContext, environmentForPath, inEnvironment, taskEnvironment, type AppEnvironment } from '@/state/environment';
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

/** Where the open workspace lives and what data it reads — the answer to "what am I looking at?". */
function workspaceIdentity(product: ReturnType<typeof useProduct>): { name: string; detail: string } {
  if (product.location === 'server') {
    return { name: product.server?.name ?? 'Server workspace', detail: product.mode === 'connected' ? 'Server · live sources' : product.mode === 'imported' ? 'Server · imported data' : 'Server workspace' };
  }
  return { name: 'Local workspace', detail: product.mode === 'imported' ? 'This browser · your imported data' : product.mode === 'sample' ? 'This browser · sample data' : 'This browser · not set up' };
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
  // WORKSPACE vs DEMO NIGHT — derived from the URL alone (state/environment.ts). Nothing a page opened
  // earlier can switch the product into Demo night.
  const env: AppEnvironment = environmentForPath(location.pathname, location.search);
  // Badges count the current environment only — never a silent mix of Workspace and Demo night.
  const pendingApprovals =
    env === 'workspace'
      ? pendingAgentApprovals(product.state.result?.investigations ?? [], product.state.decisions).length
      : state.approvals.filter((a) => a.status === 'pending' || a.status === 'more_evidence_requested').length;
  const openTasks = state.tasks.filter((t) => t.status !== 'done' && taskEnvironment(t) === env).length;
  const watchFindings = product.state.result?.investigations.filter((i) => i.status !== 'DISMISSED' && i.attention !== 'LOW').length ?? 0;

  // OPERATE — the daily loop. REVIEW — what waits for a person. ADVANCED — inspect and evaluate.
  const primary: NavItem[] = [
    { to: '/', label: 'Overview', icon: LayoutDashboard },
    { to: '/watches', label: 'Watches', icon: Binoculars },
    { to: '/investigations', label: 'Investigations', icon: Telescope, count: watchFindings || undefined, alert: watchFindings > 0 },
    { to: '/briefs', label: 'Briefs', icon: Newspaper },
    { to: '/sources', label: 'Sources', icon: Plug },
    { to: '/settings', label: 'Settings', icon: Settings },
  ];
  const review: NavItem[] = [
    { to: inEnvironment('/approvals', env), label: 'Approvals', icon: ShieldCheck, count: pendingApprovals || undefined, alert: pendingApprovals > 0 },
    { to: inEnvironment('/tasks', env), label: 'Tasks', icon: ListChecks, count: openTasks || undefined },
  ];
  const advanced: NavItem[] = [
    { to: inEnvironment('/trace', env), label: 'Agent trace', icon: ScrollText },
    { to: '/evaluations', label: 'Evaluations', icon: FlaskConical },
    { to: '/about', label: 'About Jagr', icon: BookOpen },
  ];
  const demo: NavItem[] = [
    { to: '/demo', label: 'Replay', icon: Radar },
    { to: '/signals', label: 'Signals', icon: Activity },
    { to: '/integrations', label: 'Integrations', icon: Plug },
    { to: '/demo/settings', label: 'Demo settings', icon: Settings },
  ];
  const identity = workspaceIdentity(product);

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
        <button className="interactive rounded p-1 text-ink-3 hover:bg-subtle lg:hidden" onClick={() => setMenuOpen(false)} aria-label="Close menu">
          <X size={16} />
        </button>
      </div>
      {!compact && (
        <Link to="/settings#workspace" className="interactive mb-3 block rounded-lg border border-line px-2.5 py-2 hover:bg-subtle" title="Switch or manage workspaces">
          <span className="block truncate text-[13px] font-medium text-ink">{identity.name}</span>
          <span className="block truncate text-[12px] text-ink-3">{identity.detail}</span>
        </Link>
      )}
      {primary.map((it) => (
        <NavRow key={it.to} item={it} compact={compact} env={env} />
      ))}
      <NavGroup label="Review" compact={compact} />
      {review.map((it) => (
        <NavRow key={it.to} item={it} compact={compact} env={env} />
      ))}
      <NavGroup label="Advanced" compact={compact} />
      {advanced.map((it) => (
        <NavRow key={it.to} item={it} compact={compact} env={env} />
      ))}
      <div className={cx('mt-4 border-t border-line pt-3', compact && 'mx-1')}>
        <NavRow item={{ to: '/demo', label: 'Demo night', icon: Moon }} compact={compact} env={env} demoEntry />
        {env === 'demo' && !compact && (
          <div className="mt-0.5 ml-3 border-l border-line pl-2">
            {demo.map((it) => (
              <NavRow key={it.to} item={it} compact={false} env={env} />
            ))}
          </div>
        )}
      </div>
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
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-canvas px-4 sm:px-6">
          <button className="-ml-1 rounded p-1.5 text-ink-2 hover:bg-subtle lg:hidden" onClick={() => setMenuOpen(true)} aria-label="Open menu">
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
          {env === 'demo' ? (
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="inline-flex min-w-0 items-center gap-2 text-[13px] text-ink-2">
                <Moon size={14} aria-hidden className="shrink-0 text-ink-3" />
                <span className="truncate">
                  <span className="font-medium text-ink">Demo night</span>
                  <span className="max-md:hidden"> · a scripted replay, separate from your workspace</span>
                </span>
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <Link to="/" className="interactive inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[13px] text-ink-2 hover:bg-subtle hover:text-ink">
                  <ArrowLeft size={14} aria-hidden /> <span className="max-sm:sr-only">Back to workspace</span>
                </Link>
                <Button icon={Radar} onClick={requestDemo}>
                  <span className="max-sm:sr-only">Reset &amp; replay</span>
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="min-w-0 truncate text-[13px] text-ink-3 lg:hidden">{identity.name}</span>
              {/* Overview owns its own Run button; before a workspace exists there is nothing to run. */}
              {location.pathname !== '/' && product.mode && (
                <Button
                  className="ml-auto"
                  icon={RefreshCw}
                  aria-label="Run monitoring now"
                  disabled={product.running || !product.mode || (product.mode === 'imported' && !product.state.watches.length)}
                  title={product.mode === 'imported' && !product.state.watches.length ? 'Create a watch first' : 'Check every active watch now'}
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
                        : { tone: 'success', title: 'Monitoring complete', body: 'Watches ran 18:00 → 08:00 on the sample data. Brief composed at 08:00.' },
                    );
                  }}
                >
                  <span className="max-sm:sr-only">{product.running ? 'Running…' : 'Run now'}</span>
                </Button>
              )}
            </div>
          )}
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

function NavRow({ item, compact = false, env, demoEntry = false }: { item: NavItem; compact?: boolean; env: AppEnvironment; demoEntry?: boolean }) {
  const Icon = item.icon;
  const location = useLocation();
  const [path, query = ''] = item.to.split('?');
  // Active = same page AND same environment: Approvals in the Workspace is not Approvals in Demo night.
  const samePage = path === '/' ? location.pathname === '/' : location.pathname === path || location.pathname.startsWith(`${path}/`);
  // The Demo night entry is marked active only when collapsed; expanded, its own sub-items are.
  const active = demoEntry ? env === 'demo' && compact : samePage && environmentForPath(path, query) === env;
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      title={compact ? item.label : undefined}
      aria-label={compact ? (item.count !== undefined ? `${item.label} (${item.count})` : item.label) : undefined}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'interactive relative flex h-8 items-center gap-2.5 rounded-lg text-[13px] transition-colors',
        compact ? 'justify-center' : 'px-2.5',
        active ? 'bg-subtle font-medium text-ink' : 'text-ink-2 hover:bg-subtle hover:text-ink',
      )}
    >
      {active && !compact && <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-ink" />}
      <Icon size={15} className="shrink-0" aria-hidden />
      {!compact && <span className="truncate">{item.label}</span>}
      {compact && item.count !== undefined && <span aria-hidden className={cx('absolute top-1 right-1.5 size-1.5 rounded-full', item.alert ? 'bg-high' : 'bg-ink-3')} />}
      {!compact && item.count !== undefined && (
        <span className={cx('tabular ml-auto rounded px-1.5 text-[12px] font-medium', item.alert ? 'bg-high-soft text-high' : 'text-ink-3')}>{item.count}</span>
      )}
    </NavLink>
  );
}

function NavGroup({ label, compact = false }: { label: string; compact?: boolean }) {
  if (compact) return <div className="mx-2 mt-3 mb-2 border-t border-line" role="separator" aria-label={label} />;
  return <div className="mt-4 mb-1 px-2.5 text-[12px] font-medium text-ink-3">{label}</div>;
}
