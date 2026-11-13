// Validate Sales — what happens to EVERY line of an orders file.
//
// The operator's rule (2026-11-13): each line of the sheet is kept. It lands
// as exactly one line in a box — a real plant marked sold, a line that's
// already there left in place, or a new placeholder / flagged line — and is
// never dropped, never folded into another line, and never allowed to delete
// somebody else's line. Before this plan, lines went missing four ways:
//   • two lines with the same SKU (a Buy Now listing bought by two buyers,
//     or one SKU typed on two listings) both "matched" the one plant; the
//     second write overwrote the first buyer's box with the second buyer's;
//   • a SKU already in another buyer's OPEN box counted as "already in a
//     box" and the line was skipped, though it was a different order;
//   • a Quantity of 2+ on a real plant's line kept one unit;
//   • placeholder SKUs were built from the merged-into box's upload id and
//     the row number in the NEW file, and the server deleted whatever row
//     already had that SKU — another buyer's line from an earlier upload.
//
// How a line finds its row, in order — each row is claimed by one line only:
//   0. its own plant: the SKU, already in a box for THIS order # (or put in
//      this buyer's box by hand, no order #);
//   1. its own placeholder by SKU (UNMATCHED-P<order>-<n>, made by an earlier
//      upload of this order line);
//   2. a placeholder / flagged line an earlier upload made for this order #
//      with this title — never one made for another line of the file that
//      hasn't been planned yet (bundle halves share order # and title);
//   3. what's left: the SKU's plant in stock → mark it sold (if the order
//      already has a placeholder in a box, the plant REPLACES it — "relink");
//      a row this order # already has in a box → that's this line; the SKU's
//      plant sold to a different order, or taken by an earlier line of this
//      file → a flagged double-sale line; nothing at all → a placeholder.
// A fully refunded row (status 'refunded', still in its box) is the line's
// own row: the line lands on it and nothing is added or replaced.
// Palmstreet gives every purchased line its own order # (4,177 BAE orders,
// 14 with more than one line), so "this order #" is the line's identity.
import { normalizeSku } from '../labels/boxCode.js';
import { boxPlatform } from '../packing/platform.js';

const PLACED = new Set(['sold', 'shipped', 'delivered']);
// In stock: a sale line claims it. 'acclimated' is a TC still on the bench —
// sold is sold. (Not 'consigned': that plant is with another seller.)
const IN_STOCK = new Set(['available', 'listed', 'acclimated']);

const norm = (s) => String(s ?? '').trim().toLowerCase();
const nameKey = (s) => norm(String(s ?? '').slice(0, 200));

// Compare two timestamps by the instant they represent, not their string
// form — Postgres returns timestamptz as `…+00:00` while the parser emits
// `…000Z`, so a raw === would re-write an identical date on every upload.
export function sameInstant(a, b) {
  if (!a || !b) return false;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  return !isNaN(ta) && !isNaN(tb) && ta === tb;
}

const isSynthetic = (i) => i.lotKind === 'unmatched' || /^(?:UNMATCHED|DBL)-/i.test(String(i.sku || ''));
const isShipped = (i) => i.status === 'shipped' || i.status === 'delivered';
const inBox = (i) => !!i.shipmentBoxId && PLACED.has(i.status);
// A row refunded in full (Financial → Sync refunds sets status 'refunded' and
// leaves the box) is still that order line's row: the line lands on it and
// nothing is added — re-adding it would put a refunded order back in the
// packing queue, and the server would replace the row and its refund record.
const isRefunded = (i) => i.status === 'refunded';
const isOwnBoxed = (i) => inBox(i) || (!!i.shipmentBoxId && isRefunded(i));
// Sold but never boxed (no path does this today) is still the plant to box.
const isStock = (i) => IN_STOCK.has(i.status) || (i.status === 'sold' && !i.shipmentBoxId);

