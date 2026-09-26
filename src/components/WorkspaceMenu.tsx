import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Check, ChevronsUpDown, LogOut, Monitor, Moon, Plus, Sun, UserRound } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useProduct } from '@/state/productContext';
import { markSigningIn, useServerSession } from '@/state/serverSession';
import { serverApi } from '@/state/serverApi';
import { useExploreLocally } from '@/state/exploreLocally';
import type { AppEnvironment } from '@/state/environment';
import { useSignOut } from './signOut';
import { CreateForm } from './WorkspaceGate';
import { Modal, cx } from './ui';

/**
 * The sidebar's two context controls, kept apart on purpose:
 *   WorkspaceSwitcher (top)   which workspace everything below is about — open another server
 *                             workspace, this browser's workspace, or create one. Never signs out.
 *   AccountMenu (bottom)      who is signed in, the theme, and Sign out (the shared useSignOut).
 * Both are simple disclosures (a button with aria-expanded / aria-controls and a panel of ordinary
 * buttons and links), not ARIA menus: Escape closes and returns focus to the button, as does clicking
 * or tabbing outside. Expanded, the panel opens in place; in the collapsed sidebar it flies out to the
 * right (fixed, so the scrolling sidebar cannot clip it).
 */

// ─────────────────────────────────────────────────────────────
// Disclosure
// ─────────────────────────────────────────────────────────────

function useDisclosure(compact: boolean, placement: 'down' | 'up') {
  const [open, setOpen] = useState(false);
  const [flyout, setFlyout] = useState<CSSProperties>();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  }, []);
  useEffect(() => close(), [pathname, close]);
  const toggle = () => {
    if (!open && compact && button.current) {
      const r = button.current.getBoundingClientRect();
      // Beside the sidebar, not beside the (centred) button: clear of the sidebar's right edge.
      const edge = (button.current.closest('aside') ?? button.current).getBoundingClientRect().right;
      setFlyout(placement === 'down' ? { left: edge + 8, top: r.top } : { left: edge + 8, bottom: window.innerHeight - r.bottom });
    }
    setOpen((o) => !o);
  };
  useEffect(() => {
    if (!open) return;
    const outside = (t: EventTarget | null) => !(t instanceof Node && (button.current?.contains(t) || panel.current?.contains(t)));
    // Capture phase on window, so Escape closes this panel before an enclosing dialog (the mobile menu) sees it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close(true);
    };
    const onPointer = (e: PointerEvent) => outside(e.target) && close();
    const onFocus = (e: FocusEvent) => outside(e.target) && close();
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('focusin', onFocus);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('focusin', onFocus);
    };
  }, [open, close]);
  return { open, toggle, close, button, panel, style: compact ? flyout : undefined };
}

