// A plant's short For Sale code — "KM42": two letters then two digits. It's
// printed big on the plant's tag and put in every listing title, so whoever
// packs an order can find the pot on the bench at a glance. The letters skip
// I, O and Q (read as 1, 0 and 0/O); the shape can't be mistaken for a SKU
// (B-ANT-9759), a box tag (B-7KQ2MX) or a lineup number (042). Unique per
// brand and never reused (unique index, migration 0052). Mirrors
// src/forsale/saleCode.js — keep the two identical.

export const CODE_LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ';
export const SALE_CODE_RE = /^[A-HJ-NPR-Z]{2}\d{2,3}$/;

// "km-42", " KM 42 " → "KM42"; anything that isn't a code → ''.
export function normalizeSaleCode(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return SALE_CODE_RE.test(s) ? s : '';
}

function randomCode(rand, digits) {
  const L = CODE_LETTERS;
  const a = L[Math.floor(rand() * L.length)];
  const b = L[Math.floor(rand() * L.length)];
  const n = String(Math.floor(rand() * 10 ** digits)).padStart(digits, '0');
  return `${a}${b}${n}`;
}

// `count` fresh codes, none in `taken` (a Set, updated in place). Random, not
// sequential, so plants sitting side by side on the bench don't carry
// near-identical codes (KM42 / KM43). Two digits until that space is 90%
// used (~47,600 codes), then three.
export function pickSaleCodes(taken, count, rand = Math.random) {
  const out = [];
  const twoDigitSpace = CODE_LETTERS.length ** 2 * 100;
  for (let k = 0; k < count; k++) {
    const twoUsed = [...taken].filter((c) => c.length === 4).length;
    const digits = twoUsed < twoDigitSpace * 0.9 ? 2 : 3;
    let code = '';
    for (let tries = 0; tries < 500; tries++) {
      const c = randomCode(rand, digits);
      if (!taken.has(c)) { code = c; break; }
    }
    if (!code) throw new Error('Ran out of plant codes — tell the developer');
    taken.add(code);
    out.push(code);
  }
  return out;
}
