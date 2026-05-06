// Small wrapper to make handlers consistent: catches errors and
// returns a JSON response with an HTTP status from err.status (or 500).
//
// Server errors (5xx) are logged with the request method/url for Vercel's
// function logs. Client errors (4xx) are not logged — they're expected.

export function wrap(handler) {
  return async (req, res) => {
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
  if (allowed.length) res.setHeader('Allow', allowed.join(', '));
  res.status(405).json({ error: 'Method not allowed' });
}
