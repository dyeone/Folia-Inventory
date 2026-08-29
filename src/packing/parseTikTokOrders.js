// Parse rows from a TikTok Seller Center "To Ship" orders export
// (OrderSKUList sheet — one row per SKU of an order) and group them into
// boxes with the SAME shape parsePalmstreetOrders emits, so the whole
// Validate pipeline (matching, classify, apply) is shared.
//
// One box = one recipient at one address WITHIN this upload — multiple
// TikTok orders from the same buyer pack together, but the `tt…` box-id
// prefix keeps them from ever merging into that client's Palmstreet
// boxes (see platform.js).
//
// SKU resolution: live listings created from the flowers template carry
// the plant's label number as the Product Name (e.g. "7393" for
// ANT-7393). The per-brand SKU counter is a single sequence across all
// prefixes, so bare digits resolve unambiguously against inventory by
// numeric suffix. Non-numeric product names are scanned for a standard
// PREFIX-123 SKU; anything else stays unmatched and flows through as a
// placeholder, same as Palmstreet.

function pick(row, ...keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
  }
  return '';
}

const SKU_SHAPE = /^(?:[A-Za-z]{2,8}-)?[A-Za-z]{2,8}-(\d+)$/;

export function parseTikTokOrders(rows, inventoryItems) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  // Numeric suffix → full inventory SKU. Prefer a fresh (available/listed)
  // row when a suffix somehow appears twice (e.g. a consignment SKU that
  // wraps a base one) — that's the row apply would mark sold.
  const skuBySuffix = new Map();
  for (const i of inventoryItems || []) {
    if (i.deletedAt || !i.sku) continue;
    const m = SKU_SHAPE.exec(String(i.sku).trim());
    if (!m) continue;
    const fresh = i.status === 'available' || i.status === 'listed';
    const prev = skuBySuffix.get(m[1]);
    if (!prev || (fresh && !prev.fresh)) {
      skuBySuffix.set(m[1], { sku: String(i.sku).trim().toUpperCase(), fresh });
    }
  }

  // Per-upload nonce — same rationale as parsePalmstreetOrders (each
  // upload is its own batch of work), plus the `tt` prefix that marks
  // every box from this flow as TikTok forever.
  const uploadId = `tt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  const boxes = new Map();
  // TikTok repeats the ORDER-level shipping fee on every SKU row of that
  // order — attribute it once (to the first row seen) so a box's items
  // sum to what the buyer actually paid.
  const feeCounted = new Set();

  rows.forEach((row, idx) => {
    const orderId = String(pick(row, 'Order ID')).trim();
    // The export's row 2 is a per-column description ("Platform unique
    // order ID." …) — real order ids are long digit runs.
    if (!/^\d{6,}$/.test(orderId)) return;

    const status = String(pick(row, 'Order Status')).trim().toLowerCase();
    // Same canceled-detection posture as the Palmstreet parser: skip
    // truly-canceled rows, keep cancellation-requested ones (they still
    // ship unless the cancel goes through).
    if (/cancel(l?ed|lation)/.test(status) && !/request|pending|review/.test(status)) return;

    const recipient = String(pick(row, 'Recipient')).trim();
    const street1 = String(pick(row, 'Address Line 1')).trim();
    if (!recipient && !street1) return;
    const street2 = String(pick(row, 'Address Line 2')).trim();
    const city = String(pick(row, 'City')).trim();
    const state = String(pick(row, 'State')).trim();
    const zip = String(pick(row, 'Zipcode')).trim();
    // TikTok spells the country out ("United States") — store the ISO code
    // carriers want; the server normalizes again at buy time regardless.
    const countryRaw = String(pick(row, 'Country')).trim();
    const country = /^(united states|usa|u\.s\.a?\.?|america)$/i.test(countryRaw) ? 'US' : countryRaw;
    const username = String(pick(row, 'Buyer Username', 'Buyer Nickname')).trim();

    // "08/25/2026 9:29:53 AM" — US-style, Date() parses it directly.
    const dateRaw = String(pick(row, 'Paid Time', 'Created Time')).trim();
    const d = dateRaw ? new Date(dateRaw) : null;
    const orderDateIso = d && !isNaN(d.getTime()) ? d.toISOString() : null;

    const quantity = parseInt(pick(row, 'Quantity'), 10) || 1;
    const price = parseFloat(pick(row, 'SKU Subtotal After Discount', 'SKU Subtotal Before Discount')) || 0;
    const feeRaw = parseFloat(pick(row, 'Shipping Fee After Discount')) || 0;
    let orderShippingFee = 0;
    if (feeRaw > 0 && !feeCounted.has(orderId)) {
      feeCounted.add(orderId);
      orderShippingFee = feeRaw;
    }

    const productName = String(pick(row, 'Product Name')).trim();
    const variation = String(pick(row, 'Variation')).trim();
    const sellerNote = String(pick(row, 'Seller Note')).trim();
    const buyerMsg = String(pick(row, 'Buyer Message')).trim();
    const rowNotes = [];
    if (sellerNote) rowNotes.push(`Seller: ${sellerNote}`);
    if (buyerMsg) rowNotes.push(`Buyer: ${buyerMsg}`);

    let sku = '';
    let lineupIndex = null;
    if (/^\d{1,6}$/.test(productName)) {
      // Label number — also the packer's handle on the physical plant.
      lineupIndex = productName;
      sku = skuBySuffix.get(productName)?.sku || '';
    } else {
      const m = /\b((?:[A-Za-z]{2,8}-)?[A-Za-z]{2,8}-\d+)\b/.exec(productName);
      if (m) sku = m[1].toUpperCase();
    }

    const title = variation && variation !== '1' && !/^default/i.test(variation)
      ? `${productName} · ${variation}`
      : productName;

    const groupKey = [
      recipient.toLowerCase(),
      street1.toLowerCase(),
      city.toLowerCase(),
      state.toLowerCase(),
      zip.toLowerCase(),
    ].join('|');
    const boxId = `${uploadId}|${groupKey}`;

    if (!boxes.has(boxId)) {
      boxes.set(boxId, {
        id: boxId,
        recipientName: recipient,
        username,
        street1,
        street2,
        city,
        state,
        zip,
        country,
        shipmentMethod: String(pick(row, 'Delivery Option', 'Delivery Option Type')).trim(),
        // TikTok is seller-shipped; the operator's default label channel.
        carrier: 'usps',
        items: [],
        orderNumbers: [],
        shippingFee: 0,
      });
    }
    const box = boxes.get(boxId);
    if (!box.orderNumbers.includes(orderId)) box.orderNumbers.push(orderId);
    if (orderShippingFee > 0) box.shippingFee += orderShippingFee;

    box.items.push({
      rowKey: `r${idx}`,
      title,
      sku,
      lineupIndex,
      quantity,
      price,
      orderShippingFee,
      orderNumber: orderId,
      orderDate: orderDateIso,
      notes: rowNotes.length ? rowNotes.join(' · ') : null,
    });
  });

  return [...boxes.values()].filter(b => b.items.length > 0);
}
