import type { Pool, PoolClient } from 'pg';

/**
 * The only database surface the Postgres adapters use. Two implementations: a `pg` Pool (production)
 * and PGlite (in-process Postgres, tests and local development) — same SQL, same behaviour.
 */
export interface SqlClient {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  /** Several statements, no parameters (migrations). */
  exec(sql: string): Promise<void>;
  /** Runs `fn` in one transaction. Inside a transaction, nested calls join the outer one. */
  transaction<T>(fn: (c: SqlClient) => Promise<T>): Promise<T>;
}

function clientAdapter(c: PoolClient): SqlClient {
  const self: SqlClient = {
    query: async (text, params) => ({ rows: (await c.query(text, params as unknown[])).rows }),
    exec: async (sql) => void (await c.query(sql)),
    transaction: (fn) => fn(self),
  };
  return self;
}

export function pgClient(pool: Pool): SqlClient {
  return {
    query: async (text, params) => ({ rows: (await pool.query(text, params as unknown[])).rows }),
    exec: async (sql) => void (await pool.query(sql)),
    transaction: async (fn) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn(clientAdapter(c));
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    },
  };
}
