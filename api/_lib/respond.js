// Small wrapper to make handlers consistent: catches errors and
// returns a JSON response with an HTTP status from err.status (or 500).
export function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      const status = e?.status ?? 500;
      res.status(status).json({ error: e?.message || 'Server error' });
    }
  };
}

export function methodNotAllowed(res, allowed = []) {
  if (allowed.length) res.setHeader('Allow', allowed.join(', '));
  res.status(405).json({ error: 'Method not allowed' });
}
