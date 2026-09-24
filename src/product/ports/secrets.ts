/**
 * SecretStore port — provider credentials, and nothing else.
 *
 * Secrets never enter domain objects, logs, traces, exports or HTTP responses: a connection holds an
 * opaque SecretRef, and the secret is read only inside the request or job that uses it.
 * Initial production implementation: AES-256-GCM envelope encryption in Postgres (server/).
 */

export type SecretPayload =
  | { kind: 'api_key'; fields: Record<string, string> }
  | { kind: 'oauth'; accessToken: string; refreshToken?: string; expiresAt?: string; scopes: string[] }
  | { kind: 'app_installation'; installationId: string };

/** Opaque handle. Safe to store and log; useless without the store. */
export type SecretRef = string & { readonly __secretRef: unique symbol };

export interface SecretStore {
  put(owner: { workspaceId: string; connectionId: string }, secret: SecretPayload): Promise<SecretRef>;
  get(ref: SecretRef): Promise<{ secret: SecretPayload; version: number }>;
  /** Compare-and-swap: fails with SecretVersionConflict if another writer got there first (rotating refresh tokens). */
  replace(ref: SecretRef, expectedVersion: number, secret: SecretPayload): Promise<void>;
  delete(ref: SecretRef): Promise<void>;
}

export class SecretNotFound extends Error {
  constructor() {
    super('Secret not found.');
    this.name = 'SecretNotFound';
  }
}

export class SecretVersionConflict extends Error {
  constructor() {
    super('The secret changed since it was read; re-read and retry.');
    this.name = 'SecretVersionConflict';
  }
}
