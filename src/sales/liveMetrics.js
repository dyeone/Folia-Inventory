// Metrics for the post-live report, from the show archived into a sale
// event (api/settings.js archiveLiveShow). Pure functions, no React — used
// by src/sales/LiveReport.jsx and unit-testable with plain node.

export const BUCKET_MS = 15 * 60_000; // pace buckets

// Everything the report shows, from the archived show.
export function computeLiveMetrics(report) {
  const sold = (report?.sold || [])
    .filter(s => s && s.at)
    .map(s => ({ ...s, t: new Date(s.at).getTime(), price: Number(s.price) || 0 }))
    .filter(s => Number.isFinite(s.t))
    .sort((a, b) => a.t - b.t);
  const t0 = report?.startedAt ? new Date(report.startedAt).getTime() : (sold[0]?.t ?? null);
  const tEnd = report?.lastSeenAt ? new Date(report.lastSeenAt).getTime() : (sold[sold.length - 1]?.t ?? t0);
  const t1 = t0 != null && tEnd != null ? Math.max(tEnd, t0 + 10 * 60_000) : tEnd;
  const durationMs = t0 != null && tEnd != null ? Math.max(0, tEnd - t0) : 0;
  const hours = durationMs / 3.6e6;
  const soldGross = sold.reduce((s, x) => s + x.price, 0);
  const gross = report?.totals?.gross != null && Number.isFinite(Number(report.totals.gross)) ? Number(report.totals.gross) : soldGross;
  const priced = sold.filter(x => x.price > 0);
  const avgPrice = priced.length ? soldGross / priced.length : null;
  const lotsPerHour = hours >= 0.1 ? sold.length / hours : null;
  const gaps = [];
  for (let i = 1; i < sold.length; i++) gaps.push(sold[i].t - sold[i - 1].t);
  const avgGapMs = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
  const maxGap = gaps.length ? gaps.reduce((best, g, i) => (g > best.ms ? { ms: g, at: sold[i].t } : best), { ms: 0, at: null }) : null;
  const firstSaleMs = sold.length && t0 != null ? sold[0].t - t0 : null;
  // Best 30 minutes: sliding window over sale times.
  let best = { count: 0, start: null };
  for (let i = 0; i < sold.length; i++) {
    let j = i;
    while (j < sold.length && sold[j].t - sold[i].t < 30 * 60_000) j++;
    if (j - i > best.count) best = { count: j - i, start: sold[i].t };
  }
  // Pace buckets (lots per 15 min) across the show.
  const buckets = [];
  if (t0 != null && t1 != null) {
    for (let b = t0; b < t1; b += BUCKET_MS) buckets.push({ t: b, count: 0, gross: 0 });
    for (const s of sold) {
      const i = Math.min(buckets.length - 1, Math.max(0, Math.floor((s.t - t0) / BUCKET_MS)));
      if (buckets[i]) { buckets[i].count += 1; buckets[i].gross += s.price; }
    }
  }
  // Cumulative gross at each sale (from sold prices, so it matches the list).
  let run = 0;
  const grossPts = [{ t: t0 ?? (sold[0]?.t ?? Date.now()), v: 0 }, ...sold.map(s => { run += s.price; return { t: s.t, v: run }; })];
  const series = (report?.series || []).map(p => ({ ...p, tt: new Date(p.t).getTime() })).filter(p => Number.isFinite(p.tt));
  const viewerPts = series.filter(p => p.viewers != null).map(p => ({ t: p.tt, v: Number(p.viewers) }));
  const peakViewers = report?.viewers?.peak != null ? Number(report.viewers.peak) : (viewerPts.length ? Math.max(...viewerPts.map(p => p.v)) : null);
  const avgViewers = viewerPts.length ? viewerPts.reduce((s, p) => s + p.v, 0) / viewerPts.length : null;
  const joins = (report?.joins || []).length;
  const bids = (report?.bidders || []).length;
  return {
    sold, t0, t1, tEnd, durationMs, gross, soldGross, avgPrice, lotsPerHour, avgGapMs,
    maxGapMs: maxGap?.ms ?? null, maxGapAt: maxGap?.at ?? null, firstSaleMs,
    best30: best.count ? best : null, buckets, grossPts, viewerPts, peakViewers, avgViewers, joins, bids,
    orders: report?.totals?.orders ?? null,
  };
}

