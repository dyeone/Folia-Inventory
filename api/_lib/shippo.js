// Thin wrapper around Shippo's REST API.
// Docs: https://docs.goshippo.com/
// Auth: `Authorization: ShippoToken <token>` (header, never sent to browser).
//
// We only use it to *quote* rates today (compare against ShipStation) — no
// label purchase goes through Shippo. The token lives in SHIPPO_API_TOKEN
// and all calls are server-side.

const BASE = 'https://api.goshippo.com';

export function shippoConfigured() {
  return !!process.env.SHIPPO_API_TOKEN;
}

function authHeader() {
  const token = process.env.SHIPPO_API_TOKEN;
  if (!token) {
    const e = new Error('Shippo not configured (SHIPPO_API_TOKEN)');
    e.status = 412;
    e.code = 'SHIPPO_NOT_CONFIGURED';
    throw e;
  }
  return `ShippoToken ${token}`;
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
  try { data = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  if (!res.ok) {
    const msg = data?.detail || data?.message || text || `Shippo ${res.status}`;
    const e = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    e.status = res.status;
    e.body = data;
    throw e;
  }
  return data;
}

export function isTestToken() {
  return (process.env.SHIPPO_API_TOKEN || '').startsWith('shippo_test');
}

// Map an app ship-from / buyer address into Shippo's address shape.
function toShippoAddress(a = {}) {
  return {
    name: a.name || a.recipientName || 'N/A',
    company: a.company || undefined,
    street1: a.street1,
    street2: a.street2 || undefined,
    city: a.city,
    state: a.state,
    zip: a.zip,
    country: a.country || 'US',
    phone: a.phone || undefined,
  };
}

function toShippoParcel(p = {}) {
  return {
    length: String(p.length),
    width: String(p.width),
    height: String(p.height),
    distance_unit: 'in',
    weight: String(p.weightOz),
    mass_unit: 'oz',
  };
}

// POST /shipments — creates a shipment and (with async:false) returns the
// fully-rated object synchronously. Returns the normalized rates array:
//   [{ provider, serviceName, serviceToken, amount, currency, estDays }]
export async function getRates({ addressFrom, addressTo, parcel }) {
  const shipment = await call('POST', '/shipments/', {
    address_from: toShippoAddress(addressFrom),
    address_to: toShippoAddress(addressTo),
    parcels: [toShippoParcel(parcel)],
    async: false,
  });
  const rates = Array.isArray(shipment?.rates) ? shipment.rates : [];
  return rates.map(r => ({
    provider: r.provider || '',
    serviceName: r.servicelevel?.name || '',
    serviceToken: r.servicelevel?.token || '',
    amount: r.amount != null ? Number(r.amount) : null,
    currency: r.currency || 'USD',
    estDays: r.estimated_days ?? null,
  }));
}

// Buy a label for one parcel via a specific service. Creates the shipment,
// finds the matching rate by servicelevel token, then purchases it via a
// Transaction. Returns tracking + a Shippo-hosted PDF URL + the txn id
// (needed for refunds). With a shippo_test_* token, no charge is made.
export async function createLabel({ addressFrom, addressTo, parcel, serviceToken, shipmentDate }) {
  const shipment = await call('POST', '/shipments/', {
    address_from: toShippoAddress(addressFrom),
    address_to: toShippoAddress(addressTo),
    parcels: [toShippoParcel(parcel)],
    // ISO datetime of the planned carrier hand-off (Shippo's shipment_date);
    // omitted → Shippo assumes now.
    ...(shipmentDate ? { shipment_date: shipmentDate } : {}),
    async: false,
  });
  const rates = Array.isArray(shipment?.rates) ? shipment.rates : [];
  const rate = rates.find(r => r.servicelevel?.token === serviceToken);
  if (!rate) {
    const e = new Error(`Shippo returned no ${serviceToken} rate for this box — is that carrier connected in Shippo?`);
    e.status = 422; throw e;
  }

  const txn = await call('POST', '/transactions/', {
    rate: rate.object_id,
    // Force a 4×6 thermal label (not the account-default 'PDF', which can be an
    // 8.5×11 sheet that prints clipped to "half" on a 4×6 label printer).
    label_file_type: 'PDF_4x6',
    async: false,
  });
  if (txn?.status !== 'SUCCESS') {
    const msg = (txn?.messages || []).map(m => m?.text || m).filter(Boolean).join('; ')
      || `Shippo could not buy the label (status ${txn?.status || 'unknown'})`;
    const e = new Error(msg); e.status = 422; throw e;
  }

  return {
    trackingNumber: txn.tracking_number || null,
    labelUrl: txn.label_url || null,
    amount: rate.amount != null ? Number(rate.amount) : null,
    currency: rate.currency || 'USD',
    transactionId: txn.object_id || null,
    serviceName: rate.servicelevel?.name || '',
    isTest: isTestToken(),
  };
}

// POST /refunds — Shippo's equivalent of voiding. Refunds are frequently
// returned as PENDING (processed async); only an explicit ERROR is a
// failure. Treats PENDING/SUCCESS as accepted.
export async function refund(transactionId) {
  const r = await call('POST', '/refunds/', { transaction: transactionId, async: false });
  if (r?.status === 'ERROR') {
    const msg = (r?.messages || []).map(m => m?.text || m).filter(Boolean).join('; ')
      || 'Shippo declined the refund';
    const e = new Error(msg); e.status = 409; throw e;
  }
  return r;
}
