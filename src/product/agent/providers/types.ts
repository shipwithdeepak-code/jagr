import type { HttpClient, HttpResponse } from '../../ports/http.js';

/**
 * Provider adapter contract (server-side only).
 *
 * An adapter knows exactly one API: how to authenticate, how to ask for structured output, and how
 * to pull the plan JSON out of that API's native response. It returns the plan as JSON text and
 * nothing else. Parsing, schema validation, timeouts, fallback and policy all happen outside it,
 * identically for every provider.
 *
 * No path-alias imports: loaded by the server-side planner endpoint.
 */

export interface GenerateRequest {
  system: string;
  prompt: string;
  /** The shared plan contract as JSON Schema; adapters translate it to their native format. */
  schema: Record<string, unknown>;
  toolName: string;
  signal?: AbortSignal;
}

export interface ProviderAdapter {
  id: string;
  displayName: string;
  model: string;
  /** Returns the plan as JSON text (or whatever text came back — the shared parser decides). Throws on transport/API errors. */
  generate(req: GenerateRequest): Promise<string>;
}

export type StructuredMode = 'json_schema' | 'json_object' | 'prompt';

export interface ProviderConfig {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  structured?: StructuredMode;
}

/** A provider's error, with a message that is safe to show (status and error type only — never request data). */
export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    detail?: string,
  ) {
    super(`${provider} API returned ${status}${detail ? ` (${detail})` : ''}`);
    this.name = 'ProviderHttpError';
  }
}

export async function safeErrorType(res: HttpResponse): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: { type?: string; status?: string; code?: string } | string };
    const e = body.error;
    if (typeof e === 'string') return undefined;
    const t = e?.type ?? e?.status ?? e?.code;
    return typeof t === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

/** Strip keywords a provider's structured-output dialect may not accept. The shared schema is still enforced locally. */
export function stripKeywords(schema: unknown, drop: string[]): unknown {
  if (Array.isArray(schema)) return schema.map((x) => stripKeywords(x, drop));
  if (schema && typeof schema === 'object') {
    return Object.fromEntries(Object.entries(schema as Record<string, unknown>).filter(([k]) => !drop.includes(k)).map(([k, v]) => [k, k === 'properties' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, stripKeywords(pv, drop)])) : stripKeywords(v, drop)]));
  }
  return schema;
}

/**
 * The provider stopped because it hit its output limit, so the plan is cut off. Not an outage (no
 * provider switch) and not a schema problem — reported as its own failure so the trace says what happened.
 */
export class TruncatedOutputError extends Error {
  constructor(provider: string, detail: string) {
    super(`${provider} output was cut off before the plan was complete (${detail}).`);
    this.name = 'TruncatedOutputError';
  }
}

/** Outbound HTTP, injected by the host (the platform's fetch in production, a double in tests). */
export type Fetch = HttpClient;
