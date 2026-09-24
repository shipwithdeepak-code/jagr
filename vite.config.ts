import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { createPlannerHandler } from './src/product/agent/providers/server.js';
import { serveNode } from './server/http/node.js';

/**
 * Dev backend (optional): JAGR_DEV_DB=pglite runs the Jagr API on an on-disk PGlite database
 * (.jagr/dev-db), or DATABASE_URL points it at a real Postgres. Without either, the app is
 * browser-local only, exactly like the static build.
 */
function apiEndpoint(env: Record<string, string>): Plugin {
  return {
    name: 'jagr-api',
    apply: 'serve',
    async configureServer(server) {
      if (env.JAGR_DEV_DB !== 'pglite' && !env.DATABASE_URL) return;
      const [{ createRuntime, productionRuntime }, { createApp }, { serveApi }] = await Promise.all([import('./server/runtime.js'), import('./server/app.js'), import('./server/http/api.js')]);
      const rt =
        env.JAGR_DEV_DB === 'pglite'
          ? await (async () => {
              const [{ PGlite }, { pgliteClient }, { mkdirSync }] = await Promise.all([import('@electric-sql/pglite'), import('./server/postgres/pglite.js'), import('node:fs')]);
              mkdirSync('./.jagr', { recursive: true });
              return createRuntime(env, { sql: pgliteClient(new PGlite('./.jagr/dev-db')) });
            })()
          : await productionRuntime(env);
      const app = createApp(rt);
      server.middlewares.use((req, res, next) => (req.url?.startsWith('/api/') && !req.url.startsWith('/api/planner') ? void serveApi(app, req, res) : next()));
    },
  };
}

/**
 * Dev planner endpoint. Provider credentials stay in this Node process (from the environment or an
 * ignored .env.local); the browser only ever talks to /api/planner/*. In production the same handler
 * runs as a Vercel serverless function (api/planner.ts).
 */
function plannerEndpoint(env: Record<string, string>): Plugin {
  const handle = createPlannerHandler(env, (url, init) => fetch(url, init));
  return {
    name: 'jagr-planner-endpoint',
    apply: 'serve',
    configureServer(server) {
      // Same Node adapter as the production function in api/planner.ts.
      server.middlewares.use('/api/planner', (req, res) => void serveNode(handle, req, res, (req.url ?? '/').split('?')[0]));
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), plannerEndpoint(loadEnv(mode, process.cwd(), '')), apiEndpoint(loadEnv(mode, process.cwd(), ''))],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // The live provider comparison only runs on request (npm run eval:planners) — never in npm test.
    include: process.env.JAGR_LIVE_EVAL ? ['scripts/eval/**/*.live.ts'] : ['src/**/*.test.ts', 'server/**/*.test.ts'],
    environment: 'node',
  },
}));
