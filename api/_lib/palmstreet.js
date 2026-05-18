// Palmstreet OMS API — write-only endpoints we use to close the
// tracking-visibility loop after the operator marks a box shipped.
//
// Token model: operator-pasted bearer token with a ~1-hour lifetime,
// no refresh endpoint. We stash it under app_settings.id='shipping'
// → data.palmstreet.{token, tokenSetAt}. When a call returns 401 the
// caller is expected to surface "token expired" to the operator so
// they reload palmstreet and paste a fresh one.
//
// Three endpoints, all POST, all Bearer-authed:
//   1. update one order's tracking by order_number
//   2. create a package (one shipment) from a list of order_numbers
//   3. update a package's tracking by package_id (cascades to every
//      order in the package)

const BASE_URL = 'https://api.plantstory.app';

class PalmstreetError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'PalmstreetError';
    this.status = status;
    this.body = body;
  }
}

async function call(endpoint, token, body) {
  if (!token) {
    throw new PalmstreetError(
      'Palmstreet token not set. Paste a fresh one in Shipping Settings.',
      { status: 401 },
    );
  }
  let res;
  try {
    res = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new PalmstreetError(`Palmstreet request failed: ${e.message}`, { status: 0 });
  }

  // Try to surface as much of the upstream body as possible — the
  // operator needs the full error text to debug a bad token / missing
  // order / unsupported carrier value.
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }

  if (!res.ok) {
    const detail = parsed?.message || parsed?.error || text || `HTTP ${res.status}`;
    throw new PalmstreetError(
      `Palmstreet ${endpoint} failed (${res.status}): ${detail}`,
      { status: res.status, body: parsed || text || null },
    );
  }
  if (parsed?.status && parsed.status !== 'success') {
    throw new PalmstreetError(
      `Palmstreet ${endpoint} returned status='${parsed.status}': ${parsed.message || JSON.stringify(parsed)}`,
      { status: 200, body: parsed },
    );
  }
  return parsed?.data ?? parsed;
}

export function updateOrderTracking(token, { orderNumber, trackingNumber, carrier }) {
  return call('/oms/ops/orders/orderNumber/update', token, {
    tracking_number: trackingNumber,
    shipment_carrier: carrier,
    order_number: orderNumber,
  });
}

export function createPackageByOrderNumbers(token, orderNumbers) {
  return call('/oms/order-package/create/by/order/numbers', token, {
    order_numbers: orderNumbers,
  });
}

export function updatePackageTracking(token, packageId, { trackingNumber, carrier }) {
  return call(`/oms/order-package/update/tracking/${encodeURIComponent(packageId)}`, token, {
    tracking_number: trackingNumber,
    shipment_carrier: carrier,
  });
}

export { PalmstreetError };
