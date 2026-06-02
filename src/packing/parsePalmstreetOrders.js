// Parse rows from a Palmstreet orders export and group them into boxes.
// One box = one recipient at one address (a single buyer with multiple
// orders ships in one box).
//
// Every row in the file makes it through to the parsed output — including
// coupons, free-shipping lines, and the UPS-upgrade row — so the operator
// sees the upload exactly as it came from Palmstreet.

// Buyers who paid for the UPS upgrade have an extra line item with this
// title in their order. We detect it on any line in the box → flip the
// whole box's carrier from the default 'usps' to 'ups'. The row itself
// still passes through into box.items.
const UPS_UPGRADE_PATTERN = /ups\s*2[\s-]*day\s*upgrade/i;

function isUpsUpgradeLine(title) {
  return !!title && UPS_UPGRADE_PATTERN.test(title.trim());
}

// Pull every SKU pattern out of an order title. The matcher resolves
// each one to an inventory item so a single Palmstreet line that bundles
// multiple plants becomes one match per SKU.
//
// Recognized SKU shapes:
//   ALO-142          bare prefix-number anywhere in the title
//   Alo-142          lowercase prefix (operators are sloppy)
//   (ALO-142)        parenthesized — the bundled-title convention
//   (1589)           bare number in parens; matcher resolves by suffix
//                    against the (globally unique) inventory SKU number
//
// Bare numbers are only honored when parenthesized — bare digits in
// running text are too ambiguous (could be qty, year, count, etc.).
const SKU_PATTERN = /\(\s*([A-Za-z]{2,4}-\d+|\d+)\s*\)|\b([A-Za-z]{2,4}-\d+)\b/g;

function normalizeSku(raw) {
  const s = String(raw || '').trim();
  return /^[A-Za-z]{2,4}-\d+$/.test(s) ? s.toUpperCase() : s;
}

