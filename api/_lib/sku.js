// Every SKU minted since 2026-10-02 starts with its BRAND. From 2026-10-08
// the brand segment is ONE letter — B-ANT-8912, G-NC-ANT-9808 — because the
// word ("BAEGIN-") ate a third of a 2-inch label. The brands share plants
// (cross-brand transfer) and each keeps its own number sequence, so the
// letter is what makes a label mean one plant wherever it is scanned.
// Older SKUs (BAE-…, BAEGIN-…, unprefixed) stay as they are; every reader
// accepts a first segment of 1–8 letters. The client previews use the same
// table (src/constants.js skuPrefixForBrand) — keep the two identical.
export const BRAND_SKU_LETTER = {
  bae: 'B',
  'bae-gin': 'G',
};

export function brandSkuPrefix(brandId) {
  const id = String(brandId || '').toLowerCase();
  if (BRAND_SKU_LETTER[id]) return BRAND_SKU_LETTER[id];
  // A brand without a letter: the initials of its id ("new-brand" → NB).
  return id.split(/[^a-z0-9]+/).filter(Boolean).map((p) => p[0].toUpperCase()).join('') || 'X';
}

// ── The number part ───────────────────────────────────────────────────────
// A brand's SKUs count 1 … 9999, then A001 … A999, B001 … Z999 (operator's
// call, 2026-10-08: a four-character suffix always fits the label). The
// "serial" is the plain count behind both spellings: 9999 → 9999,
// A001 → 10000, A999 → 10998, B001 → 10999, Z999 → 35973.
export const SKU_SUFFIX_RE = /(?:\d+|[A-Z]\d{3})/;          // what a suffix looks like
export const SKU_SUFFIX_END_RE = /-(\d+|[A-Z]\d{3})$/;       // … at the end of a SKU
const LETTER_BLOCK = 999;
const FIRST_LETTER_SERIAL = 10000;
export const MAX_SKU_SERIAL = FIRST_LETTER_SERIAL + 26 * LETTER_BLOCK - 1;   // Z999

export function formatSkuSerial(n) {
  const s = Math.max(1, Math.floor(Number(n) || 0));
  if (s < FIRST_LETTER_SERIAL) return String(s);
  if (s > MAX_SKU_SERIAL) throw Object.assign(new Error('SKU numbers are exhausted (past Z999) — time for a new scheme'), { status: 500 });
  const k = s - FIRST_LETTER_SERIAL;
  return `${String.fromCharCode(65 + Math.floor(k / LETTER_BLOCK))}${String((k % LETTER_BLOCK) + 1).padStart(3, '0')}`;
}

export function parseSkuSerial(suffix) {
  const t = String(suffix || '').trim().toUpperCase();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const m = /^([A-Z])(\d{3})$/.exec(t);
  if (!m) return null;
  const d = parseInt(m[2], 10);
  if (d < 1) return null;
  return FIRST_LETTER_SERIAL + (m[1].charCodeAt(0) - 65) * LETTER_BLOCK + (d - 1);
}

// The serial of a whole SKU (null when it has no suffix we know).
export function skuSerialOf(sku) {
  const m = SKU_SUFFIX_END_RE.exec(String(sku || '').toUpperCase());
  return m ? parseSkuSerial(m[1]) : null;
}

// The next serial for a brand: the numeric max from the SQL function
// (migration 0051 teaches it the letter form too) joined with a scan of
// the letter-coded SKUs, so the rollover is right even before 0051 runs.
export async function nextSkuSerial(supabase, brandId) {
  const { data: numeric, error } = await supabase.rpc('inventory_max_sku_suffix', { p_brand: brandId });
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  let max = Number(numeric) || 0;
  const { data: lettered, error: lErr } = await supabase
    .from('inventory_items').select('sku').eq('brandId', brandId).filter('sku', 'match', '-[A-Z][0-9]{3}$');
  if (lErr) { const e = new Error(lErr.message); e.status = 500; throw e; }
  for (const r of lettered || []) { const s = skuSerialOf(r.sku); if (s != null && s > max) max = s; }
  return max + 1;
}
