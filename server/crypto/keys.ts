import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Master keys for envelope encryption. The initial implementation reads them from the deployment
 * environment; a KMS replaces only this provider (the secret store and its rows do not change).
 *
 *   JAGR_SECRET_KEYS="1:<base64 32 bytes>,2:<base64 32 bytes>"   (rotation: newest version encrypts)
 *   JAGR_SECRET_KEY="<base64 32 bytes>"                            (single key, version 1)
 */
export interface KeyProvider {
  currentVersion(): number;
  key(version: number): Buffer;
}

export function envKeyProvider(env: Record<string, string | undefined>): KeyProvider {
  const keys = new Map<number, Buffer>();
  const spec = env.JAGR_SECRET_KEYS ?? (env.JAGR_SECRET_KEY ? `1:${env.JAGR_SECRET_KEY}` : '');
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [v, b64] = part.split(':');
    const k = Buffer.from(b64 ?? '', 'base64');
    if (!Number.isInteger(Number(v)) || k.length !== 32) throw new Error('JAGR_SECRET_KEYS entries must be "<version>:<base64 of 32 random bytes>".');
    keys.set(Number(v), k);
  }
  if (!keys.size) throw new Error('No secret-encryption key configured (JAGR_SECRET_KEY or JAGR_SECRET_KEYS). Provider credentials cannot be stored without one.');
  const current = Math.max(...keys.keys());
  return {
    currentVersion: () => current,
    key: (v) => {
      const k = keys.get(v);
      if (!k) throw new Error(`Secret-encryption key version ${v} is not configured.`);
      return k;
    },
  };
}

/** AES-256-GCM. Returns base64 parts; the tag authenticates the ciphertext (tampering fails decryption). */
export function seal(key: Buffer, plaintext: Buffer): { iv: string; tag: string; ciphertext: string } {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

export function open(key: Buffer, s: { iv: string; tag: string; ciphertext: string }): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64'));
  d.setAuthTag(Buffer.from(s.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(s.ciphertext, 'base64')), d.final()]);
}
