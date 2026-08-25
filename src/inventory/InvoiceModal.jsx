import { useEffect, useMemo, useRef, useState } from 'react';
import { X, ScanLine, FileText, Download, Trash2, AlertTriangle } from 'lucide-react';
import { normalizeSku } from '../labels/boxCode.js';

// Create Invoice — scan plants continuously, collect them into a list with each
// plant's cost, apply a profit rate, see the final price per item, and export a
// CSV. Read-only: it never mutates inventory. Works for both brands.
//
// Final price = cost × (1 + profitRate/100), rounded to cents. A per-row price
// can be overridden (e.g. to round to a nice number); cost is editable too, so
// the operator can adjust the basis without leaving the invoice.

// The cost basis for an item: gross purchase cost first, then the legacy `cost`
// alias, then net cost. Returns a number (0 if none).
function itemCost(item) {
  for (const v of [item.grossCost, item.cost, item.netCost]) {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function numOrNull(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function InvoiceModal({ items, idealRate, brand, onClose }) {
  const itemsBySku = useMemo(() => {
    const m = new Map();
    for (const i of items) if (i.sku && !i.deletedAt) m.set(normalizeSku(i.sku), i);
    return m;
  }, [items]);

  const defaultRate = Number.isFinite(parseFloat(idealRate)) ? parseFloat(idealRate) : 100;
  const [rate, setRate] = useState(String(defaultRate));
  const [lines, setLines] = useState([]); // { id, sku, name, variety, cost, priceOverride }
  const [scanInput, setScanInput] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  // Keep the scanner focused so HID scanners never miss a scan.
  useEffect(() => { inputRef.current?.focus(); });
  useEffect(() => {
    if (!error) return undefined;
    const t = setTimeout(() => setError(''), 2500);
    return () => clearTimeout(t);
  }, [error]);

  const rateNum = numOrNull(rate) ?? 0;
  const finalPrice = (line) => {
    if (line.priceOverride != null) return line.priceOverride;
    const c = numOrNull(line.cost) ?? 0;
    return Math.round(c * (1 + rateNum / 100) * 100) / 100;
  };

  const addBySku = (raw) => {
    setError('');
    const key = normalizeSku(raw);
    if (!key) return;
    const item = itemsBySku.get(key);
    if (!item) { setError(`No SKU "${raw.trim()}" in inventory`); return; }
    if (lines.some(l => l.id === item.id)) { setError(`${item.sku} is already on the invoice`); return; }
    setLines(prev => [
      {
        id: item.id,
        sku: item.sku,
        name: item.name || '',
        variety: item.variety || '',
        cost: itemCost(item),
        priceOverride: null,
      },
      ...prev,
    ]);
  };

  const onSubmit = (e) => {
    e.preventDefault();
    if (!scanInput) return;
    addBySku(scanInput);
    setScanInput('');
  };

  const patch = (id, p) => setLines(ls => ls.map(l => (l.id === id ? { ...l, ...p } : l)));
  const remove = (id) => setLines(ls => ls.filter(l => l.id !== id));

  const totalCost = lines.reduce((s, l) => s + (numOrNull(l.cost) ?? 0), 0);
  const totalPrice = lines.reduce((s, l) => s + finalPrice(l), 0);

  const exportCsv = () => {
    const headers = ['SKU', 'Name', 'Variety', 'Cost', 'Profit %', 'Final Price'];
    const rows = lines.map(l => [
      l.sku, l.name, l.variety,
      (numOrNull(l.cost) ?? 0).toFixed(2),
      l.priceOverride != null ? '' : String(rateNum),
      finalPrice(l).toFixed(2),
    ]);
    rows.push([]);
    rows.push([`TOTAL · ${lines.length} item${lines.length === 1 ? '' : 's'}`, '', '', totalCost.toFixed(2), '', totalPrice.toFixed(2)]);
    const csv = [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `invoice-${(brand || 'bae-gin')}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-stretch sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full max-w-4xl h-full sm:h-[92vh] sm:rounded-2xl flex flex-col">
        {/* Header */}
        <div className="border-b border-gray-200 px-5 py-4 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center flex-shrink-0">
              <FileText className="w-5 h-5 text-emerald-600" />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-gray-900 text-lg">Create Invoice</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Scan plants to add them, set a profit rate, then export the price list.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 -mr-1 text-gray-500 hover:bg-gray-100 active:bg-gray-200 rounded-lg" aria-label="Close invoice">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scan + controls */}
        <div className="px-5 pt-4 space-y-3 flex-shrink-0">
          <form onSubmit={onSubmit}>
            <div className="relative">
              <ScanLine className="w-5 h-5 text-gray-400 absolute left-4 top-1/2 -translate-y-1/2" />
              <input
                ref={inputRef}
                type="text"
                value={scanInput}
                onChange={(e) => setScanInput(e.target.value)}
                placeholder="Scan or type a SKU, then Enter…"
                autoComplete="off"
                spellCheck={false}
                className="w-full pl-12 pr-4 py-4 text-lg font-mono tabular-nums border-2 border-emerald-300 bg-emerald-50/40 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              />
            </div>
          </form>
          {error && (
            <div className="flex items-start gap-2 bg-red-50 text-red-700 text-sm px-3 py-2 rounded-lg">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {error}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <span className="font-medium text-gray-700">Profit rate</span>
              <div className="relative">
                <input
                  type="number" step="1" value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  className="w-24 pl-3 pr-6 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm">%</span>
              </div>
            </label>
            <span className="text-sm text-gray-500">
              <span className="font-semibold text-gray-900">{lines.length}</span> item{lines.length === 1 ? '' : 's'}
              <span className="mx-1.5 text-gray-300">·</span>
              cost <span className="font-medium text-gray-700">{money(totalCost)}</span>
              <span className="mx-1.5 text-gray-300">·</span>
              total <span className="font-semibold text-emerald-700">{money(totalPrice)}</span>
            </span>
            <div className="ml-auto flex gap-2">
              {lines.length > 0 && (
                <button
                  onClick={() => setLines([])}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg"
                >
                  <Trash2 className="w-4 h-4" /> Clear
                </button>
              )}
              <button
                onClick={exportCsv}
                disabled={lines.length === 0}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white disabled:bg-gray-200 disabled:text-gray-400"
              >
                <Download className="w-4 h-4" /> Export CSV
              </button>
            </div>
          </div>
        </div>

        {/* Line list */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {lines.length === 0 ? (
            <div className="text-center py-16 text-sm text-gray-400">
              Scan a plant to start the invoice…
            </div>
          ) : (
            <div className="border border-gray-200 rounded-xl overflow-hidden">
              <div className="hidden sm:grid grid-cols-[2rem_1.6fr_0.8fr_0.8fr_2rem] gap-2 px-3 py-2 bg-gray-50 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                <span>#</span><span>Plant</span><span className="text-right">Cost</span><span className="text-right">Final price</span><span />
              </div>
              <div className="divide-y divide-gray-100">
                {lines.map((l, idx) => (
                  <div key={l.id} className="grid grid-cols-[2rem_1.6fr_0.8fr_0.8fr_2rem] gap-2 items-center px-3 py-2">
                    <span className="text-sm font-semibold text-gray-400 tabular-nums">{lines.length - idx}</span>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-gray-900 truncate">{l.name || l.sku}</div>
                      <div className="text-xs text-gray-500 font-mono truncate">
                        {l.sku}{l.variety ? ` · ${l.variety}` : ''}
                      </div>
                    </div>
                    <div className="relative">
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                      <input
                        type="number" step="0.01" value={l.cost}
                        onChange={(e) => patch(l.id, { cost: e.target.value })}
                        className="w-full pl-5 pr-1 py-1.5 text-sm text-right border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                    </div>
                    <div className="relative">
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-emerald-500 text-sm">$</span>
                      <input
                        type="number" step="0.01"
                        value={finalPrice(l).toFixed(2)}
                        onChange={(e) => patch(l.id, { priceOverride: numOrNull(e.target.value) })}
                        title={l.priceOverride != null ? 'Manual price (overrides the rate)' : 'Computed from cost × rate — edit to override'}
                        className={`w-full pl-5 pr-1 py-1.5 text-sm text-right font-semibold rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 border ${
                          l.priceOverride != null ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-gray-200 text-emerald-700'
                        }`}
                      />
                    </div>
                    <button
                      onClick={() => remove(l.id)}
                      className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg justify-self-center"
                      title="Remove"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
