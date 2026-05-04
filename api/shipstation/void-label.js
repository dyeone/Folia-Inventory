import { supabase, requireUser } from '../_lib/supabase.js';
import { wrap, methodNotAllowed } from '../_lib/respond.js';
import { voidLabel } from '../_lib/shipstation.js';

// POST /api/shipstation/void-label
// Body: { shipmentBoxId, userId }
// Marks the shipments row voided and asks ShipStation to refund the cost.
// ShipStation may decline (already used, too old, etc.) — we still record
// the attempt's response and surface it to the user.

export default wrap(async (req, res) => {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const userId = req.body?.userId;
  await requireUser(userId);

  const { shipmentBoxId } = req.body || {};
  if (!shipmentBoxId) {
    const e = new Error('shipmentBoxId required'); e.status = 400; throw e;
  }

  const { data: shipment } = await supabase
    .from('shipments')
    .select('id, "shipstationShipmentId", "voidedAt"')
    .eq('id', shipmentBoxId)
    .maybeSingle();
  if (!shipment) {
    const e = new Error('No purchased label for this box'); e.status = 404; throw e;
  }
  if (shipment.voidedAt) {
    const e = new Error('Label already voided'); e.status = 409; throw e;
  }
  if (!shipment.shipstationShipmentId) {
    const e = new Error('Missing ShipStation shipment id — cannot void');
    e.status = 422; throw e;
  }

  const result = await voidLabel(Number(shipment.shipstationShipmentId));
  // ShipStation returns { approved: bool, message: '...' }.
  if (result && result.approved === false) {
    const e = new Error(result.message || 'ShipStation declined the void');
    e.status = 409; throw e;
  }

  const { data: updated, error: updErr } = await supabase
    .from('shipments')
    .update({ voidedAt: new Date().toISOString(), voidedBy: userId })
    .eq('id', shipmentBoxId)
    .select()
    .single();
  if (updErr) { const e = new Error(updErr.message); e.status = 500; throw e; }

  return res.status(200).json({ shipment: updated });
});
