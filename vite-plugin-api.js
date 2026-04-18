// Dev-only Vite plugin that mimics Vercel API routes.
// Routes `/api/<path>` → `api/<path>.js` and loads the default export as handler.
// Gives the handler a Vercel-like (req, res) with req.body parsed from JSON.
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadEnv } from 'vite';

export function apiPlugin() {
  return {
    name: 'folia-api-dev',

    // Expose non-VITE_ env vars from .env.local to the API handlers.
    config({ mode }) {
      const env = loadEnv(mode, process.cwd(), '');
      for (const [k, v] of Object.entries(env)) {
        if (!(k in process.env)) process.env[k] = v;
      }
    },

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/')) return next();

        const pathname = req.url.split('?')[0];
        const rel = pathname.replace(/^\/api\//, '');
        const filePath = path.resolve(process.cwd(), 'api', `${rel}.js`);

        try {
          await fs.access(filePath);
        } catch {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: `No API route: ${pathname}` }));
          return;
        }

        let body = null;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const raw = Buffer.concat(chunks).toString('utf-8');
          if (raw) {
            try { body = JSON.parse(raw); } catch { body = null; }
          }
        }

        // Vercel-shaped req/res shims.
        req.body = body;
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (data) => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(data));
          return res;
        };

        try {
          const mod = await server.ssrLoadModule(filePath);
          const handler = mod.default;
          if (typeof handler !== 'function') {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: `Route ${pathname} has no default export` }));
            return;
          }
          await handler(req, res);
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: e?.message || 'Server error' }));
        }
      });
    },
  };
}
