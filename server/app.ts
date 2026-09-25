import { z } from 'zod';
import type { Membership, Workspace } from '../src/product/ports/persistence';
import type { ProviderId, WatchInvestigation } from '../src/product/types';
import { isSourceId, type SourceId } from '../src/product/roles/types';
import { decide } from '../src/product/agent/decisions';
import { ApprovalRequiredError } from '../src/product/agent/actions';
import { commitServerImport, exportServerWorkspace, planImport } from '../src/product/export/workspace';
import { schedulerTick } from '../src/product/app/scheduler';
import { checkConnection, drainJobs, runWorkspaceNow, sourcesForRun } from '../src/product/app/monitoring';
import type { Runtime } from './runtime';
import type { ApiRequest, ApiResponse } from './http/types';
import { json, redirect } from './http/types';
import { authenticate, clearCookie, cookie, CSRF_COOKIE, csrfOk, OAUTH_COOKIE, openOAuthState, parseCookies, sealOAuthState, SESSION_COOKIE, startSession, hashToken, type Principal } from './auth';
import { randomToken } from './identity/pkce';
import { OWNER_WORKSPACE_ID } from './singleTenant';
import { connectionView } from '../src/product/connections/model';
import { watchFromTemplate, WATCH_TEMPLATES } from '../src/product/catalog';
import { createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time comparison (hashing first makes the lengths equal). */
const sameSecret = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

/**
 * The Jagr HTTP API — framework-neutral. Host adapters (Node http for local dev, Vercel functions)
 * turn their request into an ApiRequest and write the ApiResponse back.
 *
 * Every workspace route checks membership; nothing reads across workspaces. Consequential decisions
 * (HIGH / CRITICAL actions) need a member who can approve, and go through the same approval gate the
 * engine uses. Provider secrets never appear in a response.
 */

export const APP_VERSION = '1.1.0';
const newId = (prefix: string) => `${prefix}_${randomToken(12)}`;

const DecisionBody = z.object({ actionId: z.string().min(1), status: z.enum(['approved', 'rejected', 'done']), optionId: z.string().optional(), note: z.string().max(500).optional() }).strict();
const ImportBody = z.object({ doc: z.unknown(), confirm: z.literal(true).optional() }).strict();
const WatchBody = z.object({ templateId: z.enum(WATCH_TEMPLATES.map((t) => t.id) as [string, ...string[]]), sources: z.array(z.string()).min(1).optional() }).strict();
const WorkspaceBody = z.object({ name: z.string().min(1).max(80), mode: z.enum(['connected', 'imported']).default('connected') }).strict();

/** What a member sees of a workspace: never secret references or connection errors with provider detail beyond the message. */
function publicWorkspace(ws: Workspace) {
  const { importedExportIds: _i, ...rest } = ws;
  void _i;
  return rest;
}

export function createApp(rt: Runtime) {
  const secure = rt.config.secureCookies;

  const memberOf = (p: Principal, workspaceId: string): Membership | undefined => p.memberships.find((m) => m.workspaceId === workspaceId);

  async function audit(workspaceId: string, p: Principal, action: string, target?: string, detail?: string) {
    await rt.repos.audit.append({ id: newId('audit'), workspaceId, at: rt.clock.now(), actor: { ref: p.user.id, displayName: p.user.displayName }, action, target, detail });
  }

  // ── Auth ────────────────────────────────────────────────────
  async function authStart(provider: string, req: ApiRequest): Promise<ApiResponse> {
    const idp = rt.identity[provider];
    if (!idp) return json(404, { error: `Sign-in with ${provider} is not configured.` });
    const state = randomToken(24);
    const verifier = randomToken(48);
    const returnTo = req.query.returnTo?.startsWith('/') && !req.query.returnTo.startsWith('//') ? req.query.returnTo : '/';
    const sealed = sealOAuthState(rt.config.sessionSecret, { provider, state, verifier, exp: Date.parse(rt.clock.now()) + 10 * 60_000, returnTo });
    return redirect(idp.authorizationUrl({ state, codeVerifier: verifier, redirectUri: `${rt.config.appBaseUrl}/api/auth/${provider}/callback` }), [cookie(OAUTH_COOKIE, sealed, { maxAgeSeconds: 600, secure })]);
  }

  async function authCallback(provider: string, req: ApiRequest): Promise<ApiResponse> {
    const idp = rt.identity[provider];
    if (!idp) return json(404, { error: `Sign-in with ${provider} is not configured.` });
    const saved = openOAuthState(rt.config.sessionSecret, parseCookies(req.headers.cookie)[OAUTH_COOKIE], Date.parse(rt.clock.now()));
    if (!saved || saved.provider !== provider || !req.query.state || saved.state !== req.query.state || !req.query.code) return json(400, { error: 'Sign-in could not be verified (state mismatch or expired). Start again.' });
    const identity = await idp.exchange({ code: req.query.code, codeVerifier: saved.verifier, redirectUri: `${rt.config.appBaseUrl}/api/auth/${provider}/callback` });
    // Single-tenant deployments admit only the configured owner identities.
    if (rt.config.mode === 'single-tenant' && !rt.config.ownerIdentities.includes(`${identity.provider}:${identity.subject}`)) {
      return json(403, { error: 'This Jagr deployment is single-tenant; this account is not its owner.' }, { cookies: [clearCookie(OAUTH_COOKIE, secure)] });
    }
    // Identities are linked by (provider, subject) — never by email.
    let user = await rt.repos.users.byIdentity(identity.provider, identity.subject);
    if (!user) {
      user = { id: newId('usr'), displayName: identity.displayName || `${identity.provider} user`, createdAt: rt.clock.now() };
      await rt.repos.users.create(user, { provider: identity.provider, subject: identity.subject });
    }
    // The single-tenant owner is a member of the owner workspace (idempotent).
    if (rt.config.mode === 'single-tenant') await rt.repos.members.add({ workspaceId: OWNER_WORKSPACE_ID, userId: user.id, role: 'owner', canApprove: true });
    const { token } = await startSession(rt.repos, user.id, rt.clock);
    return redirect(saved.returnTo, [cookie(SESSION_COOKIE, token, { secure }), cookie(CSRF_COOKIE, randomToken(24), { secure, httpOnly: false }), clearCookie(OAUTH_COOKIE, secure)]);
  }

  // ── Workspace-scoped routes ─────────────────────────────────
  async function workspaceRoute(p: Principal, req: ApiRequest, id: string, rest: string[]): Promise<ApiResponse> {
    const m = memberOf(p, id);
    if (!m) return json(404, { error: 'Workspace not found.' });
    const ws = await rt.repos.workspaces.get(id);
    if (!ws) return json(404, { error: 'Workspace not found.' });
    const [section, sub] = rest;

    if (!section && req.method === 'GET') {
      const connections = (await rt.repos.connections.list(id)).map((c) => connectionView(c, rt.clock.now()));
      return json(200, { workspace: publicWorkspace(ws), membership: m, connections, watches: await rt.repos.watches.list(id) });
    }
    // Watches are created from the catalog's templates; sources must be connections in this workspace.
    if (section === 'watches' && req.method === 'POST' && !sub) {
      const body = WatchBody.safeParse(req.body);
      if (!body.success) return json(400, { error: 'Expected { templateId, sources? }.' });
      const tpl = WATCH_TEMPLATES.find((t) => t.id === body.data.templateId)!;
      const connected = new Set((await rt.repos.connections.list(id)).map((c) => c.source as string));
      const sources = body.data.sources ?? tpl.sources.filter((s) => connected.has(s));
      const unknown = sources.filter((s) => !connected.has(s));
      if (unknown.length || !sources.length) return json(400, { error: unknown.length ? `Not a source in this workspace: ${unknown.join(', ')}.` : 'None of this template’s sources is connected; pass sources explicitly.' });
      // Connected workspaces define their own metrics: keep the template's metric signals the sources serve.
      // Metrics configured for the template's area that the template does not name are added too.
      const served = ws.mode === 'connected' ? (await sourcesForRun(rt, ws, rt.clock.now())).registry.metrics(sources.filter((x): x is SourceId => isSourceId(x as ProviderId))) : undefined;
      const watch = watchFromTemplate(newId('watch'), tpl.id, { sources: sources as ProviderId[], metricKeys: served?.map((m) => m.def.key) }, rt.clock.now());
      for (const m of served ?? []) {
        const key = `metric:${m.def.key}` as const;
        if ((tpl.area === '*' || m.def.area === tpl.area) && !watch.signals.some((x) => x.key === key)) watch.signals.unshift({ key });
      }
      await rt.repos.watches.save(id, watch);
      await audit(id, p, 'watch.created', watch.id, tpl.name);
      return json(201, { watch });
    }
    if (section === 'watches' && req.method === 'DELETE' && sub) {
      if (!(await rt.repos.watches.get(id, sub))) return json(404, { error: 'Watch not found.' });
      await rt.repos.watches.remove(id, sub);
      await audit(id, p, 'watch.removed', sub);
      return json(200, { ok: true });
    }
    // Probe a connection's credential now; the outcome is recorded on the connection.
    if (section === 'connections' && sub && rest[2] === 'check' && req.method === 'POST') {
      if (!(await rt.repos.connections.get(id, sub))) return json(404, { error: 'Connection not found.' });
      const result = await checkConnection(rt, id, sub);
      await audit(id, p, 'connection.checked', sub, result.state);
      return json(200, { check: result });
    }
    if (section === 'investigations' && req.method === 'GET') {
      if (sub) {
        const inv = await rt.repos.investigations.get(id, sub);
        return inv ? json(200, { investigation: inv, decisions: (await rt.repos.decisions.list(id)).filter((d) => inv.actions.some((a) => a.id === d.actionId)) }) : json(404, { error: 'Investigation not found.' });
      }
      const all = await rt.repos.investigations.list(id);
      return json(200, { investigations: all.map((i: WatchInvestigation) => ({ id: i.id, title: i.title, area: i.area, status: i.status, attention: i.attention, updatedAt: i.updatedAt })) });
    }
    if (section === 'decisions' && req.method === 'POST') {
      const body = DecisionBody.safeParse(req.body);
      if (!body.success) return json(400, { error: 'Invalid decision.', issues: body.error.issues.map((i) => i.message) });
      const inv = (await rt.repos.investigations.list(id)).find((i) => i.actions.some((a) => a.id === body.data.actionId));
      const action = inv?.actions.find((a) => a.id === body.data.actionId);
      if (!action) return json(404, { error: 'Action not found in this workspace.' });
      const consequential = action.risk === 'HIGH' || action.risk === 'CRITICAL';
      if (consequential && body.data.status === 'approved' && !m.canApprove) return json(403, { error: `${action.risk}-risk actions need a member who can approve.` });
      try {
        const decision = decide(action, { status: body.data.status, optionId: body.data.optionId, note: body.data.note, at: rt.clock.now() });
        await rt.tx.run(async (repos) => {
          await repos.decisions.put(id, { ...decision, actionId: action.id, decidedBy: { ref: p.user.id, displayName: p.user.displayName } });
          await repos.audit.append({ id: newId('audit'), workspaceId: id, at: rt.clock.now(), actor: { ref: p.user.id, displayName: p.user.displayName }, action: `decision.${body.data.status}`, target: action.id, detail: `${action.risk} · ${action.title}` });
        });
        return json(200, { decision });
      } catch (e) {
        if (e instanceof ApprovalRequiredError) return json(409, { error: e.message });
        throw e;
      }
    }
    if (section === 'runs' && req.method === 'POST') {
      if (ws.mode === 'connected') return json(409, { error: 'Connected workspaces run on the schedule; there is nothing to replay.' });
      const summary = await runWorkspaceNow(rt, id);
      await audit(id, p, 'monitor.requested');
      return json(200, summary);
    }
    if (section === 'export' && req.method === 'GET') {
      const doc = await exportServerWorkspace(rt.repos, id, { clock: rt.clock, appVersion: APP_VERSION });
      await audit(id, p, 'workspace.exported', doc.exportId);
      return json(200, doc, { headers: { 'content-disposition': `attachment; filename="jagr-workspace-${doc.exportedAt.slice(0, 10)}.json"` } });
    }
    // Delivery log: what was sent where, and whether it arrived. Never message addresses or tokens.
    if (section === 'notifications' && req.method === 'GET') return json(200, { notifications: (await rt.repos.notifications.list(id)).map(({ email: _e, ...n }) => (void _e, n)) });
    if (section === 'audit' && req.method === 'GET') return json(200, { entries: await rt.repos.audit.list(id) });
    return json(404, { error: 'Not found.' });
  }

  async function handle(req: ApiRequest): Promise<ApiResponse> {
    const parts = req.path.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const [head, a, b] = parts;

    if (head === 'health') return json(200, { ok: true, version: APP_VERSION, mode: rt.config.mode, signIn: Object.keys(rt.identity) });
    if (head === 'auth' && a && b === 'start' && req.method === 'GET') return authStart(a, req);
    if (head === 'auth' && a && b === 'callback' && req.method === 'GET') return authCallback(a, req);

    if (head === 'cron' && a === 'tick') {
      if (!rt.config.cronSecret || !sameSecret(req.headers.authorization ?? '', `Bearer ${rt.config.cronSecret}`)) return json(401, { error: 'Unauthorized.' });
      const tick = await schedulerTick(rt);
      const run = await drainJobs(rt, { workerId: 'cron', limit: 10, leaseMs: 5 * 60_000 });
      return json(200, { tick, run });
    }

    const p = await authenticate(rt.repos, req, rt.clock);
    if (!p) return json(401, { error: 'Sign in first.' });
    if (!csrfOk(req)) return json(403, { error: 'Missing or invalid CSRF token.' });

    if (head === 'auth' && a === 'logout' && req.method === 'POST') {
      await rt.repos.sessions.revoke(p.session.id);
      return json(200, { ok: true }, { cookies: [clearCookie(SESSION_COOKIE, secure), clearCookie(CSRF_COOKIE, secure)] });
    }
    if (head === 'me' && req.method === 'GET') return json(200, { user: p.user, memberships: p.memberships });

    if (head === 'workspaces' && !a && req.method === 'POST') {
      const body = WorkspaceBody.safeParse(req.body ?? {});
      if (!body.success) return json(400, { error: 'Invalid workspace.' });
      const ws: Workspace = { id: newId('ws'), name: body.data.name, mode: body.data.mode, createdAt: rt.clock.now(), settings: { planner: 'deterministic', aiEgressAllowed: true, timezone: 'UTC' }, brief: { enabled: true, time: '08:00', timezone: 'UTC' }, importedExportIds: [], version: 1 };
      await rt.tx.run(async (repos) => {
        await repos.workspaces.create(ws);
        await repos.members.add({ workspaceId: ws.id, userId: p.user.id, role: 'owner', canApprove: true });
      });
      await audit(ws.id, p, 'workspace.created');
      return json(201, { workspace: publicWorkspace(ws) });
    }
    if (head === 'workspaces' && a) return workspaceRoute(p, req, a, parts.slice(2));

    // Local → server: dry run first; a write needs an explicit confirmation of that report.
    if (head === 'import' && (a === 'plan' || a === 'commit') && req.method === 'POST') {
      const body = ImportBody.safeParse(req.body);
      if (!body.success) return json(400, { error: 'Expected { doc, confirm? }.' });
      const all = await rt.repos.workspaces.list();
      const plan = planImport(body.data.doc, { alreadyImported: all.flatMap((w) => w.importedExportIds) });
      if (a === 'plan' || !plan.report.ok) return json(plan.report.ok ? 200 : 422, { report: plan.report });
      if (!body.data.confirm) return json(400, { error: 'Confirm the dry-run report (confirm: true) to import.', report: plan.report });
      const workspaceId = newId('ws');
      const ws = await commitServerImport(rt.tx, plan, { workspaceId, actor: { ref: p.user.id, displayName: p.user.displayName }, clock: rt.clock });
      await rt.repos.members.add({ workspaceId, userId: p.user.id, role: 'owner', canApprove: true });
      return json(201, { workspace: publicWorkspace(ws), report: plan.report });
    }
    return json(404, { error: 'Not found.' });
  }

  return async (req: ApiRequest): Promise<ApiResponse> => {
    try {
      return await handle(req);
    } catch (e) {
      // Never echo internals (or anything that might carry a credential) to the client.
      console.error('[jagr api]', req.method, req.path, (e as Error).message);
      return json(500, { error: 'Internal error.' });
    }
  };
}

/** Exposed for tests: the session id stored for a cookie token. */
export const sessionIdFor = hashToken;