// The order line's identity, stable across uploads: the order # plus the
// line's place among that order's lines in the file. No order # (never seen
// from Palmstreet) falls back to this upload + row, unique but not stable.
export function lineKeyFor(platform, uploadNonce, line, nth) {
  const ord = String(line.orderNumber || '').trim();
  if (ord) {
    const safe = ord.toUpperCase().replace(/[^A-Z0-9-]+/g, '-').slice(0, 60);
    return `${platform === 'tiktok' ? 'T' : 'P'}${safe}-${nth}`;
  }
  return `${String(uploadNonce).toUpperCase()}-${String(line.rowKey).toUpperCase()}`;
}
export const placeholderSkuFor = (lineKey) => `UNMATCHED-${lineKey}`;
// A real plant's line ordered with Quantity N: the other N−1 units.
export const extraUnitsSkuFor = (lineKey) => `UNMATCHED-${lineKey}-X`;

// SKU keys to try, in order: the exact key; then, for 3+ segments (a stray
// hyphenated word glued on, "GREEN-ANT-142"), the trailing two segments.
function skuKeys(raw) {
  const k = normalizeSku(raw);
  if (!k) return [];
  const segs = k.split('-');
  return segs.length >= 3 ? [k, segs.slice(-2).join('-')] : [k];
}

function sameBuyer(box, inv) {
  if (box.username && inv.buyerUsername && norm(box.username) === norm(inv.buyerUsername)) return true;
  return !!box.recipientName && norm(box.recipientName) === norm(inv.buyer);
}

// A SHIPPED plant with no order # on one side (legacy rows): the same
// shipment only when buyer, full address and sold date all line up — the
// operator's strict rule — else the plant looks sold twice.
function isSameShipment(box, it, inv) {
  const a = inv.buyerAddress || {};
  const addrMatch =
    norm(box.street1) === norm(a.street1) &&
    norm(box.city) === norm(a.city) &&
    norm(box.state) === norm(a.state) &&
    norm(box.zip) === norm(a.zip);
  const dateMatch = sameInstant(it.orderDate, inv.soldAt) || sameInstant(it.orderDate, inv.orderDate);
  return norm(box.recipientName) === norm(inv.buyer) && addrMatch && dateMatch;
}

const DAY_MS = 86400000;
function bornBy(row, orderDate) {
  const born = Date.parse(row.createdAt || '');
  const ordered = Date.parse(orderDate || '');
  return isNaN(born) || isNaN(ordered) || born <= ordered + DAY_MS;
}

function rowOrder(rowKey) {
  const m = /^r(\d+)(?:_(\d+))?$/.exec(String(rowKey || ''));
  return m ? [Number(m[1]), Number(m[2] || 0)] : [Number.MAX_SAFE_INTEGER, 0];
}

