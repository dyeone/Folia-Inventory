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
   - `SESSION_SECRET` — a dedicated random server-only signing key, at least 32 bytes (see `.env.example`)
2. Run the schema: Supabase Dashboard → SQL Editor → paste `supabase/schema.sql` → Run.
3. `npm install && npm run dev`

`npm run dev` serves the Vite frontend and the `/api/*` routes together (via the local dev plugin in `vite-plugin-api.js`).

## Deploy

Push to GitHub and import into Vercel. Set these environment variables in Vercel (Settings → Environment Variables):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SESSION_SECRET` (different random values for Production and Preview; never `VITE_`)

Vercel will build the Vite app and deploy each file in `api/` as a serverless function automatically.

## Sessions

Private API requests require a signed session from the existing password login.
Browser sessions use an HttpOnly, SameSite=Lax cookie (Secure in production),
expire after 12 hours, and are invalidated by password changes or key rotation.
Roles, active status and brand access are checked against the database. Existing
ID-only sessions must sign in once after upgrading. Missing/short `SESSION_SECRET`
fails closed; configure the key before deploying this change.

Sign-out clears this device's cookie/token. A copied token remains valid until
expiry, password change or key rotation; this minimal stateless scheme does not
introduce a session table. Manual clients can POST `action: "login"` with their
username/password and `sessionMode: "token"`, then use the returned `sessionToken`
as `Authorization: Bearer …`. Never put session tokens in URLs or Chrome Sync.
Bridge workers keep their existing separate Bearer authentication.

The Chrome extension must be updated to 0.6.11 and signed in through its Settings.
Tokens stay in device-local extension storage; passwords are not stored. There is
no fallback accepting user IDs as credentials.
