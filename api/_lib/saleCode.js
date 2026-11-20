// A plant's short For Sale code — "A12": a series letter, then a number
// counting up from 1 (2026-11-20, operator: "use simpler way to mark them
// like from A1-A999, after clear this pool, then start from B1 - B999").
// A series runs A1, A2 … A999. Once the pool has been emptied, the next
// plant to join starts the next letter at 1 (B1, B2 …); a series that
// reaches 999 rolls on to the next letter too. Letters skip I, O and Q
// (read as 1, 0 and 0) and wrap Z → A, when that letter's codes from its
// earlier round are released first (api/_lib/pool.js startSeries).
//
// Printed big on the plant's tag and put in every listing title, so whoever
// packs an order can find the pot on the bench at a glance. The shape can't
// be mistaken for a SKU (B-ANT-9759), a box tag (B-7KQ2MX) or a lineup
// number (042). Unique per brand (unique index, migration 0052). Plants
// coded before 2026-11-20 carry the old random shape ("KM42"), which still
// reads everywhere.
//
// Mirrors src/forsale/saleCode.js — keep the shared part identical.

export const CODE_LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ';
export const SERIES_MAX = 999;
const SERIES_RE = /^([A-HJ-NPR-Z])([1-9]\d{0,2})$/;
const OLD_CODE_RE = /^[A-HJ-NPR-Z]{2}\d{2,3}$/;

export const isSaleCode = (s) => SERIES_RE.test(s) || OLD_CODE_RE.test(s);

// "a-12", " A 012 " → "A12"; "km-42" → "KM42"; anything else → ''.
export function normalizeSaleCode(raw) {
  let s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = /^([A-Z])0*(\d{1,3})$/.exec(s);
  if (m) s = `${m[1]}${Number(m[2])}`;
  return isSaleCode(s) ? s : '';
}

// "A12" → { series: 'A', n: 12 }; an old-shape code (or none) → null.
export function parseSeriesCode(code) {
  const m = SERIES_RE.exec(String(code || ''));
  return m ? { series: m[1], n: Number(m[2]) } : null;
}

export const seriesCode = (series, n) => `${series}${n}`;

// The letter after `series` (Z → A; anything unknown → A).
export function nextSeries(series) {
  const i = CODE_LETTERS.indexOf(String(series || ''));
  return CODE_LETTERS[(i + 1) % CODE_LETTERS.length];
}

// The highest number used in `series` among `codes` (any iterable), 0 if none.
export function seriesMax(codes, series) {
  let max = 0;
  for (const c of codes) {
    const p = parseSeriesCode(c);
    if (p && p.series === series && p.n > max) max = p.n;
  }
  return max;
}
