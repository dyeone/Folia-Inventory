// Consolidated ShipStation dispatcher. Used to be two routes
// (/api/shipstation/buy-label and /api/shipstation/void-label) but
// merged to stay under Vercel's 12-function Hobby cap.
//
// POST /api/shipstation
// Body: { action: 'buy-label' | 'void-label', userId, ... }

import { supabase, requireBrand, brandIdFromReq } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';
import { createLabel, voidLabel, getRates as ssGetRates, getDefaultShipFrom } from './_lib/shipstation.js';
import {
  getRates as shippoGetRates, createLabel as shippoCreateLabel,
  refund as shippoRefund, shippoConfigured, isTestToken as shippoIsTest,
} from './_lib/shippo.js';
import { SHIPPING_SERVICES } from './_lib/services.js';

export default wrap(async (req, res) => {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const userId = req.body?.userId;
  const { brandId } = await requireBrand(userId, brandIdFromReq(req));

  const action = req.body?.action;
  switch (action) {
    case 'buy-label': return buyLabel(req, res, userId, brandId);
    case 'void-label': return voidLabelHandler(req, res, userId, brandId);
    case 'get-rates': return getRatesHandler(req, res, brandId);
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
async function getRatesHandler(req, res, brandId) {
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
    .eq('brandId', brandId)
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
    // UPS quotes originate from ShipStation's default Ship From location —
    // the same origin the purchase uses below — so quoted UPS prices match
    // what's actually bought. Falls back to the settings zip on any failure.
    let fromPostalCode = shipFrom.zip;
    if (carrier === 'ups') {
      try { fromPostalCode = (await getDefaultShipFrom())?.postalCode || shipFrom.zip; }
      catch { /* settings zip */ }
    }
    const rates = await ssGetRates({
      carrierCode,
      packageCode: settings.carriers?.[carrier]?.packageCode || 'package',
      fromPostalCode,
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
    // So the buy UI can label a purchase test vs live before confirming.
    shipstationTestMode: settings.testMode !== false,
    shippoTest: shippoIsConfigured ? shippoIsTest() : false,
  });
}

async function buyLabel(req, res, userId, brandId) {
  const { shipmentBoxId } = req.body || {};
  if (!shipmentBoxId) {
    const e = new Error('shipmentBoxId required'); e.status = 400; throw e;
  }
  const provider = req.body?.provider === 'shippo' ? 'shippo' : 'shipstation';
  const serviceKey = req.body?.serviceKey || null;

  // Ship date (YYYY-MM-DD) — the date sent to the carrier and printed on the
  // label. Required in the UI; defaults to today (server clock) for any
  // legacy caller that doesn't send one. Allow one day in the past so the
  // operator's evening straddling the server's midnight can't reject "today".
  const todayStr = new Date().toISOString().slice(0, 10);
  let shipDate = todayStr;
  if (req.body?.shipDate != null && req.body.shipDate !== '') {
    const raw = String(req.body.shipDate);
    // Round-trip check: Date.parse rolls impossible dates over (2026-02-30
    // parses as Mar 2), so the parsed date must format back to the input.
    const parsed = new Date(`${raw}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== raw) {
      const e = new Error('shipDate must be a real YYYY-MM-DD date'); e.status = 422; throw e;
    }
    const days = (parsed.getTime() - Date.parse(`${todayStr}T00:00:00Z`)) / 86400000;
    if (days < -1 || days > 30) {
      const e = new Error('shipDate must be between today and 30 days out'); e.status = 422; throw e;
    }
    shipDate = raw;
  }

  // Already-purchased guard. The unique key prevents accidental double-buys.
  const { data: existing } = await supabase
    .from('shipments')
    .select('id, voidedAt')
    .eq('id', shipmentBoxId)
    .eq('brandId', brandId)
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
  // variety is needed to apply the anthurium → UPS carrier rule below.
  const { data: items, error: itemsErr } = await supabase
    .from('inventory_items')
    .select('id, sku, variety, buyer, "buyerUsername", "buyerAddress", "shipmentCarrier", "saleId"')
    .eq('brandId', brandId)
    .eq('shipmentBoxId', shipmentBoxId);
  if (itemsErr) { const e = new Error(itemsErr.message); e.status = 500; throw e; }
  if (!items || items.length === 0) {
    const e = new Error('No items found for this shipment box'); e.status = 404; throw e;
  }
  const sample = items[0];
  const buyerAddr = sample.buyerAddress || {};
  if (!buyerAddr.street1 || !buyerAddr.city || !buyerAddr.state || !buyerAddr.zip) {
    const e = new Error('Buyer address incomplete on this box'); e.status = 422; throw e;
  }

  // Resolve the service. A serviceKey (new rate-shop flow) picks the carrier
  // + per-provider codes from the shared catalog; without one we fall back
  // to the box's content-derived carrier + saved defaults (legacy Buy-label).
  const svc = serviceKey ? SHIPPING_SERVICES.find(s => s.key === serviceKey) : null;
  if (serviceKey && !svc) {
    const e = new Error(`Unknown serviceKey: ${serviceKey}`); e.status = 400; throw e;
  }
  // Content rule (mirrors src/packing/carrier.js): a per-box override wins,
  // else any anthurium item → UPS, else the stamped carrier. Select '*' so a
  // missing carrierOverride column (pre-migration) degrades to no override
  // rather than erroring.
  const { data: boxRow } = await supabase
    .from('shipment_boxes').select('*').eq('id', shipmentBoxId).eq('brandId', brandId).maybeSingle();
  const override = boxRow?.carrierOverride ? String(boxRow.carrierOverride).toLowerCase() : null;
  const hasAnthurium = items.some(i => (i.variety || '').toLowerCase() === 'anthurium');
  const derivedCarrier = override || (hasAnthurium ? 'ups' : (sample.shipmentCarrier || 'usps'));
  const carrier = svc ? svc.provider : derivedCarrier;
  const carrierDefaults = settings.carriers?.[carrier] || {};

  const pkg = settings.defaultPackage || {};
  const weightOz = Number(req.body?.weightOz ?? pkg.weightOz ?? 16);
  const dims = req.body?.dims || pkg;
  if (!(weightOz > 0)) { const e = new Error('Weight is required to buy a label'); e.status = 422; throw e; }

  const shipFromAddr = {
    name: shipFrom.name,
    company: shipFrom.company || undefined,
    street1: shipFrom.street1,
    street2: shipFrom.street2 || undefined,
    city: shipFrom.city,
    state: shipFrom.state,
    zip: shipFrom.zip,
    country: shipFrom.country,
    phone: shipFrom.phone || undefined,
  };
  const shipToAddr = {
    name: sample.buyer || sample.buyerUsername || 'Buyer',
    street1: buyerAddr.street1,
    street2: buyerAddr.street2 || undefined,
    city: buyerAddr.city,
    state: buyerAddr.state,
    zip: buyerAddr.zip,
    country: buyerAddr.country || 'US',
    phone: buyerAddr.phone || undefined,
  };

  // Provider-specific purchase. Both normalize to:
  //   { labelData(base64), trackingNumber, labelCost, serviceCode,
  //     carrierCode, isTestLabel, shipstation*Id, shippoTransactionId }
  let purchase;
  // The origin actually sent to the carrier — recorded on the shipments row.
  // ShipStation UPS buys swap in the account's default Ship From location.
  let shipFromUsed = shipFromAddr;
  if (provider === 'shippo') {
    if (!svc) { const e = new Error('serviceKey required for a Shippo label'); e.status = 400; throw e; }
    if (!shippoConfigured()) { const e = new Error('Shippo not configured (SHIPPO_API_TOKEN)'); e.status = 412; throw e; }
    const r = await shippoCreateLabel({
      addressFrom: shipFromAddr,
      addressTo: shipToAddr,
      parcel: { length: Number(dims.length), width: Number(dims.width), height: Number(dims.height), weightOz },
      serviceToken: svc.shippoToken,
      // Only send a date that's still in the future: noon UTC on "today" is
      // already past for most of the US day, and some carriers reject a past
      // tender time. Same-day (or grace-day) buys omit it — Shippo assumes
      // "now", which is exactly the pre-feature behavior. Noon UTC keeps the
      // calendar date stable across US timezones for future dates.
      shipmentDate: shipDate > todayStr ? `${shipDate}T12:00:00Z` : undefined,
    });
    if (!r.labelUrl) { const e = new Error('Shippo did not return a label PDF'); e.status = 502; throw e; }
    const pdfRes = await fetch(r.labelUrl);
    if (!pdfRes.ok) { const e = new Error('Could not download the Shippo label PDF'); e.status = 502; throw e; }
    const labelData = Buffer.from(await pdfRes.arrayBuffer()).toString('base64');
    purchase = {
      labelData,
      trackingNumber: r.trackingNumber,
      labelCost: r.amount,
      serviceCode: svc.shippoToken,
      carrierCode: 'shippo',
      isTestLabel: r.isTest,
      shipstationShipmentId: null,
      shipstationLabelId: null,
      shippoTransactionId: r.transactionId,
    };
  } else {
    const serviceCode = svc ? svc.shipstationServiceCode : (req.body?.serviceCode || carrierDefaults.serviceCode);
    const carrierCode = carrierDefaults.carrierCode;
    const packageCode = req.body?.packageCode || carrierDefaults.packageCode || 'package';
    const confirmation = req.body?.confirmation || carrierDefaults.confirmation || 'delivery';
    if (!carrierCode || !serviceCode) {
      const e = new Error(`Missing carrier/service code for ${carrier} — open Shipping Settings`);
      e.status = 412; throw e;
    }
    const testLabel = settings.testMode !== false; // default to TRUE for safety
    // UPS labels ship from ShipStation's DEFAULT Ship From location (the
    // UPS-registered pickup address the operator maintains in ShipStation),
    // not the app's Shipping Settings address. Real purchases FAIL CLOSED
    // when that location can't be confirmed — silently buying with the
    // settings origin is the wrong-origin label this feature exists to
    // prevent. Test labels (no charge) fall back so test flows still work.
    let ssShipFrom = { ...shipFromAddr, postalCode: shipFrom.zip, zip: undefined };
    if (carrier === 'ups') {
      let def = null, lookupErr = null;
      try {
        def = await getDefaultShipFrom({ fresh: true }); // money path — no cache
      } catch (e) { lookupErr = e; }
      if (def) {
        ssShipFrom = def;
      } else if (testLabel) {
        console.warn('[shipstation] default Ship From unavailable — test label uses settings address:',
          lookupErr?.message || 'none marked default');
      } else {
        const e = new Error(lookupErr
          ? `Couldn't confirm the ShipStation default Ship From location (${lookupErr.message}) — try again`
          : 'No default Ship From location in ShipStation — mark one as default (ShipStation → Settings → Shipping → Ship From Locations)');
        e.status = 412; throw e;
      }
    }
    shipFromUsed = { ...ssShipFrom, zip: ssShipFrom.postalCode, postalCode: undefined };
    let result;
    try {
      result = await createLabel({
        carrierCode, serviceCode, packageCode, confirmation,
        shipDate,
        weight: { value: weightOz, units: 'ounces' },
        dimensions: dims?.length && dims?.width && dims?.height
          ? { units: 'inches', length: Number(dims.length), width: Number(dims.width), height: Number(dims.height) }
          : undefined,
        shipFrom: ssShipFrom,
        shipTo: { ...shipToAddr, postalCode: buyerAddr.zip, zip: undefined },
        testLabel,
      });
    } catch (e) {
      // ShipStation only issues test labels for USPS (Stamps.com); UPS/FedEx
      // by ShipStation reject them. Turn that opaque 500 into a next step.
      if (testLabel && /test label/i.test(e?.message || '')) {
        const err = new Error(`ShipStation can't make test labels for ${carrier.toUpperCase()} — only USPS. Turn off Test mode in Shipping Settings to buy a real ${carrier.toUpperCase()} label, or test with USPS / Shippo.`);
        err.status = 422; throw err;
      }
      throw e;
    }
    purchase = {
      labelData: result?.labelData || null,
      trackingNumber: result?.trackingNumber || null,
      labelCost: result?.shipmentCost ?? null,
      serviceCode,
      carrierCode,
      isTestLabel: !!testLabel,
      shipstationShipmentId: result?.shipmentId ? String(result.shipmentId) : null,
      shipstationLabelId: result?.labelId ? String(result.labelId) : null,
      shippoTransactionId: null,
    };
  }

  // Upload the PDF to the `shipping-labels` Storage bucket so the row stays
  // small. Soft-fall-through to inline labelData if the upload fails —
  // better a working bigger row than losing a label we've paid for.
  let labelStoragePath = null;
  let labelData = purchase.labelData || null;
  if (labelData) {
    try {
      const buf = Buffer.from(labelData, 'base64');
      // shipmentBoxId is a composite key (contains | and spaces); Supabase
      // Storage rejects those, so sanitize it into a valid object key.
      const path = `${storageKey(shipmentBoxId)}.pdf`;
      const { error: upErr } = await supabase
        .storage
        .from('shipping-labels')
        .upload(path, buf, { contentType: 'application/pdf', upsert: true });
      if (upErr) throw upErr;
      labelStoragePath = path;
      labelData = null; // success — no need to store the bytes inline
    } catch (e) {
      console.error(`[${provider}] label upload to Storage failed; falling back to inline labelData:`, e?.message || e);
    }
  }

  const row = {
    id: shipmentBoxId,
    brandId,
    saleId: sample.saleId || null,
    carrier,
    carrierCode: purchase.carrierCode,
    serviceCode: purchase.serviceCode,
    packageCode: 'package',
    weightOz,
    dimsLength: Number(dims?.length) || null,
    dimsWidth: Number(dims?.width) || null,
    dimsHeight: Number(dims?.height) || null,
    shipFrom: shipFromUsed,
    shipTo: shipToAddr,
    trackingNumber: purchase.trackingNumber,
    labelCost: purchase.labelCost,
    labelData,
    labelStoragePath,
    provider,
    shippoTransactionId: purchase.shippoTransactionId,
    shipstationShipmentId: purchase.shipstationShipmentId,
    shipstationLabelId: purchase.shipstationLabelId,
    isTestLabel: !!purchase.isTestLabel,
    purchasedAt: new Date().toISOString(),
    purchasedBy: userId,
    voidedAt: null,
    voidedBy: null,
  };

  const saved = await upsertShipment(row);
  return res.status(200).json({ shipment: saved });
}

// Supabase Storage rejects keys with characters like | and spaces. The
// shipmentBoxId is a composite "id|buyer|street|city|state|zip" key, so map
// it to a safe object key. The sanitized path is stored on the row, so
// retrieval (getLabelUrl) uses it verbatim — no need to reverse it.
function storageKey(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
}

// True for a "column does not exist" / stale-schema-cache error — used to
// stay functional on a DB where migration 0023 (provider,
// shippoTransactionId) hasn't been applied yet.
function isMissingColumn(error) {
  const m = (error?.message || '').toLowerCase();
  return error?.code === '42703' || error?.code === 'PGRST204'
    || (m.includes('column') && (m.includes('does not exist') || m.includes('schema cache')));
}

// Upsert a shipments row. If the 0023 columns aren't there yet, strip them
// and retry so buying never hard-fails on deploy ordering. ShipStation
// voids still work (shipstationShipmentId); Shippo refund-routing needs the
// columns, so apply 0023 for full function.
async function upsertShipment(row) {
  let { data, error } = await supabase.from('shipments').upsert(row).select().single();
  if (error && isMissingColumn(error)) {
    const { provider: _p, shippoTransactionId: _t, ...legacy } = row;
    console.warn('[shipstation] shipments.provider/shippoTransactionId missing — apply migration 0023. Saving without them.');
    ({ data, error } = await supabase.from('shipments').upsert(legacy).select().single());
  }
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return data;
}

async function voidLabelHandler(req, res, userId, brandId) {
  const { shipmentBoxId } = req.body || {};
  if (!shipmentBoxId) {
    const e = new Error('shipmentBoxId required'); e.status = 400; throw e;
  }

  // Tolerate a pre-0023 DB: fall back to the legacy column set (treats the
  // row as ShipStation) if provider/shippoTransactionId aren't there yet.
  let shipment;
  {
    const r = await supabase
      .from('shipments')
      .select('id, "carrierCode", provider, "shipstationShipmentId", "shippoTransactionId", "isTestLabel", "voidedAt"')
      .eq('id', shipmentBoxId)
      .eq('brandId', brandId)
      .maybeSingle();
    if (r.error && isMissingColumn(r.error)) {
      const r2 = await supabase
        .from('shipments')
        .select('id, "carrierCode", "shipstationShipmentId", "isTestLabel", "voidedAt"')
        .eq('id', shipmentBoxId)
        .eq('brandId', brandId)
        .maybeSingle();
      shipment = r2.data ? { ...r2.data, provider: null, shippoTransactionId: null } : null;
    } else {
      shipment = r.data;
    }
  }
  if (!shipment) {
    const e = new Error('No purchased label for this box'); e.status = 404; throw e;
  }
  if (shipment.voidedAt) {
    const e = new Error('Label already voided'); e.status = 409; throw e;
  }

  // Two cases have nothing to undo at the carrier, so we skip the void/refund
  // call and just mark our row voided below — which frees the box to switch
  // carriers and buy a new label:
  //   • Test labels — placeholders, nothing charged (ShipStation's voidlabel
  //     even throws a .NET "Index was out of range" on the fake test id).
  //   • Palmstreet/manual USPS rows — the label was generated in Palmstreet and
  //     the operator just entered the tracking here; there's no purchase to void.
  const isManual = shipment.carrierCode === 'palmstreet';
  if (!shipment.isTestLabel && !isManual) {
    // Route the void by who sold the label. A null provider on a row with a
    // ShipStation id is a legacy ShipStation label.
    const isShippo = shipment.provider === 'shippo' || (!!shipment.shippoTransactionId && !shipment.shipstationShipmentId);
    if (isShippo) {
      if (!shipment.shippoTransactionId) {
        const e = new Error('Missing Shippo transaction id — cannot refund'); e.status = 422; throw e;
      }
      await shippoRefund(shipment.shippoTransactionId);
    } else {
      if (!shipment.shipstationShipmentId) {
        const e = new Error('Missing ShipStation shipment id — cannot void'); e.status = 422; throw e;
      }
      const result = await voidLabel(Number(shipment.shipstationShipmentId));
      if (result && result.approved === false) {
        const e = new Error(result.message || 'ShipStation declined the void');
        e.status = 409; throw e;
      }
    }
  }

  const { data: updated, error: updErr } = await supabase
    .from('shipments')
    .update({ voidedAt: new Date().toISOString(), voidedBy: userId })
    .eq('id', shipmentBoxId)
    .eq('brandId', brandId)
    .select()
    .single();
  if (updErr) { const e = new Error(updErr.message); e.status = 500; throw e; }

  return res.status(200).json({ shipment: updated });
}
