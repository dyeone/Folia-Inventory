// Parse a Palmstreet "Payout Cashflow List" xlsx export and surface the
// refund / partial-refund rows (the only activities that need to be synced
// back into our inventory).
//
// Sheet columns: Date (Excel serial), Activity, Amount (negative for
// refunds), Order No, Order Source, Description.

// Convert an Excel serial date number to a JS Date. 25569 = days between
// 1899-12-30 (Excel epoch) and 1970-01-01 (Unix epoch).
function excelSerialToDate(serial) {
  if (typeof serial !== 'number' || !isFinite(serial)) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  return new Date(ms);
}

function pick(row, ...keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
  }
  return '';
}

// Returns { refunds, totalRefundAmount, otherCounts }.
//   refunds: [{ orderId, amount, refundedAt, kind, description, raw }]
//   amount is positive (the absolute refund amount), kind is 'full' | 'partial'.
export function parseCashflow(rows) {
  if (!Array.isArray(rows)) return { refunds: [], totalRefundAmount: 0, otherCounts: {} };

  const refunds = [];
  const otherCounts = {};
  let totalRefundAmount = 0;

  for (const row of rows) {
    const activity = String(pick(row, 'Activity')).trim().toLowerCase();
    if (!activity) continue;

    if (activity === 'refunded' || activity === 'partially_refunded') {
      const orderId = String(pick(row, 'Order No', 'Order Number', 'OrderNo')).trim();
      if (!orderId) continue;
      const rawAmt = parseFloat(pick(row, 'Amount'));
      const amount = isNaN(rawAmt) ? 0 : Math.abs(rawAmt);
      const dateRaw = pick(row, 'Date');
      let refundedAt = null;
      if (typeof dateRaw === 'number') {
        const d = excelSerialToDate(dateRaw);
        refundedAt = d ? d.toISOString() : null;
      } else if (typeof dateRaw === 'string' && dateRaw) {
        const d = new Date(dateRaw);
        refundedAt = isNaN(d.getTime()) ? null : d.toISOString();
      }
      refunds.push({
        orderId,
        amount,
        refundedAt,
        kind: activity === 'refunded' ? 'full' : 'partial',
        description: String(pick(row, 'Description') || ''),
      });
      totalRefundAmount += amount;
    } else {
      otherCounts[activity] = (otherCounts[activity] || 0) + 1;
    }
  }

  return { refunds, totalRefundAmount, otherCounts };
}

// Match parsed refunds against inventory items by orderId and produce the
// per-item updates to apply. One Palmstreet order can contain multiple
// items; the refund amount is distributed across them proportionally to
// each item's salePrice (so a $30 partial refund on a 2-item order with
// prices $40 + $20 yields $20 + $10).
export function buildRefundUpdates(refunds, inventoryItems) {
  // Index items by orderId. An order can map to multiple items.
  const byOrder = new Map();
  for (const item of inventoryItems) {
    if (!item.orderId) continue;
    if (!byOrder.has(item.orderId)) byOrder.set(item.orderId, []);
    byOrder.get(item.orderId).push(item);
  }

  const matched = [];
  const unmatched = [];
  // Aggregate per item: there can be multiple refund rows per order
  // (e.g. an initial partial then a final full refund).
  const itemAgg = new Map(); // itemId → { item, refundedAmount, refundedAt, kind }

  for (const refund of refunds) {
    const items = byOrder.get(refund.orderId);
    if (!items || items.length === 0) {
      unmatched.push(refund);
      continue;
    }
    matched.push({ refund, itemCount: items.length });

    const totalSale = items.reduce((s, i) => s + (parseFloat(i.salePrice) || 0), 0);
    for (const item of items) {
      const sp = parseFloat(item.salePrice) || 0;
      // Distribute proportionally; if no prices are set, split evenly.
      const share = totalSale > 0 ? (sp / totalSale) * refund.amount : refund.amount / items.length;
      const prev = itemAgg.get(item.id) || {
        item,
        refundedAmount: parseFloat(item.refundedAmount) || 0,
        addedAmount: 0,
        refundedAt: item.refundedAt || null,
        kind: 'partial',
      };
      prev.addedAmount += share;
      prev.refundedAmount += share;
      // Latest refund date wins.
      if (!prev.refundedAt || (refund.refundedAt && refund.refundedAt > prev.refundedAt)) {
        prev.refundedAt = refund.refundedAt;
      }
      // Any 'full' refund on the order escalates the item to full refund.
      if (refund.kind === 'full') prev.kind = 'full';
      itemAgg.set(item.id, prev);
    }
  }

  const updates = [];
  for (const { item, refundedAmount, refundedAt, kind } of itemAgg.values()) {
    updates.push({
      id: item.id,
      refundedAmount: Number(refundedAmount.toFixed(2)),
      refundedAt,
      ...(kind === 'full' ? { status: 'refunded' } : {}),
    });
  }

  return { updates, matched, unmatched, perItem: [...itemAgg.values()] };
}
