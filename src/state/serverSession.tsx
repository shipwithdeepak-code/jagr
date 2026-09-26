import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { serverApi, type ServerHealth, type ServerWorkspaceSummary } from './serverApi';

/**
 * Where the product workspace lives. Without a Jagr server (static hosting), always this browser.
 * With one, a signed-in user can open a server workspace instead; the choice is remembered in this
 * browser (only the workspace id — never data or credentials).
 */

const ACTIVE_KEY = 'jagr:server-workspace';

export interface ServerSessionApi {
  /** Undefined until the first health check; null when there is no server. */
  server: ServerHealth | null | undefined;
  user?: { id: string; displayName: string };
  workspaces: ServerWorkspaceSummary[];
  /** The open server workspace; undefined = the browser-local workspace. */
  activeId?: string;
  active?: ServerWorkspaceSummary;
  /** True while a workspace remembered in this browser is still being confirmed by the first check. */
  restoring: boolean;
  error?: string;
  open(id: string): void;
  useBrowserWorkspace(): void;
  create(name: string, mode: 'connected' | 'imported'): Promise<void>;
  signOut(): Promise<void>;
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

export function ServerSessionProvider({ children }: { children: ReactNode }) {
  const [server, setServer] = useState<ServerHealth | null | undefined>(undefined);
  const [user, setUser] = useState<{ id: string; displayName: string } | undefined>();
  const [workspaces, setWorkspaces] = useState<ServerWorkspaceSummary[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>(readActive);
  const [error, setError] = useState<string | undefined>();
  const [checked, setChecked] = useState(false);

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

  const open = useCallback((id: string) => {
    writeActive(id);
    setActiveId(id);
  }, []);
  const useBrowserWorkspace = useCallback(() => {
    writeActive(undefined);
    setActiveId(undefined);
  }, []);
  const create = useCallback(
    async (name: string, mode: 'connected' | 'imported') => {
      const id = await serverApi.createWorkspace(name, mode);
      await refresh();
      open(id);
    },
    [open, refresh],
  );
  const signOut = useCallback(async () => {
    await serverApi.signOut().catch(() => undefined);
    writeActive(undefined);
    setActiveId(undefined);
    await refresh();
  }, [refresh]);

  const active = workspaces.find((w) => w.id === activeId);
  const restoring = !checked && !!activeId;
  const api = useMemo<ServerSessionApi>(
    () => ({ server, user, workspaces, activeId: active ? activeId : undefined, active, restoring, error, open, useBrowserWorkspace, create, signOut, refresh }),
    [server, user, workspaces, activeId, active, restoring, error, open, useBrowserWorkspace, create, signOut, refresh],
  );
  return <ServerSessionContext.Provider value={api}>{children}</ServerSessionContext.Provider>;
}

export function useServerSession(): ServerSessionApi {
  const v = useContext(ServerSessionContext);
  if (!v) throw new Error('useServerSession must be used inside ServerSessionProvider');
  return v;
}
