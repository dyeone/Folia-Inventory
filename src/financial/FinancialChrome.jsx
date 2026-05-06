import { useMemo, useState } from 'react';
import { ArrowUpRight, ArrowDownRight, Search, X, Activity } from 'lucide-react';
import { fmt$, fmtPct, rollup, SOLD_STATUSES } from './financialHelpers.js';

// Tonal headline KPI cell used across the Financial overview.
export function Kpi(props) {
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

export function PctBadge({ value }) {
  if (value === null || value === undefined) {
    return <span className="text-xs text-gray-400">—</span>;
  }
  const cls = value >= 50 ? 'bg-emerald-100 text-emerald-800'
    : value >= 0 ? 'bg-amber-100 text-amber-800'
    : 'bg-red-100 text-red-800';
  return <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${cls}`}>{fmtPct(value)}</span>;
}

export function StatusBadge({ status, partialRefund }) {
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

export function MonthlyDelta({ monthly }) {
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
export function ProfitTrendByName({ items }) {
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

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
            const h = (Math.abs(m.profit) / maxProfitAbs) * 50;
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