function extractAllSkus(title) {
  const t = String(title || '');
  const seen = new Set();
  const out = [];
  let m;
  SKU_PATTERN.lastIndex = 0;
  while ((m = SKU_PATTERN.exec(t)) !== null) {
    const raw = m[1] || m[2];
    if (!raw) continue;
    const norm = normalizeSku(raw);
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

function pick(row, ...keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
  }
  return '';
}

export function parsePalmstreetOrders(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  // Per-upload nonce prefixed onto every box id. Without it, re-uploading
  // the same buyer in a fresh sales report would produce the same
  // shipmentBoxId as a historical upload — Shipping would silently fold
  // the new order into the previously-shipped box for that buyer. The
  // operator's mental model is: each spreadsheet upload is its own batch
  // of work, never mixed with prior history. The nonce enforces that.
  // Within a single upload, the recipient+address group key still
  // collapses multiple orders for the same buyer into one box.
  const uploadId = `up${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  // Group key: recipient name + street + city + state + zip (case-insensitive).
  // Rationale: same person may place multiple Palmstreet orders that all
  // ship to the same physical address — those become one packing box
  // within this upload.
  const boxes = new Map();

  rows.forEach((row, idx) => {
    const recipient = String(pick(row, 'Recipient Name')).trim();
    const street1 = String(pick(row, 'Street Line 1')).trim();
    const street2 = String(pick(row, 'Street Line 2')).trim();
    const city = String(pick(row, 'City')).trim();
    const state = String(pick(row, 'State')).trim();
    const zip = String(pick(row, 'Zip/Postal Code', 'Zip', 'Postal Code')).trim();
    const country = String(pick(row, 'Country')).trim();
    const username = String(pick(row, 'Palmstreet UserName', 'Username')).trim();
    const orderNum = String(pick(row, 'Order number', 'Order Number', 'Order')).trim();
    const orderDateRaw = String(pick(row, 'Order Date(PDT)', 'Order Date', 'OrderDate')).trim();
    // Palmstreet exports `2026-04-06 21:30:12`. Treat as ISO-ish; new Date()
    // handles the space delimiter.
    const orderDateIso = orderDateRaw ? (() => {
      const d = new Date(orderDateRaw.replace(' ', 'T'));
      return isNaN(d.getTime()) ? null : d.toISOString();
    })() : null;
    const shipMethod = String(pick(row, 'Shipment Method', 'Shipping Method')).trim();
    const sellerNote = String(pick(row, 'Seller Order Note')).trim();
    const buyerNote = String(pick(row, 'Buyer Order Note')).trim();
    const orderStatus = String(pick(row, 'Order Status')).trim().toLowerCase();

    // Skip canceled orders entirely — the buyer never paid, the line shouldn't
    // mark inventory sold or create a packing box. Matches 'canceled' (American)
    // and 'cancelled' (British) case-insensitively.
    if (orderStatus === 'canceled' || orderStatus === 'cancelled') return;

    const title = String(pick(row, 'Item Title', 'Title')).trim();
    const sku = String(pick(row, 'SKU')).trim();
    const quantity = parseInt(pick(row, 'Quantity', 'Qty'), 10) || 1;
    const price = parseFloat(pick(row, 'Item Price', 'Price')) || 0;
    const shippingFee = parseFloat(pick(row, 'Shipping Fee')) || 0;

    if (!recipient && !street1) return; // skip empty rows

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
        shipmentMethod: shipMethod,
        // Default carrier — flipped to 'ups' below if any line in this box
        // contains the "UPS 2-Day Upgrade" item.
        carrier: 'usps',
        items: [],
        orderNumbers: [],
        shippingFee: 0,
      });
    }
    const box = boxes.get(boxId);

    if (orderNum && !box.orderNumbers.includes(orderNum)) {
      box.orderNumbers.push(orderNum);
    }
    if (shippingFee > 0) box.shippingFee += shippingFee;

    // Per-row notes: attached to each item emitted from this row so
    // the packer can see the seller/buyer instructions next to the
    // specific item they apply to. Persisted on inventory_items.notes
    // as a single ' · '-joined string; the "Seller: " / "Buyer: "
    // prefix is the only signal of origin downstream.
    const rowNotes = [];
    if (sellerNote) rowNotes.push(`Seller: ${sellerNote}`);
    if (buyerNote)  rowNotes.push(`Buyer: ${buyerNote}`);
    const itemNotes = rowNotes.length ? rowNotes.join(' · ') : null;

    // Detect the UPS 2-Day Upgrade row to flip the whole box's carrier
    // — this is a side effect of seeing the row, not a reason to drop it.
    // The row itself stays in box.items so the operator sees every line
    // exactly as it came from Palmstreet (coupons, free-shipping rows,
    // upgrade lines, all of it).
    if (isUpsUpgradeLine(title)) box.carrier = 'ups';

    // Find every SKU mentioned in the title. Two SKUs ⇒ this is a
    // bundled row; emit one virtual item per SKU with even price split.
    // One SKU ⇒ override Palmstreet's (often empty) sku column with the
    // one parsed from the title. Zero ⇒ fall back to whatever Palmstreet
    // gave us; the matcher will return null and the row stays unmatched
    // in the preview (manual linking has been removed by design).
    const skusInTitle = extractAllSkus(title);

    if (skusInTitle.length > 1) {
      const each = price / skusInTitle.length;
      // Split the row's shipping fee across the bundled SKUs the same way
      // price is split, so summing a box's items reproduces the order total.
      const feeEach = shippingFee / skusInTitle.length;
      skusInTitle.forEach((sk, i) => {
        box.items.push({
          rowKey: `r${idx}_${i}`,
          title,                 // keep full title for context in the UI
          sku: sk,
          quantity,
          price: Number.isFinite(each) ? each : 0,
          orderShippingFee: Number.isFinite(feeEach) ? feeEach : 0,
          orderNumber: orderNum,
          orderDate: orderDateIso,
          notes: itemNotes,
        });
      });
      return;
    }

    const resolvedSku = skusInTitle[0] || sku;
    box.items.push({
      rowKey: `r${idx}`,
      title,
      sku: resolvedSku,
      quantity,
      price,
      orderShippingFee: shippingFee,
      orderNumber: orderNum,
      orderDate: orderDateIso,
      notes: itemNotes,
    });
  });

  // Return every box that had at least one row — including boxes whose
  // only row is a coupon / free-shipping line. The operator asked to see
  // every uploaded line, no skips.
  return [...boxes.values()].filter(b => b.items.length > 0);
}
