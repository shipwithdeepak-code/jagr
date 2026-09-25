import type { HttpClient } from '../../src/product/ports/http.js';
import type { IdentityProvider, VerifiedIdentity } from '../../src/product/ports/identity.js';
import { codeChallenge } from './pkce.js';

/** GitHub sign-in (OAuth app, authorization code + PKCE). The subject is GitHub's numeric user id, never the login (logins can change). */
export function githubIdentity(cfg: { clientId: string; clientSecret: string; http: HttpClient }): IdentityProvider {
  const api = (path: string, token: string) => cfg.http(`https://api.github.com${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'jagr' } });
  return {
    id: 'github',
    authorizationUrl: ({ state, codeVerifier, redirectUri }) => {
      const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectUri, scope: 'read:user user:email', state, code_challenge: codeChallenge(codeVerifier), code_challenge_method: 'S256', allow_signup: 'false' });
      return `https://github.com/login/oauth/authorize?${q}`;
    },
    async exchange({ code, codeVerifier, redirectUri }): Promise<VerifiedIdentity> {
      const tok = await cfg.http('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirectUri, code_verifier: codeVerifier }).toString(),
      });
      if (!tok.ok) throw new Error(`GitHub token exchange failed (${tok.status}).`);
      const { access_token, error } = (await tok.json()) as { access_token?: string; error?: string };
      if (!access_token) throw new Error(`GitHub returned no access token${error ? ` (${error})` : ''}.`);
      const me = await api('/user', access_token);
      if (!me.ok) throw new Error(`GitHub user lookup failed (${me.status}).`);
      const u = (await me.json()) as { id?: number; login?: string; name?: string | null };
      if (typeof u.id !== 'number') throw new Error('GitHub returned no user id.');
      const emails = await api('/user/emails', access_token);
      const primary = emails.ok ? ((await emails.json()) as { email: string; primary: boolean; verified: boolean }[]).find((e) => e.primary && e.verified) : undefined;
      return { provider: 'github', subject: String(u.id), email: primary?.email, emailVerified: !!primary, displayName: u.name || u.login };
    },
  };
}
