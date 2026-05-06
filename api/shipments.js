import { supabase, requireUser } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';

// Routes:
//   GET /api/shipments?saleId=X&userId=...
//     → all shipments for a sale (PackingView reads this on mount)
//
//   GET /api/shipments?action=label-url&id=BOX&userId=...
//     → mints a 5-minute signed URL for the label PDF in Storage.
//       Falls back to a data: URL built from labelData for legacy
//       rows that pre-date the storage cutover.

const SIGNED_URL_TTL_SECONDS = 300; // 5 minutes — long enough to print, short enough to not leak

export default wrap(async (req, res) => {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const userId = req.query?.userId;
  await requireUser(userId);

  const action = req.query?.action;
  if (action === 'label-url') return labelUrl(req, res);

  const saleId = req.query?.saleId;
  // Don't ship the heavy labelData blob when listing — clients only need
  // it on demand via the label-url action. The list view just needs
  // tracking + carrier + status info to render.
  let query = supabase
    .from('shipments')
    .select('id, "saleId", carrier, "carrierCode", "serviceCode", "trackingNumber", "labelCost", "labelStoragePath", "isTestLabel", "purchasedAt", "voidedAt"');
  if (saleId) query = query.eq('saleId', saleId);

  const { data, error } = await query;
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ shipments: data || [] });
});

async function labelUrl(req, res) {
  const id = req.query?.id;
  if (!id) { const e = new Error('id required'); e.status = 400; throw e; }

  const { data: row, error } = await supabase
    .from('shipments')
    .select('id, "labelStoragePath", "labelData"')
    .eq('id', id)
    .maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  if (!row) { const e = new Error('Shipment not found'); e.status = 404; throw e; }

  if (row.labelStoragePath) {
    const { data: signed, error: sErr } = await supabase
      .storage
      .from('shipping-labels')
      .createSignedUrl(row.labelStoragePath, SIGNED_URL_TTL_SECONDS);
    if (sErr) { const e = new Error(sErr.message); e.status = 500; throw e; }
    return res.status(200).json({ url: signed.signedUrl });
  }

  // Legacy fallback for shipments rows from before the storage cutover.
  if (row.labelData) {
    return res.status(200).json({ url: `data:application/pdf;base64,${row.labelData}` });
  }

  const e = new Error('No label PDF available for this shipment'); e.status = 404; throw e;
}
