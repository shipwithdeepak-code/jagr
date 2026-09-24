import { createHash, randomBytes } from 'node:crypto';

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
/** RFC 7636 S256 code challenge. */
export const codeChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
