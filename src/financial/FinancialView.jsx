import { useMemo, useState } from 'react';
import {
  DollarSign, TrendingUp, Receipt, Percent, ShoppingBag, Tag,
  Download, Calendar, ArrowUpRight, ArrowDownRight, Search, Upload,
  AlertCircle, Check, RotateCcw, FileText, X, Activity,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { parseCashflow, buildRefundUpdates } from './parseCashflow.js';

const SOLD_STATUSES = new Set(['sold', 'shipped', 'delivered']);

const RANGES = [
  { id: 'all',    label: 'All time',  days: null },
  { id: '30d',    label: '30 days',   days: 30 },
  { id: '90d',    label: '90 days',   days: 90 },
  { id: 'ytd',    label: 'This year', days: null, ytd: true },
  { id: '12m',    label: '12 months', days: 365 },
  { id: 'custom', label: 'Custom',    days: null, custom: true },
];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoIso(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function fmt$(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 10000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}
function fmt$2(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return `$${n.toFixed(2)}`;
}
function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(0)}%`;
}

function inRange(item, range) {
  if (range.id === 'all') return true;
  const t = item.soldAt ? new Date(item.soldAt).getTime() : 0;
  if (!t) return false;
  if (range.custom) {
    const from = range.from ? new Date(`${range.from}T00:00:00`).getTime() : 0;
    const to = range.to ? new Date(`${range.to}T23:59:59.999`).getTime() : Date.now();
    return t >= from && t <= to;
  }
  if (range.ytd) {
    const yStart = new Date(new Date().getFullYear(), 0, 1).getTime();
    return t >= yStart;
  }
  const cutoff = Date.now() - range.days * 86400_000;
  return t >= cutoff;
}

// Effective revenue for an item = salePrice − refundedAmount (clamped ≥ 0).
function effectiveRevenue(item) {
  const sp = parseFloat(item.salePrice) || 0;
  const ref = parseFloat(item.refundedAmount) || 0;
  return Math.max(0, sp - ref);
}

// Roll up sold items into headline financials. Refunded items are excluded
// from unitsSold; partial refunds reduce revenue via effectiveRevenue.
function rollup(items) {
  let revenue = 0;
  let cost = 0;
  let unitsSold = 0;
  let unitsWithFinancials = 0;
  let refundsTotal = 0;
  for (const i of items) {
    if (i.status === 'refunded') {
      refundsTotal += parseFloat(i.refundedAmount) || 0;
      continue;
    }
    if (!SOLD_STATUSES.has(i.status)) continue;
    if (i.lotKind === 'giveaway') { unitsSold += 1; continue; }
    unitsSold += 1;
    const rev = effectiveRevenue(i);
    const c = parseFloat(i.grossCost ?? i.cost);
    if (rev > 0) revenue += rev;
    if (!isNaN(c) && c > 0) cost += c;
    if (rev > 0 && !isNaN(c) && c > 0) unitsWithFinancials += 1;
    refundsTotal += parseFloat(i.refundedAmount) || 0;
  }
  const profit = revenue - cost;
  const margin = revenue > 0 ? (profit / revenue) * 100 : null;
  const avgPrice = unitsWithFinancials > 0 ? revenue / unitsWithFinancials : null;
  return { revenue, cost, profit, margin, unitsSold, unitsWithFinancials, avgPrice, refundsTotal };
}

const TABS = [
  { id: 'overview',  label: 'Overview',  icon: TrendingUp },
  { id: 'sold',      label: 'Sold Items', icon: ShoppingBag },
  { id: 'cashflow',  label: 'Cashflow Sync', icon: RotateCcw },
];

export function FinancialView({ items, sales, onApplyRefunds }) {
  const [tab, setTab] = useState('overview');
  const [rangeId, setRangeId] = useState('all');
  const [customFrom, setCustomFrom] = useState(() => daysAgoIso(30));
  const [customTo, setCustomTo] = useState(() => todayIso());
  const range = useMemo(() => {
    const base = RANGES.find(r => r.id === rangeId) || RANGES[0];
    return base.custom ? { ...base, from: customFrom, to: customTo } : base;
  }, [rangeId, customFrom, customTo]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-emerald-600" /> Financials
          </h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Revenue, cost, profit, and refunds across sales.
          </p>
        </div>
        {tab !== 'cashflow' && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
              {RANGES.map(r => (
                <button
                  key={r.id}
                  onClick={() => setRangeId(r.id)}
                  className={`px-3 py-1.5 text-xs sm:text-sm font-medium rounded-md transition ${
                    rangeId === r.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 active:bg-gray-200'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
            {rangeId === 'custom' && (
              <div className="flex items-center gap-1.5 bg-white border border-gray-300 rounded-lg p-1">
                <input
                  type="date"
                  value={customFrom}
                  max={customTo}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="px-2 py-1 text-sm border-0 focus:outline-none focus:ring-0 bg-transparent"
                />
                <span className="text-gray-400 text-sm">→</span>
                <input
                  type="date"
                  value={customTo}
                  min={customFrom}
                  max={todayIso()}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="px-2 py-1 text-sm border-0 focus:outline-none focus:ring-0 bg-transparent"
                />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-b border-gray-200">
        <div className="flex gap-1 -mb-px">
          {TABS.map(t => {
            const Ic = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition active:bg-gray-100 ${
                  tab === t.id
                    ? 'border-emerald-600 text-emerald-700'
                    : 'border-transparent text-gray-600 hover:text-gray-900'
                }`}
              >
                <Ic className="w-4 h-4" /> {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {tab === 'overview' && <Overview items={items} sales={sales} range={range} />}
      {tab === 'sold' && <SoldItems items={items} sales={sales} range={range} />}
      {tab === 'cashflow' && <CashflowSync items={items} onApplyRefunds={onApplyRefunds} />}
    </div>
  );
}

// ─────────────────────────── Overview ───────────────────────────────────────

function Overview({ items, sales, range }) {
  const itemsInRange = useMemo(
    () => items.filter(i =>
      (SOLD_STATUSES.has(i.status) || i.status === 'refunded') && inRange(i, range)
    ),
    [items, range]
  );
  const totals = useMemo(() => rollup(itemsInRange), [itemsInRange]);

  const perSale = useMemo(() => {
    const rows = sales.map(sale => {
      const saleItems = items.filter(i => i.saleId === sale.id);
      const inRangeItems = saleItems.filter(i =>
        (SOLD_STATUSES.has(i.status) || i.status === 'refunded') && inRange(i, range)
      );
      if (inRangeItems.length === 0 && range.id !== 'all') return null;
      const r = rollup(inRangeItems);
      const lineupTotal = saleItems.filter(i => i.lotKind !== 'giveaway').length;
      return {
        sale,
        ...r,
        lineupTotal,
        sellThrough: lineupTotal > 0 ? (r.unitsSold / lineupTotal) * 100 : null,
      };
    }).filter(Boolean);
    return rows.sort((a, b) => {
      const da = a.sale.startTime || a.sale.date || a.sale.createdAt || '';
      const db = b.sale.startTime || b.sale.date || b.sale.createdAt || '';
      return db.localeCompare(da);
    });
  }, [sales, items, range]);

  const byVariety = useMemo(() => {
    const groups = new Map();
    for (const i of itemsInRange) {
      if (i.lotKind === 'giveaway') continue;
      const key = i.variety?.trim() || 'Unspecified';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    }
    return [...groups.entries()]
      .map(([variety, list]) => ({ variety, ...rollup(list) }))
      .sort((a, b) => b.profit - a.profit);
  }, [itemsInRange]);

  const monthly = useMemo(() => {
    const now = new Date();
    const months = [];
    for (let k = 11; k >= 0; k--) {
      const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
      months.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        label: d.toLocaleDateString(undefined, { month: 'short' }),
        year: d.getFullYear(),
        items: [],
      });
    }
    const idx = Object.fromEntries(months.map((m, i) => [m.key, i]));
    for (const i of items) {
      if (!i.soldAt) continue;
      if (!SOLD_STATUSES.has(i.status) && i.status !== 'refunded') continue;
      if (i.lotKind === 'giveaway') continue;
      const d = new Date(i.soldAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (idx[key] === undefined) continue;
      months[idx[key]].items.push(i);
    }
    return months.map(m => ({ ...m, ...rollup(m.items) }));
  }, [items]);

  const maxMonthlyRevenue = Math.max(1, ...monthly.map(m => m.revenue));
  const maxVarietyProfit = Math.max(1, ...byVariety.map(v => Math.abs(v.profit)));

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        <Kpi icon={DollarSign} label="Revenue (net)" value={fmt$(totals.revenue)} tone="emerald" />
        <Kpi icon={Receipt}    label="Cost"          value={fmt$(totals.cost)}    tone="gray" />
        <Kpi
          icon={TrendingUp}
          label="Profit"
          value={fmt$(totals.profit)}
          tone={totals.profit >= 0 ? 'blue' : 'red'}
        />
        <Kpi
          icon={Percent}
          label="Margin"
          value={fmtPct(totals.margin)}
          tone={(totals.margin ?? 0) >= 50 ? 'emerald' : (totals.margin ?? 0) >= 0 ? 'amber' : 'red'}
        />
        <Kpi icon={ShoppingBag} label="Units sold" value={totals.unitsSold} tone="gray" />
        <Kpi
          icon={RotateCcw}
          label="Refunds"
          value={fmt$(totals.refundsTotal)}
          tone={totals.refundsTotal > 0 ? 'amber' : 'gray'}
        />
      </section>

      <section className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <h3 className="font-medium text-gray-900 flex items-center gap-2">
            <Calendar className="w-4 h-4 text-gray-400" /> Per sale event
          </h3>
          <span className="text-xs text-gray-500">{perSale.length} events</span>
        </div>
        {perSale.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-gray-500">
            No sales in this range yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Event</th>
                  <th className="px-3 py-2 text-right font-medium">Sold / Lineup</th>
                  <th className="px-3 py-2 text-right font-medium">Sell-through</th>
                  <th className="px-3 py-2 text-right font-medium">Revenue</th>
                  <th className="px-3 py-2 text-right font-medium hidden sm:table-cell">Cost</th>
                  <th className="px-3 py-2 text-right font-medium">Profit</th>
                  <th className="px-3 py-2 text-right font-medium hidden md:table-cell">Margin</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {perSale.map(r => (
                  <tr key={r.sale.id} className="hover:bg-gray-50/50">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-gray-900 truncate max-w-[200px]">{r.sale.name}</div>
                      <div className="text-xs text-gray-500">
                        {r.sale.startTime
                          ? new Date(r.sale.startTime).toLocaleDateString()
                          : (r.sale.date || '')}
                        {r.sale.status === 'closed' && ' · closed'}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right text-gray-900 tabular-nums">
                      {r.unitsSold}<span className="text-gray-400">/{r.lineupTotal}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {r.sellThrough !== null ? `${r.sellThrough.toFixed(0)}%` : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right text-emerald-700 font-medium tabular-nums">
                      {fmt$(r.revenue)}
                    </td>
                    <td className="px-3 py-2.5 text-right text-gray-600 tabular-nums hidden sm:table-cell">
                      {fmt$(r.cost)}
                    </td>
                    <td className={`px-3 py-2.5 text-right font-medium tabular-nums ${
                      r.profit >= 0 ? 'text-blue-700' : 'text-red-700'
                    }`}>
                      {fmt$(r.profit)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums hidden md:table-cell">
                      <PctBadge value={r.margin} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50 text-sm font-medium border-t border-gray-200">
                <tr>
                  <td className="px-4 py-2.5 text-gray-700">Total</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{totals.unitsSold}</td>
                  <td className="px-3 py-2.5"></td>
                  <td className="px-3 py-2.5 text-right text-emerald-700 tabular-nums">{fmt$(totals.revenue)}</td>
                  <td className="px-3 py-2.5 text-right text-gray-700 tabular-nums hidden sm:table-cell">{fmt$(totals.cost)}</td>
                  <td className={`px-3 py-2.5 text-right tabular-nums ${
                    totals.profit >= 0 ? 'text-blue-700' : 'text-red-700'
                  }`}>{fmt$(totals.profit)}</td>
                  <td className="px-3 py-2.5 text-right hidden md:table-cell">
                    <PctBadge value={totals.margin} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      <div className="grid lg:grid-cols-2 gap-4">
        <section className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200">
            <h3 className="font-medium text-gray-900">By variety</h3>
            <p className="text-xs text-gray-500 mt-0.5">Profit share within range</p>
          </div>
          {byVariety.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-500">No data.</div>
          ) : (
            <div className="p-4 space-y-3">
              {byVariety.map(v => {
                const widthPct = (Math.abs(v.profit) / maxVarietyProfit) * 100;
                const isPositive = v.profit >= 0;
                return (
                  <div key={v.variety}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="font-medium text-gray-900 truncate">{v.variety}</span>
                      <span className="flex items-center gap-3 text-gray-600 tabular-nums">
                        <span className="text-emerald-700">{fmt$(v.revenue)}</span>
                        <span className={isPositive ? 'text-blue-700 font-medium' : 'text-red-700 font-medium'}>
                          {fmt$(v.profit)}
                        </span>
                      </span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full ${isPositive ? 'bg-blue-500' : 'bg-red-500'}`}
                        style={{ width: `${widthPct}%` }}
                      />
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5 flex justify-between">
                      <span>{v.unitsSold} sold</span>
                      <span>{fmtPct(v.margin)} margin</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200">
            <h3 className="font-medium text-gray-900">Monthly trend</h3>
            <p className="text-xs text-gray-500 mt-0.5">Revenue, last 12 months</p>
          </div>
          <div className="p-4">
            <div className="flex items-end gap-1.5 h-32">
              {monthly.map(m => {
                const h = (m.revenue / maxMonthlyRevenue) * 100;
                return (
                  <div key={m.key} className="flex-1 flex flex-col items-center justify-end group">
                    <div className="text-[10px] text-gray-500 mb-0.5 opacity-0 group-hover:opacity-100 transition tabular-nums">
                      {fmt$(m.revenue)}
                    </div>
                    <div
                      className={`w-full rounded-t ${m.revenue > 0 ? 'bg-emerald-500' : 'bg-gray-100'}`}
                      style={{ height: `${Math.max(h, 2)}%` }}
                      title={`${m.label} ${m.year}: ${fmt$(m.revenue)} · ${fmt$(m.profit)} profit`}
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex gap-1.5 mt-1">
              {monthly.map(m => (
                <div key={m.key} className="flex-1 text-center text-[10px] text-gray-500">{m.label}</div>
              ))}
            </div>
            <MonthlyDelta monthly={monthly} />
          </div>
        </section>

        <section className="bg-white border border-gray-200 rounded-xl overflow-hidden lg:col-span-2">
          <ProfitTrendByName items={items} />
        </section>
      </div>
    </div>
  );
}

// ─────────────────────────── Sold Items ─────────────────────────────────────

function SoldItems({ items, sales, range }) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const saleNameById = useMemo(
    () => Object.fromEntries(sales.map(s => [s.id, s.name])),
    [sales]
  );

  const rows = useMemo(() => {
    const filtered = items.filter(i => {
      if (!SOLD_STATUSES.has(i.status) && i.status !== 'refunded') return false;
      if (i.lotKind === 'giveaway') return false;
      if (!inRange(i, range)) return false;
      if (statusFilter === 'sold' && i.status === 'refunded') return false;
      if (statusFilter === 'refunded' && i.status !== 'refunded' && (parseFloat(i.refundedAmount) || 0) === 0) return false;
      if (search) {
        const q = search.toLowerCase();
        const hit = (
          i.sku?.toLowerCase().includes(q) ||
          i.name?.toLowerCase().includes(q) ||
          i.variety?.toLowerCase().includes(q) ||
          i.buyer?.toLowerCase().includes(q) ||
          i.buyerUsername?.toLowerCase().includes(q) ||
          i.orderId?.toLowerCase().includes(q)
        );
        if (!hit) return false;
      }
      return true;
    });
    return filtered.sort((a, b) => {
      const da = a.soldAt ? new Date(a.soldAt).getTime() : 0;
      const db = b.soldAt ? new Date(b.soldAt).getTime() : 0;
      return db - da;
    });
  }, [items, range, search, statusFilter]);

  const totals = useMemo(() => rollup(rows), [rows]);

  const exportCsv = () => {
    const headers = [
      'Sold At', 'SKU', 'Name', 'Variety', 'Type', 'Order ID', 'Buyer', 'Username',
      'Sale Event', 'Sale Price', 'Refunded', 'Net Revenue', 'Cost', 'Profit', 'Status',
    ];
    const out = rows.map(i => {
      const sp = parseFloat(i.salePrice) || 0;
      const ref = parseFloat(i.refundedAmount) || 0;
      const cost = parseFloat(i.grossCost ?? i.cost) || 0;
      const net = effectiveRevenue(i);
      return [
        i.soldAt ? new Date(i.soldAt).toISOString().slice(0, 10) : '',
        i.sku || '',
        i.name || '',
        i.variety || '',
        i.type || '',
        i.orderId || '',
        i.buyer || '',
        i.buyerUsername || '',
        saleNameById[i.saleId] || '',
        sp.toFixed(2),
        ref.toFixed(2),
        net.toFixed(2),
        cost.toFixed(2),
        (net - cost).toFixed(2),
        i.status,
      ];
    });
    const csv = [headers, ...out]
      .map(r => r.map(v => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(','))
      .join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sold-items-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="flex-1 relative">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search SKU, name, buyer, order ID…"
            className="w-full pl-9 pr-3 py-2.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
        </div>
        <div className="flex gap-1 bg-gray-100 p-1 rounded-lg">
          {[
            { v: 'all',      label: 'All' },
            { v: 'sold',     label: 'Sold' },
            { v: 'refunded', label: 'Refunded' },
          ].map(opt => (
            <button
              key={opt.v}
              onClick={() => setStatusFilter(opt.v)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition ${
                statusFilter === opt.v
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-600 active:bg-gray-200'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <button
          onClick={exportCsv}
          disabled={rows.length === 0}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-100 active:bg-gray-200 disabled:opacity-50 rounded-lg"
        >
          <Download className="w-4 h-4" /> Export
        </button>
      </div>

      <div className="text-sm text-gray-600 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span><span className="font-semibold text-gray-900">{rows.length}</span> items</span>
        <span>Revenue <span className="font-semibold text-emerald-700">{fmt$(totals.revenue)}</span></span>
        <span>Profit <span className={`font-semibold ${totals.profit >= 0 ? 'text-blue-700' : 'text-red-700'}`}>{fmt$(totals.profit)}</span></span>
        {totals.refundsTotal > 0 && (
          <span>Refunded <span className="font-semibold text-amber-700">{fmt$(totals.refundsTotal)}</span></span>
        )}
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        {rows.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-gray-500">
            No sold items match.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Date</th>
                  <th className="px-3 py-2 text-left font-medium">SKU</th>
                  <th className="px-3 py-2 text-left font-medium">Item</th>
                  <th className="px-3 py-2 text-left font-medium hidden md:table-cell">Order / Buyer</th>
                  <th className="px-3 py-2 text-left font-medium hidden lg:table-cell">Sale Event</th>
                  <th className="px-3 py-2 text-right font-medium">Sale $</th>
                  <th className="px-3 py-2 text-right font-medium">Refunded</th>
                  <th className="px-3 py-2 text-right font-medium">Net</th>
                  <th className="px-3 py-2 text-right font-medium hidden sm:table-cell">Profit</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map(i => {
                  const sp = parseFloat(i.salePrice) || 0;
                  const ref = parseFloat(i.refundedAmount) || 0;
                  const cost = parseFloat(i.grossCost ?? i.cost) || 0;
                  const net = effectiveRevenue(i);
                  const profit = net - cost;
                  const isRefunded = i.status === 'refunded';
                  const partialRefund = !isRefunded && ref > 0;
                  return (
                    <tr key={i.id} className="hover:bg-gray-50/50">
                      <td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">
                        {i.soldAt ? new Date(i.soldAt).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-700">{i.sku || '—'}</td>
                      <td className="px-3 py-2">
                        <div className="text-gray-900 truncate max-w-[180px]">{i.name}</div>
                        {i.variety && <div className="text-xs text-gray-500 truncate max-w-[180px]">{i.variety}</div>}
                      </td>
                      <td className="px-3 py-2 hidden md:table-cell">
                        <div className="text-xs text-gray-600 font-mono truncate max-w-[140px]">{i.orderId || '—'}</div>
                        <div className="text-xs text-gray-500 truncate max-w-[140px]">
                          {i.buyer || ''}{i.buyerUsername ? ` · @${i.buyerUsername}` : ''}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-600 hidden lg:table-cell truncate max-w-[160px]">
                        {saleNameById[i.saleId] || '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-900">{fmt$2(sp)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${ref > 0 ? 'text-amber-700' : 'text-gray-400'}`}>
                        {ref > 0 ? `−${fmt$2(ref)}` : '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium text-emerald-700">{fmt$2(net)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums hidden sm:table-cell ${
                        profit >= 0 ? 'text-blue-700' : 'text-red-700'
                      }`}>
                        {cost > 0 ? fmt$2(profit) : '—'}
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge status={i.status} partialRefund={partialRefund} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────── Cashflow Sync ──────────────────────────────────

function CashflowSync({ items, onApplyRefunds }) {
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState(null);
  const [updates, setUpdates] = useState(null);
  const [unmatched, setUnmatched] = useState([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);

  const handleFile = async (file) => {
    setErr('');
    setLoading(true);
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      const result = parseCashflow(rows);
      if (result.refunds.length === 0) {
        setErr('No refund rows found in this file.');
        setParsed(null);
        setUpdates(null);
      } else {
        const built = buildRefundUpdates(result.refunds, items);
        setParsed(result);
        setUpdates(built.updates);
        setUnmatched(built.unmatched);
      }
    } catch (e) {
      setErr(`Could not read file: ${e.message}`);
      setParsed(null);
      setUpdates(null);
    }
    setLoading(false);
  };

  const reset = () => {
    setFileName('');
    setParsed(null);
    setUpdates(null);
    setUnmatched([]);
    setErr('');
  };

  const apply = async () => {
    if (!updates || updates.length === 0) return;
    setApplying(true);
    try {
      await onApplyRefunds(updates);
      reset();
    } finally {
      setApplying(false);
    }
  };

  const matchedAmount = updates?.reduce((s, u) => s + (u.refundedAmount || 0), 0) || 0;
  const unmatchedAmount = unmatched.reduce((s, r) => s + r.amount, 0);

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="text-sm text-gray-600 bg-blue-50 border border-blue-200 rounded-lg p-3">
        <div className="font-medium text-blue-900 mb-1 flex items-center gap-1.5">
          <RotateCcw className="w-4 h-4" /> Sync refunds from Palmstreet
        </div>
        <p>
          Upload a Palmstreet "Payout Cashflow List" export. Refund rows are matched
          to inventory items by Order ID. The refund amount on each order is
          distributed across that order's items proportionally to sale price.
        </p>
      </div>

      {!parsed ? (
        <>
          <label className="block">
            <div className="border-2 border-dashed border-gray-300 rounded-xl p-10 sm:p-14 text-center hover:border-emerald-400 hover:bg-emerald-50/50 active:bg-emerald-50 cursor-pointer transition">
              <Upload className="w-9 h-9 text-gray-400 mx-auto mb-2" />
              <div className="text-base font-medium text-gray-900">
                {loading ? 'Reading file…' : 'Upload cashflow xlsx'}
              </div>
              <div className="text-sm text-gray-500 mt-1">
                Looks for "Payout Cashflow List" exports
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
        </>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <div className="text-sm">
              <FileText className="w-4 h-4 inline mr-1 text-gray-400" />
              <span className="font-medium text-gray-900">{fileName}</span>
              <span className="text-gray-500"> · {parsed.refunds.length} refund rows</span>
            </div>
            <button onClick={reset} className="text-xs text-gray-600 hover:text-gray-900">
              Choose different file
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Kpi
              icon={Check}
              label="Items will be updated"
              value={updates.length}
              tone={updates.length > 0 ? 'emerald' : 'gray'}
            />
            <Kpi
              icon={DollarSign}
              label="Matched refund $"
              value={fmt$(matchedAmount)}
              tone="emerald"
            />
            <Kpi
              icon={AlertCircle}
              label="Unmatched orders"
              value={unmatched.length}
              sub={unmatched.length > 0 ? fmt$(unmatchedAmount) : null}
              tone={unmatched.length > 0 ? 'amber' : 'gray'}
            />
          </div>

          {updates.length > 0 && (
            <details open className="bg-white border border-gray-200 rounded-xl">
              <summary className="px-4 py-3 cursor-pointer font-medium text-gray-900 border-b border-gray-200 bg-emerald-50">
                Items to update ({updates.length})
              </summary>
              <div className="divide-y divide-gray-100 max-h-80 overflow-y-auto">
                {updates.map(u => {
                  const item = items.find(i => i.id === u.id);
                  if (!item) return null;
                  return (
                    <div key={u.id} className="px-4 py-2.5 flex items-start gap-3 text-sm">
                      <div className="flex-1 min-w-0">
                        <div className="text-gray-900 truncate">{item.name}{item.variety ? ` · ${item.variety}` : ''}</div>
                        <div className="text-xs text-gray-500 font-mono">
                          {item.sku} · order {item.orderId}
                        </div>
                      </div>
                      <div className="text-right whitespace-nowrap">
                        <div className="text-amber-700 font-medium tabular-nums">
                          −{fmt$2(u.refundedAmount)}
                        </div>
                        {u.status === 'refunded' && (
                          <div className="text-[11px] text-red-600">Full refund</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </details>
          )}

          {unmatched.length > 0 && (
            <details className="bg-white border border-gray-200 rounded-xl">
              <summary className="px-4 py-3 cursor-pointer font-medium text-gray-900 border-b border-gray-200 bg-amber-50">
                Unmatched refunds ({unmatched.length}) — will be ignored
              </summary>
              <div className="px-4 py-2 text-xs text-gray-600 bg-amber-50/40">
                These orders aren't in your inventory yet — likely from sales applied
                before order IDs were captured.
              </div>
              <div className="divide-y divide-gray-100 max-h-60 overflow-y-auto">
                {unmatched.slice(0, 50).map((r, idx) => (
                  <div key={idx} className="px-4 py-2 text-xs flex items-center justify-between">
                    <span className="font-mono text-gray-700">{r.orderId}</span>
                    <span className="text-amber-700 tabular-nums">−{fmt$2(r.amount)}</span>
                  </div>
                ))}
                {unmatched.length > 50 && (
                  <div className="px-4 py-2 text-xs text-gray-500">…and {unmatched.length - 50} more</div>
                )}
              </div>
            </details>
          )}

          <div className="flex justify-end gap-2 sticky bottom-0 bg-white border-t border-gray-200 -mx-4 px-4 py-3">
            <button onClick={reset} className="px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-100 active:bg-gray-200 rounded-lg">
              Cancel
            </button>
            <button
              onClick={apply}
              disabled={updates.length === 0 || applying}
              className="px-5 py-2.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 disabled:bg-gray-300 text-white rounded-lg flex items-center gap-1.5"
            >
              <Check className="w-4 h-4" /> {applying ? 'Applying…' : `Apply ${updates.length} updates`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────── Shared building blocks ────────────────────────

function Kpi(props) {
  const { icon: Icon, label, value, sub, tone = 'gray' } = props;
  const tones = {
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-900',
    blue:    'bg-blue-50 border-blue-200 text-blue-900',
    amber:   'bg-amber-50 border-amber-200 text-amber-900',
    red:     'bg-red-50 border-red-200 text-red-900',
    gray:    'bg-white border-gray-200 text-gray-900',
  };
  const iconTones = {
    emerald: 'text-emerald-600',
    blue:    'text-blue-600',
    amber:   'text-amber-600',
    red:     'text-red-600',
    gray:    'text-gray-400',
  };
  return (
    <div className={`border rounded-xl p-3 sm:p-4 ${tones[tone]}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium opacity-70">{label}</span>
        <Icon className={`w-4 h-4 ${iconTones[tone]}`} />
      </div>
      <div className="text-xl sm:text-2xl font-semibold mt-1 tabular-nums">{value}</div>
      {sub && <div className="text-xs opacity-70 mt-0.5 tabular-nums">{sub}</div>}
    </div>
  );
}

function PctBadge({ value }) {
  if (value === null || value === undefined) {
    return <span className="text-xs text-gray-400">—</span>;
  }
  const cls = value >= 50 ? 'bg-emerald-100 text-emerald-800'
    : value >= 0 ? 'bg-amber-100 text-amber-800'
    : 'bg-red-100 text-red-800';
  return <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${cls}`}>{fmtPct(value)}</span>;
}

function StatusBadge({ status, partialRefund }) {
  if (status === 'refunded') {
    return <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-800">Refunded</span>;
  }
  if (partialRefund) {
    return <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">Partial refund</span>;
  }
  if (status === 'shipped') {
    return <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">Shipped</span>;
  }
  if (status === 'delivered') {
    return <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">Delivered</span>;
  }
  return <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">Sold</span>;
}

function MonthlyDelta({ monthly }) {
  const last = monthly[monthly.length - 1];
  const prev = monthly[monthly.length - 2];
  if (!last || !prev) return null;
  if (prev.revenue === 0 && last.revenue === 0) return null;
  const delta = prev.revenue > 0 ? ((last.revenue - prev.revenue) / prev.revenue) * 100 : null;
  if (delta === null) return null;
  const up = delta >= 0;
  return (
    <div className="mt-3 flex items-center justify-center gap-1.5 text-xs">
      <span className="text-gray-500">{prev.label} → {last.label}:</span>
      {up ? (
        <ArrowUpRight className="w-3.5 h-3.5 text-emerald-600" />
      ) : (
        <ArrowDownRight className="w-3.5 h-3.5 text-red-600" />
      )}
      <span className={`font-medium tabular-nums ${up ? 'text-emerald-700' : 'text-red-700'}`}>
        {fmtPct(delta)}
      </span>
    </div>
  );
}

// Monthly gross profit trend, optionally filtered to a single item name.
// Bars grow up from a center baseline for profits and down for losses, so
// you can read months at a glance.
function ProfitTrendByName({ items }) {
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  // Distinct item names from items that have any sale activity. Sorted
  // alphabetically. Limited to names with at least one sold/refunded row.
  const itemNames = useMemo(() => {
    const set = new Set();
    for (const i of items) {
      if (!SOLD_STATUSES.has(i.status) && i.status !== 'refunded') continue;
      if (i.lotKind === 'giveaway') continue;
      if (i.name) set.add(i.name);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [items]);

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return itemNames.slice(0, 30);
    return itemNames.filter(n => n.toLowerCase().includes(q)).slice(0, 30);
  }, [itemNames, query]);

  const monthly = useMemo(() => {
    const now = new Date();
    const months = [];
    for (let k = 11; k >= 0; k--) {
      const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
      months.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        label: d.toLocaleDateString(undefined, { month: 'short' }),
        year: d.getFullYear(),
        items: [],
      });
    }
    const idx = Object.fromEntries(months.map((m, i) => [m.key, i]));
    for (const i of items) {
      if (!i.soldAt) continue;
      if (!SOLD_STATUSES.has(i.status) && i.status !== 'refunded') continue;
      if (i.lotKind === 'giveaway') continue;
      if (name && i.name !== name) continue;
      const d = new Date(i.soldAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (idx[key] === undefined) continue;
      months[idx[key]].items.push(i);
    }
    return months.map(m => ({ ...m, ...rollup(m.items) }));
  }, [items, name]);

  const maxProfitAbs = Math.max(1, ...monthly.map(m => Math.abs(m.profit)));
  const totalProfit = monthly.reduce((s, m) => s + m.profit, 0);
  const totalRevenue = monthly.reduce((s, m) => s + m.revenue, 0);
  const totalUnits = monthly.reduce((s, m) => s + m.unitsSold, 0);

  return (
    <>
      <div className="px-4 py-3 border-b border-gray-200 flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium text-gray-900 flex items-center gap-2">
            <Activity className="w-4 h-4 text-gray-400" /> Gross profit trend
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Monthly profit, last 12 months{name ? ` · ${name}` : ' · all items'}
          </p>
        </div>
        <div className="relative w-64 max-w-[60%]">
          <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            placeholder={name || 'Filter by item name…'}
            className="w-full pl-8 pr-8 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
          {(name || query) && (
            <button
              onClick={() => { setName(''); setQuery(''); setOpen(false); }}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-700"
              aria-label="Clear"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          {open && suggestions.length > 0 && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
              <div className="absolute z-20 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                {suggestions.map(n => (
                  <button
                    key={n}
                    onClick={() => { setName(n); setQuery(''); setOpen(false); }}
                    className="w-full px-3 py-2 text-left text-sm text-gray-900 hover:bg-emerald-50 truncate"
                  >
                    {n}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="p-4">
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-gray-600 mb-3">
          <span>Revenue <span className="font-semibold text-emerald-700">{fmt$(totalRevenue)}</span></span>
          <span>Profit <span className={`font-semibold ${totalProfit >= 0 ? 'text-blue-700' : 'text-red-700'}`}>{fmt$(totalProfit)}</span></span>
          <span>Units <span className="font-semibold text-gray-900">{totalUnits}</span></span>
        </div>
        <div className="relative h-40 flex items-stretch gap-1.5 border-y border-dashed border-gray-200">
          {monthly.map(m => {
            const h = (Math.abs(m.profit) / maxProfitAbs) * 50;  // half-height max
            const isPositive = m.profit >= 0;
            return (
              <div key={m.key} className="flex-1 flex flex-col group relative">
                <div className="flex-1 flex items-end justify-center">
                  {isPositive && m.profit > 0 && (
                    <div
                      className="w-full bg-blue-500 rounded-t"
                      style={{ height: `${Math.max(h, 2)}%` }}
                      title={`${m.label} ${m.year}: +${fmt$(m.profit)} profit · ${fmt$(m.revenue)} rev · ${m.unitsSold} sold`}
                    />
                  )}
                </div>
                <div className="flex-1 flex items-start justify-center">
                  {!isPositive && m.profit < 0 && (
                    <div
                      className="w-full bg-red-500 rounded-b"
                      style={{ height: `${Math.max(h, 2)}%` }}
                      title={`${m.label} ${m.year}: ${fmt$(m.profit)} loss · ${fmt$(m.revenue)} rev · ${m.unitsSold} sold`}
                    />
                  )}
                </div>
                <div className="absolute inset-x-0 bottom-full mb-0.5 text-center text-[10px] text-gray-500 opacity-0 group-hover:opacity-100 transition tabular-nums whitespace-nowrap">
                  {m.profit >= 0 ? '+' : ''}{fmt$(m.profit)}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex gap-1.5 mt-1">
          {monthly.map(m => (
            <div key={m.key} className="flex-1 text-center text-[10px] text-gray-500">{m.label}</div>
          ))}
        </div>
      </div>
    </>
  );
}
