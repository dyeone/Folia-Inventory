// Pure helpers shared by the Financial tab — extracted so the main view
// stays small and so these are easy to unit-test in isolation.

export const SOLD_STATUSES = new Set(['sold', 'shipped', 'delivered']);

export const RANGES = [
  { id: 'all',    label: 'All time',  days: null },
  { id: '30d',    label: '30 days',   days: 30 },
  { id: '90d',    label: '90 days',   days: 90 },
  { id: 'ytd',    label: 'This year', days: null, ytd: true },
  { id: '12m',    label: '12 months', days: 365 },
  { id: 'custom', label: 'Custom',    days: null, custom: true },
];

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
export function daysAgoIso(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export function fmt$(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 10000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}
export function fmt$2(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return `$${n.toFixed(2)}`;
}
export function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(0)}%`;
}
// One-decimal average (e.g. "3.7"); '—' when there's no data.
export function fmt1(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return n.toFixed(1);
}

export function inRange(item, range) {
  if (range.id === 'all') return true;
  const t = item.soldAt ? new Date(item.soldAt).getTime() : 0;
  if (!t) return false;
  if (range.custom) {
    const from = range.from ? new Date(`${range.from}T00:00:00`).getTime() : 0;
    const to = range.to ? new Date(`${range.to}T23:59:59.999`).getTime() : Date.now();
    return t >= from && t <= to;
  }
  if (range.ytd) {
    const yStart = new Date(new Date().getFullYear(), 0, 1).getTime();
    return t >= yStart;
  }
  const cutoff = Date.now() - range.days * 86400_000;
  return t >= cutoff;
}

// Effective revenue for an item = salePrice − refundedAmount (clamped ≥ 0).
export function effectiveRevenue(item) {
  const sp = parseFloat(item.salePrice) || 0;
  const ref = parseFloat(item.refundedAmount) || 0;
  return Math.max(0, sp - ref);
}

// Roll up sold items into headline financials. Refunded items are excluded
// from unitsSold; partial refunds reduce revenue via effectiveRevenue.
export function rollup(items) {
  let revenue = 0;
  let cost = 0;
  let unitsSold = 0;
  let unitsWithFinancials = 0;
  let refundsTotal = 0;
  for (const i of items) {
    if (i.status === 'refunded') {
      refundsTotal += parseFloat(i.refundedAmount) || 0;
      continue;
    }
    if (!SOLD_STATUSES.has(i.status)) continue;
    if (i.lotKind === 'giveaway') { unitsSold += 1; continue; }
    unitsSold += 1;
    const rev = effectiveRevenue(i);
    const c = parseFloat(i.grossCost ?? i.cost);
    if (rev > 0) revenue += rev;
    if (!isNaN(c) && c > 0) cost += c;
    if (rev > 0 && !isNaN(c) && c > 0) unitsWithFinancials += 1;
    refundsTotal += parseFloat(i.refundedAmount) || 0;
  }
  const profit = revenue - cost;
  const margin = revenue > 0 ? (profit / revenue) * 100 : null;
  const avgPrice = unitsWithFinancials > 0 ? revenue / unitsWithFinancials : null;
  return { revenue, cost, profit, margin, unitsSold, unitsWithFinancials, avgPrice, refundsTotal };
}

// Shipping P/L for a set of items, given the shipments keyed by box id.
//   cost      — what we paid the carrier for labels
//   collected — what buyers paid to ship (summed from item.orderShippingFee)
//   net       — collected − cost (negative = we lost money shipping)
//   boxes     — how many boxes the figures cover
// A box only counts when BOTH numbers are known: it has a real purchased
// label (non-test, non-voided) AND at least one item with a recorded
// shipping fee. That keeps net a like-for-like comparison and avoids
// overstating losses on legacy boxes that predate fee tracking (null fee)
// or that shipped via Palmstreet/USPS (label bought off-site, no cost here).
// A box with an explicit $0 fee (free shipping) still counts — that's a real
// loss when we paid for the label.
export function shippingRollup(items, shipmentsByBox) {
  const byBox = new Map(); // boxId -> { fee, hasFee }
  for (const i of items) {
    if (!i.shipmentBoxId) continue;
    let rec = byBox.get(i.shipmentBoxId);
    if (!rec) { rec = { fee: 0, hasFee: false }; byBox.set(i.shipmentBoxId, rec); }
    const f = i.orderShippingFee;
    if (f != null && f !== '' && Number.isFinite(parseFloat(f))) {
      rec.fee += parseFloat(f);
      rec.hasFee = true;
    }
  }
  let cost = 0;
  let collected = 0;
  let boxes = 0;
  for (const [boxId, rec] of byBox) {
    if (!rec.hasFee) continue;
    const ship = shipmentsByBox?.[boxId];
    const live = ship && !ship.voidedAt && !ship.isTestLabel ? ship : null;
    const lc = live ? parseFloat(live.labelCost) : NaN;
    if (!Number.isFinite(lc)) continue;
    cost += lc;
    collected += rec.fee;
    boxes += 1;
  }
  return { cost, collected, net: collected - cost, boxes };
}

// ── Box throughput / contents ────────────────────────────────────────────
// A "box" is one shipmentBoxId on the items. Most boxes ship off-app
// (Palmstreet/USPS) and have NO shipments row — there are far more distinct
// shipmentBoxIds than shipments rows — so we derive boxes from the ITEMS, not
// from the shipments table, and date each box by when its items shipped
// (max shippedAt, falling back to soldAt). A box is skipped only if it maps to
// a shipments row that was voided or was a test label.
// Returns one record per box: { tc, plant, ts } (ts = ship time in ms, 0 = unknown).
export function buildBoxes(items, shipmentsByBox) {
  const byBox = new Map();
  for (const i of items) {
    if (!i.shipmentBoxId) continue;
    const ship = shipmentsByBox?.[i.shipmentBoxId];
    if (ship && (ship.voidedAt || ship.isTestLabel)) continue;
    let b = byBox.get(i.shipmentBoxId);
    if (!b) { b = { tc: 0, plant: 0, ts: 0 }; byBox.set(i.shipmentBoxId, b); }
    if (i.type === 'tc') b.tc += 1; else b.plant += 1;
    const t = i.shippedAt ? new Date(i.shippedAt).getTime()
            : i.soldAt ? new Date(i.soldAt).getTime() : 0;
    if (t > b.ts) b.ts = t;  // the box ships when its last item ships
  }
  return [...byBox.values()];
}

// Average contents across boxes: tissue cultures (item.type 'tc') vs plants
// (everything else) vs all items, per box.
export function boxStats(boxes) {
  const n = boxes.length;
  let tc = 0, plant = 0;
  for (const b of boxes) { tc += b.tc; plant += b.plant; }
  return {
    boxes: n,
    totalTc: tc, totalPlant: plant, totalItems: tc + plant,
    avgTc: n ? tc / n : null,
    avgPlant: n ? plant / n : null,
    avgItems: n ? (tc + plant) / n : null,
  };
}

// How many boxes shipped in [from, to) by box ship time.
export function boxesBetween(boxes, from, to) {
  let n = 0;
  for (const b of boxes) if (b.ts >= from && b.ts < to) n += 1;
  return n;
}
