// Consolidated ShipStation dispatcher. Used to be two routes
// (/api/shipstation/buy-label and /api/shipstation/void-label) but
// merged to stay under Vercel's 12-function Hobby cap.
//
// POST /api/shipstation
// Body: { action: 'buy-label' | 'void-label', userId, ... }

import { supabase, requireUser } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';
import { createLabel, voidLabel } from './_lib/shipstation.js';

export default wrap(async (req, res) => {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const userId = req.body?.userId;
  await requireUser(userId);

  const action = req.body?.action;
  switch (action) {
    case 'buy-label': return buyLabel(req, res, userId);
    case 'void-label': return voidLabelHandler(req, res, userId);
    default: { const e = new Error(`Unknown action: ${action}`); e.status = 400; throw e; }
  }
});

async function buyLabel(req, res, userId) {
  const { shipmentBoxId } = req.body || {};
  if (!shipmentBoxId) {
    const e = new Error('shipmentBoxId required'); e.status = 400; throw e;
  }

  // Already-purchased guard. The unique key prevents accidental double-buys.
  const { data: existing } = await supabase
    .from('shipments')
    .select('id, voidedAt')
    .eq('id', shipmentBoxId)
    .maybeSingle();
  if (existing && !existing.voidedAt) {
    const e = new Error('Label already purchased for this box (void it first)');
    e.status = 409; throw e;
  }

  // Pull settings (ship-from + carrier defaults + test mode).
  const { data: settingsRow } = await supabase
    .from('app_settings')
    .select('data')
    .eq('id', 'shipping')
    .maybeSingle();
  const settings = settingsRow?.data || {};
  const shipFrom = settings.shipFrom || {};
  if (!shipFrom.name || !shipFrom.street1 || !shipFrom.city || !shipFrom.state || !shipFrom.zip || !shipFrom.country) {
    const e = new Error('Ship-from address incomplete — open Shipping Settings');
    e.status = 412; throw e;
  }

  // Pull all items in this box (for the buyer name + address + carrier).
  const { data: items, error: itemsErr } = await supabase
    .from('inventory_items')
    .select('id, sku, buyer, "buyerUsername", "buyerAddress", "shipmentCarrier", "saleId"')
    .eq('shipmentBoxId', shipmentBoxId);
  if (itemsErr) { const e = new Error(itemsErr.message); e.status = 500; throw e; }
  if (!items || items.length === 0) {
    const e = new Error('No items found for this shipment box'); e.status = 404; throw e;
  }
  const sample = items[0];
  const carrier = sample.shipmentCarrier || 'usps';
  const carrierDefaults = settings.carriers?.[carrier] || {};
  const buyerAddr = sample.buyerAddress || {};
  if (!buyerAddr.street1 || !buyerAddr.city || !buyerAddr.state || !buyerAddr.zip) {
    const e = new Error('Buyer address incomplete on this box'); e.status = 422; throw e;
  }

  // Resolve the ShipStation request fields with caller overrides → settings
  // defaults → hard-coded fallbacks.
  const pkg = settings.defaultPackage || {};
  const weightOz = Number(req.body?.weightOz ?? pkg.weightOz ?? 16);
  const dims = req.body?.dims || pkg;
  const serviceCode = req.body?.serviceCode || carrierDefaults.serviceCode;
  const packageCode = req.body?.packageCode || carrierDefaults.packageCode || 'package';
  const confirmation = req.body?.confirmation || carrierDefaults.confirmation || 'delivery';
  const carrierCode = carrierDefaults.carrierCode;
  if (!carrierCode || !serviceCode) {
    const e = new Error(`Missing carrier/service code for ${carrier} — open Shipping Settings`);
    e.status = 412; throw e;
  }

  const testLabel = settings.testMode !== false; // default to TRUE for safety
  const today = new Date().toISOString().slice(0, 10);

  const payload = {
    carrierCode,
    serviceCode,
    packageCode,
    confirmation,
    shipDate: today,
    weight: { value: weightOz, units: 'ounces' },
    dimensions: dims?.length && dims?.width && dims?.height
      ? { units: 'inches', length: Number(dims.length), width: Number(dims.width), height: Number(dims.height) }
      : undefined,
    shipFrom: {
      name: shipFrom.name,
      company: shipFrom.company || undefined,
      street1: shipFrom.street1,
      street2: shipFrom.street2 || undefined,
      city: shipFrom.city,
      state: shipFrom.state,
      postalCode: shipFrom.zip,
      country: shipFrom.country,
      phone: shipFrom.phone || undefined,
    },
    shipTo: {
      name: sample.buyer || sample.buyerUsername || 'Buyer',
      street1: buyerAddr.street1,
      street2: buyerAddr.street2 || undefined,
      city: buyerAddr.city,
      state: buyerAddr.state,
      postalCode: buyerAddr.zip,
      country: buyerAddr.country || 'US',
      phone: buyerAddr.phone || undefined,
    },
    testLabel,
  };

  const result = await createLabel(payload);

  const row = {
    id: shipmentBoxId,
    saleId: sample.saleId || null,
    carrier,
    carrierCode,
    serviceCode,
    packageCode,
    weightOz,
    dimsLength: payload.dimensions?.length || null,
    dimsWidth: payload.dimensions?.width || null,
    dimsHeight: payload.dimensions?.height || null,
    shipFrom: payload.shipFrom,
    shipTo: payload.shipTo,
    trackingNumber: result?.trackingNumber || null,
    labelCost: result?.shipmentCost ?? null,
    labelData: result?.labelData || null,
    shipstationShipmentId: result?.shipmentId ? String(result.shipmentId) : null,
    shipstationLabelId: result?.labelId ? String(result.labelId) : null,
    isTestLabel: !!testLabel,
    purchasedAt: new Date().toISOString(),
    purchasedBy: userId,
    voidedAt: null,
    voidedBy: null,
  };

  const { data: saved, error: saveErr } = await supabase
    .from('shipments')
    .upsert(row)
    .select()
    .single();
  if (saveErr) { const e = new Error(saveErr.message); e.status = 500; throw e; }

  return res.status(200).json({ shipment: saved });
}

async function voidLabelHandler(req, res, userId) {
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
}
