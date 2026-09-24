import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { createPlannerHandler } from './src/product/agent/providers/server.js';
import { serveNode } from './src/product/agent/providers/node.js';

/**
 * Dev planner endpoint. Provider credentials stay in this Node process (from the environment or an
 * ignored .env.local); the browser only ever talks to /api/planner/*. In production the same handler
 * runs as a Vercel serverless function (api/planner.ts).
 */
function plannerEndpoint(env: Record<string, string>): Plugin {
  const handle = createPlannerHandler(env);
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
