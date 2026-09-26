import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { serverApi, type ServerHealth, type ServerWorkspaceSummary } from './serverApi';

/**
 * Where the product workspace lives. Without a Jagr server (static hosting), always this browser.
 * With one, a signed-in user can open a server workspace instead; the choice is remembered in this
 * browser (only the workspace id — never data or credentials).
 *
 * The last explicit choice is one of:
 *   server  a server workspace was opened (its id is remembered)
 *   local   the person chose this browser's workspace — Explore locally, Start over, or Switch. Jagr
 *           then never opens a server workspace on its own until they sign in again or pick one.
 *   exit    the person signed out: the public landing until they explore locally or sign in again
 *   none    no choice yet (a fresh browser, or a remembered workspace that no longer exists)
 * `signingIn` marks the return from Continue with Google, so the first check can open the right
 * workspace instead of showing the public landing. `expired` marks a session that ended while the
 * person was using a server workspace. See state/surface.ts for how these decide the screen.
 */

const ACTIVE_KEY = 'jagr:server-workspace';
const LOCAL_CHOICE_KEY = 'jagr:workspace-choice';
const SIGNING_IN_KEY = 'jagr:signing-in';

export type WorkspaceChoice = 'server' | 'local' | 'exit' | 'none';

export interface ServerSessionApi {
  /** Undefined until the first health check; null when there is no server. */
  server: ServerHealth | null | undefined;
  user?: { id: string; displayName: string };
  workspaces: ServerWorkspaceSummary[];
  /** The open server workspace; undefined = the browser-local workspace. */
  activeId?: string;
  active?: ServerWorkspaceSummary;
  /** The first health / sign-in / workspaces check has finished. */
  checked: boolean;
  /** The last explicit workspace choice in this browser. */
  choice: WorkspaceChoice;
  /** This page load is the return from Continue with Google. */
  signingIn: boolean;
  /** The session ended while a server workspace was open (a workspace call answered 401). */
  expired: boolean;
  error?: string;
  open(id: string): void;
  /** Leave any server workspace for this browser's workspace — an explicit choice that stops auto-opening. */
  useBrowserWorkspace(): void;
  /** Forget an explicit "this browser" choice, so the signed-in person is taken to their workspaces again. */
  clearChoice(): void;
  create(name: string, mode: 'connected' | 'imported'): Promise<void>;
  /**
   * End the session on the server. Throws if the server did not confirm — nothing is changed then.
   * On success the remembered workspace is forgotten and the explicit "exit" is recorded. Call it
   * through useSignOut (components/signOut.ts), which also takes the person to the public landing.
   */
  signOut(): Promise<void>;
  /** A workspace call answered 401: re-check, and if the session is gone, mark it expired. */
  sessionLost(): Promise<void>;
  refresh(): Promise<void>;
}

const ServerSessionContext = createContext<ServerSessionApi | null>(null);

