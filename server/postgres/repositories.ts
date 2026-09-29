import type { AuditEntry, Connection, Decision, MetricDefinitionRecord, Membership, NotificationRecord, Organization, OrganizationMembership, Repositories, Session, SourceState, SourceTarget, Transactor, User, Workspace } from '../../src/product/ports/persistence.js';
import { NORMALIZED_EVENT_READ_LIMIT, NotFound, WriteConflict } from '../../src/product/ports/persistence.js';
import type { MorningBriefDoc, Watch, WatchInvestigation } from '../../src/product/types.js';
import type { ImportedDataset } from '../../src/product/imports/schemas.js';
import type { NormalizedEvent } from '../../src/product/events.js';
import type { Subscription, UsageEvent } from '../../src/product/ports/controlPlane.js';
import type { SqlClient } from './sql.js';
import { decodeHistoryCursor, historyPage, pageSize, type HistoryQuery, type HistoryScope } from '../../src/product/ports/history.js';

/** Postgres implementation of the Repositories port. Every workspace query is scoped by workspace id. */

type Doc = { doc: unknown };
const json = (v: unknown) => JSON.stringify(v);

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function collection<T>(sql: SqlClient, name: string) {
  return {
    async list(w: string): Promise<T[]> {
      return (await sql.query<Doc>('select doc from workspace_docs where workspace_id = $1 and collection = $2 order by id', [w, name])).rows.map((r) => r.doc as T);
    },
    async get(w: string, id: string): Promise<T | null> {
      return ((await sql.query<Doc>('select doc from workspace_docs where workspace_id = $1 and collection = $2 and id = $3', [w, name, id])).rows[0]?.doc as T) ?? null;
    },
    async put(w: string, id: string, doc: T): Promise<void> {
      await sql.query('insert into workspace_docs (workspace_id, collection, id, doc) values ($1, $2, $3, $4::jsonb) on conflict (workspace_id, collection, id) do update set doc = excluded.doc, updated_at = now()', [w, name, id, json(doc)]);
    },
    async remove(w: string, id: string): Promise<void> {
      await sql.query('delete from workspace_docs where workspace_id = $1 and collection = $2 and id = $3', [w, name, id]);
    },
  };
}

