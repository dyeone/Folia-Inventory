// A scanned plant that's in no box, and the placeholder lines it can fill.
//
// A line sold without a SKU or a lineup number — a giveaway ("mint dark
// phoenix #2"), a Buy Now from a pool of look-alikes ("AOS self", "KOS x RC
// rehab") — becomes a purple placeholder in its buyer's box: nothing says
// which pot it is, so the plant's own QR label scanned as "not in a box" and
// the wrap station never printed it a label (2026-11-13: ~45 such lines in
// open BAE boxes). The packer knows which pot it is — it's in their hand. A
// scan offers the lines that plant can fill (this box's first), and the pick
// links them on the server (api/items.js link-to-line, guarded; the writes
// are api/_lib/linkLine.js): the plant takes the line's place — order,
// price, buyer, box — so it prints, scans and packs like any other plant.
import { sharedWords } from './nameMatch.js';
import { isNigelBoxId } from './platform.js';

// Lines that are never a plant: shipping upgrades, add-ons, credits.
const NOT_A_PLANT = /(heat\s*pack|insulat|\bhold\b|mailer|upgrade|next\s*day|2[\s-]*day|overnight|shipping|store\s*credit|coupon|gift\s*card|sponge|bae\s*aid|\btip\b|donation)/i;

// Placeholder lines (UNMATCHED-…, not a flagged double-sale DBL- line) still
// to pack in an open box — never in one of Nigel's boxes (his slip lines are
// his products, not our inventory). Same rule as api/_lib/linkLine.js
// isOpenLine, plus the not-a-plant names.
export function isOpenPlantLine(i) {
  return !!i && !i.deletedAt
    && i.lotKind === 'unmatched'
    && /^UNMATCHED-/i.test(String(i.sku || ''))
    && i.status === 'sold'
    && !!i.shipmentBoxId
    && !isNigelBoxId(i.shipmentBoxId)
    && !i.packedAt
    && !NOT_A_PLANT.test(String(i.name || ''));
}

// Plants that can be put on a line: our inventory, in no box yet (in stock,
// or sold but never boxed). Same rule as api/_lib/linkLine.js.
export function isLinkablePlant(i) {
  return !!i && !i.deletedAt && i.lotKind !== 'unmatched' && !i.shipmentBoxId
    && ['available', 'listed', 'acclimated', 'sold'].includes(i.status);
}

// The lines `plant` could fill, best first: same lineup number, then the
// most words in common with the line's title. With `boxId` (the packer is in
// that box), every plant line of that box is offered — the packer is the
// judge there; without, only lines whose number or name agrees.
export function linkCandidates(plant, items, { boxId = null } = {}) {
  if (!isLinkablePlant(plant)) return [];
  return (items || [])
    .filter((i) => isOpenPlantLine(i) && (!boxId || i.shipmentBoxId === boxId))
    .map((line) => {
      const sameLot = plant.lotNumber != null && plant.lotNumber !== ''
        && String(line.lotNumber ?? '') === String(plant.lotNumber);
      const words = sharedWords(line.name, plant.name);
      return { line, score: (sameLot ? 100 : 0) + words * 10, sameLot, words };
    })
    .filter((c) => boxId || c.score > 0)
    .sort((a, b) => b.score - a.score || String(a.line.orderDate || '').localeCompare(String(b.line.orderDate || '')));
}
