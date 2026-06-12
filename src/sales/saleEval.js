// Read-only financial evaluation of one live's sales from an uploaded
// Palmstreet orders CSV. NOTHING here mutates inventory: it parses the order
// file, joins each line to an inventory item by SKU to look up cost, and rolls
// the result into headline financials + breakdowns. The computed result is
// cached in localStorage (per sale id) so the "Financial Report" button can
// reopen it without re-uploading — same pattern as live state (see liveState.js).
//
// Reporting rules:
//   - UNMATCHED lines are excluded from every report total/table. They stay
//     available for manual matching (applyManualMatch) so the operator can pull
//     them in; until matched they count for nothing.
//   - Seller commission is paid only on NEW plants. A plant is "old" when its
//     (matched item's) SKU number is below OLD_PLANT_SKU_MAX — those are set
//     aside and pay no commission. Old plants still count in revenue/profit.
//
// Manual matching (applyManualMatch) lets the operator link an unmatched line
// to an inventory item. That's still read-only: it overrides the line's cost
// and brings it into the report, never touching the inventory row.

import { normalizeSku } from '../labels/boxCode.js';
import { api } from '../api.js';

export const STORAGE_KEY = (saleId) => `sale-eval-${saleId}`;

// Bump when the result shape OR a stored calculation changes. loadEval/fetchEval
// discard caches from an older version, so the operator re-uploads and the report
// recomputes. (v5: old/new plant cutoff is SKU 2380; was 2466, was 3000.)
export const RESULT_VERSION = 5;

// Operating-cost assumptions for the net-profit waterfall.
export const LABOR_PER_BOX = 2;
export const SHIPPING_COST_PER_BOX = 10;
export const SELLER_COMMISSION_RATE = 0.15;
// A matched plant whose SKU number is below this is an "old plant" — set aside,
// no seller commission. Everything at/above it is a "new plant" and pays.
// SKU < 2380 → old; SKU >= 2380 → new (so 2380 itself is the first new plant).
export const OLD_PLANT_SKU_MAX = 2380;

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

// Persist to the database (durable, cross-device) AND the localStorage cache.
// The DB write is best-effort: if it fails (offline, or the table isn't
// migrated yet) the cache still holds the report this session. Returns the
// localStorage save result so the caller can warn on a quota overflow.
export async function storeEval(saleId, result) {
  const cached = saveEval(saleId, result);
  let persisted = false;
  try { const r = await api.saveSaleEval(saleId, result); persisted = !!(r && r.ok); }
  catch { persisted = false; }
  return { cached, persisted };
}

