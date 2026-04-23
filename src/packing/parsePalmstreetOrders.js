// Parse rows from a Palmstreet orders export and group them into boxes.
// One box = one recipient at one address (a single buyer with multiple
// orders ships in one box).

const SERVICE_TITLE_PATTERNS = [
  /^📦/,
  /vacation hold/i,
  /^free\s+(usps|ups|shipping)/i,
  /shipping/i,
];

function isServiceLine(title, price) {
  if (!title) return true;
  const t = title.trim();
  if (SERVICE_TITLE_PATTERNS.some(re => re.test(t))) return true;
  // Defensive: zero-priced rows with no real plant name.
  if ((!price || price === 0) && t.length < 3) return true;
  return false;
}

function pick(row, ...keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
  }
  return '';
}

export function parsePalmstreetOrders(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  // Group key: recipient name + street + city + state + zip (case-insensitive).
  // Rationale: same person may place multiple Palmstreet orders that all
  // ship to the same physical address — those become one packing box.
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

    const title = String(pick(row, 'Item Title', 'Title')).trim();
    const sku = String(pick(row, 'SKU')).trim();
    const quantity = parseInt(pick(row, 'Quantity', 'Qty'), 10) || 1;
    const price = parseFloat(pick(row, 'Item Price', 'Price')) || 0;
    const shippingFee = parseFloat(pick(row, 'Shipping Fee')) || 0;

    if (!recipient && !street1) return; // skip empty rows

    const key = [
      recipient.toLowerCase(),
      street1.toLowerCase(),
      city.toLowerCase(),
      state.toLowerCase(),
      zip.toLowerCase(),
    ].join('|');

    if (!boxes.has(key)) {
      boxes.set(key, {
        id: key,
        recipientName: recipient,
        username,
        street1,
        street2,
        city,
        state,
        zip,
        country,
        shipmentMethod: shipMethod,
        items: [],
        orderNumbers: [],
        notes: [],
        shippingFee: 0,
      });
    }
    const box = boxes.get(key);

    if (orderNum && !box.orderNumbers.includes(orderNum)) {
      box.orderNumbers.push(orderNum);
    }
    if (shippingFee > 0) box.shippingFee += shippingFee;
    if (sellerNote && !box.notes.includes(sellerNote)) box.notes.push(sellerNote);
    if (buyerNote && !box.notes.includes(buyerNote)) box.notes.push(buyerNote);

    if (isServiceLine(title, price)) return;

    box.items.push({
      rowKey: `r${idx}`,
      title,
      sku,
      quantity,
      price,
      orderNumber: orderNum,
      orderDate: orderDateIso,
    });
  });

  // Drop boxes that ended up with no shippable items (e.g. only had a
  // service line like "Vacation Hold").
  return [...boxes.values()].filter(b => b.items.length > 0);
}
