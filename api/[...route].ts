import type { IncomingMessage, ServerResponse } from 'node:http';
import { productionRuntime } from '../server/runtime.js';
import { createApp } from '../server/app.js';
import { serveApi } from '../server/http/api.js';

/**
 * The Jagr API on Vercel (every /api/* path except /api/planner, which has its own function).
 * Host glue only: the application lives in server/app.ts and the core; Postgres, cron and sign-in
 * providers are chosen in server/runtime.ts from the environment.
 */
export const config = { maxDuration: 60 };

let app: ReturnType<typeof createApp> | undefined;

export default async function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  if (!app) {
    try {
      app = createApp(await productionRuntime(process.env));
    } catch (e) {
      // Missing configuration or an unreachable database. Answer, rather than crash the function; the
      // browser then shows "no Jagr server" as it does for static hosting. The message names env vars only.
      console.error(`jagr: server unavailable: ${(e as Error).message.slice(0, 200)}`);
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify({ error: 'The Jagr server is not configured or its database is unavailable.' }));
      return;
    }
  }
  await serveApi(app, req, res);
}
