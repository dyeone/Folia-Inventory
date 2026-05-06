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
