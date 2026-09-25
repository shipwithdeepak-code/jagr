import type { WorkspaceSnapshot } from '@/product/app/workspaceSnapshot';
import type { InvestigationReplay } from '@/product/app/replay';
import type { ConnectionTypeInfo } from '@/product/app/connections';
import type { ConnectionView } from '@/product/connections/model';
import type { ConnectorCheck } from '@/product/integrations/connectors/types';
import type { ActionDecision, AttentionLevel, BriefSchedule, Watch, WatchTemplateId } from '@/product/types';
import type { ImportKind } from '@/product/imports/schemas';
import type { WorkspaceExportV1 } from '@/product/export/v1';

/**
 * The browser's client for the Jagr server API. Session cookies are httpOnly; state-changing calls
 * carry the double-submit CSRF token. Credentials entered to connect a source go to the server once
 * and are never returned.
 */

export class ServerError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
    this.name = 'ServerError';
  }
}

const csrf = () => decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('jagr_csrf='))?.slice('jagr_csrf='.length) ?? '');

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-jagr-csrf': csrf() } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const d = data as { error?: string; code?: string } | undefined;
    throw new ServerError(res.status, d?.error ?? `The server answered ${res.status}.`, d?.code);
  }
  return data as T;
}

export interface ServerHealth {
  ok: boolean;
  mode: 'multi-tenant' | 'single-tenant';
  signIn: string[];
}
export interface ServerWorkspaceSummary {
  id: string;
  name: string;
  mode: 'connected' | 'imported' | 'sample';
  createdAt: string;
  role: 'owner' | 'admin' | 'member';
  canApprove: boolean;
}
export interface WatchInput {
  templateId: WatchTemplateId;
  sources?: string[];
  name?: string;
  schedule?: Watch['schedule'];
  severityThreshold?: AttentionLevel;
  thresholds?: Record<string, number>;
  notificationPolicy?: Watch['notificationPolicy'];
}

export const serverApi = {
  /** Undefined when this build has no Jagr server behind it (static hosting / local-only). */
  async health(): Promise<ServerHealth | undefined> {
    try {
      const res = await fetch('/api/health', { headers: { accept: 'application/json' } });
      if (!res.ok) return undefined;
      const h = (await res.json()) as Partial<ServerHealth>;
      return h && h.ok === true && Array.isArray(h.signIn) ? (h as ServerHealth) : undefined;
    } catch {
      return undefined;
    }
  },
  async me(): Promise<{ user: { id: string; displayName: string } } | undefined> {
    try {
      return await call('GET', '/api/me');
    } catch (e) {
      if (e instanceof ServerError && e.status === 401) return undefined;
      throw e;
    }
  },
  signInUrl: (provider: string, returnTo: string) => `/api/auth/${encodeURIComponent(provider)}/start?returnTo=${encodeURIComponent(returnTo)}`,
  signOut: () => call<{ ok: true }>('POST', '/api/auth/logout'),
  workspaces: () => call<{ workspaces: ServerWorkspaceSummary[] }>('GET', '/api/workspaces').then((r) => r.workspaces),
  createWorkspace: (name: string, mode: 'connected' | 'imported') => call<{ workspace: { id: string } }>('POST', '/api/workspaces', { name, mode }).then((r) => r.workspace.id),
  snapshot: (ws: string) => call<WorkspaceSnapshot>('GET', `/api/workspaces/${encodeURIComponent(ws)}/snapshot`),
  updateWorkspace: (ws: string, patch: { name?: string; brief?: BriefSchedule; planner?: 'deterministic' | 'llm'; aiEgressAllowed?: boolean }) => call('PATCH', `/api/workspaces/${encodeURIComponent(ws)}`, patch),
  runNow: (ws: string) => call<{ investigations: number }>('POST', `/api/workspaces/${encodeURIComponent(ws)}/runs`),
  createWatch: (ws: string, input: WatchInput) => call<{ watch: Watch }>('POST', `/api/workspaces/${encodeURIComponent(ws)}/watches`, input),
  setWatchStatus: (ws: string, id: string, status: 'active' | 'paused') => call('PATCH', `/api/workspaces/${encodeURIComponent(ws)}/watches/${encodeURIComponent(id)}`, { status }),
  decide: (ws: string, input: { actionId: string; status: ActionDecision['status']; optionId?: string; note?: string }) => call<{ decision: ActionDecision }>('POST', `/api/workspaces/${encodeURIComponent(ws)}/decisions`, input),
  addImport: (ws: string, kind: ImportKind, filename: string, text: string) => call('POST', `/api/workspaces/${encodeURIComponent(ws)}/imports`, { kind, filename, text }),
  removeImport: (ws: string, id: string) => call('DELETE', `/api/workspaces/${encodeURIComponent(ws)}/imports/${encodeURIComponent(id)}`),
  exportWorkspace: (ws: string) => call<WorkspaceExportV1>('GET', `/api/workspaces/${encodeURIComponent(ws)}/export`),
  /** The original investigation from storage (no provider is read). */
  replay: (ws: string, inv: string, pass?: number) => call<InvestigationReplay>('GET', `/api/workspaces/${encodeURIComponent(ws)}/investigations/${encodeURIComponent(inv)}/replay${pass !== undefined ? `?pass=${pass}` : ''}`),
  /** A new run over current data (connected workspaces); the original investigation is kept as recorded. */
  runAgain: (ws: string, inv: string) => call<{ kind: 'run_again'; investigations: number; note: string }>('POST', `/api/workspaces/${encodeURIComponent(ws)}/investigations/${encodeURIComponent(inv)}/rerun`),
  connectionTypes: () => call<{ types: ConnectionTypeInfo[] }>('GET', '/api/connection-types').then((r) => r.types),
  connect: (ws: string, input: { provider: string; config: Record<string, unknown>; credential?: Record<string, string> }) => call<{ connection: ConnectionView; check: ConnectorCheck }>('PUT', `/api/workspaces/${encodeURIComponent(ws)}/connections`, input),
  testConnection: (ws: string, id: string) => call<{ connection: ConnectionView; check: ConnectorCheck }>('POST', `/api/workspaces/${encodeURIComponent(ws)}/connections/${encodeURIComponent(id)}/check`),
  reconnect: (ws: string, id: string, credential: Record<string, string>) => call<{ connection: ConnectionView; check: ConnectorCheck }>('POST', `/api/workspaces/${encodeURIComponent(ws)}/connections/${encodeURIComponent(id)}/reconnect`, { credential }),
  disconnect: (ws: string, id: string) => call<{ connection: ConnectionView }>('DELETE', `/api/workspaces/${encodeURIComponent(ws)}/connections/${encodeURIComponent(id)}`),
};
