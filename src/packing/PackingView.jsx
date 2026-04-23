import { useState, useMemo, useEffect } from 'react';
import {
  Upload, Package, MapPin, AlertCircle, X, ChevronDown, ChevronRight,
  Check, Link2, Truck, FileText, Box, ArrowLeft, PackageCheck, PackageOpen,
  Send,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { parsePalmstreetOrders } from './parsePalmstreetOrders.js';
import { matchInventory } from './matchInventory.js';

export function PackingView({ inventoryItems, sales, onApplyOrders, onShipBox }) {
  const [activeSaleId, setActiveSaleId] = useState(null);

  const pendingSales = useMemo(
    () => sales.filter(s => s.status === 'packing'),
    [sales]
  );

  const activeSale = pendingSales.find(s => s.id === activeSaleId)
    || sales.find(s => s.id === activeSaleId);

  if (activeSale) {
    return (
      <SalePackingPane
        sale={activeSale}
        inventoryItems={inventoryItems}
        onBack={() => setActiveSaleId(null)}
        onApplyOrders={(updates) => onApplyOrders(activeSale.id, updates)}
        onShipBox={(itemIds) => onShipBox(activeSale.id, itemIds)}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <Package className="w-5 h-5 text-emerald-600" /> Packing
        </h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Sale events that have been sent to packing show up here. Upload the Palmstreet
          orders file to mark items sold and assemble shipping boxes.
        </p>
      </div>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-gray-700">
          Pending sale events ({pendingSales.length})
        </h3>
        {pendingSales.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-xl p-8 text-center">
            <PackageOpen className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-500">
              No sale events pending. Click "Send to Packing" on a sale event to start packing.
            </p>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {pendingSales.map(sale => (
              <SalePendingCard
                key={sale.id}
                sale={sale}
                inventoryItems={inventoryItems}
                onOpen={() => setActiveSaleId(sale.id)}
              />
            ))}
          </div>
        )}
      </section>

      <StandaloneUploader inventoryItems={inventoryItems} />
    </div>
  );
}

function SalePendingCard({ sale, inventoryItems, onOpen }) {
  const saleLots = inventoryItems.filter(i => i.saleId === sale.id && i.lotKind !== 'giveaway');
  const giveaways = inventoryItems.filter(i => i.saleId === sale.id && i.lotKind === 'giveaway');
  const sold = saleLots.filter(i => ['sold', 'shipped', 'delivered'].includes(i.status));
  const shipped = saleLots.filter(i => ['shipped', 'delivered'].includes(i.status));
  const hasUpload = saleLots.some(i => i.shipmentBoxId);

  return (
    <button
      onClick={onOpen}
      className="text-left bg-white border border-gray-200 rounded-xl p-4 hover:border-emerald-400 hover:shadow-sm active:bg-gray-50 transition"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-gray-900 truncate">{sale.name}</div>
          <div className="text-xs text-gray-500">{sale.date}</div>
        </div>
        <span className={`text-xs px-2 py-1 rounded-full whitespace-nowrap font-medium ${
          hasUpload ? 'bg-blue-100 text-blue-800' : 'bg-amber-100 text-amber-800'
        }`}>
          {hasUpload ? `${shipped.length}/${saleLots.length} shipped` : 'Awaiting upload'}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <Mini label="Lots" value={saleLots.length} />
        <Mini label="Giveaways" value={giveaways.length} />
        <Mini label="Sold" value={sold.length} />
      </div>
    </button>
  );
}

function Mini({ label, value }) {
  return (
    <div className="bg-gray-50 rounded p-2">
      <div className="text-gray-500">{label}</div>
      <div className="font-semibold text-gray-900">{value}</div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Per-sale packing pane: shows the upload prompt OR the assembled boxes
// (derived from items once the upload has been applied).
// ───────────────────────────────────────────────────────────────────────────

function SalePackingPane({ sale, inventoryItems, onBack, onApplyOrders, onShipBox }) {
  const saleItems = useMemo(
    () => inventoryItems.filter(i => i.saleId === sale.id),
    [inventoryItems, sale.id]
  );

  // If any item has a shipmentBoxId, the upload was already applied.
  const hasApplied = saleItems.some(i => i.shipmentBoxId);

  if (!hasApplied) {
    return (
      <PackingUploadPane
        sale={sale}
        saleItems={saleItems}
        inventoryItems={inventoryItems}
        onBack={onBack}
        onApply={onApplyOrders}
      />
    );
  }
  return (
    <PackingBoxesPane
      sale={sale}
      saleItems={saleItems}
      onBack={onBack}
      onShipBox={onShipBox}
    />
  );
}

// ───── Upload phase ────────────────────────────────────────────────────────

function PackingUploadPane({ sale, saleItems, inventoryItems, onBack, onApply }) {
  const [fileName, setFileName] = useState('');
  const [boxes, setBoxes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [overrides, setOverrides] = useState({}); // `${boxId}::${rowKey}` → invItemId | null
  const [pickerFor, setPickerFor] = useState(null);

  // Match candidates: prefer this sale's lineup. If a row doesn't match
  // anything in the lineup, fall back to all inventory.
  const lineupItems = saleItems;

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
          const inv = inventoryItems.find(i => i.id === override);
          match = inv ? { item: inv, confidence: 'manual' } : null;
        } else {
          match = matchInventory(item, lineupItems) || matchInventory(item, inventoryItems);
        }
        return { ...item, match, manual: override !== undefined };
      }),
    }));
  }, [boxes, overrides, lineupItems, inventoryItems]);

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
      alert('No matched items to apply. Link items first.');
      return;
    }
    onApply(updates);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="p-2 -ml-2 text-gray-600 hover:bg-gray-100 active:bg-gray-200 rounded-lg" aria-label="Back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{sale.name}</h2>
          <p className="text-xs text-gray-500">
            {saleItems.length} lineup items · {sale.date}
          </p>
        </div>
      </div>

      {!boxes ? (
        <>
          <label className="block">
            <div className="border-2 border-dashed border-gray-300 rounded-xl p-12 sm:p-16 text-center hover:border-emerald-400 hover:bg-emerald-50/50 active:bg-emerald-50 cursor-pointer transition">
              <Upload className="w-10 h-10 text-gray-400 mx-auto mb-3" />
              <div className="text-base font-medium text-gray-900">
                {loading ? 'Reading file...' : 'Upload Palmstreet orders file'}
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
            <div className="flex items-start gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {err}
            </div>
          )}
          <div className="text-xs text-gray-600 bg-gray-50 rounded-lg p-3">
            <div className="font-medium text-gray-900 mb-1">What this does:</div>
            <ul className="space-y-0.5 list-disc list-inside">
              <li>Matches each order row against the sale's lineup (then full inventory as fallback)</li>
              <li>Marks matched items as <em>sold</em> with the buyer's price, name, and address</li>
              <li>Groups items into boxes by recipient — one box per buyer</li>
            </ul>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <div className="text-sm">
              <span className="text-gray-500">File:</span>{' '}
              <span className="font-medium text-gray-900">{fileName}</span>
              <span className="text-gray-500"> · {summary.totalItems} items</span>
            </div>
            <button
              onClick={() => { setBoxes(null); setFileName(''); setOverrides({}); }}
              className="text-xs text-gray-600 hover:text-gray-900"
            >
              Choose different file
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
            mode="preview"
            onPick={(boxId, rowKey, title) => setPickerFor({ boxId, rowKey, title })}
            onClearOverride={(boxId, rowKey) => {
              const key = `${boxId}::${rowKey}`;
              setOverrides(prev => ({ ...prev, [key]: null }));
            }}
          />

          <div className="sticky bottom-0 bg-white border-t border-gray-200 -mx-4 px-4 py-3 flex justify-end gap-2">
            <button onClick={() => { setBoxes(null); setFileName(''); }} className="px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-100 active:bg-gray-200 rounded-lg">
              Cancel
            </button>
            <button
              onClick={handleApply}
              disabled={summary.matched === 0}
              className="px-5 py-2.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 disabled:bg-gray-300 text-white rounded-lg flex items-center gap-1.5"
            >
              <Check className="w-4 h-4" /> Apply &amp; mark {summary.matched} sold
            </button>
          </div>

          {pickerFor && (
            <InventoryPicker
              title={pickerFor.title}
              inventoryItems={inventoryItems}
              preferredItems={lineupItems}
              onPick={(invId) => {
                const key = `${pickerFor.boxId}::${pickerFor.rowKey}`;
                setOverrides(prev => ({ ...prev, [key]: invId }));
                setPickerFor(null);
              }}
              onClose={() => setPickerFor(null)}
            />
          )}
        </>
      )}
    </div>
  );
}

