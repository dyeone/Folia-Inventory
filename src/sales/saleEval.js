// Read-only financial evaluation of one live's sales from an uploaded
// Palmstreet orders CSV. NOTHING here mutates inventory: it parses the order
// file, joins each line to an inventory item by SKU to look up cost, and rolls
// the result into headline financials + breakdowns. The computed result is
// cached in localStorage (per sale id) so the "Financial Report" button can
// reopen it without re-uploading — same pattern as live state (see liveState.js).

import { normalizeSku } from '../labels/boxCode.js';

export const STORAGE_KEY = (saleId) => `sale-eval-${saleId}`;

export function loadEval(saleId) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY(saleId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveEval(saleId, result) {
  try {
    localStorage.setItem(STORAGE_KEY(saleId), JSON.stringify(result));
    return true;
  } catch {
    return false;
  }
}

export function hasEval(saleId) {
  try {
    return localStorage.getItem(STORAGE_KEY(saleId)) != null;
  } catch {
    return false;
  }
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// Build the evaluation from parsed Palmstreet boxes + the inventory items.
// `boxes` is the output of parsePalmstreetOrders(); `items` is the live
// inventory array. Returns a plain, JSON-serializable result object.
//
// Revenue comes from the CSV's Item Price (what the buyer actually paid);
// cost comes from the matched item's grossCost. Profit and COGS are summed
// ONLY over lines with a known cost, so an unmatched SKU (or a matched item
// with no recorded cost) never silently inflates profit — that revenue is
// surfaced separately as "excluded from profit".
export function evaluateSale(boxes, items, meta = {}) {
  // SKU → item, for cost lookup. sku is globally unique on inventory_items.
  const bySku = new Map();
  for (const it of items) {
    if (it.deletedAt) continue;
    const k = normalizeSku(it.sku);
    if (k && !bySku.has(k)) bySku.set(k, it);
  }

  const lines = [];
  const orderSet = new Set();
  const buyerSet = new Set();

  for (const box of boxes) {
    // A "buyer" is one person, keyed by username (else recipient name). A
    // single buyer shipping to two addresses is two boxes but one buyer, so
    // count buyers here — not boxes — to keep the KPI honest.
    buyerSet.add((box.username || box.recipientName || box.id).toLowerCase().trim());
    for (const li of box.items) {
      const k = normalizeSku(li.sku);
      const item = k ? bySku.get(k) : null;
      const revenue = num(li.price) || 0;
      const rawCost = item ? num(item.grossCost ?? item.cost) : null;
      const hasCost = rawCost != null && rawCost > 0;
      const profit = item && hasCost ? revenue - rawCost : null;
      if (li.orderNumber) orderSet.add(li.orderNumber);
      lines.push({
        rowKey: `${box.id}:${li.rowKey}`,
        sku: k || String(li.sku || ''),
        title: item?.name || li.title || '',
        variety: item?.variety || null,
        buyer: box.recipientName || '',
        username: box.username || '',
        orderNumber: li.orderNumber || '',
        orderDate: li.orderDate || null,
        quantity: li.quantity || 1,
        revenue,
        shippingFee: num(li.orderShippingFee) || 0,
        cost: item && hasCost ? rawCost : null,
        profit,
        matched: !!item,
        hasCost: !!(item && hasCost),
      });
    }
  }

  // Totals. Gross sales = everything buyers paid (matched or not). COGS and
  // profit are like-for-like: only lines with a known cost.
  let grossSales = 0, shippingCollected = 0, matchedRevenue = 0, cogs = 0;
  let matchedCount = 0, unmatchedCount = 0, costlessMatched = 0;
  for (const l of lines) {
    grossSales += l.revenue;
    shippingCollected += l.shippingFee;
    if (l.matched) matchedCount += 1; else unmatchedCount += 1;
    if (l.hasCost) { matchedRevenue += l.revenue; cogs += l.cost; }
    else if (l.matched) costlessMatched += 1;
  }
  const grossProfit = matchedRevenue - cogs;
  const margin = matchedRevenue > 0 ? (grossProfit / matchedRevenue) * 100 : null;
  const excludedRevenue = grossSales - matchedRevenue; // unmatched + costless-matched
  const lots = lines.length;
  const avgSale = lots > 0 ? grossSales / lots : null;

  const totals = {
    grossSales, shippingCollected, matchedRevenue, cogs, grossProfit, margin,
    excludedRevenue, lots, matchedCount, unmatchedCount, costlessMatched,
    orders: orderSet.size, buyers: buyerSet.size, avgSale,
  };

  // By-variety: matched lines grouped by their item's variety; unmatched
  // lines bucketed under "(unmatched)".
  const vmap = new Map();
  for (const l of lines) {
    const key = l.matched ? (l.variety || '(no variety)') : '(unmatched)';
    let r = vmap.get(key);
    if (!r) { r = { variety: key, revenue: 0, cost: 0, profit: 0, units: 0, hasCost: false }; vmap.set(key, r); }
    r.revenue += l.revenue;
    r.units += 1;
    if (l.hasCost) { r.cost += l.cost; r.profit += l.profit; r.hasCost = true; }
  }
  const byVariety = [...vmap.values()].sort((a, b) => b.revenue - a.revenue);

  const topByRevenue = [...lines].sort((a, b) => b.revenue - a.revenue).slice(0, 8);
  const topByProfit = lines.filter(l => l.profit != null).sort((a, b) => b.profit - a.profit).slice(0, 8);

  // Flags: a SKU sold on more than one distinct ORDER in this upload is a
  // possible double-sale. Key on order identity (order number, else buyer);
  // skip lines with neither so a blank-order export can't manufacture a flag
  // off otherwise-unique row keys. Two units of one SKU in the SAME order
  // collapse to one key and aren't flagged — that's quantity, not a double-sale.
  const skuOrders = new Map();
  for (const l of lines) {
    if (!l.sku) continue;
    const orderKey = (l.orderNumber || l.buyer || '').toLowerCase().trim();
    if (!orderKey) continue;
    let s = skuOrders.get(l.sku);
    if (!s) { s = new Set(); skuOrders.set(l.sku, s); }
    s.add(orderKey);
  }
  const duplicateSkus = [...skuOrders.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([sku, set]) => ({ sku, count: set.size }))
    .sort((a, b) => b.count - a.count);
  const unmatchedLines = lines.filter(l => !l.matched);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    fileName: meta.fileName || null,
    saleName: meta.saleName || null,
    totals,
    lines,
    byVariety,
    topByRevenue,
    topByProfit,
    flags: { duplicateSkus, unmatchedLines },
  };
}
