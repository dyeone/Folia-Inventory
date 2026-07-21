// Thin wrapper around ShipStation's V1 REST API.
// Docs: https://docs.shipstation.com/
// Auth: Basic base64(apiKey:apiSecret) in the Authorization header.
//
// The V1 API key + secret live in env vars and are never sent to the
// browser. All ShipStation calls go through server-side /api routes.

const BASE = 'https://ssapi.shipstation.com';

function authHeader() {
  const key = process.env.SHIPSTATION_API_KEY;
  const secret = process.env.SHIPSTATION_API_SECRET;
  if (!key || !secret) {
    const e = new Error('ShipStation credentials not configured (SHIPSTATION_API_KEY / SHIPSTATION_API_SECRET)');
    e.status = 500;
    throw e;
  }
  return 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
}

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* leave data null */ }
  if (!res.ok) {
    // ShipStation wraps real errors in ExceptionMessage and puts a generic
    // "An error has occurred." in Message — prefer the specific field.
    const msg = data?.ExceptionMessage || data?.Message || data?.message || text || `ShipStation ${res.status}`;
    const e = new Error(msg);
    e.status = res.status;
    e.body = data;
    throw e;
  }
  return data;
}

// GET /warehouses — the account's "Ship From Locations" as configured in
// ShipStation. Returns the DEFAULT location's origin address, shaped for
// createlabel's shipFrom ({ ..., postalCode }), or null when no location is
// marked default or its address is unusable.
//
// Caching: only a USABLE address is cached (10 min) — a "no default" result
// is never cached, so an operator fixing their Ship From Locations isn't
// pinned to the old answer for the TTL. Quotes read the cache; purchases
// pass { fresh: true } because money moves on that path and a warm
// instance's cache must not buy a label with an origin the operator just
// changed in ShipStation.
const DEFAULT_SHIP_FROM_TTL_MS = 10 * 60 * 1000;
let defaultShipFromCache = { at: 0, addr: null };

export async function getDefaultShipFrom({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && defaultShipFromCache.addr && now - defaultShipFromCache.at < DEFAULT_SHIP_FROM_TTL_MS) {
    return defaultShipFromCache.addr;
  }
  const list = await call('GET', '/warehouses');
  const def = (Array.isArray(list) ? list : []).find(w => w.isDefault) || null;
  const a = def?.originAddress || null;
  // Require the full shippable shape — a partial address must fall out as
  // null (clear 412 upstream) rather than ride into createlabel and bounce
  // off the carrier with an opaque error.
  const addr = a && a.street1 && a.city && a.state && a.postalCode ? {
    name: a.name || def.warehouseName || '',
    company: a.company || undefined,
    street1: a.street1,
    street2: a.street2 || undefined,
    city: a.city,
    state: a.state,
    postalCode: a.postalCode,
    country: a.country || 'US',
    phone: a.phone || undefined,
  } : null;
  if (addr) defaultShipFromCache = { at: now, addr };
  return addr;
}

// POST /shipments/createlabel — buys a label and returns base64 PDF + tracking.
//
// Request shape (subset we use):
//   carrierCode, serviceCode, packageCode, confirmation, shipDate (yyyy-mm-dd)
//   weight: { value, units: 'ounces'|'pounds' }
//   dimensions: { units: 'inches'|'centimeters', length, width, height }
//   shipFrom / shipTo: { name, company, street1, street2, city, state, postalCode, country, phone }
//   testLabel: bool — when true, ShipStation does not charge.
//
// Response shape (subset we use):
//   shipmentId, shipmentCost, trackingNumber, labelData (base64 PDF)
export function createLabel(payload) {
  return call('POST', '/shipments/createlabel', payload);
}

// POST /shipments/voidlabel — voids a previously purchased label.
// ShipStation may decline if the label has already been used / scanned.
export function voidLabel(shipmentId) {
  return call('POST', '/shipments/voidlabel', { shipmentId });
}

// POST /shipments/getrates — quotes every service for one carrier without
// buying anything. serviceCode omitted → all services for the carrier.
//
// Request (subset): carrierCode, fromPostalCode, toState, toCountry,
//   toPostalCode, toCity, weight {value,units}, dimensions {units,l,w,h},
//   confirmation, residential.
// Response: [{ serviceName, serviceCode, shipmentCost, otherCost }, ...]
//
// Returns the normalized array:
//   [{ serviceName, serviceCode, amount }]  (amount = shipmentCost + otherCost)
export async function getRates(payload) {
  const data = await call('POST', '/shipments/getrates', payload);
  const list = Array.isArray(data) ? data : [];
  return list.map(r => ({
    serviceName: r.serviceName || '',
    serviceCode: r.serviceCode || '',
    amount: (Number(r.shipmentCost) || 0) + (Number(r.otherCost) || 0),
  }));
}
