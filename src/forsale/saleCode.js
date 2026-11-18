// A plant's short For Sale code — "KM42": two letters (no I/O/Q) then two
// digits (three once the brand has used ~47,600). Minted by the server when
// the plant joins a pool. Mirrors api/_lib/saleCode.js — keep the two
// identical.
export const SALE_CODE_RE = /^[A-HJ-NPR-Z]{2}\d{2,3}$/;

// "km-42", " KM 42 " → "KM42"; anything that isn't a code → ''.
export function normalizeSaleCode(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return SALE_CODE_RE.test(s) ? s : '';
}

// The live plant a typed / scanned code names in `items` (the active
// brand's list), or null. Trashed rows never match.
export function findBySaleCode(items, raw) {
  const code = normalizeSaleCode(raw);
  if (!code) return null;
  return (items || []).find((i) => !i.deletedAt && String(i.saleCode || '').toUpperCase() === code) || null;
}
