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
    // ShipStation returns either { Message, ExceptionMessage } or a string.
    const msg = data?.Message || data?.ExceptionMessage || data?.message || text || `ShipStation ${res.status}`;
    const e = new Error(msg);
    e.status = res.status;
    e.body = data;
    throw e;
  }
  return data;
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
