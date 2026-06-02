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

// POST /shipments — creates a shipment and (with async:false) returns the
// fully-rated object synchronously. Returns the normalized rates array:
//   [{ provider, serviceName, serviceToken, amount, currency, estDays }]
export async function getRates({ addressFrom, addressTo, parcel }) {
  const payload = {
    address_from: toShippoAddress(addressFrom),
    address_to: toShippoAddress(addressTo),
    parcels: [{
      length: String(parcel.length),
      width: String(parcel.width),
      height: String(parcel.height),
      distance_unit: 'in',
      weight: String(parcel.weightOz),
      mass_unit: 'oz',
    }],
    async: false,
  };

  const shipment = await call('POST', '/shipments/', payload);
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
