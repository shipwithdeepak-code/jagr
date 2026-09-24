/**
 * HttpClient port — the only way the core makes network calls.
 *
 * Connectors and planner adapters receive an HttpClient; they never reach for a global `fetch`.
 * The platform's `fetch` satisfies this interface, so the host (browser, server, test) injects it.
 * No path-alias imports: loaded by the server-side planner endpoint.
 */

export interface HttpHeadersLike {
  get(name: string): string | null;
}

export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: HttpHeadersLike;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface HttpRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type HttpClient = (url: string, init?: HttpRequest) => Promise<HttpResponse>;
