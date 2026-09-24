/**
 * What must never leave a workspace in an export: secrets, tokens, session data, and email
 * addresses. Free text (imported feedback, notes) can carry email addresses written by customers —
 * those are redacted. Anything that still looks like a credential makes the export fail closed.
 */

const SECRET_KEY = /^(secret|secrets|secretref|secret_ref|token|tokens|accesstoken|access_token|refreshtoken|refresh_token|idtoken|id_token|password|passwd|apikey|api_key|apisecret|api_secret|secretkey|secret_key|privatekey|private_key|clientsecret|client_secret|authorization|cookie|cookies|session|sessionid|session_id|sessions|credential|credentials|signingsecret|signing_secret|bearer)$/i;
const TOKEN_VALUE = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI / Anthropic style keys
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google API keys
  /\bgh[pousr]_[0-9A-Za-z]{30,}/, // GitHub tokens
  /\bxox[abprs]-[0-9A-Za-z-]{10,}/, // Slack tokens
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWTs
];
export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export interface Finding {
  path: string;
  reason: string;
}

/** Every place an object would leak a secret, a token, a session or an email address. */
export function findSensitive(value: unknown, path = '$'): Finding[] {
  if (typeof value === 'string') {
    const out: Finding[] = [];
    if (TOKEN_VALUE.some((re) => re.test(value))) out.push({ path, reason: 'looks like a credential or token' });
    if (new RegExp(EMAIL.source).test(value)) out.push({ path, reason: 'contains an email address' });
    return out;
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => findSensitive(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => {
      const here = `${path}.${k}`;
      const own = SECRET_KEY.test(k) && v !== undefined && v !== null && v !== '' ? [{ path: here, reason: `field “${k}” holds secret or session data` }] : [];
      return [...own, ...findSensitive(v, here)];
    });
  }
  return [];
}

/** Replace email addresses in every string with a marker. Returns a new value. */
export function redactEmails<T>(value: T): T {
  if (typeof value === 'string') return value.replace(EMAIL, '[email removed]') as T;
  if (Array.isArray(value)) return value.map((v) => redactEmails(v)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactEmails(v)])) as T;
  return value;
}
