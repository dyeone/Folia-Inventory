# Folia Inventory

Internal plant inventory management system built with React + Vite, backed by Supabase.

## Setup

1. Copy `.env.example` to `.env.local` and fill in your Supabase credentials.
2. Run the schema in the Supabase SQL Editor: `supabase/schema.sql`
3. `npm install && npm run dev`

## Deploy

Push to GitHub and import into Vercel. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as environment variables.
