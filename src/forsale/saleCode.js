// A plant's short For Sale code — "A12": a series letter, then a number
// counting up from 1 (A1 … A999; once the pool has been emptied the next
// plant starts the next letter: B1 …). Letters skip I, O and Q and wrap
// Z → A. Minted by the server when the plant joins the pool
// (api/_lib/pool.js). Plants coded before 2026-11-20 carry the old random
// shape ("KM42"), which still reads. Mirrors api/_lib/saleCode.js — keep
// the shared part identical.

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

// The live plant a typed / scanned code names in `items` (the active
// brand's list), or null. Trashed rows never match.
export function findBySaleCode(items, raw) {
  const code = normalizeSaleCode(raw);
  if (!code) return null;
  return (items || []).find((i) => !i.deletedAt && String(i.saleCode || '').toUpperCase() === code) || null;
}

// Tag / print order (2026-11-20, operator: tags printed out of order are
// hard for the packer to stick on): A1, A2 … A999, B1 … (letters in
// CODE_LETTERS order), then old "KM42"-style codes alphabetically, then
// plants without a code by SKU.
function codeSortKey(item) {
  const code = String(item?.saleCode || '').toUpperCase();
  const p = parseSeriesCode(code);
  if (p) return [0, CODE_LETTERS.indexOf(p.series), p.n, ''];
  if (code) return [1, 0, 0, code];
  return [2, 0, 0, String(item?.sku || '')];
}
export function compareByCode(a, b) {
  const ka = codeSortKey(a), kb = codeSortKey(b);
  for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return ka[3].localeCompare(kb[3], undefined, { numeric: true });
}
export const sortByCode = (items) => [...(items || [])].sort(compareByCode);

// "A20–A22" for a batch of fresh codes in one series (or the single code);
// '' when they aren't all series codes of one letter.
export function codeRange(codes) {
  const parsed = (codes || []).map(parseSeriesCode);
  if (!parsed.length || parsed.some((p) => !p) || new Set(parsed.map((p) => p.series)).size !== 1) return '';
  const ns = parsed.map((p) => p.n);
  const lo = Math.min(...ns), hi = Math.max(...ns);
  return lo === hi ? seriesCode(parsed[0].series, lo) : `${seriesCode(parsed[0].series, lo)}–${seriesCode(parsed[0].series, hi)}`;
}