// ───── Boxes phase (after apply) ───────────────────────────────────────────

function PackingBoxesPane({ sale, saleItems, onBack, onShipBox }) {
  // Group sold items by shipmentBoxId. Each group is a "box".
  const boxes = useMemo(() => {
    const map = new Map();
    for (const item of saleItems) {
      if (!item.shipmentBoxId) continue;
      if (!map.has(item.shipmentBoxId)) {
        map.set(item.shipmentBoxId, {
          id: item.shipmentBoxId,
          recipientName: item.buyer || '(unknown)',
          username: item.buyerUsername || '',
          address: item.buyerAddress || {},
          items: [],
        });
      }
      map.get(item.shipmentBoxId).items.push(item);
    }
    return [...map.values()].sort((a, b) =>
      (a.recipientName || '').localeCompare(b.recipientName || '')
    );
  }, [saleItems]);

  const totalBoxes = boxes.length;
  const shippedBoxes = boxes.filter(b =>
    b.items.every(i => ['shipped', 'delivered'].includes(i.status))
  ).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="p-2 -ml-2 text-gray-600 hover:bg-gray-100 active:bg-gray-200 rounded-lg" aria-label="Back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-gray-900">{sale.name}</h2>
          <p className="text-xs text-gray-500">
            {shippedBoxes}/{totalBoxes} boxes shipped · {sale.date}
          </p>
        </div>
        <span className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded">
          Orders applied
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <SummaryStat label="Total boxes" value={totalBoxes} tone="blue" />
        <SummaryStat
          label="Shipped"
          value={shippedBoxes}
          tone={shippedBoxes === totalBoxes && totalBoxes > 0 ? 'emerald' : 'gray'}
        />
        <SummaryStat label="Outstanding" value={totalBoxes - shippedBoxes} tone="amber" />
      </div>

      <div className="space-y-3">
        {boxes.map(box => (
          <ShipBoxCard
            key={box.id}
            box={box}
            onShip={() => onShipBox(box.items.map(i => i.id))}
          />
        ))}
      </div>
    </div>
  );
}

