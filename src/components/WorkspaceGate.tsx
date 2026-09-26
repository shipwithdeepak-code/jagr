import { useState, type ReactNode } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import type { Surface } from '@/state/surface';
import { markSigningIn, useServerSession } from '@/state/serverSession';
import { serverApi } from '@/state/serverApi';
import { useProduct } from '@/state/productContext';
import { Logo } from './Logo';
import { Button, Select, cx } from './ui';

/**
 * The screens between the public landing and the application (see state/surface.ts). No sidebar and
 * no workspace data: until a workspace is known, nothing is shown that could be the wrong one.
 *   resolving     Restoring your workspace…
 *   choose        Choose a workspace
 *   create        Create your workspace
 *   no-workspace  No workspace open — sign in (back to this same route), explore locally, or Demo night
 */
export function WorkspaceGate({ surface }: { surface: Exclude<Surface, 'public' | 'app'> }) {
  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <header className="border-b border-line">
        <div className="mx-auto flex h-14 w-full max-w-[720px] items-center px-4 sm:px-6">
          <Logo />
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-[520px] px-4 py-16 sm:px-6 sm:py-24">
        {surface === 'resolving' ? <Resolving /> : surface === 'choose' ? <Choose /> : surface === 'create' ? <Create /> : <NoWorkspace />}
      </main>
    </div>
  );
}

export function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3ZM12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1a5.9 5.9 0 0 1-5.5-4.1H3.2v2.6A10 10 0 0 0 12 22ZM6.5 14a6 6 0 0 1 0-3.9V7.5H3.2a10 10 0 0 0 0 9ZM12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.2 7.5l3.3 2.6A5.9 5.9 0 0 1 12 5.9Z"
      />
    </svg>
  );
}

const heading = 'text-[28px] leading-tight font-semibold tracking-[-0.02em]';
const lede = 'mt-2 text-[15px] text-ink-2';
const quiet = 'interactive text-[13px] text-ink-2 underline-offset-2 hover:text-ink hover:underline';

function Resolving() {
  const session = useServerSession();
  return (
    <div role="status" className="flex items-center gap-2.5 text-[15px] text-ink-2">
      <Loader2 size={16} aria-hidden className="shrink-0 animate-spin motion-reduce:animate-none" />
      {session.active ? `Opening ${session.active.name}…` : 'Restoring your workspace…'}
    </div>
  );
}

/** Opens this browser's sample workspace — an explicit choice to stay local. */
function useExploreLocally() {
  const { createWorkspace } = useProduct();
  const { useBrowserWorkspace } = useServerSession();
  return () => {
    useBrowserWorkspace();
    createWorkspace('sample');
  };
}

function Alternatives({ children }: { children?: ReactNode }) {
  const session = useServerSession();
  return (
    <div className="mt-10 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-5">
      {children}
      {session.user && (
        <button type="button" className={quiet} onClick={() => void session.signOut()}>
          Sign out
        </button>
      )}
    </div>
  );
}

function Choose() {
  const session = useServerSession();
  const explore = useExploreLocally();
  const [creating, setCreating] = useState(false);
  return (
    <section aria-labelledby="gate-h">
      <h1 id="gate-h" className={heading}>
        Choose a workspace
      </h1>
      <p className={lede}>{session.user ? `Signed in as ${session.user.displayName}.` : null} Jagr remembers your choice in this browser.</p>
      <ul className="mt-8 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {session.workspaces.map((w) => (
          <li key={w.id}>
            <button type="button" className="interactive flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left hover:bg-subtle" onClick={() => session.open(w.id)}>
              <span className="min-w-0">
                <span className="block truncate text-[15px] font-medium">{w.name}</span>
                <span className="block text-[13px] text-ink-3">
                  {w.mode === 'connected' ? 'Live sources' : w.mode === 'imported' ? 'Imported data' : 'Sample data'} · {w.role}
                </span>
              </span>
              <ArrowRight size={16} aria-hidden className="shrink-0 text-ink-3" />
            </button>
          </li>
        ))}
      </ul>
      {creating ? (
        <div className="mt-6">
          <CreateForm />
        </div>
      ) : (
        <button type="button" className={cx(quiet, 'mt-4')} onClick={() => setCreating(true)}>
          Create a new workspace
        </button>
      )}
      <Alternatives>
        <button type="button" className={quiet} onClick={explore}>
          Explore locally instead
        </button>
      </Alternatives>
    </section>
  );
}

