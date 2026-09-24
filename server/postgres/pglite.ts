import type { PGlite, Transaction } from '@electric-sql/pglite';
import type { SqlClient } from './sql';

/** PGlite (Postgres compiled to WASM, in-process) behind the same SqlClient. Tests and local development only. */
export function pgliteClient(db: PGlite): SqlClient {
  const inTx = (tx: Transaction): SqlClient => {
    const self: SqlClient = {
      query: async (text, params) => ({ rows: (await tx.query(text, params as unknown[])).rows as never[] }),
      exec: async (sql) => void (await tx.exec(sql)),
      transaction: (fn) => fn(self),
    };
    return self;
  };
  return {
    query: async (text, params) => ({ rows: (await db.query(text, params as unknown[])).rows as never[] }),
    exec: async (sql) => void (await db.exec(sql)),
    transaction: (fn) => db.transaction((tx) => fn(inTx(tx))),
  };
}

export async function freshPglite(): Promise<SqlClient> {
  const { PGlite } = await import('@electric-sql/pglite');
  return pgliteClient(new PGlite());
}
