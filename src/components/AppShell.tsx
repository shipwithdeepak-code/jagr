import {
  Activity,
  BookOpen,
  FlaskConical,
  LayoutDashboard,
  ListChecks,
  Menu,
  Moon,
  Play,
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
import { Logo, LogoMark } from './Logo';
import { RunPlayer } from './RunPlayer';
import { ShellContext } from './shell';
import { useToast } from './toast';
import { Button, cx, Modal } from './ui';

interface NavItem {
  to: string;
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

export function AppShell({ children }: { children: ReactNode }) {
  const { state, runOvernight, commitRun, reset } = useWorkspace();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, toggle } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [player, setPlayer] = useState<{ run: OvernightRun; mode: 'demo' | 'quick' } | null>(null);
  const [confirmDemo, setConfirmDemo] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => setMenuOpen(false), [location.pathname]);

  const pendingApprovals = state.approvals.filter((a) => a.status === 'pending' || a.status === 'more_evidence_requested').length;
  const openInvestigations = state.run?.investigations.filter((i) => i.status !== 'dismissed').length ?? 0;
  const openTasks = state.tasks.filter((t) => t.status !== 'done').length;

  const primary: NavItem[] = [
    { to: '/', label: 'Overview', icon: LayoutDashboard },
    { to: '/investigations', label: 'Investigations', icon: Telescope, count: openInvestigations || undefined },
    { to: '/tasks', label: 'Tasks', icon: ListChecks, count: openTasks || undefined },
    { to: '/signals', label: 'Signals', icon: Activity },
    { to: '/trace', label: 'Agent Trace', icon: ScrollText },
    { to: '/approvals', label: 'Approvals', icon: ShieldCheck, count: pendingApprovals || undefined, alert: pendingApprovals > 0 },
    { to: '/evaluations', label: 'Evaluations', icon: FlaskConical },
  ];
  const secondary: NavItem[] = [
    { to: '/integrations', label: 'Integrations', icon: Plug },
    { to: '/settings', label: 'Settings', icon: Settings },
    { to: '/about', label: 'About this build', icon: BookOpen },
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
    navigate('/');
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
    navigate('/');
    toast({ tone: b.counts.critical ? 'warning' : 'success', title: 'Morning brief ready', body: `${b.counts.critical} critical · ${b.counts.attention} need attention · ${b.counts.normal} normal` });
  };

  const sidebar = (
    <nav className="flex h-full flex-col gap-1 px-3 py-4" aria-label="Main">
      <div className="mb-4 flex items-center justify-between px-2">
        <Logo />
        <button className="rounded-md p-1 text-ink-3 hover:bg-subtle lg:hidden" onClick={() => setMenuOpen(false)} aria-label="Close menu">
          <X size={16} />
        </button>
      </div>
      <div className="mb-3 rounded-lg border border-line bg-surface px-2.5 py-2">
        <div className="text-[12.5px] font-medium text-ink">Tempo · Product</div>
        <div className="text-[11.5px] text-ink-3">Demo environment · simulated data</div>
      </div>
      {primary.map((it) => (
        <NavRow key={it.to} item={it} />
      ))}
      <div className="my-3 h-px bg-line" />
      {secondary.map((it) => (
        <NavRow key={it.to} item={it} />
      ))}
      <div className="mt-auto flex flex-col gap-2 pt-4">
        <button onClick={toggle} className="flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] text-ink-2 hover:bg-subtle hover:text-ink" aria-label="Toggle theme">
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          {theme === 'dark' ? 'Light theme' : 'Dark theme'}
        </button>
        <button
          onClick={requestDemo}
          className="group flex items-center gap-2.5 rounded-xl border border-line bg-surface p-2.5 text-left shadow-card transition-colors hover:border-line-strong"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-ink text-canvas">
            <Radar size={15} />
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold text-ink">Demo Mode</span>
            <span className="block truncate text-[11.5px] text-ink-3">Reset &amp; replay the night · ~30s</span>
          </span>
        </button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-dvh bg-canvas">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-line bg-canvas lg:block">{sidebar}</aside>
      {menuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/30" onClick={() => setMenuOpen(false)} />
          <aside className="animate-fade-up absolute inset-y-0 left-0 w-72 border-r border-line bg-canvas">{sidebar}</aside>
        </div>
      )}

      <div className="lg:pl-60">
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
          <div className="hidden min-w-0 items-center gap-2 text-[12.5px] text-ink-3 sm:flex lg:flex">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-line-strong px-2 py-0.5">
              <span className="size-1.5 rounded-full bg-ok" />
              Demo environment
            </span>
            <span className="hidden truncate xl:inline">
              {state.run ? `Last run ${state.run.id} · watch ${state.settings.schedule.start} → ${state.settings.schedule.end}` : `Next watch ${state.settings.schedule.start} → ${state.settings.schedule.end}`}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden sm:block">
              <Button variant="secondary" size="sm" icon={Radar} onClick={requestDemo}>
                Demo Mode
              </Button>
            </span>
            <Button variant="primary" icon={Play} onClick={startRun} disabled={running}>
              {running ? 'Starting…' : 'Run Overnight'}
            </Button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1180px] px-4 py-6 sm:px-6 sm:py-8">
          <ShellContext.Provider value={{ startRun: () => void startRun(), requestDemo, running }}>{children}</ShellContext.Provider>
        </main>
      </div>

      {player && <RunPlayer run={player.run} mode={player.mode} onDone={finishPlayer} onClose={finishPlayer} />}

      <Modal
        open={confirmDemo}
        onClose={() => setConfirmDemo(false)}
        title="Reset the workspace for Demo Mode?"
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
        Demo Mode restores default settings, clears tonight’s run, tasks you created and approval decisions, then replays the night from 6:00 PM. This only affects the simulated demo environment.
      </Modal>
    </div>
  );
}

function NavRow({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      className={({ isActive }) =>
        cx(
          'flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors',
          isActive ? 'bg-surface font-medium text-ink shadow-card ring-1 ring-line' : 'text-ink-2 hover:bg-subtle hover:text-ink',
        )
      }
    >
      <Icon size={15} className="shrink-0" />
      <span className="truncate">{item.label}</span>
      {item.count !== undefined && (
        <span className={cx('tabular ml-auto rounded-md px-1.5 text-[11px] font-medium', item.alert ? 'bg-high-soft text-high' : 'text-ink-3')}>{item.count}</span>
      )}
    </NavLink>
  );
}
