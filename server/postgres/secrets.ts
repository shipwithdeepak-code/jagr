import { randomBytes, randomUUID } from 'node:crypto';
import type { SecretPayload, SecretRef, SecretStore } from '../../src/product/ports/secrets.js';
import { SecretNotFound, SecretVersionConflict } from '../../src/product/ports/secrets.js';
import { open, seal, type KeyProvider } from '../crypto/keys.js';
import type { SqlClient } from './sql.js';

/**
 * Encrypted secret store (Postgres). Envelope encryption: every secret gets its own random data key
 * (AES-256-GCM); the data key is itself encrypted ("wrapped") with the current master key. The
 * database never holds a plaintext secret or a plaintext data key; rotating the master key only
 * re-wraps data keys. Decrypted secrets exist only inside the call that asked for them.
 */
export function postgresSecretStore(sql: SqlClient, keys: KeyProvider): SecretStore {
  const encrypt = (secret: SecretPayload) => {
    const dataKey = randomBytes(32);
    const body = seal(dataKey, Buffer.from(JSON.stringify(secret), 'utf8'));
    const keyVersion = keys.currentVersion();
    const wrapped = seal(keys.key(keyVersion), dataKey);
    return { keyVersion, wrappedKey: JSON.stringify(wrapped), ...body };
  };
  return {
    async put(owner, secret) {
      const ref = `sec_${randomUUID()}` as SecretRef;
      const e = encrypt(secret);
      await sql.query('insert into secrets (ref, workspace_id, connection_id, version, key_version, wrapped_key, iv, tag, ciphertext) values ($1, $2, $3, 1, $4, $5, $6, $7, $8)', [ref, owner.workspaceId, owner.connectionId, e.keyVersion, e.wrappedKey, e.iv, e.tag, e.ciphertext]);
      return ref;
    },
    async get(ref, owner) {
      const r = (await sql.query<{ version: number; key_version: number; wrapped_key: string; iv: string; tag: string; ciphertext: string }>('select version, key_version, wrapped_key, iv, tag, ciphertext from secrets where ref = $1 and workspace_id = $2 and connection_id = $3', [ref, owner.workspaceId, owner.connectionId])).rows[0];
      if (!r) throw new SecretNotFound();
      const dataKey = open(keys.key(r.key_version), JSON.parse(r.wrapped_key));
      return { secret: JSON.parse(open(dataKey, r).toString('utf8')) as SecretPayload, version: r.version };
    },
    async replace(ref, owner, expectedVersion, secret) {
      const e = encrypt(secret);
      const r = await sql.query('update secrets set version = version + 1, key_version = $5, wrapped_key = $6, iv = $7, tag = $8, ciphertext = $9, updated_at = now() where ref = $1 and workspace_id = $2 and connection_id = $3 and version = $4 returning ref', [ref, owner.workspaceId, owner.connectionId, expectedVersion, e.keyVersion, e.wrappedKey, e.iv, e.tag, e.ciphertext]);
      if (!r.rows.length) {
        const exists = await sql.query('select 1 from secrets where ref = $1 and workspace_id = $2 and connection_id = $3', [ref, owner.workspaceId, owner.connectionId]);
        throw exists.rows.length ? new SecretVersionConflict() : new SecretNotFound();
      }
    },
    async delete(ref, owner) {
      const r = await sql.query('delete from secrets where ref = $1 and workspace_id = $2 and connection_id = $3 returning ref', [ref, owner.workspaceId, owner.connectionId]);
      if (!r.rows.length) throw new SecretNotFound();
    },
  };
}
