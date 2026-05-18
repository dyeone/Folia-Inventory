import { supabase, requireUser, requireAdmin } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';

// Single-row JSON blob per settings id. Currently used only for
// id='shipping' (ship-from address + ShipStation defaults), but the
// shape lets us add other namespaces (id='financial', etc.) without
// new endpoints.

export default wrap(async (req, res) => {
  const userId = req.method === 'GET' ? req.query?.userId : req.body?.userId;
  await requireUser(userId);

  const id = req.method === 'GET' ? req.query?.id : req.body?.id;
  if (!id) {
    const e = new Error('id required'); e.status = 400; throw e;
  }

  switch (req.method) {
    case 'GET': {
      const { data, error } = await supabase
        .from('app_settings')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      const row = data || { id, data: {} };
      return res.status(200).json({ settings: redactSecrets(id, row) });
    }
    case 'PUT': {
      // Settings edits are admin-gated — ship-from + ShipStation defaults
      // are operationally sensitive (wrong address = misdelivered labels).
      await requireAdmin(userId);
      const incoming = req.body?.data;
      if (!incoming || typeof incoming !== 'object') {
        const e = new Error('data (object) required'); e.status = 400; throw e;
      }

      // Fetch existing so we can preserve write-only secrets that the
      // client never receives (and therefore never sends back). Currently
      // only the Palmstreet OMS bearer token lives in this category.
      const { data: existing } = await supabase
        .from('app_settings')
        .select('data')
        .eq('id', id)
        .maybeSingle();
      const merged = mergeSecrets(id, existing?.data || {}, incoming);

      const { data: row, error } = await supabase
        .from('app_settings')
        .upsert({ id, data: merged, updatedAt: new Date().toISOString(), updatedBy: userId })
        .select()
        .single();
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ settings: redactSecrets(id, row) });
    }
    default:
      return methodNotAllowed(res, ['GET', 'PUT']);
  }
});

// Strip server-only secrets before sending settings to the browser.
// The Palmstreet OMS token is a session credential — leaking it to
// the client would let any signed-in user impersonate the operator
// on the Palmstreet API. The client only needs to know when a token
// was set (so the UI can show "expires in N min"), not the value.
function redactSecrets(id, row) {
  if (id !== 'shipping') return row;
  const data = row?.data || {};
  if (!data.palmstreet?.token) return row;
  const { token, ...palmstreetSafe } = data.palmstreet;
  return { ...row, data: { ...data, palmstreet: palmstreetSafe } };
}

// Merge a client-submitted settings payload into the existing row,
// preserving write-only secrets that aren't in the payload. When the
// client *does* submit a new Palmstreet token, stamp tokenSetAt so the
// UI can show the lifetime.
function mergeSecrets(id, existing, incoming) {
  if (id !== 'shipping') return incoming;
  const incomingP = incoming.palmstreet || {};
  const existingP = existing.palmstreet || {};
  const newToken = typeof incomingP.token === 'string' ? incomingP.token.trim() : undefined;

  let palmstreet;
  if (newToken === undefined) {
    // Client didn't touch the token field — preserve whatever's stored.
    palmstreet = { ...incomingP, token: existingP.token, tokenSetAt: existingP.tokenSetAt };
  } else if (newToken === '') {
    // Empty string = explicit clear.
    palmstreet = { ...incomingP, token: undefined, tokenSetAt: undefined };
  } else {
    // New token — stamp the set-time.
    palmstreet = { ...incomingP, token: newToken, tokenSetAt: new Date().toISOString() };
  }
  return { ...incoming, palmstreet };
}
