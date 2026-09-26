/**
 * Which surface a URL shows: the public landing page or the application.
 *
 *   PUBLIC  `/` before anyone has entered a workspace — the product story, its own minimal
 *           navigation, and no application sidebar.
 *   APP     everything else, inside the application shell: `/` once a local or server workspace
 *           exists (the Overview), every workspace route, and Demo night.
 *
 * Entering a workspace — Explore locally, opening a server workspace after Continue with Google, or
 * Demo night — is what moves someone from the public surface into the application.
 */
export type Surface = 'public' | 'app';

export interface WorkspacePresence {
  /** The browser workspace's mode, once created (sample or imported); undefined before. */
  mode?: string;
  /** Where the open workspace lives; 'server' as soon as a server workspace is opened, even while it loads. */
  location: 'browser' | 'server';
  /** A server workspace remembered in this browser is still being confirmed — don't flash the landing. */
  restoring?: boolean;
}

export function surfaceFor(pathname: string, ws: WorkspacePresence): Surface {
  const entered = ws.location === 'server' || !!ws.mode || !!ws.restoring;
  return pathname === '/' && !entered ? 'public' : 'app';
}
