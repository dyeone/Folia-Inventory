import { useMemo, useState } from 'react';
import {
  X, Upload, AlertCircle, Check, FileText, ArrowLeft,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { parsePalmstreetOrders } from '../packing/parsePalmstreetOrders.js';
import { matchInventory } from '../packing/matchInventory.js';
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
export function SalesUploadModal({ items, onApply, onClose }) {
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
      const parsed = parsePalmstreetOrders(rows);
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
      items: box.items.map(item => ({
        ...item,
        match: matchInventory(item, items),
      })),
    }));
  }, [boxes, items]);

  const summary = useMemo(() => {
    if (!resolved) return null;
    let totalItems = 0, matched = 0, alreadyInBox = 0, unmatched = 0;
    for (const box of resolved) {
      for (const it of box.items) {
        totalItems += 1;
        if (it.match?.alreadyInBox) alreadyInBox += 1;
        else if (it.match?.item) matched += 1;
        else unmatched += 1;
      }
    }
    return { totalItems, matched, alreadyInBox, unmatched };
  }, [resolved]);

  const handleApply = () => {
    if (!resolved) return;
    const updates = [];
    const now = new Date().toISOString();
    for (const box of resolved) {
      // Every upload gets its own fresh shipmentBoxId from
      // parsePalmstreetOrders (the per-upload nonce). We never merge
      // into an existing box: actively-packed work shouldn't be
      // disrupted, and shipped history shouldn't absorb new orders.
      // Items whose SKU is already in another box are skipped below
      // (it.match.alreadyInBox), so the new box only ever contains
      // genuinely-new lines.
      const effectiveBoxId = box.id;
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

      for (const it of box.items) {
        if (it.match?.alreadyInBox) {
          // Inventory row already lives in another box (open or
          // shipped). Skip entirely — no new placeholder, no
          // duplicate. The preview's "already in a box" count tells
          // the operator how many lines were dropped this way.
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
            soldAt: now,
            buyer: box.recipientName,
            buyerUsername: box.username,
            buyerAddress,
            shipmentBoxId: effectiveBoxId,
            shipmentCarrier: box.carrier || 'usps',
            orderId: it.orderNumber || null,
            orderDate: it.orderDate || null,
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
            saleId: fallbackSaleId,
            salePrice: it.price > 0 ? it.price : 0,
            soldAt: now,
            buyer: box.recipientName,
            buyerUsername: box.username,
            buyerAddress,
            shipmentBoxId: effectiveBoxId,
            shipmentCarrier: box.carrier || 'usps',
            orderId: it.orderNumber || null,
            orderDate: it.orderDate || null,
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
              Validate Sales
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Match each Palmstreet order to inventory by exact SKU. Lines whose SKU is already in another box (open or shipped) are skipped — no merges, no duplicates.
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
                    {loading ? 'Reading file...' : 'Upload Palmstreet sales report'}
                  </div>
                  <div className="text-sm text-gray-500 mt-1">.xlsx, .xls or .csv</div>
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
                  <li>Marks matched items <em>sold</em> with the buyer's price, order ID, and address</li>
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

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <SummaryStat label="Boxes" value={resolved.length} tone="emerald" />
                <SummaryStat
                  label="Will mark sold"
                  value={summary.matched}
                  tone={summary.matched > 0 ? 'blue' : 'gray'}
                />
                <SummaryStat
                  label="Already in a box"
                  value={summary.alreadyInBox}
                  tone={summary.alreadyInBox > 0 ? 'gray' : 'gray'}
                />
                <SummaryStat
                  label="Unmatched"
                  value={summary.unmatched}
                  tone={summary.unmatched > 0 ? 'amber' : 'gray'}
                />
              </div>

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
              {summary?.alreadyInBox > 0 && <> · {summary.alreadyInBox} skipped</>}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