// boxes: parsed boxes (parsePalmstreetOrders / parseTikTokOrders).
// items: the brand's inventory (live and trashed rows; trashed are ignored).
// Returns the boxes with every line carrying `plan`:
//   { kind, item, replaces, lineKey, placeholderSku, extraSku, extra }
//   kind: 'fresh'         plant in stock → marked sold into this buyer's box
//         'relink'        plant in stock replaces this line's placeholder,
//                         in the placeholder's box
//         'topup'         line already in an OPEN box → missing details filled
//         'same_shipment' line already SHIPPED → left as it is
//         'double_sale'   plant already sold to another order / line → a
//                         flagged line is added to this buyer's box
//         'unmatched'     nothing in inventory → a placeholder line
//   item:     the row the line lands on (or, for double_sale, the plant's row)
//   replaces: relink — the placeholder being replaced
//   extra:    { units, row } — Quantity N on a real plant: the other N−1
//             units as one placeholder line (row = it exists already)
export function planValidation(boxes, items, { platform = 'palmstreet' } = {}) {
  const live = (items || []).filter((i) => !i.deletedAt);
  const bySku = new Map();
  const byOrder = new Map();
  for (const i of live) {
    const k = normalizeSku(i.sku);
    if (k) {
      if (!bySku.has(k)) bySku.set(k, []);
      bySku.get(k).push(i);
    }
    // Order rows count only on this upload's platform: a Palmstreet order #
    // never names a TikTok or Nigel box's line.
    if (i.orderId && isOwnBoxed(i) && boxPlatform(i.shipmentBoxId) === platform) {
      const o = norm(i.orderId);
      if (!byOrder.has(o)) byOrder.set(o, []);
      byOrder.get(o).push(i);
    }
  }

  // Lines in file order — claims are first come, first served, so the same
  // file always resolves the same way.
  const lines = [];
  for (const box of boxes || []) {
    const nonce = String(box.id || '').split('|')[0] || 'UP';
    for (const it of box.items) lines.push({ box, it, nonce, at: rowOrder(it.rowKey) });
  }
  lines.sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1]);
  const nthInOrder = new Map();
  const linesByOrder = new Map();
  for (const L of lines) {
    const o = norm(L.it.orderNumber);
    const nth = o ? (nthInOrder.get(o) || 0) + 1 : 0;
    if (o) nthInOrder.set(o, nth);
    L.nth = nth;
    L.lineKey = lineKeyFor(platform, L.nonce, L.it, nth);
    L.ord = o;
    L.title = nameKey(L.it.title);
    L.keys = [...skuKeys(L.it.sku), ...skuKeys(L.it.altSku)]
      .filter((k, i, a) => a.indexOf(k) === i);
    if (o) {
      if (!linesByOrder.has(o)) linesByOrder.set(o, []);
      linesByOrder.get(o).push(L);
    }
  }

  const claimed = new Set();
  const claimedBy = new Map();   // row id → the line that took it
  let current = null;            // the line being resolved
  const take = (row) => { claimed.add(row.id); if (current) claimedBy.set(row.id, current); return row; };
  const free = (row) => !!row && !claimed.has(row.id);
  const landOn = (row) => (isShipped(row) || isRefunded(row) ? 'same_shipment' : 'topup');
  const bySynth = new Map(live.filter(isSynthetic).map((i) => [normalizeSku(i.sku), i]));
  // Rows carrying the line's SKU — the first key that has any. A plant added
  // to inventory after the order was placed can't be the one that sold in
  // it: old numbers get reused (BAE's ANT-8620 sold 2026-09-10 as a
  // placeholder; a different plant took ANT-8620 on 09-24), and re-uploading
  // an old file must not mark that newer plant sold. A day of slack covers
  // Quick add during the show and clock skew.
  // ({ anyAge }: the line's own order # already names the row — skip the age
  // check.)
  const hitsFor = (L, { anyAge = false } = {}) => {
    for (const key of L.keys) {
      const hits = (bySku.get(key) || []).filter((i) => anyAge || bornBy(i, L.it.orderDate));
      if (hits.length) return hits;
    }
    return [];
  };
  // Which line of this order a synthetic row was made for, when its SKU says
  // so. Bundle halves ("Bundle (ALO-1) (ALO-2)" → two lines) share one order #
  // and one title, so the title alone can't tell their rows apart:
  //   UNMATCHED-P<order>-<n>      → the order's n-th line;
  //   DBL-<plant SKU>-<order>[-n] → the line carrying that plant's SKU;
  //   UNMATCHED-<12>-r<i>_<j>     → (pre-2026-11-13) bundle half j.
  // null when the SKU doesn't say (one line per order, or a legacy -r<i>).
  const ownerOf = (row, L) => {
    const sibs = linesByOrder.get(L.ord) || [];
    if (sibs.length < 2) return null;
    const sku = normalizeSku(row.sku);
    const orderKey = L.lineKey.slice(0, L.lineKey.lastIndexOf('-'));
    const own = sku.startsWith(`UNMATCHED-${orderKey}-`) ? sku.slice(`UNMATCHED-${orderKey}-`.length) : null;
    if (own && /^\d+$/.test(own)) return sibs.find((s) => s.nth === Number(own)) || null;
    const tail = `-${normalizeSku(L.it.orderNumber)}`;
    if (sku.startsWith('DBL-')) {
      const at = sku.indexOf(tail, 4);
      if (at > 4) {
        const plantSku = sku.slice(4, at);
        return sibs.find((s) => s.keys.includes(plantSku)) || null;
      }
      return null;
    }
    const half = /^UNMATCHED-[a-z0-9]{12}-r\d+_(\d+)$/i.exec(String(row.sku || '').trim());
    if (half) {
      const title = nameKey(row.name);
      return sibs.find((s) => s.title === title && s.at[1] === Number(half[1])) || null;
    }
    return null;
  };
  // Of an order's free rows, the ones line L may take: never a row made for
  // another line of this file that hasn't been planned yet (it will claim its
  // own); the row made for L first, then placeholders, then anything else.
  const candidatesFor = (L, rows) => rows
    .map((row) => ({ row, owner: ownerOf(row, L) }))
    .filter(({ owner }) => !owner || owner === L || owner.plan)
    .sort((a, b) => (b.owner === L) - (a.owner === L) || isSynthetic(b.row) - isSynthetic(a.row))
    .map(({ row }) => row);
  // The line's own placeholder / flagged line from an earlier upload. If the
  // line's plant is in stock now (its SKU was fixed, or reads since the glued
  // SKU fix), the plant replaces the placeholder in that box; otherwise the
  // line stays as it is.
  const ownRow = (L, own) => {
    const stock = isRefunded(own) ? null : hitsFor(L).find((i) => free(i) && isStock(i));
    return stock
      ? { kind: 'relink', item: take(stock), replaces: take(own) }
      : { kind: landOn(own), item: take(own) };
  };

  // 0. The line's own plant: boxed for this order #, or put in this buyer's
  //    box by hand (no order #). First, so a placeholder the plant has stood
  //    in for is left for a line that still needs a row.
  for (const L of lines) {
    if (!L.ord) continue;
    current = L;
    const hit = hitsFor(L, { anyAge: true }).find((i) => free(i) && isOwnBoxed(i) && norm(i.orderId) === L.ord)
      || hitsFor(L).find((i) => free(i) && inBox(i) && !i.orderId
        && (isShipped(i) ? isSameShipment(L.box, L.it, i) : sameBuyer(L.box, i)));
    if (hit) L.plan = { kind: landOn(hit), item: take(hit) };
  }

  // 1. Rows made for exactly this line by an earlier upload (its own SKU).
  for (const L of lines) {
    current = L;
    const extra = bySynth.get(normalizeSku(extraUnitsSkuFor(L.lineKey)));
    if (free(extra) && isOwnBoxed(extra)) L.extraRow = take(extra);
  }
  for (const L of lines) {
    if (L.plan) continue;
    current = L;
    const own = bySynth.get(normalizeSku(placeholderSkuFor(L.lineKey)));
    if (free(own) && isOwnBoxed(own)) L.plan = ownRow(L, take(own));
  }

  // 2. A placeholder / flagged line of this order # with this title that no
  //    other line of the file was made for.
  for (const L of lines) {
    if (L.plan || !L.ord) continue;
    current = L;
    const own = candidatesFor(L, (byOrder.get(L.ord) || [])
      .filter((i) => free(i) && isSynthetic(i) && nameKey(i.name) === L.title))[0];
    if (own) L.plan = ownRow(L, take(own));
  }

  // 3. Everything else.
  for (const L of lines) {
    if (L.plan) continue;
    current = L;
    const { box, it } = L;
    const hits = hitsFor(L);
    // A row this order # already has in a box that no line claimed yet —
    // a placeholder first (it IS this line, not yet linked to a plant).
    const orderRow = L.ord ? candidatesFor(L, (byOrder.get(L.ord) || []).filter(free))[0] || null : null;

    const stock = hits.find((i) => free(i) && isStock(i));
    if (stock) {
      if (orderRow && isSynthetic(orderRow) && !isRefunded(orderRow)) {
        L.plan = { kind: 'relink', item: take(stock), replaces: take(orderRow) };
      } else if (orderRow) {
        // The order's line already holds a different plant (picked by hand):
        // the operator's pick stands.
        L.plan = { kind: landOn(orderRow), item: take(orderRow) };
      } else {
        L.plan = { kind: 'fresh', item: take(stock) };
      }
      continue;
    }
    if (orderRow) { L.plan = { kind: landOn(orderRow), item: take(orderRow) }; continue; }

    const boxed = hits.find((i) => free(i) && inBox(i));
    if (boxed) {
      // Order # on both sides and they differ: another order has this plant.
      // Without one, the old rules decide whether it's this same sale.
      const orderless = !L.ord || !boxed.orderId;
      const same = orderless && (isShipped(boxed) ? isSameShipment(box, it, boxed) : sameBuyer(box, boxed));
      L.plan = same ? { kind: landOn(boxed), item: take(boxed) } : { kind: 'double_sale', item: boxed };
      continue;
    }
    // Every row with this SKU went to an earlier line of this file (two
    // buyers bought the same plant): this line is a second sale.
    const taken = hits.find((i) => claimed.has(i.id));
    if (taken) {
      const rival = claimedBy.get(taken.id);
      L.plan = { kind: 'double_sale', item: taken, rival: rival ? { buyer: rival.box.recipientName, username: rival.box.username } : null };
      continue;
    }
    L.plan = { kind: 'unmatched', item: null };
  }

  // Quantity 2+ on a REAL plant (marked sold now, already in an open box, or
  // replacing a placeholder): the plant is one unit; the rest ride along as
  // one placeholder line in the same box — in a relink it takes over the
  // replaced placeholder's state, so a shipped or packed box stays whole.
  for (const L of lines) {
    const p = L.plan;
    const units = Math.max(0, (parseInt(L.it.quantity, 10) || 1) - 1);
    const real = p.item && !isSynthetic(p.item) && ['fresh', 'relink', 'topup'].includes(p.kind);
    if (units > 0 && real) p.extra = { units, row: L.extraRow || null };
    p.lineKey = L.lineKey;
    p.nth = L.nth;
    p.placeholderSku = placeholderSkuFor(L.lineKey);
    p.extraSku = extraUnitsSkuFor(L.lineKey);
  }

  const planOf = new Map(lines.map((L) => [L.it, L.plan]));
  return (boxes || []).map((box) => ({
    ...box,
    items: box.items.map((it) => {
      const plan = planOf.get(it);
      return { ...it, plan, dispo: plan.kind };
    }),
  }));
}

// Count of what the apply will do — and the check that every line is kept.
export function summarizePlan(resolved) {
  const s = {
    totalItems: 0, matched: 0, relinked: 0, alreadyInBox: 0, sameShipment: 0,
    doubleSale: 0, unmatched: 0, extraUnits: 0, extraLines: 0,
  };
  for (const box of resolved || []) {
    for (const it of box.items) {
      s.totalItems += 1;
      const p = it.plan;
      switch (p.kind) {
        case 'fresh': s.matched += 1; break;
        case 'relink': s.matched += 1; s.relinked += 1; break;
        case 'topup': s.alreadyInBox += 1; break;
        case 'same_shipment': s.sameShipment += 1; break;
        case 'double_sale': s.doubleSale += 1; break;
        default: s.unmatched += 1;
      }
      if (p.extra && !p.extra.row) { s.extraUnits += p.extra.units; s.extraLines += 1; }
    }
  }
  s.kept = s.matched + s.alreadyInBox + s.sameShipment + s.doubleSale + s.unmatched;
  return s;
}