export function postgresRepositories(sql: SqlClient): Repositories {
  const assertHistoryScope = async (scope: HistoryScope) => {
    const found = await sql.query("select 1 from workspaces where id = $1 and doc->>'organizationId' = $2", [scope.workspaceId, scope.organizationId]);
    if (!found.rows.length) throw new NotFound('Workspace');
  };
  const pageDocs = async <T>(scope: HistoryScope, collectionName: string, keyExpression: string, keyOf: (item: T) => string, idOf: (item: T) => string, query: HistoryQuery = {}) => {
    const position = decodeHistoryCursor(query.cursor, scope, collectionName);
    await assertHistoryScope(scope);
    const rows = await sql.query<Doc>(
      `select d.doc from workspace_docs d join workspaces w on w.id = d.workspace_id
       where d.workspace_id = $1 and d.collection = $2 and w.doc->>'organizationId' = $3
         and ($4::text is null or (${keyExpression}, d.id) < ($4::text, $5::text))
       order by ${keyExpression} desc, d.id desc limit $6`,
      [scope.workspaceId, collectionName, scope.organizationId, position?.key ?? null, position?.id ?? null, pageSize(query.limit) + 1],
    );
    return historyPage(rows.rows.map((row) => row.doc as T), scope, collectionName, keyOf, idOf, query.limit);
  };
  const connections = collection<Connection>(sql, 'connections');
  const sourceTargets = collection<SourceTarget>(sql, 'source_targets');
  const sourceStates = collection<SourceState>(sql, 'source_states');
  const metricDefs = collection<MetricDefinitionRecord>(sql, 'metric_defs');
  const watches = collection<Watch>(sql, 'watches');
  const imports = collection<ImportedDataset>(sql, 'imports');
  const investigations = collection<WatchInvestigation>(sql, 'investigations');
  const decisions = collection<Decision>(sql, 'decisions');
  const notifications = collection<NotificationRecord>(sql, 'notifications');
  const cursors = collection<{ value: string }>(sql, 'cursors');
  const briefs = collection<MorningBriefDoc>(sql, 'briefs');

  return {
    organizations: {
      get: async (id) => ((await sql.query<Doc>('select doc from organizations where id = $1', [id])).rows[0]?.doc as Organization) ?? null,
      create: async (o) => {
        await sql.transaction(async (c) => {
          const r = await c.query('insert into organizations (id, doc) values ($1, $2::jsonb) on conflict (id) do nothing returning id', [o.id, json(o)]);
          if (!r.rows.length) throw new WriteConflict(`Organization ${o.id}`);
          const subscription: Subscription = { organizationId: o.id, planId: 'legacy', status: 'active', createdAt: o.createdAt, updatedAt: o.createdAt };
          await c.query('insert into subscriptions (organization_id, doc) values ($1, $2::jsonb)', [o.id, json(subscription)]);
        });
      },
    },
    organizationMembers: {
      forUser: async (userId) => (await sql.query<Doc>('select doc from organization_memberships where user_id = $1 order by organization_id', [userId])).rows.map((r) => r.doc as OrganizationMembership),
      get: async (organizationId, userId) => ((await sql.query<Doc>('select doc from organization_memberships where organization_id = $1 and user_id = $2', [organizationId, userId])).rows[0]?.doc as OrganizationMembership) ?? null,
      add: async (m) => void (await sql.query('insert into organization_memberships (organization_id, user_id, doc) values ($1, $2, $3::jsonb) on conflict (organization_id, user_id) do update set doc = excluded.doc', [m.organizationId, m.userId, json(m)])),
    },
    workspaces: {
      get: async (id) => ((await sql.query<Doc>('select doc from workspaces where id = $1', [id])).rows[0]?.doc as Workspace) ?? null,
      list: async () => (await sql.query<Doc>('select doc from workspaces order by id')).rows.map((r) => r.doc as Workspace),
      listForScheduler: async (limit) => (await sql.query<Doc>(
        `select w.doc from workspaces w
         left join workspace_docs c on c.workspace_id = w.id and c.collection = 'cursors' and c.id = 'scheduler.last_attempt'
         where w.doc->>'mode' = 'connected'
         order by coalesce(c.doc->>'value', ''), w.id limit $1`,
        [Math.max(0, Math.min(limit, 100))],
      )).rows.map((r) => r.doc as Workspace),
      listForOrganization: async (organizationId) => (await sql.query<Doc>("select doc from workspaces where doc->>'organizationId' = $1 order by id", [organizationId])).rows.map((r) => r.doc as Workspace),
      countForOrganization: async (organizationId) => Number((await sql.query<{ count: string }>("select count(*)::text as count from workspaces where doc->>'organizationId' = $1", [organizationId])).rows[0]?.count ?? 0),
      create: async (w) => {
        const r = await sql.query('insert into workspaces (id, doc, version) values ($1, $2::jsonb, $3) on conflict (id) do nothing returning id', [w.id, json(w), w.version]);
        if (!r.rows.length) throw new WriteConflict(`Workspace ${w.id}`);
      },
      update: async (w, expectedVersion) => {
        const next = { ...w, version: expectedVersion + 1 };
        const r = await sql.query('update workspaces set doc = $2::jsonb, version = $3, updated_at = now() where id = $1 and version = $4 returning id', [w.id, json(next), expectedVersion + 1, expectedVersion]);
        if (!r.rows.length) throw new WriteConflict(`Workspace ${w.id}`);
      },
    },
    users: {
      get: async (id) => ((await sql.query<Doc>('select doc from users where id = $1', [id])).rows[0]?.doc as User) ?? null,
      byIdentity: async (provider, subject) => ((await sql.query<Doc>('select u.doc from identities i join users u on u.id = i.user_id where i.provider = $1 and i.subject = $2', [provider, subject])).rows[0]?.doc as User) ?? null,
      create: (u, identity) =>
        sql.transaction(async (c) => {
          const taken = await c.query('select 1 from identities where provider = $1 and subject = $2', [identity.provider, identity.subject]);
          if (taken.rows.length) throw new WriteConflict('Identity');
          await c.query('insert into users (id, doc) values ($1, $2::jsonb)', [u.id, json(u)]);
          await c.query('insert into identities (provider, subject, user_id) values ($1, $2, $3)', [identity.provider, identity.subject, u.id]);
        }),
    },
    members: {
      forUser: async (userId) => (await sql.query<Doc>('select doc from memberships where user_id = $1 order by workspace_id', [userId])).rows.map((r) => r.doc as Membership),
      forWorkspace: async (workspaceId) => (await sql.query<Doc>('select doc from memberships where workspace_id = $1 order by user_id', [workspaceId])).rows.map((r) => r.doc as Membership),
      add: async (m) => {
        await sql.transaction(async (c) => {
          await c.query('insert into memberships (workspace_id, user_id, doc) values ($1, $2, $3::jsonb) on conflict (workspace_id, user_id) do update set doc = excluded.doc', [m.workspaceId, m.userId, json(m)]);
          const workspace = (await c.query<Doc>('select doc from workspaces where id = $1', [m.workspaceId])).rows[0]?.doc as Workspace | undefined;
          if (workspace?.organizationId) {
            const role = m.role === 'owner' || m.role === 'admin' ? m.role : 'member';
            const orgMember: OrganizationMembership = { organizationId: workspace.organizationId, userId: m.userId, role };
            await c.query('insert into organization_memberships (organization_id, user_id, doc) values ($1, $2, $3::jsonb) on conflict (organization_id, user_id) do nothing', [workspace.organizationId, m.userId, json(orgMember)]);
          }
        });
      },
    },
    sessions: {
      create: async (s) => void (await sql.query('insert into sessions (id, user_id, expires_at, doc) values ($1, $2, $3, $4::jsonb)', [s.id, s.userId, s.expiresAt, json(s)])),
      get: async (id) => ((await sql.query<Doc>('select doc from sessions where id = $1', [id])).rows[0]?.doc as Session) ?? null,
      revoke: async (id) => void (await sql.query('delete from sessions where id = $1', [id])),
    },
    connections: {
      list: (w) => connections.list(w),
      get: (w, id) => connections.get(w, id),
      save: async (w, c) => {
        if (c.workspaceId !== w) throw new WriteConflict('Connection workspace');
        await connections.put(w, c.id, c);
      },
      remove: (w, id) => connections.remove(w, id),
    },
    sourceTargets: {
      list: (w) => sourceTargets.list(w),
      get: (w, id) => sourceTargets.get(w, id),
      save: async (w, target) => {
        const workspace = (await sql.query<Doc>('select doc from workspaces where id = $1', [w])).rows[0]?.doc as Workspace | undefined;
        const connection = await connections.get(w, target.connectionId);
        if (target.workspaceId !== w || !workspace?.organizationId || target.organizationId !== workspace.organizationId || connection?.workspaceId !== w) throw new WriteConflict('Source target scope');
        await sourceTargets.put(w, target.id, target);
      },
      countForOrganization: async (organizationId) => Number((await sql.query<{ count: string }>(
        "select count(*)::text as count from workspace_docs d join workspaces w on w.id = d.workspace_id where d.collection = 'source_targets' and w.doc->>'organizationId' = $1 and d.doc->>'organizationId' = $1",
        [organizationId],
      )).rows[0]?.count ?? 0),
    },
    sourceStates: {
      get: (w, id) => sourceStates.get(w, id),
      save: async (w, state) => {
        const target = await sourceTargets.get(w, state.sourceTargetId);
        if (!target || state.workspaceId !== w || state.organizationId !== target.organizationId || state.provider !== target.provider) throw new NotFound('Source target');
        await sourceStates.put(w, state.sourceTargetId, state);
      },
    },
    events: {
      list: async (scope, query = {}) => {
        const limit = Math.max(1, Math.min(query.limit ?? NORMALIZED_EVENT_READ_LIMIT, NORMALIZED_EVENT_READ_LIMIT));
        const r = await sql.query<Doc>(
          `select e.doc from workspace_docs e join workspaces w on w.id = e.workspace_id
           where e.workspace_id = $1 and e.collection = 'normalized_events'
             and w.doc->>'organizationId' = $2 and e.doc->>'organizationId' = $2
             and ($3::text is null or e.doc->>'sourceTargetId' = $3)
             and ($4::text is null or e.doc->>'type' = $4)
             and ($5::text is null or e.doc->>'occurredAt' >= $5)
             and ($6::text is null or e.doc->>'occurredAt' <= $6)
           order by e.doc->>'occurredAt', e.id limit $7`,
          [scope.workspaceId, scope.organizationId, query.sourceTargetId ?? null, query.type ?? null, query.from ?? null, query.to ?? null, limit],
        );
        return r.rows.map((row) => row.doc as NormalizedEvent);
      },
      get: async (scope, id) => ((await sql.query<Doc>(
        `select e.doc from workspace_docs e join workspaces w on w.id = e.workspace_id
         where e.workspace_id = $1 and e.collection = 'normalized_events' and e.id = $2
           and w.doc->>'organizationId' = $3 and e.doc->>'organizationId' = $3`,
        [scope.workspaceId, id, scope.organizationId],
      )).rows[0]?.doc as NormalizedEvent) ?? null,
      forWatchSlot: async (scope, watchId, runAt, requestedLimit) => {
        const limit = Math.max(1, Math.min(requestedLimit ?? NORMALIZED_EVENT_READ_LIMIT, NORMALIZED_EVENT_READ_LIMIT));
        const r = await sql.query<Doc>(
          `select e.doc from workspace_docs e
             join workspaces w on w.id = e.workspace_id
             join workspace_docs c on c.workspace_id = e.workspace_id and c.collection = 'cursors'
               and c.id = 'source-event:' || e.id || ':watch:' || $3 and c.doc->>'value' = $4
           where e.workspace_id = $1 and e.collection = 'normalized_events'
             and w.doc->>'organizationId' = $2 and e.doc->>'organizationId' = $2
           order by e.doc->>'occurredAt', e.id limit $5`,
          [scope.workspaceId, scope.organizationId, watchId, runAt, limit],
        );
        return r.rows.map((row) => row.doc as NormalizedEvent);
      },
      add: async (w, event) => {
        const target = await sourceTargets.get(w, event.sourceTargetId);
        if (!target || event.workspaceId !== w || event.organizationId !== target.organizationId || event.connectionId !== target.connectionId || event.provider !== target.provider) throw new NotFound('Source target');
        return (await sql.query("insert into workspace_docs (workspace_id, collection, id, doc) values ($1, 'normalized_events', $2, $3::jsonb) on conflict do nothing returning id", [w, event.eventId, json(event)])).rows.length > 0;
      },
    },
    metricDefs: { list: (w) => metricDefs.list(w), save: (w, d) => metricDefs.put(w, d.key, d) },
    watches: {
      list: (w) => watches.list(w),
      get: (w, id) => watches.get(w, id),
      save: async (w, x) => {
        const workspace = (await sql.query<Doc>('select doc from workspaces where id = $1', [w])).rows[0]?.doc as Workspace | undefined;
        for (const id of x.sourceTargetIds ?? []) {
          const target = await sourceTargets.get(w, id);
          if (!target || target.workspaceId !== w || !workspace?.organizationId || target.organizationId !== workspace.organizationId) throw new NotFound('Source target');
        }
        await watches.put(w, x.id, x);
      },
      remove: (w, id) => watches.remove(w, id),
      countForOrganization: async (organizationId) => Number((await sql.query<{ count: string }>(
        "select count(*)::text as count from workspace_docs d join workspaces w on w.id = d.workspace_id where d.collection = 'watches' and w.doc->>'organizationId' = $1",
        [organizationId],
      )).rows[0]?.count ?? 0),
    },
    subscriptions: {
      get: async (organizationId) => ((await sql.query<Doc>('select doc from subscriptions where organization_id = $1', [organizationId])).rows[0]?.doc as Subscription) ?? null,
      lock: async (organizationId, at) => {
        await sql.query(
          "insert into subscriptions (organization_id, doc) select id, jsonb_build_object('organizationId', id, 'planId', 'legacy', 'status', 'active', 'createdAt', $2::text, 'updatedAt', $2::text) from organizations where id = $1 on conflict (organization_id) do nothing",
          [organizationId, at],
        );
        const subscription = (await sql.query<Doc>('select doc from subscriptions where organization_id = $1 for update', [organizationId])).rows[0]?.doc as Subscription | undefined;
        if (!subscription) throw new NotFound('Organization');
        return subscription;
      },
      save: async (subscription) => {
        const r = await sql.query('insert into subscriptions (organization_id, doc) values ($1, $2::jsonb) on conflict (organization_id) do update set doc = excluded.doc, updated_at = now() returning organization_id', [subscription.organizationId, json(subscription)]);
        if (!r.rows.length) throw new NotFound('Organization');
      },
    },
    usage: {
      get: async (organizationId, id) => ((await sql.query<Doc>('select doc from usage_events where organization_id = $1 and id = $2', [organizationId, id])).rows[0]?.doc as UsageEvent) ?? null,
      add: async (event) => (await sql.query(
        `insert into usage_events (organization_id, id, workspace_id, kind, amount, period_start, period_end, occurred_at, doc)
         select $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb
         where $3::text is null or exists (select 1 from workspaces where id = $3 and doc->>'organizationId' = $1)
         on conflict (organization_id, id) do nothing returning id`,
        [event.organizationId, event.id, event.workspaceId ?? null, event.kind, event.amount, event.periodStart, event.periodEnd, event.occurredAt, json(event)],
      )).rows.length > 0,
      sum: async (organizationId, kind, periodStart, periodEnd, workspaceId) => Number((await sql.query<{ total: string }>(
        'select coalesce(sum(amount), 0)::text as total from usage_events where organization_id = $1 and kind = $2 and period_start = $3 and period_end = $4 and ($5::text is null or workspace_id = $5)',
        [organizationId, kind, periodStart, periodEnd, workspaceId ?? null],
      )).rows[0]?.total ?? 0),
    },
    imports: { list: (w) => imports.list(w), page: (scope, query) => pageDocs<ImportedDataset>(scope, 'imports', 'd.id', (item) => item.id, (item) => item.id, query), save: (w, d) => imports.put(w, d.id, d), remove: (w, id) => imports.remove(w, id) },
    investigations: {
      list: (w) => investigations.list(w),
      page: (scope, query) => pageDocs<WatchInvestigation>(scope, 'investigations', "d.doc->>'startedAt'", (item) => item.startedAt, (item) => item.id, query),
      pageForBriefWindow: async (scope, since, at, query = {}) => {
        const collectionName = `brief-investigations:${since}:${at}`;
        const position = decodeHistoryCursor(query.cursor, scope, collectionName);
        await assertHistoryScope(scope);
        const rows = await sql.query<Doc>(
          `select d.doc from workspace_docs d join workspaces w on w.id = d.workspace_id
           where d.workspace_id = $1 and d.collection = 'investigations' and w.doc->>'organizationId' = $7
             and ((d.doc->>'updatedAt' between $2 and $3) or (d.doc->>'startedAt' between $2 and $3))
             and ($4::text is null or (d.doc->>'startedAt', d.id) < ($4::text, $5::text))
           order by d.doc->>'startedAt' desc, d.id desc limit $6`,
          [scope.workspaceId, since, at, position?.key ?? null, position?.id ?? null, pageSize(query.limit) + 1, scope.organizationId],
        );
        return historyPage(rows.rows.map((row) => row.doc as WatchInvestigation), scope, collectionName, (item) => item.startedAt, (item) => item.id, query.limit);
      },
      findByActionId: async (w, actionId) => ((await sql.query<Doc>(
        "select doc from workspace_docs where workspace_id = $1 and collection = 'investigations' and doc->'actions' @> $2::jsonb order by id limit 1",
        [w, json([{ id: actionId }])],
      )).rows[0]?.doc as WatchInvestigation) ?? null,
      get: (w, id) => investigations.get(w, id),
      save: (w, inv) => investigations.put(w, inv.id, inv),
    },
    decisions: {
      list: (w) => decisions.list(w),
      page: (scope, query) => pageDocs<Decision>(scope, 'decisions', 'd.id', (item) => item.actionId, (item) => item.actionId, query),
      get: (w, id) => decisions.get(w, id),
      put: (w, d, expected) =>
        sql.transaction(async (c) => {
          if (expected !== undefined) {
            const cur = (await c.query<Doc>("select doc from workspace_docs where workspace_id = $1 and collection = 'decisions' and id = $2 for update", [w, d.actionId])).rows[0]?.doc ?? null;
            if (!deepEqual(cur, expected ?? null)) throw new WriteConflict(`Decision on ${d.actionId}`);
          }
          await collection<Decision>(c, 'decisions').put(w, d.actionId, d);
        }),
    },
    locks: {
      acquire: async (w, key, owner, until, now) =>
        (
          await sql.query(
            "insert into workspace_docs (workspace_id, collection, id, doc) values ($1, 'locks', $2, $3::jsonb) on conflict (workspace_id, collection, id) do update set doc = excluded.doc, updated_at = now() where workspace_docs.doc->>'until' <= $4 or workspace_docs.doc->>'owner' = $5 returning id",
            [w, key, json({ owner, until }), now, owner],
          )
        ).rows.length > 0,
      renew: async (w, key, owner, until, now) =>
        (
          await sql.query(
            "update workspace_docs set doc = $4::jsonb, updated_at = now() where workspace_id = $1 and collection = 'locks' and id = $2 and doc->>'owner' = $3 and doc->>'until' > $5 returning id",
            [w, key, owner, json({ owner, until }), now],
          )
        ).rows.length > 0,
      release: async (w, key, owner) => void (await sql.query("delete from workspace_docs where workspace_id = $1 and collection = 'locks' and id = $2 and doc->>'owner' = $3", [w, key, owner])),
    },
    notifications: {
      list: (w) => notifications.list(w),
      page: (scope, query) => pageDocs<NotificationRecord>(scope, 'notifications', "d.doc->>'deliveredAt'", (item) => item.deliveredAt, (item) => item.id, query),
      pageForBriefWindow: async (scope, since, at, query = {}) => {
        const collectionName = `brief-notifications:${since}:${at}`;
        const position = decodeHistoryCursor(query.cursor, scope, collectionName);
        await assertHistoryScope(scope);
        const rows = await sql.query<Doc>(
          `select d.doc from workspace_docs d join workspaces w on w.id = d.workspace_id
           where d.workspace_id = $1 and d.collection = 'notifications' and w.doc->>'organizationId' = $7
             and d.doc->>'channel' = 'in_app' and d.doc ? 'email'
             and d.doc->>'deliveredAt' between $2 and $3
             and ($4::text is null or (d.doc->>'deliveredAt', d.id) < ($4::text, $5::text))
           order by d.doc->>'deliveredAt' desc, d.id desc limit $6`,
          [scope.workspaceId, since, at, position?.key ?? null, position?.id ?? null, pageSize(query.limit) + 1, scope.organizationId],
        );
        return historyPage(rows.rows.map((row) => row.doc as NotificationRecord), scope, collectionName, (item) => item.deliveredAt, (item) => item.id, query.limit);
      },
      firstEmailForInvestigation: async (w, investigationId) => ((await sql.query<Doc>(
        "select doc from workspace_docs where workspace_id = $1 and collection = 'notifications' and doc->>'channel' = 'in_app' and doc ? 'email' and doc->>'investigationId' = $2 order by id limit 1",
        [w, investigationId],
      )).rows[0]?.doc as NotificationRecord) ?? null,
      byDedupe: async (w, channel, dedupeKey) => ((await sql.query<Doc>("select doc from workspace_docs where workspace_id = $1 and collection = 'notifications' and doc->>'channel' = $2 and doc->>'dedupeKey' = $3 limit 1", [w, channel, dedupeKey])).rows[0]?.doc as NotificationRecord) ?? null,
      settle: (w, n) => notifications.put(w, n.id, n),
      add: async (w, n) => (await sql.query("insert into workspace_docs (workspace_id, collection, id, doc) values ($1, 'notifications', $2, $3::jsonb) on conflict do nothing returning id", [w, n.id, json(n)])).rows.length > 0,
    },
    briefs: {
      list: async (w) => (await briefs.list(w)).sort((a, b) => a.generatedAt.localeCompare(b.generatedAt)),
      page: (scope, query) => pageDocs<MorningBriefDoc>(scope, 'briefs', "d.doc->>'generatedAt'", (item) => item.generatedAt, (item) => item.id, query),
      save: (w, b) => briefs.put(w, b.id, b),
    },
    cursors: {
      get: async (w, key) => (await cursors.get(w, key))?.value ?? null,
      set: (w, key, value) => cursors.put(w, key, { value }),
    },
    audit: {
      append: async (e: AuditEntry) => void (await sql.query('insert into audit_log (workspace_id, id, at, doc) values ($1, $2, $3, $4::jsonb) on conflict do nothing', [e.workspaceId, e.id, e.at, json(e)])),
      list: async (w) => (await sql.query<Doc>('select doc from audit_log where workspace_id = $1 order by at, id', [w])).rows.map((r) => r.doc as AuditEntry),
      page: async (scope, query = {}) => {
        const position = decodeHistoryCursor(query.cursor, scope, 'audit');
        await assertHistoryScope(scope);
        const rows = await sql.query<Doc>(
          `select a.doc from audit_log a join workspaces w on w.id = a.workspace_id
           where a.workspace_id = $1 and w.doc->>'organizationId' = $2
             and ($3::timestamptz is null or (a.at, a.id) < ($3::timestamptz, $4::text))
           order by a.at desc, a.id desc limit $5`,
          [scope.workspaceId, scope.organizationId, position?.key ?? null, position?.id ?? null, pageSize(query.limit) + 1],
        );
        return historyPage(rows.rows.map((row) => row.doc as AuditEntry), scope, 'audit', (item) => item.at, (item) => item.id, query.limit);
      },
      recentWatchRuns: async (scope, requestedLimit) => {
        await assertHistoryScope(scope);
        const rows = await sql.query<Doc>(
          `select a.doc from audit_log a where a.workspace_id = $1
             and a.doc->>'action' = 'monitor.watch' and a.doc->>'target' is not null
           order by a.at desc, a.id desc limit $2`,
          [scope.workspaceId, pageSize(requestedLimit)],
        );
        return rows.rows.map((row) => row.doc as AuditEntry).reverse();
      },
    },
  };
}

export function postgresPersistence(sql: SqlClient): { repos: Repositories; tx: Transactor } {
  return { repos: postgresRepositories(sql), tx: {
    run: (fn) => sql.transaction((c) => fn(postgresRepositories(c))),
    readSnapshot: (fn) => sql.transaction(async (c) => {
      await c.exec('set transaction isolation level repeatable read read only');
      return fn(postgresRepositories(c));
    }),
  } };
}
