import { supabase, requireUser } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';

// GET /api/shipments?saleId=...&userId=...
// Returns all shipments rows for a sale event so PackingView can show
// tracking + label status next to each box. labelData (base64 PDF) is
// included so the client can offer a "Download label" button without a
// second round-trip.

export default wrap(async (req, res) => {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const userId = req.query?.userId;
  await requireUser(userId);

  const saleId = req.query?.saleId;
  let query = supabase.from('shipments').select('*');
  if (saleId) query = query.eq('saleId', saleId);

  const { data, error } = await query;
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ shipments: data || [] });
});