// Load from the database first (so a fresh device/browser sees a saved report),
// falling back to the localStorage cache. A DB hit refreshes the cache. A
// version mismatch (older shape) is ignored — the operator re-evaluates.
export async function fetchEval(saleId) {
  try {
    const remote = await api.getSaleEval(saleId);
    if (remote && remote.version === RESULT_VERSION) {
      saveEval(saleId, remote);
      return remote;
    }
  } catch { /* fall back to cache */ }
  return loadEval(saleId);
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// Local calendar day (YYYY-MM-DD) of an ISO/date value.
export function localDay(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// The calendar day after a YYYY-MM-DD string (local). A live that starts at
// night runs past midnight, so orders are expected across the live day and the
// morning after — both are "on-window".
function nextDay(day) {
  const d = new Date(`${day}T00:00:00`);
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// Trailing number in a SKU (ALO-142 -> 142, "142" -> 142). null if none.
function parseSkuNumber(sku) {
  const m = String(sku || '').match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

// Cost/profit fields for a line given the matched item (or null). $0/negative
// cost counts as "no known cost", matching financialHelpers.rollup.
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
        itemSku: item?.sku || null,
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

// Roll a set of line records into the full report object. Pure and re-runnable,
// so a manual match just patches one line and re-aggregates. Reports cover
// MATCHED lines only; commission is charged on NEW (non-old) plants only.
export function aggregate(lines, meta = {}) {
  const saleDay = meta.saleDay || null;
  const allowedDays = saleDay ? new Set([saleDay, nextDay(saleDay)]) : null;

  const annotated = lines.map(l => {
    const effSku = l.matched ? (l.itemSku || l.sku) : l.sku;
    const skuNum = parseSkuNumber(effSku);
    const oldPlant = skuNum != null && skuNum < OLD_PLANT_SKU_MAX;
    const offDay = !!(allowedDays && l.orderDate && !allowedDays.has(localDay(l.orderDate)));
    const commission = l.matched && !oldPlant ? l.revenue * SELLER_COMMISSION_RATE : 0;
    return { ...l, skuNum, oldPlant, offDay, commission };
  });

  // Reports exclude unmatched lines entirely.
  const reported = annotated.filter(l => l.matched);

  let grossSales = 0, shippingCollected = 0, matchedRevenue = 0, cogs = 0;
  let costlessMatched = 0, commissionBase = 0, oldPlantRevenue = 0, oldPlantCount = 0, sellerCommission = 0;
  const orderSet = new Set();
  const buyerSet = new Set();
  const boxSet = new Set();
  let undatedCount = 0;
  for (const l of reported) {
    grossSales += l.revenue;
    shippingCollected += l.shippingFee;
    if (l.orderNumber) orderSet.add(l.orderNumber.toLowerCase());
    buyerSet.add((l.username || l.buyer || '').toLowerCase().trim());
    if (l.boxId && l.sku) boxSet.add(l.boxId);
    if (l.hasCost) { matchedRevenue += l.revenue; cogs += l.cost; } else costlessMatched += 1;
    if (l.oldPlant) { oldPlantRevenue += l.revenue; oldPlantCount += 1; }
    else { commissionBase += l.revenue; sellerCommission += l.commission; }
    if (!l.orderDate) undatedCount += 1;
  }
  const lots = reported.length;
  const unmatchedCount = annotated.length - lots;
  const commissionableCount = lots - oldPlantCount;
  const grossProfit = matchedRevenue - cogs;
  const margin = matchedRevenue > 0 ? (grossProfit / matchedRevenue) * 100 : null;
  const excludedRevenue = grossSales - matchedRevenue; // matched-but-costless revenue
  const avgSale = lots > 0 ? grossSales / lots : null;

  const boxes = boxSet.size;
  const labor = boxes * LABOR_PER_BOX;
  const shippingCost = boxes * SHIPPING_COST_PER_BOX;
  const totalRevenue = grossSales + shippingCollected;
  const netProfit = totalRevenue - cogs - labor - sellerCommission - shippingCost;
  const netMargin = grossSales > 0 ? (netProfit / grossSales) * 100 : null;

  const totals = {
    grossSales, shippingCollected, matchedRevenue, cogs, grossProfit, margin,
    excludedRevenue, lots, matchedCount: lots, unmatchedCount, costlessMatched,
    orders: orderSet.size, buyers: buyerSet.size, avgSale,
    boxes, labor, shippingCost, sellerCommission, totalRevenue, netProfit, netMargin,
    commissionBase, oldPlantRevenue, oldPlantCount, commissionableCount,
  };

  // By-variety (matched only).
  const vmap = new Map();
  for (const l of reported) {
    const key = l.variety || '(no variety)';
    let r = vmap.get(key);
    if (!r) { r = { variety: key, revenue: 0, cost: 0, profit: 0, units: 0, hasCost: false }; vmap.set(key, r); }
    r.revenue += l.revenue;
    r.units += 1;
    if (l.hasCost) { r.cost += l.cost; r.profit += l.profit; r.hasCost = true; }
  }
  const byVariety = [...vmap.values()].sort((a, b) => b.revenue - a.revenue);

  const topByRevenue = [...reported].sort((a, b) => b.revenue - a.revenue).slice(0, 8);
  const topByProfit = reported.filter(l => l.profit != null).sort((a, b) => b.profit - a.profit).slice(0, 8);

  // Flags: SKU sold across >1 distinct order (possible double-sale, matched
  // only); unmatched lines (excluded from the report); off-window dates.
  const skuOrders = new Map();
  for (const l of reported) {
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
  const offDayLines = reported.filter(l => l.offDay);

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
      itemSku: item?.sku || null,
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
