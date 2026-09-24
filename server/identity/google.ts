import type { HttpClient } from '../../src/product/ports/http';
import type { IdentityProvider, VerifiedIdentity } from '../../src/product/ports/identity';
import { codeChallenge } from './pkce';

/**
 * Google sign-in (OpenID Connect, authorization code + PKCE). The code is exchanged server-to-server
 * and the identity read from Google's userinfo endpoint over TLS with the fresh access token.
 */
export function googleIdentity(cfg: { clientId: string; clientSecret: string; http: HttpClient }): IdentityProvider {
  return {
    id: 'google',
    authorizationUrl: ({ state, codeVerifier, redirectUri }) => {
      const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state, code_challenge: codeChallenge(codeVerifier), code_challenge_method: 'S256', prompt: 'select_account' });
      return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
    },
    async exchange({ code, codeVerifier, redirectUri }): Promise<VerifiedIdentity> {
      const tok = await cfg.http('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: codeVerifier }).toString(),
      });
      if (!tok.ok) throw new Error(`Google token exchange failed (${tok.status}).`);
      const { access_token } = (await tok.json()) as { access_token?: string };
      if (!access_token) throw new Error('Google returned no access token.');
      const me = await cfg.http('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${access_token}`, accept: 'application/json' } });
      if (!me.ok) throw new Error(`Google userinfo failed (${me.status}).`);
      const u = (await me.json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string };
      if (!u.sub) throw new Error('Google returned no subject.');
      return { provider: 'google', subject: u.sub, email: u.email, emailVerified: u.email_verified === true, displayName: u.name ?? u.email?.split('@')[0] };
    },
  };
}
