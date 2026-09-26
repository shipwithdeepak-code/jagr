import { z } from 'zod';
import type { Membership, Workspace } from '../src/product/ports/persistence.js';
import type { ProviderId, WatchInvestigation } from '../src/product/types.js';
import { isSourceId, type SourceId } from '../src/product/roles/types.js';
import { decide } from '../src/product/agent/decisions.js';
import { ApprovalRequiredError } from '../src/product/agent/actions.js';
import { commitServerImport, exportServerWorkspace, planImport } from '../src/product/export/workspace.js';
import { schedulerTick } from '../src/product/app/scheduler.js';
import { checkConnection, drainJobs, runWatchJob, runWorkspaceNow, sourcesForRun, WorkspaceBusy } from '../src/product/app/monitoring.js';
import { buildSnapshot } from '../src/product/app/workspaceSnapshot.js';
import { replayInvestigation } from '../src/product/app/replay.js';
import { briefView } from '../src/product/view/brief.js';
import { redactPersonalData } from '../src/product/lib/redact.js';
import { evaluationLab, type EvaluationLabReport } from '../src/product/app/evaluationLab.js';
import { importFile } from '../src/product/imports/schemas.js';
import { WriteConflict } from '../src/product/ports/persistence.js';
import type { Runtime } from './runtime.js';
import type { ApiRequest, ApiResponse } from './http/types.js';
import { json, redirect } from './http/types.js';
import { authenticate, clearCookie, cookie, CSRF_COOKIE, csrfOk, OAUTH_COOKIE, openOAuthState, parseCookies, sealOAuthState, SESSION_COOKIE, startSession, type Principal } from './auth.js';
import { randomToken } from './identity/pkce.js';
import { OWNER_WORKSPACE_ID } from './singleTenant.js';
import { connectionView } from '../src/product/connections/model.js';
import { ConnectionError, configureConnection, disconnectConnection, listConnections, reconnectConnection, typeInfo } from '../src/product/app/connections.js';
import { watchFromTemplate, WATCH_TEMPLATES } from '../src/product/catalog.js';
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
const Attention = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const WatchBody = z
  .object({
    templateId: z.enum(WATCH_TEMPLATES.map((t) => t.id) as [string, ...string[]]),
    sources: z.array(z.string()).min(1).optional(),
    name: z.string().min(1).max(80).optional(),
    schedule: z.object({ frequency: z.enum(['15m', '30m', '1h', '4h', 'daily']), dailyAt: z.string().regex(/^\d{2}:\d{2}$/) }).strict().optional(),
    severityThreshold: Attention.optional(),
    thresholds: z.record(z.string(), z.number().positive().max(100)).optional(),
    notificationPolicy: z.object({ interruptAt: z.enum(['MEDIUM', 'HIGH', 'CRITICAL']), briefMin: z.enum(['MEDIUM', 'HIGH']), morningBrief: z.boolean() }).strict().optional(),
  })
  .strict();
const WatchPatch = z.object({ status: z.enum(['active', 'paused']) }).strict();
const WorkspacePatch = z
  .object({
    name: z.string().min(1).max(80).optional(),
    brief: z.object({ enabled: z.boolean(), time: z.string().regex(/^\d{2}:\d{2}$/), timezone: z.string().min(1).max(60) }).strict().optional(),
    planner: z.enum(['deterministic', 'llm']).optional(),
    aiEgressAllowed: z.boolean().optional(),
  })
  .strict();
const ImportUpload = z.object({ kind: z.enum(['metrics', 'issues', 'releases', 'changes', 'feedback']), filename: z.string().min(1).max(200), text: z.string().min(1).max(3_000_000) }).strict();
const Credential = z.record(z.string().max(64), z.string().max(8192)).refine((r) => Object.keys(r).length <= 10);
const ConnectBody = z.object({ provider: z.string().min(1).max(40), config: z.record(z.string(), z.unknown()).default({}), credential: Credential.optional() }).strict();
const ReconnectBody = z.object({ credential: Credential }).strict();
const CONNECTION_ERROR_STATUS: Record<ConnectionError['code'], number> = { unknown_provider: 400, invalid_config: 400, invalid_credential: 400, managed_by_environment: 409, not_found: 404, wrong_workspace_mode: 409 };
const WorkspaceBody = z.object({ name: z.string().min(1).max(80), mode: z.enum(['connected', 'imported']).default('connected') }).strict();

