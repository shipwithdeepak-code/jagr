import { describe, expect, it, vi } from 'vitest';

// The first PGlite instance loads Postgres (WASM) from disk; allow for a cold start.
vi.setConfig({ testTimeout: 30_000 });
import { randomBytes } from 'node:crypto';
import { freshPglite } from './pglite';
import { migrate, MIGRATIONS } from './migrations';
import { postgresPersistence } from './repositories';
import { postgresJobQueue } from './jobs';
import { postgresSecretStore } from './secrets';
import { envKeyProvider } from '../crypto/keys';
import { jobQueueContract, repositoriesContract, secretStoreContract } from '../../src/product/testkit/portContracts';

/**
 * The Postgres adapters pass exactly the same contract suites as the in-memory reference — run here
 * against real Postgres (PGlite: Postgres compiled to WASM, in-process).
 */

const keyEnv = () => ({ JAGR_SECRET_KEY: randomBytes(32).toString('base64') });
const db = async () => {
  const sql = await freshPglite();
  await migrate(sql);
  return sql;
};

repositoriesContract('Postgres', async () => postgresPersistence(await db()));
jobQueueContract('Postgres', async (clock) => postgresJobQueue(await db(), clock));
secretStoreContract('Postgres (envelope-encrypted)', async () => postgresSecretStore(await db(), envKeyProvider(keyEnv())));

describe('Postgres specifics', () => {
  it('migrations are ordered and idempotent', async () => {
    const sql = await freshPglite();
    expect(await migrate(sql)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(await migrate(sql)).toEqual([]);
  });

  it('002 backfills createdAt on connections stored before it, and leaves others alone', async () => {
    const sql = await freshPglite();
    await sql.exec('create table if not exists jagr_migrations (id text primary key, applied_at timestamptz not null default now())');
    await sql.transaction(async (c) => {
      await c.exec(MIGRATIONS[0].sql);
      await c.query('insert into jagr_migrations (id) values ($1)', [MIGRATIONS[0].id]);
    });
    await sql.query("insert into workspace_docs (workspace_id, collection, id, doc) values ('w', 'connections', 'old', $1::jsonb), ('w', 'connections', 'new', $2::jsonb), ('w', 'watches', 'x', $3::jsonb)", [
      JSON.stringify({ id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ id: 'new', updatedAt: '2026-02-01T00:00:00.000Z', createdAt: '2025-12-01T00:00:00.000Z' }),
      JSON.stringify({ id: 'x', updatedAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    expect(await migrate(sql)).toEqual(MIGRATIONS.slice(1).map((m) => m.id));
    const rows = (await sql.query<{ id: string; doc: { createdAt?: string } }>('select id, doc from workspace_docs order by id')).rows;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.doc.createdAt]))).toEqual({ new: '2025-12-01T00:00:00.000Z', old: '2026-01-01T00:00:00.000Z', x: undefined });
  });

  it('secrets are encrypted at rest: no plaintext secret or data key in the table', async () => {
    const sql = await db();
    const store = postgresSecretStore(sql, envKeyProvider(keyEnv()));
    const ref = await store.put({ workspaceId: 'ws', connectionId: 'c' }, { kind: 'api_key', fields: { apiKey: 'AMPLITUDE-KEY-123', secretKey: 'AMPLITUDE-SECRET-456' } });
    const row = JSON.stringify((await sql.query('select * from secrets where ref = $1', [ref])).rows);
    expect(row).not.toMatch(/AMPLITUDE-KEY-123|AMPLITUDE-SECRET-456|apiKey/);
  });

  it('tampering with the ciphertext fails decryption instead of returning garbage', async () => {
    const sql = await db();
    const store = postgresSecretStore(sql, envKeyProvider(keyEnv()));
    const ref = await store.put({ workspaceId: 'ws', connectionId: 'c' }, { kind: 'api_key', fields: { apiKey: 'k' } });
    const { ciphertext } = (await sql.query<{ ciphertext: string }>('select ciphertext from secrets where ref = $1', [ref])).rows[0];
    const flipped = Buffer.from(ciphertext, 'base64');
    flipped[0] ^= 0xff;
    await sql.query('update secrets set ciphertext = $2 where ref = $1', [ref, flipped.toString('base64')]);
    await expect(store.get(ref)).rejects.toThrow();
  });

  it('master-key rotation: old secrets still decrypt, new writes use the newest key', async () => {
    const sql = await db();
    const k1 = randomBytes(32).toString('base64');
    const k2 = randomBytes(32).toString('base64');
    const before = postgresSecretStore(sql, envKeyProvider({ JAGR_SECRET_KEYS: `1:${k1}` }));
    const ref = await before.put({ workspaceId: 'ws', connectionId: 'c' }, { kind: 'oauth', accessToken: 'a', refreshToken: 'r', scopes: [] });
    const after = postgresSecretStore(sql, envKeyProvider({ JAGR_SECRET_KEYS: `1:${k1},2:${k2}` }));
    expect((await after.get(ref)).secret).toMatchObject({ refreshToken: 'r' });
    await after.replace(ref, 1, { kind: 'oauth', accessToken: 'a2', refreshToken: 'r2', scopes: [] });
    expect((await sql.query<{ key_version: number }>('select key_version from secrets where ref = $1', [ref])).rows[0].key_version).toBe(2);
    await expect(postgresSecretStore(sql, envKeyProvider({ JAGR_SECRET_KEYS: `1:${k1}` })).get(ref)).rejects.toThrow(/version 2 is not configured/);
  });

  it('refuses to start without an encryption key', () => {
    expect(() => envKeyProvider({})).toThrow(/No secret-encryption key/);
    expect(() => envKeyProvider({ JAGR_SECRET_KEY: 'short' })).toThrow(/32 random bytes/);
  });
});
