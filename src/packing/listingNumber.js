// The number a sold plant was listed under — on its tag, in the buyer's
// order title, and what the packer looks for on the bench: its lineup number
// ("268") or its For Sale code ("A27").
//
// A plant can carry both. B-ANT-A944 (2026-11-21) was #268 in Thursday's
// live, didn't sell, joined the For Sale pool as A27 and sold there; the
// Shipping tab still showed 268, and plants sold only from the pool showed
// no number at all. Operator: "respect the listing number, either 268 or
// Axx, whichever comes last".
//
// When each was given: a code is minted as the plant joins the pool
// (poolAddedAt); a lineup number comes after the plant is staged into an
// event (stagedAt — Pre Sale and the For Sale calendar both clear the old
// number and stamp it). A lineup number with no stagedAt is older than any
// dated code. A code with no poolAddedAt is an old random one ("CZ48") from
// before codes were dated — the lineup number wins over it.
import { isSaleCode, parseSeriesCode, CODE_LETTERS } from '../forsale/saleCode.js';

const lotOf = (item) => String(item?.lotNumber ?? '').trim();
const codeOf = (item) => {
  const c = String(item?.saleCode || '').trim().toUpperCase();
  return isSaleCode(c) ? c : '';
};

export function codeIsNewer(item) {
  const codeAt = Date.parse(item?.poolAddedAt || '');
  if (!Number.isFinite(codeAt)) return false;
  const lotAt = Date.parse(item?.stagedAt || '');
  return !Number.isFinite(lotAt) || codeAt > lotAt;
}

// → { text: 'A27', kind: 'code' } | { text: '268', kind: 'lot' } | null
export function listingNumber(item) {
  const code = codeOf(item);
  const lot = lotOf(item);
  if (code && (!lot || codeIsNewer(item))) return { text: code, kind: 'code' };
  return lot ? { text: lot, kind: 'lot' } : null;
}

// "A27" / "268" / ''.
export const listingText = (item) => listingNumber(item)?.text || '';

// "A27 · " / "#268 · " / '' — for toasts and one-line summaries.
export function listingTag(item, sep = ' · ') {
  const n = listingNumber(item);
  if (!n) return '';
  return `${n.kind === 'lot' ? '#' : ''}${n.text}${sep}`;
}

// The lineup number the plant is shown by, as an integer — null when it's
// shown by its code (an old #268 under a newer A27 is no longer what the
// packer looks for, so it can't collide with another #268) or has none.
export function shownLot(item) {
  const n = listingNumber(item);
  if (!n || n.kind !== 'lot') return null;
  const v = parseInt(n.text, 10);
  return Number.isFinite(v) ? v : null;
}

// Tooltip for the number badge.
export const listingTitle = (item) => (listingNumber(item)?.kind === 'code'
  ? 'For Sale code — find the plant tagged with this code'
  : 'Lineup number — find the plant labelled with this #');

// Bench order: lineup numbers ascending, then codes (A1, A2 … B1 …), then
// plants with neither — the order the packer walks the shelves in.
function listingSortKey(item) {
  const n = listingNumber(item);
  if (!n) return [2, 0, 0];
  if (n.kind === 'lot') {
    const v = parseInt(n.text, 10);
    return Number.isFinite(v) ? [0, v, 0] : [2, 0, 0];
  }
  const p = parseSeriesCode(n.text);
  return p ? [1, CODE_LETTERS.indexOf(p.series), p.n] : [1, CODE_LETTERS.length, 0];
}
export function compareListing(a, b) {
  const ka = listingSortKey(a), kb = listingSortKey(b);
  for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return 0;
}