/** What a member sees of a workspace: never secret references or connection errors with provider detail beyond the message. */
function publicWorkspace(ws: Workspace) {
  const { importedExportIds: _i, ...rest } = ws;
  void _i;
  return rest;
}

export function createApp(rt: Runtime) {
  const secure = rt.config.secureCookies;
  let labReport: Promise<EvaluationLabReport> | undefined;

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
      // Sources a watch may use: the workspace's connections (connected) or its imported channels (imported).
      const connected = new Set(ws.mode === 'imported' ? (await sourcesForRun(rt, ws, rt.clock.now())).connections.filter((c) => c.state === 'imported').map((c) => c.provider as string) : (await rt.repos.connections.list(id)).filter((c) => c.roles.length).map((c) => c.source as string));
      const sources = body.data.sources ?? tpl.sources.filter((s) => connected.has(s));
      const unknown = sources.filter((s) => !connected.has(s));
      if (unknown.length || !sources.length) return json(400, { error: unknown.length ? `Not a source in this workspace: ${unknown.join(', ')}.` : 'None of this template’s sources is connected; pass sources explicitly.' });
      // Connected workspaces define their own metrics: keep the template's metric signals the sources serve.
      // Metrics configured for the template's area that the template does not name are added too.
      const served = ws.mode === 'connected' ? (await sourcesForRun(rt, ws, rt.clock.now())).registry.metrics(sources.filter((x): x is SourceId => isSourceId(x as ProviderId))) : undefined;
      const { templateId: _t, sources: _s, ...overrides } = body.data;
      void _t;
      void _s;
      const watch = watchFromTemplate(newId('watch'), tpl.id, { ...overrides, sources: sources as ProviderId[], metricKeys: served?.map((m) => m.def.key) }, rt.clock.now());
      for (const m of served ?? []) {
        const key = `metric:${m.def.key}` as const;
        if ((tpl.area === '*' || m.def.area === tpl.area) && !watch.signals.some((x) => x.key === key)) watch.signals.unshift({ key });
      }
      await rt.repos.watches.save(id, watch);
      await audit(id, p, 'watch.created', watch.id, tpl.name);
      return json(201, { watch });
    }
    if (section === 'watches' && req.method === 'PATCH' && sub) {
      const body = WatchPatch.safeParse(req.body);
      if (!body.success) return json(400, { error: 'Expected { status: "active" | "paused" }.' });
      const w = await rt.repos.watches.get(id, sub);
      if (!w) return json(404, { error: 'Watch not found.' });
      const next = { ...w, status: body.data.status, updatedAt: rt.clock.now() };
      await rt.repos.watches.save(id, next);
      await audit(id, p, `watch.${body.data.status === 'active' ? 'resumed' : 'paused'}`, sub);
      return json(200, { watch: next });
    }
    if (section === 'watches' && req.method === 'DELETE' && sub) {
      if (!(await rt.repos.watches.get(id, sub))) return json(404, { error: 'Watch not found.' });
      await rt.repos.watches.remove(id, sub);
      await audit(id, p, 'watch.removed', sub);
      return json(200, { ok: true });
    }
    // ── Connections: list / get / connect-configure / test / reconnect / disconnect ──
    if (section === 'connections') {
      const canManage = m.role === 'owner' || m.role === 'admin';
      const actor = { ref: p.user.id, displayName: p.user.displayName };
      try {
        if (!sub && req.method === 'GET') return json(200, { connections: await listConnections(rt, id) });
        if (!sub && req.method === 'PUT') {
          if (!canManage) return json(403, { error: 'Only workspace owners and admins can change connections.' });
          const body = ConnectBody.safeParse(req.body);
          if (!body.success) return json(400, { error: 'Expected { provider, config, credential? }.' });
          return json(200, await configureConnection({ ...rt, types: rt.types }, ws, actor, body.data));
        }
        const c = sub ? await rt.repos.connections.get(id, sub) : null;
        if (!c) return json(404, { error: 'Connection not found.' });
        const action = rest[2];
        if (!action && req.method === 'GET') return json(200, { connection: connectionView(c, rt.clock.now()) });
        if (action === 'check' && req.method === 'POST') {
          const result = await checkConnection(rt, id, c.id);
          await audit(id, p, 'connection.checked', c.id, result.state);
          return json(200, { check: result, connection: connectionView((await rt.repos.connections.get(id, c.id))!, rt.clock.now()) });
        }
        if (action === 'reconnect' && req.method === 'POST') {
          if (!canManage) return json(403, { error: 'Only workspace owners and admins can change connections.' });
          const body = ReconnectBody.safeParse(req.body);
          if (!body.success) return json(400, { error: 'Expected { credential }.' });
          return json(200, await reconnectConnection({ ...rt, types: rt.types }, ws, actor, c.id, body.data.credential));
        }
        if (!action && req.method === 'DELETE') {
          if (!canManage) return json(403, { error: 'Only workspace owners and admins can change connections.' });
          return json(200, { connection: await disconnectConnection({ ...rt, types: rt.types }, ws, actor, c.id) });
        }
      } catch (e) {
        if (e instanceof ConnectionError) return json(CONNECTION_ERROR_STATUS[e.code], { error: e.message, code: e.code });
        throw e;
      }
      return json(404, { error: 'Not found.' });
    }
    // Replay: the stored investigation only — no source is read, nothing re-runs.
    if (section === 'investigations' && sub && rest[2] === 'replay' && req.method === 'GET') {
      const inv = await rt.repos.investigations.get(id, sub);
      if (!inv) return json(404, { error: 'Investigation not found.' });
      const decisions = Object.fromEntries((await rt.repos.decisions.list(id)).map(({ actionId, decidedBy: _d, ...d }) => (void _d, [actionId, d])));
      const pass = req.query.pass ? Number(req.query.pass) : undefined;
      return json(200, replayInvestigation(inv, decisions, Number.isInteger(pass) ? pass : undefined));
    }
    // Run again: a NEW run of the investigation's watches over current data. Separate from replay.
    if (section === 'investigations' && sub && rest[2] === 'rerun' && req.method === 'POST') {
      const inv = await rt.repos.investigations.get(id, sub);
      if (!inv) return json(404, { error: 'Investigation not found.' });
      // Imported and sample data do not change, and re-running them replaces investigations: replay instead.
      if (ws.mode !== 'connected') return json(409, { error: 'This workspace’s data does not change, so running again would only repeat it. Use the replay of the original investigation.' });
      const at = rt.clock.now();
      let investigations = 0;
      // A new pass is appended to the investigation; the original passes stay as recorded.
      for (const watchId of inv.watchIds) investigations += (await runWatchJob(rt, { workspaceId: id, payload: { watchId, dueAt: at } })).investigations;
      await audit(id, p, 'investigation.rerun', inv.id);
      return json(200, { kind: 'run_again', at, investigations, note: 'A new run over current data. Its results can differ from the original investigation, which is kept as recorded.' });
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
      if (ws.mode === 'connected') {
        // "Run now" for live sources: the same scheduled-watch path, due now, for every active watch.
        const at = rt.clock.now();
        const active = (await rt.repos.watches.list(id)).filter((w) => w.status === 'active');
        let investigations = 0;
        for (const w of active) investigations += (await runWatchJob(rt, { workspaceId: id, payload: { watchId: w.id, dueAt: at } })).investigations;
        await audit(id, p, 'monitor.requested', undefined, `${active.length} watch(es)`);
        return json(200, { workspaceId: id, watches: active.length, investigations });
      }
      const summary = await runWorkspaceNow(rt, id);
      await audit(id, p, 'monitor.requested');
      return json(200, summary);
    }
    // The latest morning brief as a PM reads it (same view as the Briefs page).
    if (section === 'briefs' && sub === 'latest' && req.method === 'GET') {
      const briefs = await rt.repos.briefs.list(id);
      const latest = briefs[briefs.length - 1];
      if (!latest) return json(404, { error: 'No morning brief yet: one is composed at the workspace’s brief time.' });
      const decisions = Object.fromEntries((await rt.repos.decisions.list(id)).map(({ actionId, decidedBy: _d, ...d }) => (void _d, [actionId, d])));
      return json(200, briefView(latest, { investigations: await rt.repos.investigations.list(id), watches: await rt.repos.watches.list(id), decisions }));
    }
    if (section === 'snapshot' && req.method === 'GET') return json(200, await buildSnapshot(rt.repos, ws, m, rt.clock.now()));
    if (!section && req.method === 'PATCH') {
      if (m.role !== 'owner' && m.role !== 'admin') return json(403, { error: 'Only workspace owners and admins can change workspace settings.' });
      const body = WorkspacePatch.safeParse(req.body);
      if (!body.success) return json(400, { error: 'Invalid workspace settings.' });
      const { name, brief, planner, aiEgressAllowed } = body.data;
      const next = { ...ws, name: name ?? ws.name, brief: brief ?? ws.brief, settings: { ...ws.settings, ...(planner ? { planner } : {}), ...(aiEgressAllowed !== undefined ? { aiEgressAllowed } : {}) } };
      try {
        await rt.repos.workspaces.update(next, ws.version);
      } catch (e) {
        if (e instanceof WriteConflict) return json(409, { error: 'The workspace changed meanwhile; reload and try again.' });
        throw e;
      }
      await audit(id, p, 'workspace.updated', undefined, Object.keys(body.data).join(', '));
      return json(200, { workspace: publicWorkspace((await rt.repos.workspaces.get(id))!) });
    }
    if (section === 'imports' && req.method === 'POST' && !sub) {
      if (ws.mode !== 'imported') return json(409, { error: 'Only imported workspaces take uploaded data.' });
      const body = ImportUpload.safeParse(req.body);
      if (!body.success) return json(400, { error: 'Expected { kind, filename, text } (up to 3 MB).' });
      const at = rt.clock.now();
      const ds = importFile(body.data.kind, body.data.filename, body.data.text, at, newId(`imp-${body.data.kind}`));
      if (!ds.error) {
        await rt.repos.imports.save(id, ds);
        await audit(id, p, 'import.added', ds.id, `${ds.kind} · ${ds.totalRows} row(s), ${ds.rejected.length} rejected`);
      }
      return json(ds.error ? 422 : 201, { dataset: ds });
    }
    if (section === 'imports' && req.method === 'DELETE' && sub) {
      await rt.repos.imports.remove(id, sub);
      await audit(id, p, 'import.removed', sub);
      return json(200, { ok: true });
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
    // The Evaluation Lab as structured results (deterministic suites on fixtures; computed once per server instance).
    if (head === 'evaluations' && !a && req.method === 'GET') {
      labReport ??= evaluationLab(rt.clock.now()).catch((e) => {
        labReport = undefined;
        throw e;
      });
      return json(200, await labReport);
    }
    if (head === 'connection-types' && req.method === 'GET') return json(200, { types: Object.values(rt.types).map(typeInfo) });

    if (head === 'workspaces' && !a && req.method === 'GET') {
      const list = [];
      for (const mem of p.memberships) {
        const w = await rt.repos.workspaces.get(mem.workspaceId);
        if (w) list.push({ id: w.id, name: w.name, mode: w.mode, createdAt: w.createdAt, role: mem.role, canApprove: mem.canApprove });
      }
      return json(200, { workspaces: list });
    }
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
      if (e instanceof WorkspaceBusy) return json(409, { error: e.message, code: 'workspace_busy' });
      // Never echo internals (or anything that might carry a credential) to the client.
      console.error('[jagr api]', req.method, req.path, redactPersonalData(String((e as Error)?.message ?? e)).slice(0, 300));
      return json(500, { error: 'Internal error.' });
    }
  };
}
