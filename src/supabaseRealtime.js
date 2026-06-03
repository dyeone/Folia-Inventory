// Lazy, optional Supabase client — used for ONE narrow thing: Realtime
// broadcast for the packer's iPad→phone "Send to phone" handoff, so it's
// instant instead of polled.
//
// The rest of the app talks to Supabase only server-side (service-role); the
// browser has no Supabase client. Exposing the anon key here is safe: every
// table has RLS enabled with no `anon` policies (see schema.sql), so the key
// grants no table access — and broadcast channels never touch the database
// anyway (pure pub/sub, no rows, no RLS policies, no publication needed).
//
// Active only when VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY are set; the
// packer UI falls back to polling when they aren't. @supabase/supabase-js is
// dynamically imported so it stays out of the main bundle for everyone else.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const REALTIME_CONFIGURED = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

let clientPromise = null;

// Returns a Promise resolving to the Supabase client, or null when realtime
// isn't configured / the import fails. Memoized so one client is shared.
export function getRealtimeClient() {
  if (!REALTIME_CONFIGURED) return Promise.resolve(null);
  if (!clientPromise) {
    clientPromise = import('@supabase/supabase-js')
      .then(({ createClient }) => createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      }))
      .catch(() => null);
  }
  return clientPromise;
}
