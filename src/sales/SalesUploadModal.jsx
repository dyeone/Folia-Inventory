import { useMemo, useState } from 'react';
import {
  X, Upload, AlertCircle, Check, FileText, ArrowLeft,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { parsePalmstreetOrdersDetailed, rowsOfWorkbookDetailed } from '../packing/parsePalmstreetOrders.js';
import { parseTikTokOrders } from '../packing/parseTikTokOrders.js';
import { boxPlatform } from '../packing/platform.js';
import { planValidation, summarizePlan, sameInstant } from './validatePlan.js';
import { normalizeSku } from '../labels/boxCode.js';
import { BoxesList, SummaryStat } from '../packing/PackingView.jsx';

// Validate Sales modal — global, not per-sale-event.
//
// Upload a Palmstreet orders file → every order line is planned against the
// whole inventory (validatePlan.js) → Update Inventory writes the plan.
//
// Every line of the file is KEPT — the operator's rule. A line becomes
// exactly one line in a box: a plant in stock marked sold, a line that's
// already in a box left in place (missing details filled in), a flagged
// double-sale line when its plant already went to another order, or a
// purple placeholder when nothing in inventory matches. Placeholders render
// purple in the Shipping tab; when a later upload finds the line's plant in
// stock (SKU fixed at source), the plant replaces the placeholder.
//
// Sale-event association is preserved automatically because items keep
// their `saleId` from when they were assigned to a lineup; this modal
// just updates them in place.
const norm = (s) => String(s || '').toLowerCase().trim();

// The lineup number in the orders file is the operator's own record: Export
// CSV wrote it into the listing title from the number on the pot's label, so
// the file says what the buyer saw and what the packer must find. For a
// Palmstreet plant being marked sold or topped up, that number is the truth.
// When the system carries a different one, something renumbered the plant
// after it was listed (the 2026-11-05 incident: a positional renumber moved
// every plant by one or two) — the upload puts the label's number back and
// the preview says so. TikTok "lineupIndex" is the product name used for SKU
// matching, not a lineup number, so it only ever fills a blank.
// Returns { from, to } when the stored number will change, else null.
function lineupFixFor(it, plan, isTikTok) {
  if (isTikTok || !it.lineupIndex || !plan?.item) return null;
  if (!['fresh', 'relink', 'topup'].includes(plan.kind)) return null;
  if (plan.item.lotKind === 'unmatched') return null;
  const stored = plan.item.lotNumber;
  if (stored == null || stored === '') return null;
  if (String(stored) === String(it.lineupIndex)) return null;
  return { from: String(stored), to: String(it.lineupIndex) };
}

// platform: 'palmstreet' (default) or 'tiktok'. Same pipeline end to end —
// only the parser, the merge scope (a TikTok order only ever merges into an
// open TikTok box, never a Palmstreet one for the same client, and vice
// versa), and the copy differ. TikTok box ids carry a `tt` prefix that marks
// them for life (badges, future merges).
export function SalesUploadModal({ items, sales = [], onApply, onClose, platform = 'palmstreet' }) {
  const isTikTok = platform === 'tiktok';
  const [fileName, setFileName] = useState('');
  const [boxes, setBoxes] = useState(null);
  const [skipped, setSkipped] = useState(null);   // what the parser left out, and why
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const handleFile = async (file) => {
    setErr('');
    setLoading(true);
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      // Every sheet, not just the first — an export split across tabs must
      // not lose its second tab.
      const { rows, repeated, sheets } = rowsOfWorkbookDetailed(XLSX, wb);
      let parsed, left = null;
      if (isTikTok) parsed = parseTikTokOrders(rows, items);
      else { const d = parsePalmstreetOrdersDetailed(rows); parsed = d.boxes; left = d.skipped; }
      // Lines the export repeats on its per-buyer tabs were read once.
      setSkipped(left ? { ...left, repeated, sheets } : (repeated ? { canceled: [], noAddress: [], blank: 0, repeated, sheets } : null));
      if (parsed.length === 0) {
        setErr(rows.length ? `No shippable items found in this file (${rows.length} rows read${left?.canceled?.length ? `, ${left.canceled.length} canceled` : ''}). Check the column names.` : 'That file has no rows.');
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

  // Plan every order line against the whole inventory (validatePlan.js):
  // each line lands on exactly one row and no row takes two lines.
  const resolved = useMemo(() => {
    if (!boxes) return null;
    return planValidation(boxes, items, { platform: isTikTok ? 'tiktok' : 'palmstreet', sales }).map(box => ({
      ...box,
      items: box.items.map(item => ({ ...item, lotFix: lineupFixFor(item, item.plan, isTikTok) })),
    }));
  }, [boxes, items, sales, isTikTok]);

  const summary = useMemo(() => {
    if (!resolved) return null;
    const s = summarizePlan(resolved);
    let renumbered = 0;
    const renumberExamples = [];
    for (const box of resolved) {
      for (const it of box.items) {
        if (!it.lotFix) continue;
        renumbered += 1;
        if (renumberExamples.length < 4) renumberExamples.push({ sku: it.plan.item.sku, ...it.lotFix });
      }
    }
    return { ...s, renumbered, renumberExamples };
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
      // (tt…) boxes, a Palmstreet upload only into Palmstreet ones. Same
      // client on both platforms = two separate boxes, by design. Nigel's
      // slip-imported boxes (ng…) are a third platform neither may touch.
      if (boxPlatform(item.shipmentBoxId) !== (isTikTok ? 'tiktok' : 'palmstreet')) continue;
      const addr = item.buyerAddress || {};
      const key = groupKeyFor(item.buyer, addr.street1, addr.city, addr.state, addr.zip);
      if (!m.has(key)) m.set(key, item.shipmentBoxId);
    }
    return m;
  }, [items, isTikTok]);

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
    const flagged = new Set();      // plants flagged double-sale in this batch
    const batchSkus = new Set();    // synthetic SKUs this batch inserts
    for (const box of resolved) {
      // If this buyer already has an OPEN box, new lines merge into it.
      // Otherwise use the fresh per-upload id from the parser.
      const groupKey = groupKeyFor(box.recipientName, box.street1, box.city, box.state, box.zip);
      const effectiveBoxId = openBoxIdByGroup.get(groupKey) || box.id;
      // New placeholder lines join the sale event of the box's first real
      // plant (cosmetic — the Shipping tab reads box.saleId off one item).
      const fallbackSaleId = box.items
        .map(i => i.plan?.item)
        .find(inv => inv && inv.lotKind !== 'unmatched' && inv.saleId)?.saleId || null;

      const buyerAddress = {
        street1: box.street1,
        street2: box.street2,
        city: box.city,
        state: box.state,
        zip: box.zip,
        country: box.country,
        shipmentMethod: box.shipmentMethod,
      };
      // A new line in this buyer's box that isn't a plant from inventory: a
      // placeholder, a flagged double-sale line, or the extra units of a
      // Quantity 2+ order. Synthetic SKUs name the order line, so a re-upload
      // finds the same row (and the server never lets one line's SKU take
      // another line's row — api/items.js settleSyntheticSkus).
      const newLine = (it, fields) => {
        batchSkus.add(normalizeSku(fields.sku));
        return {
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
          ...fields,
        };
      };
      // Per-item notes from the file. Each line carries its own ' · '-joined
      // "Seller: …" / "Buyer: …" string set by the parser, so two items in the
      // same buyer's box can have different notes.
      for (const it of box.items) {
        const p = it.plan;
        const inv = p.item;
        let plantBox = null;   // where the line's real plant ends up (extra units go there too)

        if (p.kind === 'same_shipment') {
          // Already shipped — this line IS that shipped row. Left as it is.
        } else if (p.kind === 'topup') {
          // Already in an OPEN box as this line. Never duplicate it or move it
          // between boxes — but DO top up data an earlier import didn't
          // capture (order date + shipping fee), realign soldAt to the order
          // date, and fill buyer / price / notes only when missing so a manual
          // correction is never clobbered. status and shipmentBoxId are left
          // alone — re-validating must not revert a box or shuffle placement.
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
          // Lineup number: fills a blank on any platform; on Palmstreet the
          // file's number also corrects a drifted one (see lineupFixFor).
          if (it.lineupIndex && (!inv.lotNumber || it.lotFix)) patch.lotNumber = it.lineupIndex;
          // Only enqueue a write if something actually changed.
          if (Object.keys(patch).length > 1) updates.push(patch);
          plantBox = inv.shipmentBoxId;
        } else if (p.kind === 'fresh' || p.kind === 'relink') {
          // A plant in stock: marked sold. Fresh → into this buyer's box;
          // relink → it takes the place of this line's placeholder, in the
          // placeholder's box and state (shipped stays shipped), and the
          // placeholder goes to the trash.
          const ph = p.kind === 'relink' ? p.replaces : null;
          const finalPrice = it.price > 0 ? it.price : parseFloat(inv.listingPrice) || 0;
          const targetBox = ph ? ph.shipmentBoxId : effectiveBoxId;
          // Profit / margin are computed at display time from salePrice
          // and grossCost; nothing to persist beyond the sale price itself.
          updates.push({
            id: inv.id,
            status: ph ? ph.status : 'sold',
            salePrice: finalPrice,
            // Sold time is when the buyer actually ordered (from the
            // Palmstreet "Order Date" column), not when we ran this import.
            // Falls back to now if the row had no parseable date.
            soldAt: it.orderDate || ph?.soldAt || now,
            buyer: box.recipientName || ph?.buyer || null,
            buyerUsername: box.username || ph?.buyerUsername || null,
            buyerAddress: ph?.buyerAddress || buyerAddress,
            shipmentBoxId: targetBox,
            shipmentCarrier: ph?.shipmentCarrier || box.carrier || 'usps',
            orderId: it.orderNumber || ph?.orderId || null,
            orderDate: it.orderDate || ph?.orderDate || null,
            orderShippingFee: it.orderShippingFee ?? ph?.orderShippingFee ?? null,
            notes: it.notes || ph?.notes || null,
            ...(ph ? { packedAt: ph.packedAt ?? null, shippedAt: ph.shippedAt ?? null } : {}),
            // A partial refund recorded against the placeholder moves with it.
            ...(ph && Number(ph.refundedAmount) > 0 ? { refundedAmount: ph.refundedAmount, refundedAt: ph.refundedAt ?? null } : {}),
            ...(ph && !inv.saleId && ph.saleId ? { saleId: ph.saleId } : {}),
            // The lineup number the order title carries ("<#> <name>") is what
            // the label and the listing said when the plant sold. It fills a
            // blank on any platform; on Palmstreet it also wins over a stored
            // number that drifted (it.lotFix) — the file is the operator's
            // record, the system never changes a number on its own.
            ...(it.lineupIndex && (!inv.lotNumber || it.lotFix) ? { lotNumber: it.lineupIndex } : {}),
          });
          if (ph) updates.push({ id: ph.id, deletedAt: now });
          plantBox = targetBox;
        } else if (p.kind === 'double_sale') {
          // The plant already went to another order (or an earlier line of
          // this file took it): the line is still kept — a flagged second-sale
          // line in this buyer's box — and the plant's row is flagged too, so
          // the operator picks the right plant. The DBL-<sku>-<order> SKU
          // keeps re-uploads landing on the same line.
          if (supportsReviewFlag && inv.reviewFlag !== 'double_sale' && !flagged.has(inv.id)) {
            updates.push({ id: inv.id, reviewFlag: 'double_sale' });
          }
          flagged.add(inv.id);
          const base = `DBL-${normalizeSku(inv.sku)}-${norm(it.orderNumber) || it.rowKey}`;
          let dupSku = (p.nth > 1 ? `${base}-${p.nth}` : base).slice(0, 80);
          for (let n = 2; batchSkus.has(normalizeSku(dupSku)); n += 1) dupSku = `${base}-${n}`.slice(0, 80);
          const where = (inv.status === 'shipped' || inv.status === 'delivered') ? 'already shipped' : 'already sold';
          const other = p.rival?.buyer || inv.buyer;
          const line = newLine(it, {
            sku: dupSku,
            type: inv.type === 'tc' ? 'tc' : 'plant',
            name: (it.title || inv.name || 'Item').slice(0, 200),
            variety: inv.variety || null,
            notes: `⚠ Possible double-sale of SKU ${inv.sku} (${where}${other ? ` to ${other}` : ''}${!p.rival && inv.shipmentBoxId ? ` in box ${inv.shipmentBoxId}` : ''}). ${it.notes || ''}`.trim().slice(0, 500),
          });
          if (supportsReviewFlag) line.reviewFlag = 'double_sale';
          updates.push(line);
        } else {
          // Nothing in inventory matches — a placeholder line so the box stays
          // whole in the Shipping tab (purple). No `id`, so api.upsertItems
          // takes the INSERT path and the server assigns one.
          updates.push(newLine(it, { sku: p.placeholderSku }));
        }

        // Quantity 2+ on one plant's line: the plant is one unit; the other
        // units go in the same box as one placeholder line. Price and
        // shipping fee stay on the plant's line — counted once. Replacing a
        // placeholder, the line takes its state: those units already sat in
        // that box (packed, or shipped).
        if (p.extra && !p.extra.row && plantBox) {
          const ph = p.kind === 'relink' ? p.replaces : null;
          updates.push(newLine(it, {
            sku: p.extraSku,
            quantity: p.extra.units,
            salePrice: 0,
            orderShippingFee: null,
            shipmentBoxId: plantBox,
            lotNumber: null,
            ...(ph ? { status: ph.status, packedAt: ph.packedAt ?? null, shippedAt: ph.shippedAt ?? null } : {}),
            notes: (ph
              ? `Qty ${it.quantity} ordered — SKU ${inv.sku} is one plant; the other ${p.extra.units} were already in this box on the placeholder line.${it.notes ? ` ${it.notes}` : ''}`
              : `Qty ${it.quantity} ordered — SKU ${inv.sku} is one plant: pick ${p.extra.units} more for this order.${it.notes ? ` ${it.notes}` : ''}`).slice(0, 500),
          }));
        }
      }
    }
    if (updates.length === 0) {
      setErr('Nothing to change — every line in this file is already in a box.');
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
                : 'Match each Palmstreet order to inventory by exact SKU — or, when a listing was typed without one, by the lineup number on the pot\'s label — and every line of the file is kept. New lines for a buyer with an open box merge into it; a line already in a box is updated in place (order date, shipping fee, the lineup number from the title, missing details) without duplicating or moving it. A plant bought twice is kept on both lines, flagged.'}
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
                  <li><em>Every line of the file is kept</em> — each one ends up as its own line in a buyer's box</li>
                  <li>Matches each order row against the full inventory by <em>exact SKU</em> (case-insensitive), including a SKU typed straight onto the name</li>
                  <li>A listing typed without a SKU ("553 rose belle") is matched by its <em>lineup number</em>: the plant with that number from the most recent show before the order</li>
                  <li>Marks matched items <em>sold</em> with the buyer's price, order date, shipping fee, order ID, and address</li>
                  <li>Re-uploading is safe: lines already in a box keep their place but get <em>topped up</em> with order date, shipping fee, and anything that was missing</li>
                  <li>A plant already sold to another order (or bought twice in this file) is added as a <em>flagged double-sale line</em> — never dropped</li>
                  <li>Unmatched rows flow to the Shipping tab as <em>placeholder</em> items (purple); once the SKU is fixed at source, a re-upload puts the real plant in their place</li>
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
                  onClick={() => { setBoxes(null); setSkipped(null); setFileName(''); }}
                  className="text-xs text-gray-600 hover:text-gray-900 flex items-center gap-1"
                >
                  <ArrowLeft className="w-3 h-3" /> Different file
                </button>
              </div>
              {skipped && (skipped.canceled.length > 0 || skipped.noAddress.length > 0 || skipped.repeated > 0) && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 space-y-1">
                  {skipped.repeated > 0 && (
                    <div><b>{skipped.repeated} line{skipped.repeated === 1 ? '' : 's'} repeated on other tabs</b> of this workbook ({skipped.sheets} tabs) were read once.</div>
                  )}
                  {skipped.canceled.length > 0 && (
                    <div><b>{skipped.canceled.length} canceled order line{skipped.canceled.length === 1 ? '' : 's'}</b> left out: {skipped.canceled.slice(0, 6).map((c) => c.orderNumber || c.username || '?').join(', ')}{skipped.canceled.length > 6 ? '…' : ''}</div>
                  )}
                  {skipped.noAddress.length > 0 && (
                    <div><b>{skipped.noAddress.length} line{skipped.noAddress.length === 1 ? '' : 's'} with no shipping address</b> — kept as a box under the buyer's name, flagged in Shipping: {skipped.noAddress.slice(0, 6).map((c) => c.orderNumber || c.username || '?').join(', ')}{skipped.noAddress.length > 6 ? '…' : ''}</div>
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <SummaryStat label="Boxes" value={resolved.length} tone="emerald" />
                <SummaryStat
                  label="Will mark sold"
                  value={summary.matched}
                  sub={summary.relinked > 0 ? `${summary.relinked} replace a placeholder` : null}
                  tone={summary.matched > 0 ? 'blue' : 'gray'}
                />
                <SummaryStat
                  label="Already in a box"
                  value={summary.alreadyInBox}
                  sub={summary.alreadyInBox > 0 ? 'kept · details filled' : null}
                  tone="gray"
                />
                <SummaryStat
                  label="Already shipped"
                  value={summary.sameShipment}
                  sub={summary.sameShipment > 0 ? 'kept as is' : null}
                  tone="gray"
                />
                <SummaryStat
                  label="Placeholders"
                  value={summary.unmatched}
                  sub={summary.unmatched > 0 ? 'no SKU match · added' : null}
                  tone={summary.unmatched > 0 ? 'amber' : 'gray'}
                />
                <SummaryStat
                  label="⚠ Double-sale"
                  value={summary.doubleSale}
                  sub={summary.doubleSale > 0 ? 'added · flagged' : null}
                  tone={summary.doubleSale > 0 ? 'red' : 'gray'}
                />
              </div>

              {/* The operator's rule: every line of the file is kept. The plan
                  gives each line exactly one row, so this always adds up — it
                  is shown so the count can be checked against the sheet. */}
              <div className="flex items-start gap-2 bg-emerald-50 border border-emerald-200 text-emerald-900 text-sm px-3 py-2 rounded-lg">
                <Check className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>
                  <span className="font-medium">All {summary.kept} of {summary.totalItems} order line{summary.totalItems === 1 ? '' : 's'} are kept</span>
                  {' '}— {summary.matched + summary.unmatched + summary.doubleSale} go into boxes now
                  {summary.alreadyInBox + summary.sameShipment > 0 && <>, {summary.alreadyInBox + summary.sameShipment} {summary.alreadyInBox + summary.sameShipment === 1 ? 'is' : 'are'} already in a box</>}.
                  {summary.extraLines > 0 && <> {summary.extraLines} line{summary.extraLines === 1 ? '' : 's'} ordered more than one of a plant: {summary.extraUnits} extra unit{summary.extraUnits === 1 ? '' : 's'} added as placeholder lines in the same box.</>}
                </span>
              </div>

              {summary.doubleSale > 0 && (
                <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-800 text-sm px-3 py-2 rounded-lg">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>
                    <span className="font-medium">{summary.doubleSale} possible double-sale{summary.doubleSale === 1 ? '' : 's'}.</span>{' '}
                    These plants are already in a box for a different order, or two lines of this file name the same SKU. Each line is still kept: it&apos;s added to its buyer&apos;s box as a flagged line, and the plant already sold is flagged too — pick the right plant in the Shipping tab.
                  </span>
                </div>
              )}

              {summary.relinked > 0 && (
                <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 text-blue-900 text-sm px-3 py-2 rounded-lg">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>
                    <span className="font-medium">{summary.relinked} placeholder line{summary.relinked === 1 ? '' : 's'} from an earlier upload now match{summary.relinked === 1 ? 'es' : ''} a plant in stock.</span>{' '}
                    The plant takes the placeholder&apos;s place in its box — marked shipped if that box already shipped — so inventory stops showing it as available.
                  </span>
                </div>
              )}

              {summary.renumbered > 0 && (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-900 text-sm px-3 py-2 rounded-lg">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>
                    <span className="font-medium">{summary.renumbered} plant{summary.renumbered === 1 ? ' carries' : 's carry'} a different lineup number in the system than in this file.</span>{' '}
                    The file&apos;s number is what the label and the listing said, so it is written back:{' '}
                    {summary.renumberExamples.map(e => `${e.sku} ${e.from} → ${e.to}`).join(', ')}{summary.renumbered > summary.renumberExamples.length ? ', …' : ''}.
                    {' '}A difference means something renumbered the plant after it was listed — check the Pre Sale list.
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
              {summary?.unmatched > 0 && <> + {summary.unmatched} placeholder{summary.unmatched === 1 ? '' : 's'}</>}
              {summary?.alreadyInBox > 0 && <> · {summary.alreadyInBox} updated</>}
              {summary?.doubleSale > 0 && <> · {summary.doubleSale} flagged</>}
              {summary?.renumbered > 0 && <> · {summary.renumbered} number{summary.renumbered === 1 ? '' : 's'} fixed</>}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
