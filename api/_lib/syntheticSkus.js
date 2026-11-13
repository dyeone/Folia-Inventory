// Validate Sales, Nigel slip imports and double-sale lines insert rows with
// synthetic SKUs (UNMATCHED-…, DBL-…) that name an order line, so a re-import
// of the same line lands on the same SKU. When an incoming SKU is taken:
//   • by a row in the trash → that row is hard-deleted (it only blocks the
//     unique index — the trash is throwaway for synthetic rows);
//   • by a live row for the SAME order line (same order # and the same title,
//     or the same box; with no order # on either side, the same box AND the
//     same title — a Nigel slip whose number didn't read) → it's the
//     re-import replacing its own row: deleted, the incoming one takes its
//     place — unless that row carries a refund (status 'refunded' or a
//     refundedAmount): a refund record is never deleted, so it's renamed;
//   • by anything else → the incoming row gets a free "-2", "-3"… SKU and both
//     rows stay. Until 2026-11-13 any collision deleted the existing row, and
//     Validate Sales SKUs were built from the merged-into box's upload id +
//     the row number of the NEW file — so an upload could silently delete a
//     different buyer's line from an earlier upload. Every order line must
//     survive; a duplicate is visible and can be removed, a deletion is not.
const SYNTHETIC_SKU_RE = /^(?:UNMATCHED|DBL)-/i;
export async function settleSyntheticSkus(supabase, rawInserts, brandId) {
  const rows = rawInserts.filter((i) => typeof i.sku === 'string' && SYNTHETIC_SKU_RE.test(i.sku));
  if (!rows.length) return;
  const skus = [...new Set(rows.map((i) => i.sku))];
  const existing = new Map();
  for (let k = 0; k < skus.length; k += 200) {
    const { data, error } = await supabase
      .from('inventory_items')
      .select('id, sku, "orderId", name, "shipmentBoxId", status, "refundedAmount", "deletedAt"')
      .eq('brandId', brandId)
      .in('sku', skus.slice(k, k + 200));
    if (error) { const e = new Error(error.message); e.status = 500; throw e; }
    for (const r of data || []) existing.set(r.sku, r);
  }
  const t = (v) => String(v ?? '').trim().toLowerCase();
  const purge = [];
  const rename = [];
  for (const row of rows) {
    const ex = existing.get(row.sku);
    if (!ex) continue;
    const sameBox = !!row.shipmentBoxId && ex.shipmentBoxId === row.shipmentBoxId;
    const sameName = t(ex.name) === t(row.name);
    const refunded = ex.status === 'refunded' || Number(ex.refundedAmount) > 0;
    const sameLine = !!ex.deletedAt || (!refunded && (
      t(ex.orderId) !== ''
        ? t(ex.orderId) === t(row.orderId) && (sameName || sameBox)
        : t(row.orderId) === '' && sameBox && sameName
    ));
    if (sameLine) { purge.push(ex.id); existing.delete(row.sku); } else rename.push(row);
  }
  if (purge.length) {
    for (let k = 0; k < purge.length; k += 200) {
      const { error } = await supabase.from('inventory_items').delete().eq('brandId', brandId).in('id', purge.slice(k, k + 200));
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
    }
  }
  if (!rename.length) return;
  const used = new Set(rawInserts.map((i) => i.sku));
  for (const row of rename) {
    const base = row.sku;
    let free = null;
    for (let from = 2; !free && from < 200; from += 20) {
      const candidates = Array.from({ length: 20 }, (_, j) => `${base}-${from + j}`).filter((c) => !used.has(c));
      const { data, error } = await supabase
        .from('inventory_items').select('sku').eq('brandId', brandId).in('sku', candidates);
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      const taken = new Set((data || []).map((r) => r.sku));
      free = candidates.find((c) => !taken.has(c)) || null;
    }
    if (!free) { const e = new Error(`No free SKU for order line ${base}`); e.status = 409; throw e; }
    used.add(free);
    row.sku = free;
  }
}