function Panel({ id, label, compact, style, panelRef, children }: { id: string; label: string; compact: boolean; style?: CSSProperties; panelRef: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  return (
    <div ref={panelRef} id={id} role="group" aria-label={label} style={style} className={cx('rounded-lg border border-line bg-surface p-1 text-[13px]', compact ? 'fixed z-50 w-72 shadow-pop' : 'mt-1')}>
      {children}
    </div>
  );
}

const item = 'interactive flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-subtle';

// ─────────────────────────────────────────────────────────────
// Workspace identity and switcher
// ─────────────────────────────────────────────────────────────

/** Where the open workspace lives and what data it reads — the answer to "what am I looking at?". */
export function workspaceIdentity(product: ReturnType<typeof useProduct>, env: AppEnvironment): { name: string; detail: string } {
  if (env === 'demo') return { name: 'Demo night', detail: 'Scripted replay' };
  if (product.location === 'server') {
    return { name: product.server?.name ?? 'Server workspace', detail: !product.mode ? 'Opening…' : product.mode === 'connected' ? 'Server · live sources' : product.mode === 'imported' ? 'Server · imported data' : 'Server workspace' };
  }
  return { name: 'Local workspace', detail: product.mode === 'imported' ? 'This browser · your imported data' : product.mode === 'sample' ? 'This browser · sample data' : 'This browser · not set up' };
}

const monogram = (name: string) => name.trim().charAt(0).toUpperCase() || '·';
const modeLabel = (m: string) => (m === 'connected' ? 'Live sources' : m === 'imported' ? 'Imported data' : 'Sample data');

export function WorkspaceSwitcher({ compact, env }: { compact: boolean; env: AppEnvironment }) {
  const product = useProduct();
  const session = useServerSession();
  const explore = useExploreLocally();
  const { pathname, search, hash } = useLocation();
  const d = useDisclosure(compact, 'down');
  const panelId = useId();
  const [creating, setCreating] = useState(false);
  const identity = workspaceIdentity(product, env);

  // Demo night is its own environment, not a workspace: say so, and offer nothing to switch here.
  if (env === 'demo') {
    return compact ? (
      <div className="mb-3 grid size-9 place-items-center self-center rounded-lg border border-line text-ink-3">
        <Moon size={15} aria-hidden />
        <span className="sr-only">Demo night · scripted replay</span>
      </div>
    ) : (
      <div className="mb-3 rounded-lg border border-line px-2.5 py-2">
        <span className="flex items-center gap-1.5 truncate text-[13px] font-medium text-ink">
          <Moon size={13} aria-hidden className="shrink-0 text-ink-3" /> Demo night
        </span>
        <span className="block truncate text-[12px] text-ink-3">Scripted replay · separate from workspaces</span>
      </div>
    );
  }

  const inLocal = product.location === 'browser' && !!product.mode;
  const google = session.server?.signIn.includes('google');
  const label = `Workspace: ${identity.name}, ${identity.detail}. Switch workspace`;
  return (
    <div className={cx('mb-3', compact && 'self-center')}>
      <button
        ref={d.button}
        type="button"
        aria-expanded={d.open}
        aria-controls={panelId}
        aria-label={label}
        onClick={d.toggle}
        className={cx(
          'interactive rounded-lg border border-line hover:bg-subtle',
          compact ? 'grid size-9 place-items-center text-[13px] font-semibold text-ink' : 'flex w-full items-center gap-2 px-2.5 py-2 text-left',
          d.open && 'bg-subtle',
        )}
      >
        {compact ? (
          <span aria-hidden>{monogram(identity.name)}</span>
        ) : (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-ink">{identity.name}</span>
              <span className="block truncate text-[12px] text-ink-3">{identity.detail}</span>
            </span>
            <ChevronsUpDown size={14} aria-hidden className="shrink-0 text-ink-3" />
          </>
        )}
      </button>
      {d.open && (
        <Panel id={panelId} label="Workspaces" compact={compact} style={d.style} panelRef={d.panel}>
          <p className="px-2 pt-1.5 pb-1 text-[12px] font-medium text-ink-3">Workspaces</p>
          <ul>
            {session.user &&
              session.workspaces.map((w) => {
                const current = w.id === session.activeId;
                return (
                  <li key={w.id}>
                    <button
                      type="button"
                      className={item}
                      aria-current={current ? 'true' : undefined}
                      onClick={() => {
                        if (!current) session.open(w.id);
                        d.close(true);
                      }}
                    >
                      <Check size={14} aria-hidden className={cx('shrink-0', current ? 'text-ink' : 'invisible')} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-ink">{w.name}</span>
                        <span className="block truncate text-[12px] text-ink-3">
                          {modeLabel(w.mode)} · {w.role}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            <li>
              <button
                type="button"
                className={item}
                aria-current={inLocal ? 'true' : undefined}
                onClick={() => {
                  // An existing browser workspace is reopened as it is; none yet → the sample is created.
                  if (!inLocal) explore();
                  d.close(true);
                }}
              >
                {inLocal ? <Check size={14} aria-hidden className="shrink-0 text-ink" /> : <Monitor size={14} aria-hidden className="shrink-0 text-ink-3" />}
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink">{product.localMode ? 'Browser workspace' : 'Explore locally'}</span>
                  <span className="block truncate text-[12px] text-ink-3">{product.localMode ? `This browser only · ${modeLabel(product.localMode).toLowerCase()}` : 'Sample data in this browser'}</span>
                </span>
              </button>
            </li>
          </ul>
          <div className="my-1 border-t border-line" />
          {session.user ? (
            <button type="button" className={item} onClick={() => setCreating(true)}>
              <Plus size={14} aria-hidden className="shrink-0 text-ink-3" /> Create workspace
            </button>
          ) : google ? (
            <a href={serverApi.signInUrl('google', `${pathname}${search}${hash}`)} onClick={markSigningIn} className={item}>
              <UserRound size={14} aria-hidden className="shrink-0 text-ink-3" /> Sign in to use server workspaces
            </a>
          ) : (
            <p className="px-2 py-1.5 text-[12px] text-ink-3">Server workspaces need a Jagr server; this copy runs in the browser only.</p>
          )}
        </Panel>
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title="Create workspace">
        <p className="mb-4">A server workspace keeps watching your sources on a schedule — without this browser open.</p>
        <CreateForm onCreated={() => setCreating(false)} />
      </Modal>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Account
// ─────────────────────────────────────────────────────────────

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '·';

export function AccountMenu({ compact, theme, setTheme }: { compact: boolean; theme: 'light' | 'dark'; setTheme: (t: 'light' | 'dark') => void }) {
  const session = useServerSession();
  const signOut = useSignOut();
  const { pathname, search, hash } = useLocation();
  const d = useDisclosure(compact, 'up');
  const panelId = useId();
  const name = session.user?.displayName;
  const google = session.server?.signIn.includes('google');
  const label = name ? `Account: ${name}` : 'Account: not signed in';
  return (
    <div className={cx(compact && 'self-center')}>
      <button
        ref={d.button}
        type="button"
        aria-expanded={d.open}
        aria-controls={panelId}
        aria-label={label}
        onClick={d.toggle}
        className={cx('interactive flex h-9 items-center gap-2.5 rounded-lg text-[13px] text-ink-2 hover:bg-subtle hover:text-ink', compact ? 'w-9 justify-center' : 'w-full px-1.5', d.open && 'bg-subtle text-ink')}
      >
        <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-subtle text-[11px] font-semibold text-ink ring-1 ring-line">
          {name ? initials(name) : <UserRound size={13} />}
        </span>
        {!compact && (
          <>
            <span className="min-w-0 flex-1 truncate text-left">{name ?? 'Not signed in'}</span>
            <ChevronsUpDown size={14} aria-hidden className="shrink-0 text-ink-3" />
          </>
        )}
      </button>
      {d.open && (
        <Panel id={panelId} label="Account" compact={compact} style={d.style} panelRef={d.panel}>
          <p className="px-2 pt-1.5 pb-1 text-[12px] text-ink-3">
            {name ? (
              <>
                Signed in as <span className="font-medium text-ink">{name}</span>
              </>
            ) : session.server === null ? (
              'This copy of Jagr runs in the browser only.'
            ) : (
              'Not signed in.'
            )}
          </p>
          {!name && google && (
            <a href={serverApi.signInUrl('google', `${pathname}${search}${hash}`)} onClick={markSigningIn} className={item}>
              <UserRound size={14} aria-hidden className="shrink-0 text-ink-3" /> Continue with Google
            </a>
          )}
          <div className="my-1 border-t border-line" />
          <fieldset className="px-2 py-1.5">
            <legend className="mb-1.5 text-[12px] text-ink-3">Theme</legend>
            <div className="flex gap-1">
              {(['light', 'dark'] as const).map((t) => (
                <button key={t} type="button" aria-pressed={theme === t} onClick={() => setTheme(t)} className={cx('interactive inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md border text-[12px]', theme === t ? 'border-line-strong bg-subtle font-medium text-ink' : 'border-line text-ink-2 hover:text-ink')}>
                  {t === 'light' ? <Sun size={13} aria-hidden /> : <Moon size={13} aria-hidden />}
                  {t === 'light' ? 'Light' : 'Dark'}
                </button>
              ))}
            </div>
          </fieldset>
          {name && (
            <>
              <div className="my-1 border-t border-line" />
              <button type="button" className={item} onClick={() => void signOut()}>
                <LogOut size={14} aria-hidden className="shrink-0 text-ink-3" /> Sign out
              </button>
            </>
          )}
        </Panel>
      )}
    </div>
  );
}
