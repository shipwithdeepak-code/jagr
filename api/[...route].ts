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
  app ??= createApp(await productionRuntime(process.env));
  await serveApi(app, req, res);
}
