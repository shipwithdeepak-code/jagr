import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../src/product/ports/clock.js';
import type { Membership, Repositories, Session, User } from '../src/product/ports/persistence.js';
import type { ApiRequest } from './http/types.js';
import { randomToken } from './identity/pkce.js';

/**
 * Sessions, OAuth state and CSRF.
 *
 * - The session cookie is httpOnly, Secure, SameSite=Lax. Only a SHA-256 hash of the session token is
 *   stored, so a database leak does not hand out live sessions.
 * - The OAuth state (provider, state, PKCE verifier, expiry) travels in an httpOnly cookie signed with
 *   HMAC; the callback must match it.
 * - Mutating requests must carry the CSRF token (double-submit: cookie + x-jagr-csrf header).
 */

export const SESSION_COOKIE = 'jagr_session';
export const CSRF_COOKIE = 'jagr_csrf';
export const OAUTH_COOKIE = 'jagr_oauth';
const SESSION_DAYS = 14;

export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name: string, value: string, opts: { maxAgeSeconds?: number; httpOnly?: boolean; secure: boolean }): string {
  return [`${name}=${encodeURIComponent(value)}`, 'Path=/', `Max-Age=${opts.maxAgeSeconds ?? SESSION_DAYS * 86400}`, 'SameSite=Lax', opts.httpOnly === false ? '' : 'HttpOnly', opts.secure ? 'Secure' : ''].filter(Boolean).join('; ');
}

export const clearCookie = (name: string, secure: boolean) => cookie(name, '', { maxAgeSeconds: 0, secure });

function sign(secret: string, value: string) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function sealOAuthState(secret: string, v: { provider: string; state: string; verifier: string; exp: number; returnTo: string }): string {
  const body = Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

export function openOAuthState(secret: string, sealed: string | undefined, now: number): { provider: string; state: string; verifier: string; returnTo: string } | null {
  if (!sealed) return null;
  const [body, mac] = sealed.split('.');
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(secret, body));
  const got = Buffer.from(mac);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { provider: string; state: string; verifier: string; exp: number; returnTo: string };
  return v.exp > now ? v : null;
}

export async function startSession(repos: Repositories, userId: string, clock: Clock): Promise<{ token: string; session: Session }> {
  const token = randomToken(32);
  const now = clock.now();
  const session: Session = { id: hashToken(token), userId, createdAt: now, expiresAt: new Date(Date.parse(now) + SESSION_DAYS * 86_400_000).toISOString() };
  await repos.sessions.create(session);
  return { token, session };
}

export interface Principal {
  user: User;
  session: Session;
  memberships: Membership[];
}

export async function authenticate(repos: Repositories, req: ApiRequest, clock: Clock): Promise<Principal | null> {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const session = await repos.sessions.get(hashToken(token));
  if (!session || session.expiresAt <= clock.now()) return null;
  const user = await repos.users.get(session.userId);
  if (!user) return null;
  return { user, session, memberships: await repos.members.forUser(user.id) };
}

/** Double-submit CSRF check for state-changing requests. */
export function csrfOk(req: ApiRequest): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const c = parseCookies(req.headers.cookie)[CSRF_COOKIE];
  const h = req.headers['x-jagr-csrf'];
  if (!c || !h || c.length !== h.length) return false;
  return timingSafeEqual(Buffer.from(c), Buffer.from(h));
}
