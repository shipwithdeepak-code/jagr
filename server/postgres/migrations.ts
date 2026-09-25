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