function ShipBoxCard({ box, onShip }) {
  const [open, setOpen] = useState(true);
  const allShipped = box.items.every(i => ['shipped', 'delivered'].includes(i.status));
  const a = box.address || {};
  const addressLine = [
    a.street1,
    a.street2,
    [a.city, a.state, a.zip].filter(Boolean).join(', '),
    a.country && a.country !== 'US' ? a.country : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className={`bg-white border rounded-xl overflow-hidden ${
      allShipped ? 'border-emerald-300' : 'border-gray-200'
    }`}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-start gap-3 px-4 py-3 hover:bg-gray-50 text-left"
      >
        <div className="mt-0.5 text-gray-400">
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-gray-900">{box.recipientName}</span>
            {box.username && <span className="text-xs text-gray-500">@{box.username}</span>}
            {a.shipmentMethod && (
              <span className="inline-flex items-center gap-1 text-[11px] text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">
                <Truck className="w-3 h-3" /> {a.shipmentMethod}
              </span>
            )}
            {allShipped && (
              <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200">
                <PackageCheck className="w-3 h-3" /> Shipped
              </span>
            )}
          </div>
          {addressLine && (
            <div className="text-xs text-gray-500 mt-0.5 flex items-start gap-1">
              <MapPin className="w-3 h-3 mt-0.5 flex-shrink-0" />
              <span>{addressLine}</span>
            </div>
          )}
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-sm font-medium text-gray-900">
            {box.items.length} {box.items.length === 1 ? 'item' : 'items'}
          </div>
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-100">
          <div className="divide-y divide-gray-100">
            {box.items.map(item => (
              <div key={item.id} className="px-4 py-2.5 flex items-start gap-3">
                <Box className="w-3.5 h-3.5 text-gray-400 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-900 truncate">
                    {item.name}{item.variety ? ` · ${item.variety}` : ''}
                  </div>
                  <div className="text-xs text-gray-500 font-mono">
                    {item.sku}
                    {item.lotNumber ? ` · Lot #${item.lotNumber}` : ''}
                    {item.salePrice ? ` · $${parseFloat(item.salePrice).toFixed(2)}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {!allShipped && (
            <div className="px-4 py-3 bg-gray-50 flex justify-end">
              <button
                onClick={onShip}
                className="flex items-center gap-1.5 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white text-sm font-medium rounded-lg"
              >
                <Send className="w-4 h-4" /> Mark Shipped
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ───── Standalone uploader (no sale linkage) ───────────────────────────────

function StandaloneUploader({ inventoryItems }) {
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState('');
  const [boxes, setBoxes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [overrides, setOverrides] = useState({});
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

  const resolved = useMemo(() => {
    if (!boxes) return null;
    return boxes.map(box => ({
      ...box,
      items: box.items.map(item => {
        const key = `${box.id}::${item.rowKey}`;
        const override = overrides[key];
        let match = null;
        if (override === null) match = null;
        else if (override) {
          const inv = inventoryItems.find(i => i.id === override);
          match = inv ? { item: inv, confidence: 'manual' } : null;
        } else {
          match = matchInventory(item, inventoryItems);
        }
        return { ...item, match, manual: override !== undefined };
      }),
    }));
  }, [boxes, overrides, inventoryItems]);

  return (
    <section className="space-y-2">
      <button
        onClick={() => setOpen(!open)}
        className="text-sm font-medium text-gray-700 hover:text-gray-900 flex items-center gap-1"
      >
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        Standalone upload (not linked to a sale event)
      </button>
      {open && (
        <div className="bg-gray-50 rounded-xl p-4 space-y-3">
          {!boxes ? (
            <>
              <label className="block">
                <div className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center hover:border-emerald-400 hover:bg-white active:bg-emerald-50 cursor-pointer transition">
                  <Upload className="w-7 h-7 text-gray-400 mx-auto mb-2" />
                  <div className="text-sm sm:text-base text-gray-900">
                    {loading ? 'Reading file...' : 'Upload a Palmstreet orders file'}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">Preview only — does not change inventory</div>
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={(e) => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }}
                    className="hidden"
                  />
                </div>
              </label>
              {err && (
                <div className="flex items-start gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {err}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div className="text-sm">
                  <FileText className="w-3 h-3 inline mr-1 text-gray-400" />
                  <span className="font-medium text-gray-900">{fileName}</span>
                  <span className="text-gray-500"> · {resolved.length} boxes</span>
                </div>
                <button
                  onClick={() => { setBoxes(null); setFileName(''); setOverrides({}); }}
                  className="text-xs text-gray-600 hover:text-gray-900"
                >
                  Reset
                </button>
              </div>
              <BoxesList
                boxes={resolved}
                mode="preview"
                onPick={(boxId, rowKey, title) => setPickerFor({ boxId, rowKey, title })}
                onClearOverride={(boxId, rowKey) => {
                  const key = `${boxId}::${rowKey}`;
                  setOverrides(prev => ({ ...prev, [key]: null }));
                }}
              />
            </>
          )}
          {pickerFor && (
            <InventoryPicker
              title={pickerFor.title}
              inventoryItems={inventoryItems}
              onPick={(invId) => {
                const key = `${pickerFor.boxId}::${pickerFor.rowKey}`;
                setOverrides(prev => ({ ...prev, [key]: invId }));
                setPickerFor(null);
              }}
              onClose={() => setPickerFor(null)}
            />
          )}
        </div>
      )}
    </section>
  );
}

// ───── Shared building blocks ──────────────────────────────────────────────

function BoxesList({ boxes, onPick, onClearOverride }) {
  const [collapsed, setCollapsed] = useState(() => new Set());
  return (
    <div className="space-y-3">
      {boxes.map(box => {
        const isCollapsed = collapsed.has(box.id);
        const matched = box.items.filter(i => i.match?.item).length;
        const a = box;
        return (
          <div key={box.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <button
              onClick={() => setCollapsed(prev => {
                const next = new Set(prev);
                if (next.has(box.id)) next.delete(box.id); else next.add(box.id);
                return next;
              })}
              className="w-full flex items-start gap-3 px-4 py-3 hover:bg-gray-50 text-left"
            >
              <div className="mt-0.5 text-gray-400">
                {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-gray-900">{box.recipientName}</span>
                  {box.username && <span className="text-xs text-gray-500">@{box.username}</span>}
                  {a.shipmentMethod && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">
                      <Truck className="w-3 h-3" /> {a.shipmentMethod}
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-500 mt-0.5 flex items-start gap-1">
                  <MapPin className="w-3 h-3 mt-0.5 flex-shrink-0" />
                  <span>
                    {[a.street1, a.street2, [a.city, a.state, a.zip].filter(Boolean).join(', ')]
                      .filter(Boolean).join(' · ')}
                  </span>
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-sm font-medium text-gray-900">
                  {box.items.length} {box.items.length === 1 ? 'item' : 'items'}
                </div>
                <div className={`text-xs ${matched === box.items.length ? 'text-emerald-600' : 'text-amber-600'}`}>
                  {matched}/{box.items.length} matched
                </div>
              </div>
            </button>

            {!isCollapsed && (
              <div className="border-t border-gray-100 divide-y divide-gray-100">
                {box.items.map(item => (
                  <BoxItemRow
                    key={item.rowKey}
                    item={item}
                    onPick={() => onPick(box.id, item.rowKey, item.title)}
                    onClear={() => onClearOverride(box.id, item.rowKey)}
                  />
                ))}
                {box.notes?.length > 0 && (
                  <div className="px-4 py-2 bg-amber-50 text-xs text-amber-900">
                    <span className="font-medium">Notes:</span> {box.notes.join(' · ')}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function BoxItemRow({ item, onPick, onClear }) {
  const match = item.match?.item;
  const confidence = item.match?.confidence;
  return (
    <div className="px-4 py-2.5 flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-900 truncate">{item.title}</div>
        <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-2 flex-wrap">
          <span>Qty {item.quantity}</span>
          <span>·</span>
          <span>${item.price.toFixed(2)}</span>
          {item.sku && <><span>·</span><span className="font-mono">SKU {item.sku}</span></>}
        </div>
        {match ? (
          <div className="mt-1.5 inline-flex items-center gap-1.5 text-xs bg-emerald-50 text-emerald-800 px-2 py-0.5 rounded border border-emerald-200">
            <Check className="w-3 h-3" />
            <span className="font-mono">{match.sku}</span>
            <span className="opacity-70">·</span>
            <span className="truncate max-w-[200px]">{match.name}{match.variety ? ` · ${match.variety}` : ''}</span>
            <span className="opacity-60 ml-1">({confidenceLabel(confidence)})</span>
          </div>
        ) : (
          <div className="mt-1.5 inline-flex items-center gap-1.5 text-xs bg-amber-50 text-amber-800 px-2 py-0.5 rounded border border-amber-200">
            <AlertCircle className="w-3 h-3" /> No inventory match
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 flex-shrink-0">
        <button
          onClick={onPick}
          className="text-xs px-3 py-1.5 text-gray-700 bg-white border border-gray-200 hover:bg-gray-100 active:bg-gray-200 rounded-lg inline-flex items-center gap-1 font-medium"
        >
          <Link2 className="w-3.5 h-3.5" /> {match ? 'Change' : 'Link'}
        </button>
        {item.manual && (
          <button onClick={onClear} className="text-xs px-2 py-1 text-gray-500 hover:text-gray-900">
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

function SummaryStat({ label, value, sub, tone }) {
  const tones = {
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-900',
    blue: 'bg-blue-50 border-blue-200 text-blue-900',
    amber: 'bg-amber-50 border-amber-200 text-amber-900',
    gray: 'bg-gray-50 border-gray-200 text-gray-900',
  };
  return (
    <div className={`border rounded-lg p-3 ${tones[tone] || tones.gray}`}>
      <div className="text-xs opacity-70">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
      {sub && <div className="text-[11px] opacity-70 mt-0.5">{sub}</div>}
    </div>
  );
}

function confidenceLabel(c) {
  if (c === 'sku') return 'SKU';
  if (c === 'lot') return 'lot #';
  if (c === 'fuzzy') return 'fuzzy';
  if (c === 'manual') return 'manual';
  return c;
}

function InventoryPicker({ title, inventoryItems, preferredItems, onPick, onClose }) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    const pool = inventoryItems
      .filter(i => i.status === 'available' || i.status === 'listed');
    const prefIds = new Set((preferredItems || []).map(i => i.id));
    const sorted = [...pool].sort((a, b) => {
      const ap = prefIds.has(a.id) ? 0 : 1;
      const bp = prefIds.has(b.id) ? 0 : 1;
      return ap - bp;
    });
    if (!query) return sorted.slice(0, 50);
    return sorted.filter(i => (
      i.sku?.toLowerCase().includes(query) ||
      i.name?.toLowerCase().includes(query) ||
      i.variety?.toLowerCase().includes(query) ||
      String(i.lotNumber || '').toLowerCase().includes(query)
    )).slice(0, 100);
  }, [q, inventoryItems, preferredItems]);

  // Re-focus the search input when opened.
  useEffect(() => {
    const t = setTimeout(() => {
      document.getElementById('inv-picker-search')?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-lg md:max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-gray-200 px-4 sm:px-5 py-3 sm:py-4 flex items-center justify-between">
          <div className="min-w-0">
            <h3 className="font-semibold text-gray-900 text-base sm:text-lg">Link to inventory</h3>
            <p className="text-xs sm:text-sm text-gray-500 truncate">{title}</p>
          </div>
          <button onClick={onClose} className="p-2 -mr-1 text-gray-500 hover:bg-gray-100 active:bg-gray-200 rounded-lg" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-3 sm:p-4">
          <input
            id="inv-picker-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search SKU, name, variety, lot #"
            className="w-full px-3 py-3 border border-gray-300 rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
        </div>
        <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
          {filtered.length === 0 ? (
            <div className="text-center text-sm text-gray-500 py-6">No matching items</div>
          ) : (
            filtered.map(i => (
              <button
                key={i.id}
                onClick={() => onPick(i.id)}
                className="w-full px-4 py-3 text-left hover:bg-emerald-50 active:bg-emerald-100"
              >
                <div className="text-sm sm:text-base font-medium text-gray-900 truncate">{i.name}{i.variety ? ` · ${i.variety}` : ''}</div>
                <div className="text-xs sm:text-sm text-gray-500 font-mono mt-0.5">
                  {i.sku}{i.lotNumber ? ` · Lot #${i.lotNumber}` : ''} · {i.status}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
