// Read-only financial evaluation of one live's sales from an uploaded
// Palmstreet orders CSV. NOTHING here mutates inventory: it parses the order
// file, joins each line to an inventory item by SKU to look up cost, and rolls
// the result into headline financials + breakdowns. The computed result is
// cached in localStorage (per sale id) so the "Financial Report" button can
// reopen it without re-uploading — same pattern as live state (see liveState.js).
//
// Manual matching (applyManualMatch) lets the operator link an unmatched line
// to an inventory item. That's still read-only: it overrides the line's cost
// in THIS report only, never touching the inventory row.

import { normalizeSku } from '../labels/boxCode.js';

export const STORAGE_KEY = (saleId) => `sale-eval-${saleId}`;

// Bump when the result shape changes. loadEval discards caches from an older
// version (they lack fields this UI now needs, e.g. boxId / net-profit totals),
// so the operator just re-uploads rather than rendering a half-broken report.
export const RESULT_VERSION = 2;

export function loadEval(saleId) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY(saleId));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.version !== RESULT_VERSION) return null;
    return obj;
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
  return loadEval(saleId) != null;
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// Operating-cost assumptions for the net-profit waterfall.
//   LABOR_PER_BOX           — flat labor we pay to pack/ship each box
//   SHIPPING_COST_PER_BOX   — flat shipping-label cost we pay per box
//   SELLER_COMMISSION_RATE  — the seller's cut of gross (product) sales
export const LABOR_PER_BOX = 2;
export const SHIPPING_COST_PER_BOX = 10;
export const SELLER_COMMISSION_RATE = 0.15;

