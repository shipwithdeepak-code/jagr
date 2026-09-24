/** Framework-neutral HTTP shapes. Host adapters (Node http, Vercel) translate to and from these. */
export interface ApiRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  headers?: Record<string, string>;
  /** Set-Cookie values. */
  cookies?: string[];
  body?: unknown;
}

export const json = (status: number, body: unknown, extra: Partial<ApiResponse> = {}): ApiResponse => ({ status, body, ...extra });
export const redirect = (location: string, cookies: string[] = []): ApiResponse => ({ status: 302, headers: { location }, cookies });
