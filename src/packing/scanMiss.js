// What to tell the packer when a scanned plant isn't in any open box.
//
// A bare "SKU … isn't in any open box" reads as broken scanning. On
// 2026-11-13 the packer scanned #585 (B-ANT-9759): the plant had sold in
// Thursday's show, but Validate Sales hadn't run yet, so it was in no box.
// The packer should hear why, and what to do next. The caller re-reads the
// list first (a stalled poll or a sale validated a moment ago), so the
// verdict below is about the freshest data.
import { normalizeSku, shortBoxCode } from '../labels/boxCode.js';
import { skuPrefixForBrand } from '../constants.js';

const lotTag = (i) => (i?.lotNumber ? `#${i.lotNumber} · ` : '');

// sku: the normalized scanned SKU. items: the active brand's live rows.
// activeBrand / brands: AuthContext's ids and [{ id, name }].
export function scanMissMessage(sku, items, { activeBrand, brands } = {}) {
  const brandName = (id) => (brands || []).find((b) => b.id === id)?.name || id || 'this brand';
  const mine = (items || []).filter((i) => !i.deletedAt && normalizeSku(i.sku) === sku);
  if (!mine.length) {
    // SKUs carry their brand's letter (B-… BAE, G-… bae-gin): a plant of the
    // brand the packer isn't on is the common reason for "no such plant".
    const letter = /^([A-Z])-/.exec(sku)?.[1];
    const other = letter && (brands || []).find((b) => b.id !== activeBrand && skuPrefixForBrand(b.id) === letter);
    if (other) {
      return `${sku} is a ${other.name || other.id} plant — you're packing ${brandName(activeBrand)}. Switch to ${other.name || other.id} at the top, then scan again.`;
    }
    return `No plant with SKU ${sku} in ${brandName(activeBrand)} — check the label`;
  }
  // The row that says the most: in a box, then sold, then shipped, then any.
  const pick = mine.find((i) => i.status === 'sold' && i.shipmentBoxId)
    || mine.find((i) => i.status === 'sold')
    || mine.find((i) => i.status === 'shipped' || i.status === 'delivered')
    || mine[0];
  const tag = `${lotTag(pick)}${sku}`;
  switch (pick.status) {
    case 'sold':
      return pick.shipmentBoxId
        ? `List updated — ${tag} is in box ${shortBoxCode(pick.shipmentBoxId)}. Scan it again.`
        : `${tag} is sold but not in a box yet — run Validate Sales at the desk, then scan again.`;
    case 'shipped':
    case 'delivered':
      return `${tag} already shipped${pick.shipmentBoxId ? ` (box ${shortBoxCode(pick.shipmentBoxId)})` : ''} — it doesn't go in a box again.`;
    case 'available':
    case 'listed':
      return `${tag} isn't in a box — it isn't marked sold yet${pick.saleId ? ' (still in a show lineup)' : ''}. If it sold, run Validate Sales at the desk, then scan again.`;
    case 'acclimated':
      return `${tag} is still in acclimation, not sold — it isn't in any box.`;
    case 'consigned':
      return `${tag} is out on consignment — it isn't in any box.`;
    case 'refunded':
      return `${tag} was refunded — it isn't in any open box.`;
    default:
      return `${tag} is ${pick.status} — it isn't in any open box.`;
  }
}
