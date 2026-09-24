import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { createPlannerHandler } from './src/product/agent/providers/server';

/**
 * Dev-only planner endpoint. Provider credentials stay in this Node process (from the environment
 * or an ignored .env.local); the browser only ever talks to /api/planner/*. The static production
 * build has no endpoint, so the app runs the deterministic planner there.
 */
function plannerEndpoint(env: Record<string, string>): Plugin {
  const handle = createPlannerHandler(env);
  return {
    name: 'jagr-planner-endpoint',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/planner', async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        let body: unknown;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          body = undefined;
        }
        const out = await handle({ method: req.method ?? 'GET', path: (req.url ?? '/').split('?')[0], body });
        res.statusCode = out.status;
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify(out.body));
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), plannerEndpoint(loadEnv(mode, process.cwd(), ''))],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // The live provider comparison only runs on request (npm run eval:planners) — never in npm test.
    include: process.env.JAGR_LIVE_EVAL ? ['src/**/*.live.ts'] : ['src/**/*.test.ts'],
    environment: 'node',
  },
}));
