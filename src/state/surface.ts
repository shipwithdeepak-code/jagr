import { environmentForPath } from './environment';
import type { WorkspaceChoice } from './serverSession';

/**
 * Which screen a URL shows, from the session and workspace state. The one rule for the boundary
 * between the public landing and the application:
 *
 *   public        `/` with no workspace to show — the product story, its own navigation, no sidebar.
 *   resolving     "Restoring your workspace…": the session or a server workspace is not known yet.
 *                 Nothing else renders, so neither the landing nor sample data can flash first.
 *   choose        signed in, several server workspaces, none chosen yet.
 *   create        signed in, no server workspace yet.
 *   no-workspace  an application route with no workspace to show (signed out, or chose to leave).
 *   app           the application shell with a local or server workspace — and always for Demo night
 *                 and the pages that need no workspace (About, Evaluations).
 *
 * `autoOpen` names the one server workspace to open now: a signed-in person who has made no other
 * choice (or has just signed in) goes straight into their only workspace, on the route they asked for.
 */
export type Surface = 'public' | 'resolving' | 'choose' | 'create' | 'no-workspace' | 'app';

export interface SurfaceSession {
  /** The first health / sign-in / workspaces check has finished. */
  checked: boolean;
  signedIn: boolean;
  /** Ids of the server workspaces this person can open. */
  workspaceIds: string[];
  /** The open server workspace, once confirmed by the check. */
  activeId?: string;
  choice: WorkspaceChoice;
  /** This load is the return from Continue with Google. */
  signingIn: boolean;
  /** The check failed (other than "not signed in"). */
  failed?: boolean;
}

export interface SurfaceWorkspace {
  location: 'browser' | 'server';
  /** Workspace mode once known: the browser workspace's, or the loaded server snapshot's. */
  mode?: string;
  /** The server workspace could not be loaded — show the application with its error, not a spinner forever. */
  serverFailed?: boolean;
}

export interface Resolution {
  surface: Surface;
  autoOpen?: string;
}

/** Routes that never wait for a workspace: Demo night and pages without workspace data. */
export function needsNoWorkspace(pathname: string, search = ''): boolean {
  return environmentForPath(pathname, search) === 'demo' || pathname === '/about' || pathname === '/evaluations';
}

export function resolveSurface(pathname: string, search: string, s: SurfaceSession, ws: SurfaceWorkspace): Resolution {
  if (needsNoWorkspace(pathname, search)) return { surface: 'app' };
  const local = ws.location === 'browser' ? ws.mode : undefined;

  // 1 · Still checking. A server workspace may be about to open: show nothing that could be wrong.
  if (!s.checked) {
    if (s.choice === 'server' || s.signingIn) return { surface: 'resolving' };
    if (local) return { surface: 'app' };
    return { surface: pathname === '/' ? 'public' : 'resolving' };
  }

  // 2 · A confirmed server workspace: the application, once its data has arrived.
  if (s.activeId) return { surface: ws.location === 'server' && !ws.mode && !ws.serverFailed ? 'resolving' : 'app' };

  // 3 · Signed in, no workspace open, and no choice to stay in this browser: take them to their workspaces.
  //     A local workspace wins only when they didn't just sign in. (A remembered server workspace that
  //     the check could not confirm lands here too.)
  const wantsServer = s.choice === 'server' || (s.signedIn && s.choice !== 'local' && (s.signingIn || !local));
  if (wantsServer) {
    // A failed check is not "no workspaces": say so (the no-workspace screen shows the error and a retry).
    if (s.failed || !s.signedIn) return { surface: 'no-workspace' };
    if (s.workspaceIds.length === 1) return { surface: 'resolving', autoOpen: s.workspaceIds[0] };
    return { surface: s.workspaceIds.length ? 'choose' : 'create' };
  }

  // 4 · This browser's workspace.
  if (local) return { surface: 'app' };

  // 5 · Nothing to show: the landing at `/`, the no-workspace screen anywhere else.
  return { surface: pathname === '/' ? 'public' : 'no-workspace' };
}