const readActive = () => {
  try {
    return localStorage.getItem(ACTIVE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};
const writeActive = (id?: string) => {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // storage blocked: the choice lasts for this tab only
  }
};
type StoredChoice = 'local' | 'exit' | undefined;
const readStoredChoice = (): StoredChoice => {
  try {
    const v = localStorage.getItem(LOCAL_CHOICE_KEY);
    return v === 'local' || v === 'exit' ? v : undefined;
  } catch {
    return undefined;
  }
};
const writeStoredChoice = (v: StoredChoice) => {
  try {
    if (v) localStorage.setItem(LOCAL_CHOICE_KEY, v);
    else localStorage.removeItem(LOCAL_CHOICE_KEY);
  } catch {
    // storage blocked: the choice lasts for this tab only
  }
};

/** The last explicit choice, from the remembered server workspace and the stored local/exit choice. */
export function choiceFrom(rememberedId: string | undefined, stored: StoredChoice): WorkspaceChoice {
  return rememberedId ? 'server' : (stored ?? 'none');
}
/** Read once per page load: was this load the return from Continue with Google? */
const consumeSigningIn = () => {
  try {
    const v = sessionStorage.getItem(SIGNING_IN_KEY) === '1';
    sessionStorage.removeItem(SIGNING_IN_KEY);
    return v;
  } catch {
    return false;
  }
};

/**
 * Call when Continue with Google is clicked (before the browser leaves for the sign-in page).
 * Signing in is itself a choice to use server workspaces, so an earlier "this browser" or "exit"
 * choice is cleared.
 */
export function markSigningIn() {
  try {
    sessionStorage.setItem(SIGNING_IN_KEY, '1');
  } catch {
    // storage blocked: the return still works, it just lands without the sign-in hint
  }
  writeStoredChoice(undefined);
}

export function ServerSessionProvider({ children }: { children: ReactNode }) {
  const [server, setServer] = useState<ServerHealth | null | undefined>(undefined);
  const [user, setUser] = useState<{ id: string; displayName: string } | undefined>();
  const [workspaces, setWorkspaces] = useState<ServerWorkspaceSummary[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>(readActive);
  const [error, setError] = useState<string | undefined>();
  const [checked, setChecked] = useState(false);
  const [storedChoice, setStoredChoice] = useState<StoredChoice>(readStoredChoice);
  const [signingIn, setSigningIn] = useState(consumeSigningIn);
  const [expired, setExpired] = useState(false);
  const remember = useCallback((v: StoredChoice) => {
    writeStoredChoice(v);
    setStoredChoice(v);
  }, []);

  // One pass: server health, then who is signed in and their workspaces.
  const check = async () => {
    const h = await serverApi.health();
    setServer(h ?? null);
    if (!h) {
      setUser(undefined);
      setWorkspaces([]);
      return;
    }
    try {
      const me = await serverApi.me();
      setUser(me?.user);
      const list = me ? await serverApi.workspaces() : [];
      setWorkspaces(list);
      // A remembered workspace that is gone (or not ours any more) falls back to the browser workspace.
      setActiveId((cur) => {
        const keep = cur && list.some((w) => w.id === cur) ? cur : undefined;
        if (keep !== cur) writeActive(keep);
        return keep;
      });
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  // Uses only state setters and the API, so a stable callback around it is safe.
  const refresh = useCallback(async () => {
    try {
      await check();
    } finally {
      setChecked(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = useCallback(
    (id: string) => {
      writeActive(id);
      setActiveId(id);
      remember(undefined);
      setSigningIn(false);
      setExpired(false);
    },
    [remember],
  );
  const useBrowserWorkspace = useCallback(() => {
    writeActive(undefined);
    setActiveId(undefined);
    remember('local');
    setSigningIn(false);
    setExpired(false);
  }, [remember]);
  const clearChoice = useCallback(() => remember(undefined), [remember]);
  const create = useCallback(
    async (name: string, mode: 'connected' | 'imported') => {
      const id = await serverApi.createWorkspace(name, mode);
      await refresh();
      open(id);
    },
    [open, refresh],
  );
  const signOut = useCallback(async () => {
    // Throws when the server does not confirm: the person is still signed in, so nothing changes here.
    await serverApi.signOut();
    // Confirmed: the session is gone. Update everything in the same tick as the caller's navigation,
    // so no screen in between can show "signed in" or a workspace.
    writeActive(undefined);
    setActiveId(undefined);
    remember('exit');
    setUser(undefined);
    setWorkspaces([]);
    setSigningIn(false);
    setExpired(false);
    void refresh();
  }, [refresh, remember]);
  const sessionLost = useCallback(async () => {
    // me() answers undefined only for 401 — the session really ended (not a network failure).
    const me = await serverApi.me().catch(() => null);
    if (me === undefined) setExpired(true);
    await refresh();
  }, [refresh]);

  const active = workspaces.find((w) => w.id === activeId);
  // Until the first check confirms it, a remembered id still counts as the server choice.
  const choice = choiceFrom(activeId, storedChoice);
  const api = useMemo<ServerSessionApi>(
    () => ({ server, user, workspaces, activeId: active ? activeId : undefined, active, checked, choice, signingIn, expired, error, open, useBrowserWorkspace, clearChoice, create, signOut, sessionLost, refresh }),
    [server, user, workspaces, activeId, active, checked, choice, signingIn, expired, error, open, useBrowserWorkspace, clearChoice, create, signOut, sessionLost, refresh],
  );
  return <ServerSessionContext.Provider value={api}>{children}</ServerSessionContext.Provider>;
}

export function useServerSession(): ServerSessionApi {
  const v = useContext(ServerSessionContext);
  if (!v) throw new Error('useServerSession must be used inside ServerSessionProvider');
  return v;
}
