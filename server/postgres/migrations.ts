import type { SqlClient } from './sql.js';

/**
 * Schema, as ordered migrations. Workspace data is stored as JSON documents keyed by
 * (workspace, collection, id): the domain shape lives in the core, not in columns. Typed columns
 * exist only where the database must enforce something (uniqueness, leases, versions).
 */
export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001_foundation',
    sql: `
      create table if not exists workspaces (id text primary key, doc jsonb not null, version integer not null, updated_at timestamptz not null default now());
      create table if not exists users (id text primary key, doc jsonb not null);
      create table if not exists identities (provider text not null, subject text not null, user_id text not null references users(id) on delete cascade, primary key (provider, subject));
      create table if not exists memberships (workspace_id text not null, user_id text not null, doc jsonb not null, primary key (workspace_id, user_id));
      create table if not exists sessions (id text primary key, user_id text not null, expires_at timestamptz not null, doc jsonb not null);
      create table if not exists workspace_docs (
        workspace_id text not null, collection text not null, id text not null, doc jsonb not null,
        updated_at timestamptz not null default now(), primary key (workspace_id, collection, id));
      create unique index if not exists workspace_notifications_dedupe on workspace_docs (workspace_id, (doc->>'channel'), (doc->>'dedupeKey')) where collection = 'notifications';
      create table if not exists audit_log (workspace_id text not null, id text not null, at timestamptz not null, doc jsonb not null, primary key (workspace_id, id));
      create table if not exists jobs (
        id text primary key, idempotency_key text not null unique, kind text not null, workspace_id text not null,
        payload jsonb not null, run_at timestamptz not null, attempts integer not null default 0, max_attempts integer not null,
        state text not null, lease_token text, lease_until timestamptz, last_error text, created_at timestamptz not null default now());
      create index if not exists jobs_due on jobs (state, run_at);
      create table if not exists secrets (
        ref text primary key, workspace_id text not null, connection_id text not null, version integer not null,
        key_version integer not null, wrapped_key text not null, iv text not null, tag text not null, ciphertext text not null,
        updated_at timestamptz not null default now());
    `,
  },
  {
    // Connections domain: every connection carries createdAt (records before it get their updatedAt).
    id: '002_connection_created_at',
    sql: `
      update workspace_docs set doc = jsonb_set(doc, '{createdAt}', doc->'updatedAt')
      where collection = 'connections' and doc ? 'updatedAt' and not doc ? 'createdAt';
    `,
  },
  {
    id: '003_organization_and_source_targets',
    sql: `
      create table if not exists organizations (id text primary key, doc jsonb not null, created_at timestamptz not null default now());
      create table if not exists organization_memberships (
        organization_id text not null references organizations(id) on delete cascade,
        user_id text not null references users(id) on delete cascade,
        doc jsonb not null,
        primary key (organization_id, user_id)
      );

      insert into organizations (id, doc)
      select 'org_' || id, jsonb_build_object('id', 'org_' || id, 'name', coalesce(doc->>'name', 'Organization'), 'createdAt', coalesce(doc->>'createdAt', updated_at::text))
      from workspaces on conflict (id) do nothing;

      update workspaces set doc = jsonb_set(doc, '{organizationId}', to_jsonb('org_' || id))
      where not doc ? 'organizationId';

      insert into organization_memberships (organization_id, user_id, doc)
      select w.doc->>'organizationId', m.user_id,
        jsonb_build_object('organizationId', w.doc->>'organizationId', 'userId', m.user_id,
          'role', case when m.doc->>'role' in ('owner', 'admin') then m.doc->>'role' else 'member' end)
      from memberships m join workspaces w on w.id = m.workspace_id
      on conflict (organization_id, user_id) do nothing;

      insert into workspace_docs (workspace_id, collection, id, doc)
      select workspace_id, 'source_targets', 'target-' || id,
        jsonb_build_object(
          'id', 'target-' || id,
          'workspaceId', workspace_id,
          'connectionId', id,
          'provider', coalesce(doc->>'provider', doc->>'source'),
          'externalId', 'legacy:' || id,
          'displayName', coalesce(doc#>>'{label,name}', doc->>'provider', doc->>'source'),
          'configuration', coalesce(doc->'config', '{}'::jsonb),
          'status', case when doc->>'state' in ('not_configured', 'needs_reconnect') then 'disconnected' else 'active' end,
          'createdAt', coalesce(doc->>'createdAt', doc->>'updatedAt'),
          'updatedAt', doc->>'updatedAt')
      from workspace_docs where collection = 'connections'
      on conflict (workspace_id, collection, id) do nothing;
    `,
  },
  {
    id: '004_job_lifecycle_timestamps',
    sql: `
      alter table jobs add column if not exists first_attempted_at timestamptz;
      alter table jobs add column if not exists last_attempted_at timestamptz;
      alter table jobs add column if not exists completed_at timestamptz;
      alter table jobs add column if not exists last_failed_at timestamptz;
      alter table jobs add column if not exists updated_at timestamptz not null default now();
    `,
  },
  {
    id: '005_source_target_tenant_scope',
    sql: `
      update workspace_docs targets
      set doc = jsonb_set(targets.doc, '{organizationId}', workspaces.doc->'organizationId'), updated_at = now()
      from workspaces
      where targets.workspace_id = workspaces.id
        and targets.collection = 'source_targets'
        and not targets.doc ? 'organizationId';
      update workspace_docs
      set doc = jsonb_set(doc, '{checkIntervalMinutes}', '15'::jsonb), updated_at = now()
      where collection = 'source_targets' and doc->>'provider' = 'sentry' and not doc ? 'checkIntervalMinutes';
    `,
  },
  {
    id: '006_normalized_event_reads',
    sql: `
      create index if not exists workspace_normalized_events_time
      on workspace_docs (workspace_id, (doc->>'occurredAt'), id)
      where collection = 'normalized_events';
    `,
  },
  {
    id: '007_saas_control_plane',
    sql: `
      create table if not exists subscriptions (
        organization_id text primary key references organizations(id) on delete cascade,
        doc jsonb not null,
        updated_at timestamptz not null default now()
      );
      insert into subscriptions (organization_id, doc)
      select id, jsonb_build_object(
        'organizationId', id,
        'planId', 'legacy',
        'status', 'active',
        'createdAt', coalesce(doc->>'createdAt', created_at::text),
        'updatedAt', now()::text
      ) from organizations on conflict (organization_id) do nothing;

      create table if not exists usage_events (
        organization_id text not null references organizations(id) on delete cascade,
        id text not null,
        workspace_id text,
        kind text not null,
        amount integer not null check (amount > 0),
        period_start timestamptz not null,
        period_end timestamptz not null,
        occurred_at timestamptz not null,
        doc jsonb not null,
        primary key (organization_id, id)
      );
      create index if not exists usage_events_period
      on usage_events (organization_id, kind, period_start, period_end);
      create index if not exists memberships_user on memberships (user_id, workspace_id);
      create index if not exists organization_memberships_user on organization_memberships (user_id, organization_id);
    `,
  },
  {
    id: '008_fair_job_claims',
    sql: `
      create table if not exists job_claim_sequence (
        id smallint primary key check (id = 1), next_turn bigint not null
      );
      insert into job_claim_sequence (id, next_turn) values (1, 0) on conflict (id) do nothing;
      create table if not exists job_tenant_turns (
        tenant_key text primary key, last_turn bigint not null
      );
      create index if not exists jobs_queued_due on jobs (run_at, id) where state = 'queued';
      create index if not exists jobs_expired_due on jobs (lease_until, run_at, id) where state = 'leased';
    `,
  },
  {
    id: '009_history_pages',
    sql: `
      create index if not exists workspace_investigations_history
      on workspace_docs (workspace_id, (doc->>'startedAt') desc, id desc)
      where collection = 'investigations';
      create index if not exists workspace_investigations_updated
      on workspace_docs (workspace_id, (doc->>'updatedAt'))
      where collection = 'investigations';
      create index if not exists workspace_investigations_actions
      on workspace_docs using gin ((doc->'actions'))
      where collection = 'investigations';
      create index if not exists workspace_notifications_history
      on workspace_docs (workspace_id, (doc->>'deliveredAt') desc, id desc)
      where collection = 'notifications';
      create index if not exists workspace_notifications_investigation_email
      on workspace_docs (workspace_id, (doc->>'investigationId'), id)
      where collection = 'notifications' and doc->>'channel' = 'in_app' and doc ? 'email';
      create index if not exists workspace_briefs_history
      on workspace_docs (workspace_id, (doc->>'generatedAt') desc, id desc)
      where collection = 'briefs';
      create index if not exists audit_log_history on audit_log (workspace_id, at desc, id desc);
      create index if not exists audit_log_watch_runs on audit_log (workspace_id, at desc, id desc)
      where doc->>'action' = 'monitor.watch' and doc->>'target' is not null;
    `,
  },
];

export async function migrate(sql: SqlClient): Promise<string[]> {
  await sql.exec('create table if not exists jagr_migrations (id text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await sql.query<{ id: string }>('select id from jagr_migrations')).rows.map((r) => r.id));
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await sql.transaction(async (c) => {
      await c.exec(m.sql);
      await c.query('insert into jagr_migrations (id) values ($1)', [m.id]);
    });
    applied.push(m.id);
  }
  return applied;
}
