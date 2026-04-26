import { useMemo, useState } from 'react';
import {
  X, Upload, AlertCircle, Check, FileText, ArrowLeft,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { parsePalmstreetOrders } from '../packing/parsePalmstreetOrders.js';
import { matchInventory } from '../packing/matchInventory.js';
import { BoxesList, InventoryPicker, SummaryStat } from '../packing/PackingView.jsx';

// Step 3 of the sale-event lifecycle: upload the Palmstreet sales report,
// match each row to a lineup item, then mark items sold and create the
// shipment box assignment that the Packing tab will later draw on.
export function SalesUploadModal({ sale, items, onApply, onClose }) {
  const saleItems = useMemo(
    () => items.filter(i => i.saleId === sale.id),
    [items, sale.id]
  );

  const [fileName, setFileName] = useState('');
  const [boxes, setBoxes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [overrides, setOverrides] = useState({}); // `${boxId}::${rowKey}` → invItemId | null
  const [pickerFor, setPickerFor] = useState(null);

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

  // For each box item, resolve the inventory match. Lineup items are
  // tried first (so a name collision between sales doesn't pull in the
  // wrong SKU), then the global inventory as a fallback.
  const resolved = useMemo(() => {
    if (!boxes) return null;
    return boxes.map(box => ({
      ...box,
      items: box.items.map(item => {
        const key = `${box.id}::${item.rowKey}`;
        const override = overrides[key];
        let match = null;
        if (override === null) {
          match = null;
        } else if (override) {
          const inv = items.find(i => i.id === override);
          match = inv ? { item: inv, confidence: 'manual' } : null;
        } else {
          match = matchInventory(item, saleItems) || matchInventory(item, items);
        }
        return { ...item, match, manual: override !== undefined };
      }),
    }));
  }, [boxes, overrides, saleItems, items]);

  const summary = useMemo(() => {
    if (!resolved) return null;
    let totalItems = 0, matched = 0, unmatched = 0;
    for (const box of resolved) {
      for (const it of box.items) {
        totalItems += 1;
        if (it.match?.item) matched += 1;
        else unmatched += 1;
      }
    }
    return { totalItems, matched, unmatched };
  }, [resolved]);

  const handleApply = () => {
    if (!resolved) return;
    const updates = [];
    const now = new Date().toISOString();
    for (const box of resolved) {
      for (const it of box.items) {
        if (!it.match?.item) continue;
        const inv = it.match.item;
        const finalPrice = it.price > 0 ? it.price : parseFloat(inv.listingPrice) || 0;
        const cost = parseFloat(inv.grossCost ?? inv.cost) || 0;
        updates.push({
          id: inv.id,
          status: 'sold',
          salePrice: finalPrice,
          soldAt: now,
          buyer: box.recipientName,
          buyerUsername: box.username,
          buyerAddress: {
            street1: box.street1,
            street2: box.street2,
            city: box.city,
            state: box.state,
            zip: box.zip,
            country: box.country,
            shipmentMethod: box.shipmentMethod,
          },
          shipmentBoxId: box.id,
          orderId: it.orderNumber || null,
          orderDate: it.orderDate || null,
          actualProfit: cost > 0 ? finalPrice - cost : null,
          actualProfitRate: cost > 0 ? ((finalPrice - cost) / cost) * 100 : null,
        });
      }
    }
    if (updates.length === 0) {
      alert('No matched items to apply. Link items first or pick a different file.');
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
              Upload Sales Report · <span className="truncate">{sale.name}</span>
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Step 3 · Marks lineup items sold, captures buyer / order details
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
                  <li>Matches each order row against this sale's lineup ({saleItems.length} items)</li>
                  <li>Marks matched items <em>sold</em> with the buyer's price, order ID, and address</li>
                  <li>Groups items by buyer so the Packing tab can ship them</li>
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
                  onClick={() => { setBoxes(null); setFileName(''); setOverrides({}); }}
                  className="text-xs text-gray-600 hover:text-gray-900 flex items-center gap-1"
                >
                  <ArrowLeft className="w-3 h-3" /> Different file
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <SummaryStat label="Boxes" value={resolved.length} tone="emerald" />
                <SummaryStat
                  label="Will mark sold"
                  value={summary.matched}
                  tone={summary.matched > 0 ? 'blue' : 'gray'}
                />
                <SummaryStat
                  label="Unmatched"
                  value={summary.unmatched}
                  tone={summary.unmatched > 0 ? 'amber' : 'gray'}
                />
              </div>

              <BoxesList
                boxes={resolved}
                onPick={(boxId, rowKey, title) => setPickerFor({ boxId, rowKey, title })}
                onClearOverride={(boxId, rowKey) => {
                  const key = `${boxId}::${rowKey}`;
                  setOverrides(prev => ({ ...prev, [key]: null }));
                }}
              />
            </>
          )}
        </div>

        {boxes && (
          <div className="border-t border-gray-200 px-4 sm:px-5 py-3 flex justify-end gap-2 flex-shrink-0 bg-white">
            <button onClick={onClose} className="px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-100 active:bg-gray-200 rounded-lg">
              Cancel
            </button>
            <button
              onClick={handleApply}
              disabled={!summary || summary.matched === 0}
              className="px-5 py-2.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 disabled:bg-gray-300 text-white rounded-lg flex items-center gap-1.5"
            >
              <Check className="w-4 h-4" /> Apply &amp; mark {summary?.matched || 0} sold
            </button>
          </div>
        )}

        {pickerFor && (
          <InventoryPicker
            title={pickerFor.title}
            inventoryItems={items}
            preferredItems={saleItems}
            onPick={(invId) => {
              const key = `${pickerFor.boxId}::${pickerFor.rowKey}`;
              setOverrides(prev => ({ ...prev, [key]: invId }));
              setPickerFor(null);
            }}
            onClose={() => setPickerFor(null)}
          />
        )}
      </div>
    </div>
  );
}