// Local calendar day (YYYY-MM-DD) of an ISO/date value. Used to check each
// order's date against the live's day. Local time matches how the orders
// parser interprets Palmstreet's naive PDT timestamps.
export function localDay(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Cost/profit fields for a line given the matched item (or null). $0/negative
// cost counts as "no known cost", matching financialHelpers.rollup so the two
// views agree.
function costFor(item, revenue) {
  const rawCost = item ? num(item.grossCost ?? item.cost) : null;
  const hasCost = rawCost != null && rawCost > 0;
  return {
    cost: item && hasCost ? rawCost : null,
    profit: item && hasCost ? revenue - rawCost : null,
    hasCost: !!(item && hasCost),
  };
}

// Build the per-line records from parsed Palmstreet boxes + inventory items.
// Revenue comes from the CSV's Item Price (what the buyer paid); cost from the
// matched item's grossCost.
function buildLines(boxes, items) {
  const bySku = new Map(); // sku is globally unique on inventory_items
  for (const it of items) {
    if (it.deletedAt) continue;
    const k = normalizeSku(it.sku);
    if (k && !bySku.has(k)) bySku.set(k, it);
  }
  const lines = [];
  for (const box of boxes) {
    for (const li of box.items) {
      const k = normalizeSku(li.sku);
      const item = k ? bySku.get(k) : null;
      const revenue = num(li.price) || 0;
      const cf = costFor(item, revenue);
      lines.push({
        rowKey: `${box.id}:${li.rowKey}`,
        boxId: box.id,
        sku: k || String(li.sku || ''),
        csvTitle: li.title || '',
        title: item?.name || li.title || '',
        variety: item?.variety || null,
        buyer: box.recipientName || '',
        username: box.username || '',
        orderNumber: li.orderNumber || '',
        orderDate: li.orderDate || null,
        quantity: li.quantity || 1,
        revenue,
        shippingFee: num(li.orderShippingFee) || 0,
        cost: cf.cost,
        profit: cf.profit,
        matched: !!item,
        hasCost: cf.hasCost,
        matchedItemId: item?.id || null,
        manual: false,
      });
    }
  }
  return lines;
}

// Roll a set of line records into the full report object. Pure and
// re-runnable, so a manual match just patches one line and re-aggregates.
// meta carries through generatedAt/fileName/saleName/saleDay so re-aggregation
// preserves them.
export function aggregate(lines, meta = {}) {
  const saleDay = meta.saleDay || null;
  const annotated = lines.map(l => ({
    ...l,
    offDay: !!(saleDay && l.orderDate && localDay(l.orderDate) !== saleDay),
  }));

  let grossSales = 0, shippingCollected = 0, matchedRevenue = 0, cogs = 0;
  let matchedCount = 0, unmatchedCount = 0, costlessMatched = 0;
  const orderSet = new Set();
  const buyerSet = new Set();
  const boxSet = new Set();
  let undatedCount = 0;
  for (const l of annotated) {
    grossSales += l.revenue;
    shippingCollected += l.shippingFee;
    if (l.orderNumber) orderSet.add(l.orderNumber.toLowerCase());
    buyerSet.add((l.username || l.buyer || '').toLowerCase().trim());
    // Count a box for labor only if it carries a real (SKU'd) item — a
    // coupon / free-shipping-only "box" ships nothing, so it gets no labor.
    if (l.boxId && l.sku) boxSet.add(l.boxId);
    if (l.matched) matchedCount += 1; else unmatchedCount += 1;
    if (l.hasCost) { matchedRevenue += l.revenue; cogs += l.cost; }
    else if (l.matched) costlessMatched += 1;
    if (!l.orderDate) undatedCount += 1;
  }
  const grossProfit = matchedRevenue - cogs;
  const margin = matchedRevenue > 0 ? (grossProfit / matchedRevenue) * 100 : null;
  const excludedRevenue = grossSales - matchedRevenue;
  const lots = annotated.length;
  const avgSale = lots > 0 ? grossSales / lots : null;

  // Net-profit waterfall: shipping is income, COGS + per-box labor + the
  // seller's commission on gross sales are costs. (Shipping label cost lives in
  // the cashflow export, not these orders, so it isn't subtracted here.)
  const boxes = boxSet.size;
  const labor = boxes * LABOR_PER_BOX;
  const shippingCost = boxes * SHIPPING_COST_PER_BOX;
  const sellerCommission = grossSales * SELLER_COMMISSION_RATE;
  const totalRevenue = grossSales + shippingCollected;
  const netProfit = totalRevenue - cogs - labor - sellerCommission - shippingCost;
  const netMargin = grossSales > 0 ? (netProfit / grossSales) * 100 : null;

  const totals = {
    grossSales, shippingCollected, matchedRevenue, cogs, grossProfit, margin,
    excludedRevenue, lots, matchedCount, unmatchedCount, costlessMatched,
    orders: orderSet.size, buyers: buyerSet.size, avgSale,
    boxes, labor, shippingCost, sellerCommission, totalRevenue, netProfit, netMargin,
  };

  // By-variety: matched lines grouped by variety; unmatched bucketed.
  const vmap = new Map();
  for (const l of annotated) {
    const key = l.matched ? (l.variety || '(no variety)') : '(unmatched)';
    let r = vmap.get(key);
    if (!r) { r = { variety: key, revenue: 0, cost: 0, profit: 0, units: 0, hasCost: false }; vmap.set(key, r); }
    r.revenue += l.revenue;
    r.units += 1;
    if (l.hasCost) { r.cost += l.cost; r.profit += l.profit; r.hasCost = true; }
  }
  const byVariety = [...vmap.values()].sort((a, b) => b.revenue - a.revenue);

  const topByRevenue = [...annotated].sort((a, b) => b.revenue - a.revenue).slice(0, 8);
  const topByProfit = annotated.filter(l => l.profit != null).sort((a, b) => b.profit - a.profit).slice(0, 8);

  // Flags: SKU sold across >1 distinct order (possible double-sale); unmatched
  // lines; lines dated outside the live day.
  const skuOrders = new Map();
  for (const l of annotated) {
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
  const unmatchedLines = annotated.filter(l => !l.matched);
  const offDayLines = annotated.filter(l => l.offDay);

  return {
    version: RESULT_VERSION,
    generatedAt: meta.generatedAt || new Date().toISOString(),
    fileName: meta.fileName || null,
    saleName: meta.saleName || null,
    saleDay,
    totals,
    lines: annotated,
    byVariety,
    topByRevenue,
    topByProfit,
    flags: { duplicateSkus, unmatchedLines, offDayLines, undatedCount },
  };
}

export function evaluateSale(boxes, items, meta = {}) {
  return aggregate(buildLines(boxes, items), meta);
}

// Override one line's match with a chosen inventory item (or null to clear,
// reverting to unmatched). Re-aggregates so totals/flags reflect it. Read-only:
// the inventory item is never modified.
export function applyManualMatch(result, rowKey, item) {
  const lines = result.lines.map(l => {
    if (l.rowKey !== rowKey) return l;
    const cf = costFor(item, l.revenue);
    return {
      ...l,
      title: item ? (item.name || l.csvTitle) : l.csvTitle,
      variety: item ? (item.variety || null) : null,
      cost: cf.cost,
      profit: cf.profit,
      matched: !!item,
      hasCost: cf.hasCost,
      matchedItemId: item?.id || null,
      manual: !!item,
    };
  });
  return aggregate(lines, {
    generatedAt: result.generatedAt,
    fileName: result.fileName,
    saleName: result.saleName,
    saleDay: result.saleDay,
  });
}
