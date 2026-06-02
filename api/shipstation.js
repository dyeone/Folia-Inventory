// Consolidated ShipStation dispatcher. Used to be two routes
// (/api/shipstation/buy-label and /api/shipstation/void-label) but
// merged to stay under Vercel's 12-function Hobby cap.
//
// POST /api/shipstation
// Body: { action: 'buy-label' | 'void-label', userId, ... }

import { supabase, requireUser } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';
import { createLabel, voidLabel, getRates as ssGetRates } from './_lib/shipstation.js';
import { getRates as shippoGetRates, shippoConfigured } from './_lib/shippo.js';
import { SHIPPING_SERVICES } from './_lib/services.js';

export default wrap(async (req, res) => {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const userId = req.body?.userId;
  await requireUser(userId);

  const action = req.body?.action;
  switch (action) {
    case 'buy-label': return buyLabel(req, res, userId);
    case 'void-label': return voidLabelHandler(req, res, userId);
    case 'get-rates': return getRatesHandler(req, res);
    default: { const e = new Error(`Unknown action: ${action}`); e.status = 400; throw e; }
  }
});

// POST /api/shipstation  body: { action:'get-rates', shipmentBoxId,
//   dims:{length,width,height}, weightOz, services?:[serviceKey] }
//
// Quotes the offered services from BOTH ShipStation and Shippo for one box,
// side by side. Read-only — buys nothing. Resolves ship-from from settings
// and ship-to from the box's items. ShipStation is quoted once per distinct
// carrier; Shippo once total. Either provider failing degrades to null for
// that column rather than failing the whole request.
async function getRatesHandler(req, res) {
  const { shipmentBoxId, dims, weightOz } = req.body || {};
  if (!shipmentBoxId) { const e = new Error('shipmentBoxId required'); e.status = 400; throw e; }

  const length = Number(dims?.length), width = Number(dims?.width), height = Number(dims?.height);
  const weight = Number(weightOz);
  if (![length, width, height, weight].every(n => Number.isFinite(n) && n > 0)) {
    const e = new Error('Box dimensions and weight are required to quote rates'); e.status = 422; throw e;
  }

  // Limit to a requested subset of services, else quote all three.
  const wanted = Array.isArray(req.body?.services) && req.body.services.length
    ? SHIPPING_SERVICES.filter(s => req.body.services.includes(s.key))
    : SHIPPING_SERVICES;

  // Ship-from + connected carrier codes from settings.
  const { data: settingsRow } = await supabase
    .from('app_settings').select('data').eq('id', 'shipping').maybeSingle();
  const settings = settingsRow?.data || {};
  const shipFrom = settings.shipFrom || {};
  if (!shipFrom.zip) {
    const e = new Error('Ship-from address incomplete — open Shipping Settings'); e.status = 412; throw e;
  }
  const carrierCodes = {
    usps: settings.carriers?.usps?.carrierCode || null,
    ups: settings.carriers?.ups?.carrierCode || null,
  };

  // Ship-to from the box's items.
  const { data: items } = await supabase
    .from('inventory_items')
    .select('buyer, "buyerUsername", "buyerAddress"')
    .eq('shipmentBoxId', shipmentBoxId)
    .limit(1);
  const sample = items?.[0];
  const to = sample?.buyerAddress || {};
  if (!to.zip || !to.state) {
    const e = new Error('Buyer address incomplete on this box'); e.status = 422; throw e;
  }

  // ── ShipStation: one getrates call per distinct carrier needed ──────────
  const neededCarriers = [...new Set(wanted.map(s => s.provider))];
  const ssByServiceCode = {};
  const ssJobs = neededCarriers.map(async (carrier) => {
    const carrierCode = carrierCodes[carrier];
    if (!carrierCode) return; // carrier not connected in settings — skip
    const rates = await ssGetRates({
      carrierCode,
      packageCode: settings.carriers?.[carrier]?.packageCode || 'package',
      fromPostalCode: shipFrom.zip,
      toState: to.state,
      toCountry: to.country || 'US',
      toPostalCode: to.zip,
      toCity: to.city,
      weight: { value: weight, units: 'ounces' },
      dimensions: { units: 'inches', length, width, height },
      confirmation: 'delivery',
      residential: true,
    });
    for (const r of rates) ssByServiceCode[r.serviceCode] = r;
  });

  // ── Shippo: one call returns rates for every provider/service ───────────
  const shippoIsConfigured = shippoConfigured();
  let shippoByToken = {};
  let shippoError = null;
  const shippoJob = (async () => {
    if (!shippoIsConfigured) return;
    try {
      const rates = await shippoGetRates({
        addressFrom: shipFrom,
        addressTo: { ...to, name: sample?.buyer || sample?.buyerUsername || 'Buyer' },
        parcel: { length, width, height, weightOz: weight },
      });
      for (const r of rates) if (r.serviceToken) shippoByToken[r.serviceToken] = r;
    } catch (e) {
      shippoError = e?.message || 'Shippo rate lookup failed';
    }
  })();

  const ssSettled = await Promise.allSettled([...ssJobs, shippoJob]);
  // Surface a ShipStation-wide failure (e.g. bad creds) without masking Shippo.
  const ssErr = ssSettled.slice(0, ssJobs.length).find(r => r.status === 'rejected');
  const shipstationError = ssErr ? (ssErr.reason?.message || 'ShipStation rate lookup failed') : null;

  const rates = wanted.map((svc) => {
    const ss = ssByServiceCode[svc.shipstationServiceCode];
    const shp = shippoByToken[svc.shippoToken];
    const shipstation = ss ? { amount: ss.amount, serviceName: ss.serviceName } : null;
    const shippo = shp && shp.amount != null
      ? { amount: shp.amount, serviceName: shp.serviceName, estDays: shp.estDays }
      : null;
    let cheapest = null;
    if (shipstation && shippo) {
      cheapest = shippo.amount < shipstation.amount ? 'shippo'
        : shippo.amount > shipstation.amount ? 'shipstation' : 'tie';
    }
    return { key: svc.key, label: svc.label, provider: svc.provider, shipstation, shippo, cheapest };
  });

  return res.status(200).json({
    rates,
    shippoConfigured: shippoIsConfigured,
    shippoError,
    shipstationError,
  });
}

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

  // Upload the PDF to the `shipping-labels` Storage bucket so the row stays
  // small. The DB only keeps the path; signed URLs are minted on demand.
  // Soft-fall-through to inline labelData if the bucket doesn't exist or
  // the upload fails — better to leave a working but bigger row than to
  // lose the label after we've already paid for it.
  let labelStoragePath = null;
  let labelData = result?.labelData || null;
  if (labelData) {
    try {
      const buf = Buffer.from(labelData, 'base64');
      const path = `${shipmentBoxId}.pdf`;
      const { error: upErr } = await supabase
        .storage
        .from('shipping-labels')
        .upload(path, buf, { contentType: 'application/pdf', upsert: true });
      if (upErr) throw upErr;
      labelStoragePath = path;
      labelData = null; // success — no need to store the bytes inline
    } catch (e) {
      console.error('[shipstation] label upload to Storage failed; falling back to inline labelData:', e?.message || e);
    }
  }

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
    labelData,
    labelStoragePath,
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
