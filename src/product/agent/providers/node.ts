import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PlannerHttpRequest, PlannerHttpResponse } from './server.js';

/**
 * Serves the framework-free planner handler over Node's http primitives. Shared by the Vite dev
 * server and the production serverless function (api/planner.ts) — one implementation, two hosts.
 *
 * The endpoint spends the deployment owner's model budget, so it is deliberately narrow:
 * small bodies only, a best-effort per-IP rate limit, no caching, and never a key in a response.
 */

export const MAX_BODY_BYTES = 64 * 1024;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 60;
const hits = new Map<string, number[]>();

/** Best effort: serverless instances don't share memory. Pair with provider-side spend limits. */
export function rateLimited(ip: string, now = Date.now()): boolean {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > MAX_PER_WINDOW;
}

async function readBody(req: IncomingMessage & { body?: unknown }): Promise<{ body?: unknown; tooLarge?: boolean }> {
  // Some hosts (Vercel) have already parsed JSON bodies.
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return req.body.length > MAX_BODY_BYTES ? { tooLarge: true } : { body: safeJson(req.body) };
    return JSON.stringify(req.body).length > MAX_BODY_BYTES ? { tooLarge: true } : { body: req.body };
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) return { tooLarge: true };
  }
  return { body: raw ? safeJson(raw) : undefined };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export async function serveNode(handle: (r: PlannerHttpRequest) => Promise<PlannerHttpResponse>, req: IncomingMessage & { body?: unknown }, res: ServerResponse, path: string) {
  const send = (status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
  };
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? 'unknown').split(',')[0].trim();
  if (req.method === 'POST' && rateLimited(ip)) return send(429, { error: 'Too many planning requests — try again in a minute.' });
  const { body, tooLarge } = req.method === 'POST' ? await readBody(req) : { body: undefined, tooLarge: false };
  if (tooLarge) return send(413, { error: 'Request too large.' });
  const out = await handle({ method: req.method ?? 'GET', path, body });
  send(out.status, out.body);
}
