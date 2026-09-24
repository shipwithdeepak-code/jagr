/**
 * IdentityProvider port — who the user is. The application owns users, sessions and memberships;
 * a provider only proves an identity. Identities are linked by (provider, subject), never by email
 * alone (an unverified email must not be able to take over an account).
 * Initial implementations: Google (OIDC) and GitHub (OAuth), in server/identity/.
 */

export interface VerifiedIdentity {
  provider: string;
  /** Stable account id at the provider. */
  subject: string;
  email?: string;
  emailVerified: boolean;
  displayName?: string;
}

export interface IdentityProvider {
  readonly id: string;
  authorizationUrl(i: { state: string; codeVerifier: string; redirectUri: string }): string;
  exchange(i: { code: string; codeVerifier: string; redirectUri: string }): Promise<VerifiedIdentity>;
}
