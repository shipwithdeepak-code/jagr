import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPlannerHandler } from '../src/product/agent/providers/server.js';
import { serveNode } from '../server/http/node.js';

/**
 * Production planner endpoint (Vercel serverless function). Same handler as the dev server.
 *
 * Configure in the Vercel project's environment variables — server-side only, never VITE_-prefixed:
 *   LLM_PROVIDER, LLM_MODEL, LLM_API_KEY (optional LLM_BASE_URL, LLM_FALLBACK_PROVIDER, …)
 * Without them the endpoint reports deterministic mode and the app says so.
 *
 * vercel.json rewrites /api/planner/<path> → /api/planner?path=<path>.
 */

export const config = { maxDuration: 30 };

let handle: ReturnType<typeof createPlannerHandler> | undefined;

export default async function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  handle ??= createPlannerHandler(process.env, (url, init) => fetch(url, init));
  const url = new URL(req.url ?? '/', 'http://localhost');
  const sub = url.searchParams.get('path') ?? url.pathname.replace(/^\/api\/planner\/?/, '');
  await serveNode(handle, req, res, `/${sub.replace(/^\/+/, '')}`);
}
