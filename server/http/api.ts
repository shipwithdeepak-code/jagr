import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiRequest, ApiResponse } from './types';

/**
 * Node http adapter for the Jagr API (the Vite dev server and Vercel functions both hand us Node's
 * request/response). Bodies are JSON, capped; workspace exports can be large, so the cap is generous.
 */
export const MAX_API_BODY_BYTES = 4 * 1024 * 1024;

async function readJson(req: IncomingMessage & { body?: unknown }): Promise<{ body?: unknown; tooLarge?: boolean; invalid?: boolean }> {
  if (req.body !== undefined) {
    if (typeof req.body !== 'string') return { body: req.body };
    if (req.body.length > MAX_API_BODY_BYTES) return { tooLarge: true };
    try {
      return { body: req.body ? JSON.parse(req.body) : undefined };
    } catch {
      return { invalid: true };
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_API_BODY_BYTES) return { tooLarge: true };
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return { body: raw ? JSON.parse(raw) : undefined };
  } catch {
    return { invalid: true };
  }
}

export async function serveApi(handle: (r: ApiRequest) => Promise<ApiResponse>, req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : (v ?? '')]));
  const write = (out: ApiResponse) => {
    res.statusCode = out.status;
    res.setHeader('cache-control', 'no-store');
    for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
    if (out.cookies?.length) res.setHeader('set-cookie', out.cookies);
    if (out.body === undefined) return res.end();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out.body));
  };
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const parsed = hasBody ? await readJson(req) : {};
  if (parsed.tooLarge) return write({ status: 413, body: { error: 'Request too large.' } });
  if (parsed.invalid) return write({ status: 400, body: { error: 'Body is not valid JSON.' } });
  write(await handle({ method: req.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body: parsed.body }));
}
