import { useEffect, useMemo, useState } from 'react';
import {
  ShoppingCart, Search, Download, Plus, Minus, Trash2,
} from 'lucide-react';
import { VARIETIES as DEFAULT_VARIETIES } from '../constants.js';
import { fmt$, fmt$2, fmtPct } from '../financial/financialHelpers.js';

const SOLD_STATUSES = new Set(['sold', 'shipped', 'delivered']);
const DRAFT_KEY = 'purchase-order-draft-v1';

// Group inventory by cultivar (variety + name) and roll up per-cultivar
// performance stats: how many we have, how many we've sold, what we paid,
// what we sold them for, and the resulting profit.
function buildCultivarStats(items) {
  const groups = new Map();
  for (const it of items) {
    const name = (it.name || '').trim();
    if (!name) continue;
    const key = `${it.variety || ''}|${name}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        variety: it.variety || '',
        name,
        speciesId: it.speciesId || null,
        available: 0,
        sold: 0,
        costSamples: [],
        soldSamples: [],
      };
      groups.set(key, g);
    }
    const cost = parseFloat(it.grossCost ?? it.cost);
    if (Number.isFinite(cost) && cost > 0) g.costSamples.push(cost);
    if (it.status === 'available') g.available += 1;
    if (SOLD_STATUSES.has(it.status)) {
      g.sold += 1;
      const sp = parseFloat(it.salePrice);
      if (Number.isFinite(sp) && sp > 0 && Number.isFinite(cost) && cost > 0) {
        g.soldSamples.push({ sp, cost });
      }
    }
  }
  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  return [...groups.values()].map(g => {
    const avgCost = avg(g.costSamples);
    const avgSold = g.soldSamples.length
      ? avg(g.soldSamples.map(s => s.sp))
      : null;
    const avgProfit = (avgSold != null && avgCost != null) ? avgSold - avgCost : null;
    const avgProfitRate = g.soldSamples.length
      ? avg(g.soldSamples.map(s => ((s.sp - s.cost) / s.cost) * 100))
      : null;
    return {
      ...g,
      avgCost,
      avgSold,
      avgProfit,
      avgProfitRate,
      hasFinancials: g.soldSamples.length > 0,
    };
  });
}

const SORTS = [
  { id: 'profit_rate', label: 'Profit rate' },
  { id: 'profit',      label: 'Avg profit' },
  { id: 'sold',        label: 'Most sold' },
  { id: 'low_stock',   label: 'Low stock' },
  { id: 'name',        label: 'Name' },
];

function sortStats(stats, sortId) {
  const s = [...stats];
  switch (sortId) {
    case 'profit_rate':
      return s.sort((a, b) => (b.avgProfitRate ?? -Infinity) - (a.avgProfitRate ?? -Infinity));
    case 'profit':
      return s.sort((a, b) => (b.avgProfit ?? -Infinity) - (a.avgProfit ?? -Infinity));
    case 'sold':
      return s.sort((a, b) => b.sold - a.sold);
    case 'low_stock':
      // Bestsellers with little stock surface first.
      return s.sort((a, b) => (a.available - b.available) || (b.sold - a.sold));
    case 'name':
    default:
      return s.sort((a, b) => a.name.localeCompare(b.name));
  }
}

export function PurchaseOrderView({ items, varieties = [] }) {
  const varietyNames = varieties.length > 0 ? varieties.map(v => v.name) : DEFAULT_VARIETIES;
  const [varietyTab, setVarietyTab] = useState('all');
  const [search, setSearch] = useState('');
  const [sortId, setSortId] = useState('profit_rate');
  const [onlySold, setOnlySold] = useState(true);

  // qty draft, keyed by `${variety}|${name}`. Persisted so a half-built
  // order survives a refresh.
  const [qty, setQty] = useState(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(qty));
  }, [qty]);

  const stats = useMemo(() => buildCultivarStats(items), [items]);

  const filtered = useMemo(() => {
    let s = stats;
    if (varietyTab !== 'all') s = s.filter(g => g.variety === varietyTab);
    if (onlySold) s = s.filter(g => g.hasFinancials);
    if (search) {
      const q = search.toLowerCase();
      s = s.filter(g =>
        g.name.toLowerCase().includes(q) || g.variety.toLowerCase().includes(q)
      );
    }
    return sortStats(s, sortId);
  }, [stats, varietyTab, onlySold, search, sortId]);

  const setQtyFor = (key, n) => {
    setQty(prev => {
      const next = { ...prev };
      if (!n || n <= 0) delete next[key];
      else next[key] = n;
      return next;
    });
  };
  const incQty = (key) => setQtyFor(key, (qty[key] || 0) + 1);
  const decQty = (key) => setQtyFor(key, (qty[key] || 0) - 1);

  const orderLines = useMemo(() => {
    const map = new Map(stats.map(g => [g.key, g]));
    return Object.entries(qty)
      .map(([key, n]) => {
        const g = map.get(key);
        return g ? { ...g, qty: n } : null;
      })
      .filter(Boolean);
  }, [qty, stats]);

  const orderTotals = useMemo(() => {
    let units = 0, totalCost = 0, expectedRevenue = 0, expectedProfit = 0;
    for (const line of orderLines) {
      units += line.qty;
      if (line.avgCost != null) totalCost += line.avgCost * line.qty;
      if (line.avgSold != null) expectedRevenue += line.avgSold * line.qty;
      if (line.avgProfit != null) expectedProfit += line.avgProfit * line.qty;
    }
    return { units, totalCost, expectedRevenue, expectedProfit };
  }, [orderLines]);

  const exportCsv = () => {
    if (orderLines.length === 0) return;
    const headers = [
      'Variety', 'Cultivar', 'Quantity',
      'Avg Cost', 'Line Cost',
      'Avg Sold Price', 'Expected Revenue',
      'Avg Profit', 'Expected Profit', 'Profit Rate %',
      'Currently Available', 'Total Sold',
    ];
    const rows = orderLines.map(l => [
      l.variety, l.name, l.qty,
      l.avgCost != null ? l.avgCost.toFixed(2) : '',
      l.avgCost != null ? (l.avgCost * l.qty).toFixed(2) : '',
      l.avgSold != null ? l.avgSold.toFixed(2) : '',
      l.avgSold != null ? (l.avgSold * l.qty).toFixed(2) : '',
      l.avgProfit != null ? l.avgProfit.toFixed(2) : '',
      l.avgProfit != null ? (l.avgProfit * l.qty).toFixed(2) : '',
      l.avgProfitRate != null ? l.avgProfitRate.toFixed(0) : '',
      l.available, l.sold,
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const totals = [
      'TOTAL', '', orderTotals.units,
      '', orderTotals.totalCost.toFixed(2),
      '', orderTotals.expectedRevenue.toFixed(2),
      '', orderTotals.expectedProfit.toFixed(2),
      '', '', '',
    ].map(v => `"${v}"`).join(',');
    const csv = [headers.join(','), ...rows, totals].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `purchase-order-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const clearOrder = () => setQty({});

  return (
    <div className="space-y-4 pb-32">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <ShoppingCart className="w-5 h-5 text-emerald-600" /> Purchase Order
          </h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Pick cultivars to reorder based on past performance.
          </p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-3 space-y-3">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex-1 relative">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search cultivar or variety..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
            />
          </div>
          <div className="flex gap-1 bg-gray-100 p-1 rounded-lg overflow-x-auto">
            {SORTS.map(s => (
              <button
                key={s.id}
                onClick={() => setSortId(s.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition ${
                  sortId === s.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 active:bg-gray-200'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <label className="ml-auto flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={onlySold}
              onChange={(e) => setOnlySold(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
            />
            With sales history only
          </label>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 px-1 py-1 flex gap-0.5 overflow-x-auto">
        {[{ value: 'all', label: 'All' }, ...varietyNames.map(v => ({ value: v, label: v }))].map(tab => {
          const active = varietyTab === tab.value;
          const count = tab.value === 'all'
            ? stats.length
            : stats.filter(g => g.variety === tab.value).length;
          return (
            <button
              key={tab.value}
              onClick={() => setVarietyTab(tab.value)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition whitespace-nowrap ${
                active ? 'bg-emerald-600 text-white font-medium' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              {tab.label}
              <span className={`text-xs ${active ? 'text-emerald-100' : 'text-gray-400'}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-sm text-gray-500">
          No cultivars match these filters.
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {filtered.map(g => {
            const n = qty[g.key] || 0;
            const selected = n > 0;
            return (
              <div
                key={g.key}
                className={`relative bg-white rounded-xl border p-3 transition ${
                  selected ? 'border-emerald-500 ring-2 ring-emerald-100' : 'border-gray-200'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    {g.variety && (
                      <div className="text-[10px] uppercase tracking-wide text-gray-500 font-medium truncate">
                        {g.variety}
                      </div>
                    )}
                    <div className="font-semibold text-sm text-gray-900 leading-tight truncate">
                      {g.name}
                    </div>
                  </div>
                  {selected && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                      ×{n}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
                  <Stat label="Avg sold" value={fmt$2(g.avgSold)} tone="emerald" />
                  <Stat label="Avg cost" value={fmt$2(g.avgCost)} tone="gray" />
                  <Stat label="Avg profit" value={fmt$2(g.avgProfit)} tone="blue" />
                  <Stat label="Profit rate" value={fmtPct(g.avgProfitRate)} tone="amber" />
                </div>

                <div className="mt-2 text-[11px] text-gray-500 flex items-center gap-1">
                  <span className={g.available === 0 && g.sold > 0 ? 'text-red-600 font-medium' : ''}>
                    {g.available} in stock
                  </span>
                  <span>·</span>
                  <span>{g.sold} sold</span>
                </div>

                <div className="mt-3 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => decQty(g.key)}
                      disabled={n === 0}
                      className="w-7 h-7 flex items-center justify-center rounded-lg border border-gray-300 text-gray-600 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-100 active:bg-gray-200"
                      aria-label="Decrease"
                    >
                      <Minus className="w-3.5 h-3.5" />
                    </button>
                    <input
                      type="number"
                      min="0"
                      value={n}
                      onChange={(e) => setQtyFor(g.key, parseInt(e.target.value, 10) || 0)}
                      className="w-12 h-7 text-center text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent tabular-nums"
                    />
                    <button
                      onClick={() => incQty(g.key)}
                      className="w-7 h-7 flex items-center justify-center rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100 active:bg-gray-200"
                      aria-label="Increase"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {n > 0 && g.avgCost != null && (
                    <div className="text-[11px] text-gray-600 tabular-nums">
                      {fmt$(g.avgCost * n)}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {orderLines.length > 0 && (
        <div className="fixed bottom-0 sm:bottom-0 left-0 right-0 sm:left-auto sm:right-4 sm:bottom-4 z-30 sm:max-w-md">
          <div className="bg-gray-900 text-white sm:rounded-2xl shadow-2xl p-4 pb-safe sm:pb-4 mb-14 sm:mb-0">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <div className="text-xs text-gray-400">Purchase Order</div>
                <div className="text-base font-semibold">
                  {orderLines.length} cultivar{orderLines.length === 1 ? '' : 's'} · {orderTotals.units} unit{orderTotals.units === 1 ? '' : 's'}
                </div>
              </div>
              <button
                onClick={clearOrder}
                className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/10"
                aria-label="Clear order"
                title="Clear order"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs mb-3">
              <PoStat label="Cost" value={fmt$(orderTotals.totalCost)} />
              <PoStat label="Est. revenue" value={fmt$(orderTotals.expectedRevenue)} />
              <PoStat label="Est. profit" value={fmt$(orderTotals.expectedProfit)} tone="emerald" />
            </div>
            <button
              onClick={exportCsv}
              className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white text-sm font-medium px-4 py-2.5 rounded-lg"
            >
              <Download className="w-4 h-4" /> Export Purchase Order
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone = 'gray' }) {
  const tones = {
    gray:    'text-gray-900',
    emerald: 'text-emerald-700',
    blue:    'text-blue-700',
    amber:   'text-amber-700',
  };
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`font-semibold tabular-nums ${tones[tone]}`}>{value}</div>
    </div>
  );
}

function PoStat({ label, value, tone }) {
  return (
    <div className="bg-white/10 rounded-lg px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-gray-400">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${tone === 'emerald' ? 'text-emerald-300' : 'text-white'}`}>
        {value}
      </div>
    </div>
  );
}
