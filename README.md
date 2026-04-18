# Folia Inventory

Internal plant inventory management system built with React + Vite, backed by Supabase via Vercel serverless API routes.

## Architecture

- `src/` — React frontend (Vite). Talks only to `/api/*`, never to Supabase directly.
- `api/` — Vercel serverless functions. All database access and password hashing happens here.
  - `api/_lib/supabase.js` uses the Supabase **service role key** (bypasses RLS).
  - `api/_lib/hash.js` uses PBKDF2 for password hashing.
- `supabase/schema.sql` — one-time database setup.

The service role key stays server-side; the browser never sees it.

## Setup

1. Copy `.env.example` → `.env.local` and fill in:
   - `SUPABASE_URL` — your Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY` — from Supabase Dashboard → Project Settings → API → `service_role` secret
2. Run the schema: Supabase Dashboard → SQL Editor → paste `supabase/schema.sql` → Run.
3. `npm install && npm run dev`

`npm run dev` serves the Vite frontend and the `/api/*` routes together (via the local dev plugin in `vite-plugin-api.js`).

## Deploy

Push to GitHub and import into Vercel. Set these environment variables in Vercel (Settings → Environment Variables):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Vercel will build the Vite app and deploy each file in `api/` as a serverless function automatically.
