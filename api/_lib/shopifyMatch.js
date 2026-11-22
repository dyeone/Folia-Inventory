// Which plant did a Shopify order line buy, when the line has no SKU?
//
// Products the app lists carry the plant's SKU, so their orders match
// exactly. Products made by hand in Shopify don't (2026-11-21: three orders,
// four lines, all "no SKU"): their titles start with the plant's lot number
// and then its name — "154 Dark handsome x dream weaver". Lot numbers come
// round again every few weeks (lot_number_rolling_blocks), so the number
// alone names several plants; the name decides, and it has to agree well —
// a wrong guess would mark the wrong pot sold. Anything short of one clear
// winner is left for a person: the line comes in as a placeholder.
//
// Pure — api/_lib/shopify.js does the reads and writes.
import { normalizeSaleCode } from './saleCode.js';

export const FOR_SALE = ['available', 'listed', 'acclimated'];

// "154 Dark handsome…", "#154 …", "No. 154 …", "Lot 154 - …" → lot 154;
// "A12 Dark handsome…" or the app's own "Dark handsome… · A12" → code A12.
export function parseLineTitle(title) {
  const s = String(title || '').replace(/\s+/g, ' ').trim();
  const out = { code: '', lot: null, name: s };
  const tail = /\s[·•|-]\s*([A-Za-z]{1,2}-?\d{1,3})$/.exec(s);
  if (tail && normalizeSaleCode(tail[1])) {
    out.code = normalizeSaleCode(tail[1]);
    out.name = s.slice(0, tail.index).trim();
    return out;
  }
  const lead = /^(?:#|no\.?\s*|lot\s*)?([A-Za-z]{0,2}-?\d{1,4})(?=[\s.:#)\-–—]|$)[\s.:#)\-–—]*/i.exec(s);
  if (!lead) return out;
  const token = lead[1];
  const rest = s.slice(lead[0].length).trim();
  if (/^\d+$/.test(token)) {
    out.lot = Number(token);
    out.name = rest;
  } else if (normalizeSaleCode(token)) {
    out.code = normalizeSaleCode(token);
    out.name = rest;
  }
  return out;
}

const STOP = new Set(['anthurium', 'the', 'and', 'with', 'for', 'plant', 'var', 'cross', 'hybrid']);

// Significant words: letters only, 3+ long ("x", "RC", "S1" drop out).
export function nameWords(s) {
  return [...new Set(String(s || '').toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 2 && !STOP.has(w)))];
}

const sameWord = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

// How well two names agree: `shared` words of the shorter name found in the
// longer, `cover` = shared / the shorter name's word count. "Red velvet cake
// x Michelle" vs "Red velvet x Michelle" → 3 shared, cover 1.
export function nameScore(a, b) {
  const wa = nameWords(a), wb = nameWords(b);
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (!short.length) return { shared: 0, cover: 0 };
  const shared = short.filter((w) => long.some((x) => sameWord(w, x))).length;
  return { shared, cover: shared / short.length };
}

// Close enough to mark a plant sold without a person looking: nearly every
// word of the shorter name, and at least two words (one when a name has
// only one).
export function namesMatch(score, a, b) {
  const need = Math.min(2, nameWords(a).length, nameWords(b).length);
  return need > 0 && score.shared >= need && score.cover >= 0.75;
}

const forSale = (p) => FOR_SALE.includes(p.status) && !p.shipmentBoxId && !p.deletedAt;
const synthetic = (p) => p.lotKind === 'unmatched' || /^(?:UNMATCHED|DBL)-/i.test(String(p.sku || ''));

// The plant `title` bought, from `candidates` (the brand's live plants with
// the title's code or lot number). `ongoingSaleIds`: events still running —
// a plant in one is the likelier pick (it's the one being sold right now).
// → { plant, how } | { plant: null, reason, near: [plants] }
export function pickPlant(title, candidates, { ongoingSaleIds = new Set() } = {}) {
  const t = parseLineTitle(title);
  const live = (candidates || []).filter((p) => !p.deletedAt && !synthetic(p));
  if (t.code) {
    const p = live.find((x) => String(x.saleCode || '').toUpperCase() === t.code);
    if (p && forSale(p)) return { plant: p, how: `code ${t.code}` };
    return { plant: null, reason: p ? 'taken' : 'none', near: p ? [p] : [] };
  }
  if (t.lot == null) return { plant: null, reason: 'no-number', near: [] };
  const named = live
    .filter((p) => Number(p.lotNumber) === t.lot)
    .map((p) => ({ p, s: nameScore(t.name, p.name) }))
    .filter(({ p, s }) => namesMatch(s, t.name, p.name));
  const open = named.filter(({ p }) => forSale(p));
  if (!open.length) return { plant: null, reason: named.length ? 'taken' : 'none', near: named.map(({ p }) => p) };
  const rank = ({ p, s }) => [ongoingSaleIds.has(p.saleId) ? 1 : 0, s.cover, s.shared];
  open.sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return rb[i] - ra[i];
    return 0;
  });
  if (open.length > 1 && rank(open[0]).every((v, i) => v === rank(open[1])[i])) {
    return { plant: null, reason: 'ambiguous', near: open.map(({ p }) => p) };
  }
  return { plant: open[0].p, how: `lot ${t.lot} + name` };
}
