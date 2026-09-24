import type { ProviderId } from '../../types';
import type { HttpClient, HttpRequest, HttpResponse } from '../../ports/http';
import { ProviderUnavailableError } from '../types';
import { ConnectorAuthError, ConnectorRateLimited } from './errors';

/**
 * HTTP for connectors: host allow-listing, timeouts, and error classification. Error messages name
 * the provider and the status — never the URL's query, a header, or the response body, any of which
 * can carry a credential or customer data.
 */

/** Restrict an HttpClient to https and the given hosts. A config can never point a credential elsewhere. */
export function restrictHosts(http: HttpClient, hosts: string[], provider: ProviderId): HttpClient {
  const allowed = new Set(hosts.map((h) => h.toLowerCase()));
  return (url, init) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return Promise.reject(new ProviderUnavailableError(provider, 'error', 'Refused a malformed URL.'));
    }
    if (u.protocol !== 'https:' || !allowed.has(u.hostname.toLowerCase())) return Promise.reject(new ProviderUnavailableError(provider, 'error', `Refused a request to ${u.hostname}: not a host this connector may call.`));
    return http(url, init);
  };
}

export interface JsonRequest extends HttpRequest {
  timeoutMs?: number;
  /** Provider-specific rate-limit signal on a non-429 response (e.g. GitHub's 403 with no remaining quota). */
  isRateLimited?: (res: HttpResponse) => boolean;
}

/** Call a provider and parse JSON, turning every failure into a typed, safe ProviderUnavailableError. */
export async function requestJson<T>(http: HttpClient, provider: ProviderId, label: string, url: string, init: JsonRequest = {}): Promise<T> {
  const { timeoutMs = 20_000, isRateLimited, ...req } = init;
  let res;
  try {
    res = await http(url, { ...req, signal: req.signal ?? AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e instanceof ProviderUnavailableError) throw e;
    const name = (e as Error)?.name;
    throw new ProviderUnavailableError(provider, 'unavailable', name === 'TimeoutError' || name === 'AbortError' ? `${label} did not answer within ${Math.round(timeoutMs / 1000)} s.` : `${label} could not be reached.`);
  }
  if (res.status === 429 || isRateLimited?.(res)) {
    const ra = Number(res.headers.get('retry-after'));
    throw new ConnectorRateLimited(provider, `${label} rate limit reached (${res.status}).`, Number.isFinite(ra) && ra > 0 ? ra : undefined);
  }
  if (res.status === 401 || res.status === 403) throw new ConnectorAuthError(provider, `${label} rejected the credentials (${res.status}). Reconnect ${label}.`);
  if (res.status >= 500) throw new ProviderUnavailableError(provider, 'unavailable', `${label} is having problems (${res.status}).`);
  if (!res.ok) throw new ProviderUnavailableError(provider, 'error', `${label} returned ${res.status}.`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new ProviderUnavailableError(provider, 'error', `${label} returned a response Jagr could not read.`);
  }
}

/** Basic auth header value. Encodes UTF-8 without relying on platform globals. */
export function basicAuth(user: string, password: string): string {
  return `Basic ${base64(`${user}:${password}`)}`;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64(s: string): string {
  const bytes: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
  }
  return out;
}
