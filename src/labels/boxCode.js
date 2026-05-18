// Deterministic short code for a packing box. shipmentBoxId in the
// database is a verbose recipient+address string (`john smith|123 main
// st|...`) which is unique per box but too long to print on a 2"×1"
// label or scan with a handheld. Hash it down to 6 alphanumeric chars
// with a `B-` prefix for human recognition. Examples: B-3K8F2A, B-X9P0L1.
//
// 36^6 ≈ 2.1 billion possibilities — collisions are effectively
// impossible for any realistic box count.
export function shortBoxCode(shipmentBoxId) {
  if (!shipmentBoxId) return '';
  // djb2 hash → unsigned 32-bit int
  let h = 5381;
  const s = String(shipmentBoxId);
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  const base36 = h.toString(36).toUpperCase().padStart(6, '0');
  return `B-${base36.slice(-6)}`;
}

// Box codes are uppercase alphanumeric with a B- prefix. Normalize
// operator input so trailing whitespace, case differences, and a
// missing prefix don't cause a false miss when looking up a box by
// scanned/typed code.
export function normalizeBoxCode(raw) {
  let v = String(raw || '').trim().toUpperCase();
  if (!v) return '';
  if (!v.startsWith('B-')) v = `B-${v}`;
  return v;
}
