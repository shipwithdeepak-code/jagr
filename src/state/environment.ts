import { createContext, useContext } from 'react';

/**
 * The two places a user can be. Nothing else in the app is a "mode".
 *
 *   WORKSPACE   The product: your watches, sources, monitoring runs, workspace investigations,
 *               approvals and planner selection (Deterministic or the configured LLM). In this
 *               build the sources are simulated and labelled "Simulated sources" — it is still the
 *               normal workspace, not a demo.
 *   DEMO NIGHT  A controlled, scripted replay of the original agent's overnight scenario (the
 *               Klarna payment-provider regression), with its own reset & replay. Separate data,
 *               separate engine, no planner selection.
 *
 * The environment is derived from the URL alone, never from what the user looked at before:
 *   - Demo night routes (/demo, /demo/*, /signals, /integrations, legacy /investigations/:id) are Demo night.
 *   - Pages shared by both (Tasks, Approvals, Agent Trace) are the Workspace unless the link says
 *     otherwise with `?env=demo` — Demo night's own links carry it, so a reload keeps it.
 *   - Everything else — Settings, About, Evaluations included — is the Workspace.
 * Opening Settings can never switch the product into Demo night.
 */

export type AppEnvironment = 'workspace' | 'demo';

/** Routes that only exist for Demo night. */
function isDemoPath(path: string): boolean {
  if (path === '/demo' || path.startsWith('/demo/') || path === '/signals' || path === '/integrations') return true;
  // Legacy demo investigations: /investigations/:id — workspace ones are /investigations/w/:id.
  return /^\/investigations\/(?!w\/)[^/]+/.test(path);
}

/** Pages that list records from both environments, scoped to one of them. */
export const SHARED_PATHS = ['/tasks', '/approvals', '/trace'] as const;
const isSharedPath = (path: string) => SHARED_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

/** The environment a URL belongs to. `search` is the query string (with or without "?"). */
export function environmentForPath(path: string, search = ''): AppEnvironment {
  if (isDemoPath(path)) return 'demo';
  if (isSharedPath(path) && new URLSearchParams(search).get('env') === 'demo') return 'demo';
  return 'workspace';
}

/** A link to a shared page that keeps Demo night's context (Workspace links need nothing). */
export function inEnvironment(path: string, env: AppEnvironment): string {
  if (env !== 'demo') return path;
  const [base, hash] = path.split('#');
  return `${base}${base.includes('?') ? '&' : '?'}env=demo${hash !== undefined ? `#${hash}` : ''}`;
}

export const ENVIRONMENT: Record<AppEnvironment, { label: string; badge: string; description: string; home: string }> = {
  workspace: {
    label: 'Workspace',
    badge: 'Simulated sources',
    description: 'Your watches, sources, monitoring runs and investigations. Simulated or imported data is always labelled as such — never presented as live.',
    home: '/',
  },
  demo: {
    label: 'Demo night',
    badge: 'Demo night · simulated replay',
    description: 'A controlled, reproducible replay of a scripted overnight scenario. Separate from your workspace; reset & replay any time.',
    home: '/demo',
  },
};

// ─────────────────────────────────────────────────────────────
// Record identity — every task / approval belongs to exactly one environment.
// ─────────────────────────────────────────────────────────────

export type EnvironmentScope = AppEnvironment | 'all';

/**
 * Tasks share one simulated issue tracker. Tasks filed from workspace investigations carry a
 * `watch:` fingerprint; everything else there (the seeded backlog and the scripted replay's work)
 * belongs to Demo night.
 */
export function taskEnvironment(task: { fingerprint?: string }): AppEnvironment {
  return task.fingerprint?.startsWith('watch:') ? 'workspace' : 'demo';
}

export function inScope(env: AppEnvironment, scope: EnvironmentScope): boolean {
  return scope === 'all' || scope === env;
}

export const SCOPE_TABS: { value: EnvironmentScope; label: string }[] = [
  { value: 'workspace', label: 'Workspace' },
  { value: 'demo', label: 'Demo night' },
  { value: 'all', label: 'All environments' },
];

// ─────────────────────────────────────────────────────────────
// React context — the current environment, provided by the app shell.
// ─────────────────────────────────────────────────────────────

export const EnvironmentContext = createContext<{ environment: AppEnvironment }>({ environment: 'workspace' });

export function useEnvironment() {
  return useContext(EnvironmentContext);
}
