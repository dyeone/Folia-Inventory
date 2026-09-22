// Small wrapper to make handlers consistent: catches errors and
// returns a JSON response with an HTTP status from err.status (or 500).
//
// Server errors (5xx) are logged with the request method/url for Vercel's
// function logs. Client errors (4xx) are not logged — they're expected.

// Every /api response is dynamic and authenticated — never let the
// browser or any intermediary cache it. Without this header, Vercel's
// CDN started returning 304 Not Modified on repeat polls (bridge
// status/health), which the client treats as a failure (res.ok is
// false for 304) — surfacing as a red "Failed" pill on live scans
// that the bridge actually ran fine.
function noCache(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

// The Chrome extension's background worker calls the API from a
// chrome-extension:// origin. Its manifest lists the API host, which lets
// Chrome skip CORS; this is the fallback for an install whose manifest
// doesn't (a custom API domain, an older copy). Only extension origins are
// echoed — never `*` — and the preflight is answered here so POST bodies
// (JSON) get through. Auth is the userId in the request, not a cookie, so
// this widens nothing a plain HTTP client couldn't already do.
function extensionCors(req, res) {
  const origin = req.headers?.origin;
  if (typeof origin !== 'string' || !origin.startsWith('chrome-extension://')) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

export function wrap(handler) {
  return async (req, res) => {
    noCache(res);
    if (extensionCors(req, res) && req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    try {
      await handler(req, res);
    } catch (e) {
      const status = e?.status ?? 500;
      // Log any 5xx so a deploy regression shows up in Vercel logs without
      // needing to reach for the browser console first.
      if (status >= 500) {
        console.error(`[api ${req.method} ${req.url}]`, e?.message || e, e?.stack);
      }
      res.status(status).json({ error: e?.message || 'Server error' });
    }
  };
}

export function methodNotAllowed(res, allowed = []) {
  noCache(res);
  if (allowed.length) res.setHeader('Allow', allowed.join(', '));
  res.status(405).json({ error: 'Method not allowed' });
}
