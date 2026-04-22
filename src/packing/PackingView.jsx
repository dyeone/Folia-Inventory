import { useState, useMemo } from 'react';
import {
  Upload, Package, MapPin, AlertCircle, X, ChevronDown, ChevronRight,
  Check, Link2, Truck, FileText,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { parsePalmstreetOrders } from './parsePalmstreetOrders.js';
import { matchInventory } from './matchInventory.js';

export function PackingView({ inventoryItems }) {
  const [fileName, setFileName] = useState('');
  const [boxes, setBoxes] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(() => new Set());
  // Manual SKU overrides keyed by `${boxId}::${rowKey}` → inventory item id (or null to clear)
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

  const reset = () => {
    setBoxes(null);
    setFileName('');
    setOverrides({});
    setCollapsed(new Set());
    setErr('');
  };

  // Resolve every box item to either its override or its auto-match.
  const resolved = useMemo(() => {
    if (!boxes) return null;
    return boxes.map(box => ({
      ...box,
      items: box.items.map(item => {
        const key = `${box.id}::${item.rowKey}`;
        const override = overrides[key];
        if (override === null) return { ...item, match: null, manual: true };
        if (override) {
          const inv = inventoryItems.find(i => i.id === override);
          return { ...item, match: inv ? { item: inv, confidence: 'manual' } : null, manual: true };
        }
        return { ...item, match: matchInventory(item, inventoryItems), manual: false };
      }),
    }));
  }, [boxes, overrides, inventoryItems]);

  const summary = useMemo(() => {
    if (!resolved) return null;
    let totalItems = 0;
    let matched = 0;
    let unmatched = 0;
    let totalValue = 0;
    let totalShipping = 0;
    for (const box of resolved) {
      totalShipping += box.shippingFee;
      for (const it of box.items) {
        totalItems += it.quantity;
        totalValue += it.price * it.quantity;
        if (it.match?.item) matched += 1;
        else unmatched += 1;
      }
    }
    return { totalItems, matched, unmatched, totalValue, totalShipping };
  }, [resolved]);

  if (!boxes) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Packing</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Upload a Palmstreet orders file to plan boxes and link items to inventory.
          </p>
        </div>
        <label className="block">
          <div className="border-2 border-dashed border-gray-300 rounded-xl p-10 text-center hover:border-emerald-400 hover:bg-emerald-50/50 cursor-pointer transition">
            <Upload className="w-8 h-8 text-gray-400 mx-auto mb-2" />
            <div className="text-sm font-medium text-gray-900">
              {loading ? 'Reading file...' : 'Upload Palmstreet orders file'}
            </div>
            <div className="text-xs text-gray-500 mt-1">.xlsx, .xls or .csv</div>
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }}
              className="hidden"
            />
          </div>
        </label>
        {err && (
          <div className="mt-3 flex items-start gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {err}
          </div>
        )}
        <div className="mt-4 text-xs text-gray-600 bg-gray-50 rounded-lg p-3">
          <div className="font-medium text-gray-900 mb-1">What this does:</div>
          <ul className="space-y-0.5 list-disc list-inside">
            <li>Groups order rows into boxes by recipient + address (one buyer with multiple orders ships in one box)</li>
            <li>Skips shipping/service line items (📦 Free Shipping, Vacation Hold, etc.)</li>
            <li>Tries to match each item to inventory by SKU, lot number, then fuzzy name</li>
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Package className="w-5 h-5 text-emerald-600" /> Packing
          </h2>
          <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1">
            <FileText className="w-3 h-3" /> {fileName}
          </p>
        </div>
        <button onClick={reset} className="text-xs text-gray-600 hover:text-gray-900 px-3 py-1.5 border border-gray-200 rounded-lg">
          Upload different file
        </button>
      </div>

      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <SummaryStat label="Boxes" value={resolved.length} tone="emerald" />
          <SummaryStat label="Items" value={summary.totalItems} tone="blue" />
          <SummaryStat
            label="Matched / Unmatched"
            value={`${summary.matched} / ${summary.unmatched}`}
            tone={summary.unmatched === 0 ? 'emerald' : 'amber'}
          />
          <SummaryStat
            label="Item value"
            value={`$${summary.totalValue.toFixed(0)}`}
            sub={summary.totalShipping > 0 ? `+ $${summary.totalShipping.toFixed(0)} ship` : null}
            tone="gray"
          />
        </div>
      )}

      <div className="space-y-3">
        {resolved.map(box => {
          const isCollapsed = collapsed.has(box.id);
          const matchCount = box.items.filter(i => i.match?.item).length;
          return (
            <div key={box.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <button
                onClick={() => {
                  setCollapsed(prev => {
                    const next = new Set(prev);
                    if (next.has(box.id)) next.delete(box.id); else next.add(box.id);
                    return next;
                  });
                }}
                className="w-full flex items-start gap-3 px-4 py-3 hover:bg-gray-50 text-left"
              >
                <div className="mt-0.5 text-gray-400">
                  {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-gray-900">{box.recipientName}</span>
                    <span className="text-xs text-gray-500">@{box.username}</span>
                    {box.shipmentMethod && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">
                        <Truck className="w-3 h-3" /> {box.shipmentMethod}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5 flex items-start gap-1">
                    <MapPin className="w-3 h-3 mt-0.5 flex-shrink-0" />
                    <span>{formatAddress(box)}</span>
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-sm font-medium text-gray-900">{box.items.length} {box.items.length === 1 ? 'item' : 'items'}</div>
                  <div className={`text-xs ${matchCount === box.items.length ? 'text-emerald-600' : 'text-amber-600'}`}>
                    {matchCount}/{box.items.length} matched
                  </div>
                </div>
              </button>

              {!isCollapsed && (
                <div className="border-t border-gray-100 divide-y divide-gray-100">
                  {box.items.map(item => (
                    <BoxItemRow
                      key={item.rowKey}
                      boxId={box.id}
                      item={item}
                      inventoryItems={inventoryItems}
                      onPick={() => setPickerFor({ boxId: box.id, rowKey: item.rowKey, title: item.title })}
                      onClear={() => {
                        const key = `${box.id}::${item.rowKey}`;
                        setOverrides(prev => ({ ...prev, [key]: null }));
                      }}
                    />
                  ))}
                  {box.orderNumbers.length > 0 && (
                    <div className="px-4 py-2 bg-gray-50/60 text-[11px] text-gray-500">
                      Order #: {box.orderNumbers.join(', ')}
                    </div>
                  )}
                  {box.notes.length > 0 && (
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
          className="text-xs px-2 py-1 text-gray-700 hover:bg-gray-100 rounded inline-flex items-center gap-1"
        >
          <Link2 className="w-3 h-3" /> {match ? 'Change' : 'Link'}
        </button>
        {item.manual && (
          <button onClick={onClear} className="text-[11px] px-2 py-0.5 text-gray-500 hover:text-gray-900">
            Reset
          </button>
        )}
      </div>
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

function formatAddress(box) {
  const parts = [
    box.street1,
    box.street2,
    [box.city, box.state, box.zip].filter(Boolean).join(', '),
    box.country && box.country !== 'US' ? box.country : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

function InventoryPicker({ title, inventoryItems, onPick, onClose }) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    const list = inventoryItems
      .filter(i => i.status === 'available' || i.status === 'listed')
      .slice(0, 500);
    if (!query) return list.slice(0, 50);
    return list.filter(i => (
      i.sku?.toLowerCase().includes(query) ||
      i.name?.toLowerCase().includes(query) ||
      i.variety?.toLowerCase().includes(query) ||
      String(i.lotNumber || '').toLowerCase().includes(query)
    )).slice(0, 100);
  }, [q, inventoryItems]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-gray-200 px-4 py-3 flex items-center justify-between">
          <div className="min-w-0">
            <h3 className="font-semibold text-gray-900">Link to inventory</h3>
            <p className="text-xs text-gray-500 truncate">{title}</p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-500 hover:bg-gray-100 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-3">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search SKU, name, variety, lot #"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
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
                className="w-full px-4 py-2.5 text-left hover:bg-emerald-50"
              >
                <div className="text-sm font-medium text-gray-900 truncate">{i.name}{i.variety ? ` · ${i.variety}` : ''}</div>
                <div className="text-xs text-gray-500 font-mono">
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