function Create() {
  const session = useServerSession();
  const explore = useExploreLocally();
  return (
    <section aria-labelledby="gate-h">
      <h1 id="gate-h" className={heading}>
        Create your workspace
      </h1>
      <p className={lede}>
        {session.user ? `Signed in as ${session.user.displayName}. ` : null}A workspace keeps watching your sources on a schedule — without this browser open.
      </p>
      <div className="mt-8">
        <CreateForm />
      </div>
      <Alternatives>
        <button type="button" className={quiet} onClick={explore}>
          Explore locally instead
        </button>
      </Alternatives>
    </section>
  );
}

/** The existing server call (session.create), which opens the new workspace when it succeeds. */
function CreateForm() {
  const session = useServerSession();
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'connected' | 'imported'>('connected');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <form
      className="grid gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setBusy(true);
        setError(undefined);
        try {
          await session.create(name.trim(), mode);
        } catch (err) {
          setError((err as Error).message);
          setBusy(false);
        }
      }}
    >
      <label className="grid gap-1 text-[13px] text-ink-2">
        Workspace name
        <input className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-[15px] text-ink" value={name} maxLength={80} placeholder="e.g. Checkout team" onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Select label="Data" value={mode} onChange={setMode} className="h-10" options={[{ value: 'connected', label: 'Live sources' }, { value: 'imported', label: 'Imported files' }]} />
        <Button type="submit" variant="primary" className="h-10 px-4" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create workspace'}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-[13px] text-crit">
          {error}
        </p>
      )}
    </form>
  );
}

function NoWorkspace() {
  const session = useServerSession();
  const { pathname, search, hash } = useLocation();
  const explore = useExploreLocally();
  const failed = !!session.error || (session.server === null && session.choice === 'server');
  const google = session.server?.signIn.includes('google');
  return (
    <section aria-labelledby="gate-h">
      <h1 id="gate-h" className={heading}>
        No workspace open
      </h1>
      {failed ? (
        <>
          <p className={lede}>Jagr couldn’t reach your workspace{session.error ? `: ${session.error}` : '. The Jagr server did not respond.'}</p>
          <div className="mt-8">
            <Button variant="primary" className="h-10 px-4" onClick={() => void session.refresh()}>
              Try again
            </Button>
          </div>
        </>
      ) : session.user ? (
        <>
          <p className={lede}>Signed in as {session.user.displayName}. Open a workspace to see this page.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            {session.workspaces.length === 1 ? (
              <Button variant="primary" className="h-10 px-4" onClick={() => session.open(session.workspaces[0].id)}>
                Open {session.workspaces[0].name}
              </Button>
            ) : (
              <Button variant="primary" className="h-10 px-4" onClick={session.clearChoice}>
                {session.workspaces.length ? 'Choose workspace' : 'Create your workspace'}
              </Button>
            )}
          </div>
        </>
      ) : (
        <>
          <p className={lede}>Sign in to open your workspace on this page, or look around Jagr without an account.</p>
          {google && (
            <div className="mt-8">
              <a href={serverApi.signInUrl('google', `${pathname}${search}${hash}`)} onClick={markSigningIn} className="interactive inline-flex h-10 items-center gap-2 rounded-lg bg-ink px-4 text-[14px] font-medium text-canvas hover:opacity-90">
                <GoogleMark /> Continue with Google
              </a>
            </div>
          )}
        </>
      )}
      <Alternatives>
        <button type="button" className={quiet} onClick={explore}>
          Explore locally
        </button>
        <Link to="/demo" className={cx(quiet, 'inline-flex items-center gap-1')}>
          Watch Demo night <ArrowRight size={13} aria-hidden />
        </Link>
      </Alternatives>
    </section>
  );
}
