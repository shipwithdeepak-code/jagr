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
 * The environment is derived from where the user is; pages shared by both (Tasks, Approvals,
 * Agent Trace, Evaluations, Settings, About) keep whichever environment the user came from.
 */

export type AppEnvironment = 'workspace' | 'demo';

/** Routes that only exist for Demo night. */
function isDemoPath(path: string): boolean {
  if (path === '/demo' || path.startsWith('/demo/') || path === '/signals' || path === '/integrations') return true;
  // Legacy demo investigations: /investigations/:id — workspace ones are /investigations/w/:id.
  return /^\/investigations\/(?!w\/)[^/]+/.test(path);
}

/** Routes that only exist for the workspace. */
function isWorkspacePath(path: string): boolean {
  return path === '/' || ['/investigations', '/watches', '/sources', '/briefs'].some((p) => path === p || path.startsWith(`${p}/`));
}

export function environmentForPath(path: string, previous: AppEnvironment = 'workspace'): AppEnvironment {
  if (isDemoPath(path)) return 'demo';
  if (isWorkspacePath(path)) return 'workspace';
  return previous;
}

export const ENVIRONMENT: Record<AppEnvironment, { label: string; badge: string; description: string; home: string }> = {
  workspace: {
    label: 'Workspace',
    badge: 'Simulated sources',
    description: 'Your watches, monitoring runs and investigations. Sources are simulated in this build — clearly labelled, never presented as live.',
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
// Persistence — same approach as the theme preference: one localStorage key, validated on read.
// ─────────────────────────────────────────────────────────────

export const ENVIRONMENT_STORAGE_KEY = 'jagr:environment';

/** Anything other than a known environment (missing, corrupted, old) → Workspace. */
export function parseStoredEnvironment(value: string | null | undefined): AppEnvironment {
  return value === 'demo' || value === 'workspace' ? value : 'workspace';
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function readStoredEnvironment(storage: StorageLike | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): AppEnvironment {
  try {
    return parseStoredEnvironment(storage?.getItem(ENVIRONMENT_STORAGE_KEY));
  } catch {
    return 'workspace';
  }
}

export function storeEnvironment(env: AppEnvironment, storage: StorageLike | undefined = typeof localStorage === 'undefined' ? undefined : localStorage) {
  try {
    storage?.setItem(ENVIRONMENT_STORAGE_KEY, env);
  } catch {
    /* storage unavailable — the environment still works for this session */
  }
}

/** On load: a route that belongs to one environment decides; shared routes restore the stored one. */
export function initialEnvironment(path: string, stored: AppEnvironment): AppEnvironment {
  return environmentForPath(path, stored);
}

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
