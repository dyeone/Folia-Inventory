import { useMemo, useState } from 'react';
import {
  X, Upload, AlertCircle, Check, FileText, ArrowLeft,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { parsePalmstreetOrders } from '../packing/parsePalmstreetOrders.js';
import { parseTikTokOrders } from '../packing/parseTikTokOrders.js';
import { isTikTokBoxId } from '../packing/platform.js';
import { matchInventory } from '../packing/matchInventory.js';
import { normalizeSku } from '../labels/boxCode.js';
import { BoxesList, SummaryStat } from '../packing/PackingView.jsx';

// Validate Sales modal — global, not per-sale-event.
//
// Upload a Palmstreet orders file → match each order line to an
// inventory item by exact SKU (anywhere in the inventory, regardless
// of which sale it was originally part of) → click Update Inventory
// to mark matched items sold and persist buyer / order / shipment-box
// info.
//
// Matching is exact-SKU-only — no fuzzy, no lot-number guessing, no
// manual override. Unmatched rows still flow through: on apply we
// insert placeholder inventory_items rows for them (lotKind=
// 'unmatched', synthetic SKU) so the box stays whole in the Shipping
// tab. They render purple there to flag that they're not linked to
// real inventory; fix the SKU at source and re-upload if you need a
// proper link.
//
// Sale-event association is preserved automatically because items keep
// their `saleId` from when they were assigned to a lineup; this modal
// just updates them in place.
// Compare two timestamps by the instant they represent, not their string
// form — Postgres returns timestamptz as `…+00:00` while the parser emits
// `…000Z`, so a raw === would re-write an identical date on every upload.
function sameInstant(a, b) {
  if (!a || !b) return false;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  return !isNaN(ta) && !isNaN(tb) && ta === tb;
}

const norm = (s) => String(s || '').toLowerCase().trim();

// Does this incoming order line belong to the SAME shipment as the
// already-shipped inventory item it matched by SKU? Strictest rule (operator's
// choice): order #, buyer, full address, and sold date must ALL line up. Any
// mismatch means the same physical SKU is going out in a different box — a
// likely double-sale. (Order # is skipped only when BOTH sides lack one, so a
// legacy shipped row with no order # falls back to buyer+address+date instead
// of false-flagging every re-upload.)
function isSameShipment(box, it, inv) {
  const a = inv.buyerAddress || {};
  const oid1 = norm(it.orderNumber), oid2 = norm(inv.orderId);
  const orderMatch = (!oid1 && !oid2) ? true : oid1 === oid2;
  const buyerMatch = norm(box.recipientName) === norm(inv.buyer);
  const addrMatch =
    norm(box.street1) === norm(a.street1) &&
    norm(box.city) === norm(a.city) &&
    norm(box.state) === norm(a.state) &&
    norm(box.zip) === norm(a.zip);
  const dateMatch = sameInstant(it.orderDate, inv.soldAt) || sameInstant(it.orderDate, inv.orderDate);
  return orderMatch && buyerMatch && addrMatch && dateMatch;
}

// Classify what apply will DO with one matched order line:
//   'fresh'         — available/listed SKU → mark sold (+ place in box)
//   'topup'         — SKU already in an OPEN box → backfill missing data
//   'same_shipment' — SKU already SHIPPED and this is that same shipment
//                     (re-upload) → leave it completely alone
//   'double_sale'   — SKU already SHIPPED but a different box/date → flag the
//                     shipped item and create a flagged second-sale line
//   'unmatched'     — no inventory SKU → placeholder
function classifyLine(box, it, match) {
  if (!match?.item) return 'unmatched';
  if (!match.alreadyInBox) return 'fresh';
  const inv = match.item;
  if (inv.status === 'shipped' || inv.status === 'delivered') {
    return isSameShipment(box, it, inv) ? 'same_shipment' : 'double_sale';
  }
  return 'topup';
}

// platform: 'palmstreet' (default) or 'tiktok'. Same pipeline end to end —
// only the parser, the merge scope (a TikTok order only ever merges into an
// open TikTok box, never a Palmstreet one for the same client, and vice
// versa), and the copy differ. TikTok box ids carry a `tt` prefix that marks
// them for life (badges, future merges).
export function SalesUploadModal({ items, onApply, onClose, platform = 'palmstreet' }) {
  const isTikTok = platform === 'tiktok';
  const [fileName, setFileName] = useState('');
  const [boxes, setBoxes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const handleFile = async (file) => {
    setErr('');
    setLoading(true);
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      const parsed = isTikTok ? parseTikTokOrders(rows, items) : parsePalmstreetOrders(rows);
      if (parsed.length === 0) {
        setErr('No shippable items found in this file.');
        setBoxes(null);
      } else {
        setBoxes(parsed);
      }
    } catch (e) {
      setErr(`Could not read file: ${e.message}`);
      setBoxes(null);
    }
    setLoading(false);
  };

  // Match each order line against the entire inventory by exact SKU.
  // No fallbacks, no overrides — unmatched rows surface in the preview
  // and the operator fixes the source SKU before re-uploading.
  const resolved = useMemo(() => {
    if (!boxes) return null;
    return boxes.map(box => ({
      ...box,
      items: box.items.map(item => {
        const match = matchInventory(item, items);
        return { ...item, match, dispo: classifyLine(box, item, match) };
      }),
    }));
  }, [boxes, items]);

  const summary = useMemo(() => {
    if (!resolved) return null;
    let totalItems = 0, matched = 0, alreadyInBox = 0, unmatched = 0, sameShipment = 0, doubleSale = 0;
    for (const box of resolved) {
      for (const it of box.items) {
        totalItems += 1;
        switch (it.dispo) {
          case 'fresh': matched += 1; break;
          case 'topup': alreadyInBox += 1; break;
          case 'same_shipment': sameShipment += 1; break;
          case 'double_sale': doubleSale += 1; break;
          default: unmatched += 1;
        }
      }
    }
    return { totalItems, matched, alreadyInBox, unmatched, sameShipment, doubleSale };
  }, [resolved]);

  // Buyer+address → existing OPEN box id, so new orders for the same
  // buyer get merged into that buyer's still-open box instead of
  // creating a parallel duplicate. "Open" = at least one item still
  // status='sold'. Shipped/delivered boxes are history — they never
  // absorb new orders. Items already placed in any other box are
  // skipped at apply time (see it.match.alreadyInBox), so the merge
  // only ever brings in genuinely-new lines.
  const groupKeyFor = (recipientName, street1, city, state, zip) => [
    String(recipientName || '').toLowerCase().trim(),
    String(street1 || '').toLowerCase().trim(),
    String(city || '').toLowerCase().trim(),
    String(state || '').toLowerCase().trim(),
    String(zip || '').toLowerCase().trim(),
  ].join('|');
  const openBoxIdByGroup = useMemo(() => {
    const m = new Map();
    for (const item of items) {
      if (!item.shipmentBoxId) continue;
      if (item.deletedAt) continue;
      if (item.status !== 'sold') continue;
      // Platform fence: a TikTok upload only ever merges into open TikTok
      // (tt…) boxes, a Palmstreet upload only into non-TikTok ones. Same
      // client on both platforms = two separate boxes, by design.
      if (isTikTokBoxId(item.shipmentBoxId) !== isTikTok) continue;
      const addr = item.buyerAddress || {};
      const key = groupKeyFor(item.buyer, addr.street1, addr.city, addr.state, addr.zip);
      if (!m.has(key)) m.set(key, item.shipmentBoxId);
    }
    return m;
  }, [items, isTikTok]);

  // Orders that are FULLY shipped — every item with that order number is
  // shipped/delivered and none is still 'sold'. Re-validating a file that
  // includes such an order must not mint a fresh OPEN box for it (the merge
  // logic only reuses open boxes, so without this a re-import created a
  // duplicate that sat in the Ready tab next to the shipped original). We
  // require "no sold item" so a partially-shipped order still being filled
  // keeps merging normally.
  const fullyShippedOrderIds = useMemo(() => {
    const sold = new Set();
    const shipped = new Set();
    for (const i of items) {
      if (i.deletedAt || !i.orderId) continue;
      if (i.status === 'sold') sold.add(i.orderId);
      else if (i.status === 'shipped' || i.status === 'delivered') shipped.add(i.orderId);
    }
    return new Set([...shipped].filter(o => !sold.has(o)));
  }, [items]);

  const handleApply = () => {
    if (!resolved) return;
    const updates = [];
    const now = new Date().toISOString();
    // The reviewFlag column may not be migrated yet (0026). select('*') exposes
    // the key on every row once it exists, so probe the loaded inventory and
    // only write reviewFlag when it's there — Validate Sales must never break on
    // a DB that hasn't run the migration. Detection + the second-sale line still
    // happen; only the badge waits for the column.
    const supportsReviewFlag = items.some(i => 'reviewFlag' in i);
    for (const box of resolved) {
      // If this buyer already has an OPEN box, merge new lines into it.
      // Otherwise use the fresh per-upload id from parsePalmstreetOrders.
      // alreadyInBox lines are skipped below — they don't end up in
      // either the merged box or a new one.
      const groupKey = groupKeyFor(box.recipientName, box.street1, box.city, box.state, box.zip);
      const effectiveBoxId = openBoxIdByGroup.get(groupKey) || box.id;
      // For unmatched items in this box we want to tie them to the same
      // sale event as the matched ones (purely cosmetic — the Shipping
      // tab uses box.saleId from the first item only). Pick the first
      // matched item's saleId as the borrow.
      const fallbackSaleId =
        box.items.find(i => i.match?.item)?.match?.item?.saleId || null;

      const buyerAddress = {
        street1: box.street1,
        street2: box.street2,
        city: box.city,
        state: box.state,
        zip: box.zip,
        country: box.country,
        shipmentMethod: box.shipmentMethod,
      };
      // Per-item notes from the Palmstreet file. Each item carries its
      // own ' · '-joined "Seller: …" / "Buyer: …" string set by the
      // parser, so two items in the same buyer's box can have
      // different notes (the packer sees the right note next to the
      // right item instead of a box-level rollup).
      for (const it of box.items) {
        // Already shipped AND this is the same shipment as before (a re-upload
        // of the same order). Per the operator's rule, leave it completely
        // alone — don't even top up.
        if (it.dispo === 'same_shipment') continue;

        // Already shipped, but this order line is a DIFFERENT box/date — the
        // same physical SKU looks like it sold twice. Flag the shipped item AND
        // drop a flagged second-sale line so the operator can decide how to
        // handle it. The deterministic DBL-<sku>-<order> SKU keeps re-uploads
        // idempotent (skip if that flagged line already exists).
        if (it.dispo === 'double_sale') {
          const inv = it.match.item;
          if (supportsReviewFlag && inv.reviewFlag !== 'double_sale') {
            updates.push({ id: inv.id, reviewFlag: 'double_sale' });
          }
          const dupSku = `DBL-${normalizeSku(inv.sku)}-${norm(it.orderNumber) || it.rowKey}`.slice(0, 60);
          const exists = items.some(x => !x.deletedAt && normalizeSku(x.sku) === normalizeSku(dupSku));
          if (!exists) {
            const line = {
              sku: dupSku,
              type: inv.type === 'tc' ? 'tc' : 'plant',
              name: (it.title || inv.name || 'Item').slice(0, 200),
              variety: inv.variety || null,
              quantity: it.quantity || 1,
              status: 'sold',
              lotKind: 'unmatched',
              lotNumber: it.lineupIndex || null,
              saleId: fallbackSaleId,
              salePrice: it.price > 0 ? it.price : 0,
              soldAt: it.orderDate || now,
              buyer: box.recipientName,
              buyerUsername: box.username,
              buyerAddress,
              shipmentBoxId: effectiveBoxId,
              shipmentCarrier: box.carrier || 'usps',
              orderId: it.orderNumber || null,
              orderDate: it.orderDate || null,
              orderShippingFee: it.orderShippingFee ?? null,
              notes: `⚠ Possible double-sale of SKU ${inv.sku} (already shipped${inv.shipmentBoxId ? ` in box ${inv.shipmentBoxId}` : ''}). ${it.notes || ''}`.trim().slice(0, 500),
            };
            if (supportsReviewFlag) line.reviewFlag = 'double_sale';
            updates.push(line);
          }
          continue;
        }

        if (it.dispo === 'topup') {
          // Inventory row already placed in an OPEN box. Never duplicate it or
          // move it between boxes — but DO top up data an earlier import didn't
          // capture (order date + shipping fee), realign soldAt to the order
          // date, and fill buyer / price / notes only when missing so a manual
          // correction is never clobbered. status and shipmentBoxId are left
          // alone — re-validating must not revert a box or shuffle placement.
          const inv = it.match.item;
          const patch = { id: inv.id };
          if (it.orderDate && !sameInstant(inv.orderDate, it.orderDate)) patch.orderDate = it.orderDate;
          if (it.orderDate && !sameInstant(inv.soldAt, it.orderDate)) patch.soldAt = it.orderDate;
          if (it.orderShippingFee != null && inv.orderShippingFee == null) {
            patch.orderShippingFee = it.orderShippingFee;
          }
          if (it.orderNumber && !inv.orderId) patch.orderId = it.orderNumber;
          if (box.recipientName && !inv.buyer) patch.buyer = box.recipientName;
          if (box.username && !inv.buyerUsername) patch.buyerUsername = box.username;
          if (inv.buyerAddress == null) patch.buyerAddress = buyerAddress;
          if (inv.salePrice == null && it.price > 0) patch.salePrice = it.price;
          if (it.notes && !inv.notes) patch.notes = it.notes;
          if (it.lineupIndex && !inv.lotNumber) patch.lotNumber = it.lineupIndex;
          // Only enqueue a write if something actually changed.
          if (Object.keys(patch).length > 1) updates.push(patch);
          continue;
        }
        if (it.orderNumber && fullyShippedOrderIds.has(it.orderNumber)) {
          // This Palmstreet order already shipped (in a prior box) and has
          // no still-'sold' items. Don't recreate it as a fresh open box —
          // that's the duplicate-box bug. Items physically still in a box
          // are handled by the alreadyInBox branch above; this catches the
          // fresh-match / placeholder lines that would otherwise spawn a dup.
          continue;
        }
        if (it.match?.item) {
          const inv = it.match.item;
          const finalPrice = it.price > 0 ? it.price : parseFloat(inv.listingPrice) || 0;
          // Profit / margin are computed at display time from salePrice
          // and grossCost; nothing to persist beyond the sale price itself.
          updates.push({
            id: inv.id,
            status: 'sold',
            salePrice: finalPrice,
            // Sold time is when the buyer actually ordered (from the
            // Palmstreet "Order Date" column), not when we ran this import.
            // Falls back to now if the row had no parseable date.
            soldAt: it.orderDate || now,
            buyer: box.recipientName,
            buyerUsername: box.username,
            buyerAddress,
            shipmentBoxId: effectiveBoxId,
            shipmentCarrier: box.carrier || 'usps',
            orderId: it.orderNumber || null,
            orderDate: it.orderDate || null,
            orderShippingFee: it.orderShippingFee ?? null,
            notes: it.notes || null,
            // The lineup number the order title carried ("<#> <name>") is the
            // number printed on the plant's label — persist it so the packer can
            // find the plant by it (authoritative over any earlier lot number).
            ...(it.lineupIndex ? { lotNumber: it.lineupIndex } : {}),
          });
        } else {
          // No matching inventory row — emit a placeholder insert so the
          // box still includes this line in the Shipping tab (colored
          // purple to flag it). No `id` field so api.upsertItems takes
          // the INSERT path and the server assigns one. SKU is a
          // deterministic UNMATCHED-... that won't collide with real
          // inventory SKUs (the matcher filters to status='available'
          // /'listed' anyway, so a 'sold' UNMATCHED row won't ever be
          // matched against again on a future upload).
          const placeholderSku = `UNMATCHED-${effectiveBoxId.slice(0, 12)}-${it.rowKey}`;
          updates.push({
            sku: placeholderSku,
            type: 'plant',
            name: (it.title || 'Unmatched item').slice(0, 200),
            quantity: it.quantity || 1,
            status: 'sold',
            lotKind: 'unmatched',
            // Even unmatched, the title's lineup number helps the packer find
            // the physical plant (its label carries the same number).
            lotNumber: it.lineupIndex || null,
            saleId: fallbackSaleId,
            salePrice: it.price > 0 ? it.price : 0,
            soldAt: it.orderDate || now,
            buyer: box.recipientName,
            buyerUsername: box.username,
            buyerAddress,
            shipmentBoxId: effectiveBoxId,
            shipmentCarrier: box.carrier || 'usps',
            orderId: it.orderNumber || null,
            orderDate: it.orderDate || null,
            orderShippingFee: it.orderShippingFee ?? null,
            notes: it.notes || null,
          });
        }
      }
    }
    if (updates.length === 0) {
      setErr('No items to apply. Pick a different file.');
      return;
    }
    onApply(updates);
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-stretch sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-4xl h-full sm:h-[92vh] sm:rounded-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-gray-200 px-4 sm:px-5 py-3 sm:py-4 flex items-center justify-between flex-shrink-0">
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-gray-900 text-base sm:text-lg flex items-center gap-2">
              <Upload className="w-5 h-5 text-emerald-600" />
              {isTikTok ? 'Validate TikTok Orders' : 'Validate Sales'}
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {isTikTok
                ? 'Match each TikTok order to inventory by the label number in the product name. New lines for a buyer with an open TikTok box merge into it — TikTok boxes are never combined with the same client\'s Palmstreet boxes, and carry their own TikTok mark in Shipping.'
                : 'Match each Palmstreet order to inventory by exact SKU. New lines for a buyer with an open box merge into it; lines whose SKU is already in any box (open or shipped) are updated in place — order date, shipping fee, and any missing details are filled in without duplicating or moving the box.'}
            </p>
          </div>
          <button onClick={onClose} className="p-2 -mr-1 text-gray-500 hover:bg-gray-100 active:bg-gray-200 rounded-lg ml-2" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-4 space-y-4">
          {!boxes ? (
            <>
              <label className="block">
                <div className="border-2 border-dashed border-gray-300 rounded-xl p-12 sm:p-16 text-center hover:border-emerald-400 hover:bg-emerald-50/50 active:bg-emerald-50 cursor-pointer transition">
                  <Upload className="w-10 h-10 text-gray-400 mx-auto mb-3" />
                  <div className="text-base font-medium text-gray-900">
                    {loading ? 'Reading file...' : (isTikTok ? 'Upload TikTok "To Ship" orders export' : 'Upload Palmstreet sales report')}
                  </div>
                  <div className="text-sm text-gray-500 mt-1">
                    {isTikTok ? 'Seller Center → Orders → Export (.xlsx)' : '.xlsx, .xls or .csv'}
                  </div>
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={(e) => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }}
                    className="hidden"
                  />
                </div>
              </label>
              {err && (
                <div className="flex items-start gap-2 bg-red-50 text-red-700 text-sm px-3 py-2 rounded-lg">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {err}
                </div>
              )}
              <div className="text-sm text-gray-600 bg-gray-50 rounded-lg p-3">
                <div className="font-medium text-gray-900 mb-1">What this does:</div>
                <ul className="space-y-0.5 list-disc list-inside">
                  <li>Matches each order row against the full inventory by <em>exact SKU</em> (case-insensitive)</li>
                  <li>Marks matched items <em>sold</em> with the buyer's price, order date, shipping fee, order ID, and address</li>
                  <li>Re-uploading is safe: items already in a box keep their place but get <em>topped up</em> with order date, shipping fee, and anything that was missing</li>
                  <li>Unmatched rows still flow to the Shipping tab as <em>placeholder</em> items (purple) so nothing gets dropped — fix the SKU at source and re-upload if you need them re-linked to real inventory</li>
                  <li>Groups items by buyer so the Shipping tab can ship them</li>
                </ul>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div className="text-sm">
                  <FileText className="w-4 h-4 inline mr-1 text-gray-400" />
                  <span className="font-medium text-gray-900">{fileName}</span>
                  <span className="text-gray-500"> · {summary.totalItems} order rows</span>
                </div>
                <button
                  onClick={() => { setBoxes(null); setFileName(''); }}
                  className="text-xs text-gray-600 hover:text-gray-900 flex items-center gap-1"
                >
                  <ArrowLeft className="w-3 h-3" /> Different file
                </button>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <SummaryStat label="Boxes" value={resolved.length} tone="emerald" />
                <SummaryStat
                  label="Will mark sold"
                  value={summary.matched}
                  tone={summary.matched > 0 ? 'blue' : 'gray'}
                />
                <SummaryStat
                  label="Already in a box"
                  value={summary.alreadyInBox}
                  tone="gray"
                />
                <SummaryStat
                  label="Already shipped"
                  value={summary.sameShipment}
                  sub={summary.sameShipment > 0 ? 'left as-is' : null}
                  tone="gray"
                />
                <SummaryStat
                  label="Unmatched"
                  value={summary.unmatched}
                  tone={summary.unmatched > 0 ? 'amber' : 'gray'}
                />
                <SummaryStat
                  label="⚠ Double-sale"
                  value={summary.doubleSale}
                  sub={summary.doubleSale > 0 ? 'flagged for review' : null}
                  tone={summary.doubleSale > 0 ? 'red' : 'gray'}
                />
              </div>

              {summary.doubleSale > 0 && (
                <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-800 text-sm px-3 py-2 rounded-lg">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>
                    <span className="font-medium">{summary.doubleSale} possible double-sale{summary.doubleSale === 1 ? '' : 's'}.</span>{' '}
                    These SKUs were already shipped in a different box (order #, buyer, address, or date don&apos;t match). Each shipped item gets flagged, and a flagged second-sale line is added to the new buyer&apos;s box — review them in the Shipping tab.
                  </span>
                </div>
              )}

              <BoxesList boxes={resolved} />
            </>
          )}
        </div>

        {boxes && (
          <div className="border-t border-gray-200 px-4 sm:px-5 py-3 flex items-center justify-end gap-3 flex-shrink-0 bg-white">
            {err && (
              <div className="flex-1 text-xs text-red-700 flex items-center gap-1.5" role="alert">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {err}
              </div>
            )}
            <button onClick={onClose} className="px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-100 active:bg-gray-200 rounded-lg">
              Cancel
            </button>
            <button
              onClick={handleApply}
              disabled={!summary || summary.totalItems === 0}
              className="px-5 py-2.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 disabled:bg-gray-300 text-white rounded-lg flex items-center gap-1.5"
            >
              <Check className="w-4 h-4" /> Update Inventory · {summary?.matched || 0} matched
              {summary?.unmatched > 0 && <> + {summary.unmatched} unmatched</>}
              {summary?.alreadyInBox > 0 && <> · {summary.alreadyInBox} updated</>}
              {summary?.doubleSale > 0 && <> · {summary.doubleSale} flagged</>}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
