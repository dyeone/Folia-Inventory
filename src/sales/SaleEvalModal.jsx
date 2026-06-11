import { useMemo, useState } from 'react';
import {
  Upload, FileText, AlertTriangle, RefreshCw, Download, Loader2,
  TrendingUp, DollarSign, Boxes, Truck, Percent, Tag, ShoppingCart,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { Modal } from '../ui/Modal.jsx';
import { Kpi } from '../financial/FinancialChrome.jsx';
import { fmt$, fmt$2, fmtPct } from '../financial/financialHelpers.js';
import { parsePalmstreetOrders } from '../packing/parsePalmstreetOrders.js';
import { evaluateSale, loadEval, saveEval } from './saleEval.js';

// Per-live sales evaluation popup. Two views:
//   'upload' — pick a Palmstreet orders CSV; parse + compute (READ-ONLY,
//              never touches inventory) and cache the result per sale id.
//   'report' — the financial dashboard for the cached result.
// `mode` ('evaluate' | 'report') picks the initial view.
export function SaleEvalModal({ sale, items, mode = 'evaluate', showToast, onGenerated, onClose }) {
  const existing = useMemo(() => loadEval(sale.id), [sale.id]);
  const [result, setResult] = useState(mode === 'report' ? existing : null);
  const [view, setView] = useState(mode === 'report' && existing ? 'report' : 'upload');
  const [fileName, setFileName] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const handleFile = async (file) => {
    if (!file) return;
    setErr(''); setLoading(true); setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheetName = wb.SheetNames[0];
      if (!sheetName) {
        setErr('That file has no sheets to read.');
        setLoading(false);
        return;
      }
      const sheet = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      const boxes = parsePalmstreetOrders(rows);
      if (boxes.length === 0) {
        setErr('No sales found in this file. Is it a Palmstreet orders export?');
        setLoading(false);
        return;
      }
      const res = evaluateSale(boxes, items, { fileName: file.name, saleName: sale.name });
      const saved = saveEval(sale.id, res);
      setResult(res);
      setView('report');
      onGenerated?.();
      if (saved) {
        showToast?.(`Evaluated ${res.totals.lots} ${res.totals.lots === 1 ? 'sale' : 'sales'}`);
      } else {
        // localStorage quota (or private-mode block): the report shows now, but
        // hasEval() stays false so the "Financial Report" button won't appear.
        // Tell the operator instead of letting it silently vanish.
        showToast?.('Report shown, but too large to save — re-upload to view it again later.', 'error');
      }
    } catch (e) {
      setErr(e.message || 'Could not read that file');
    }
    setLoading(false);
  };

  const title = view === 'report' ? `Financial Report — ${sale.name}` : `Evaluate Sales — ${sale.name}`;

  return (
    <Modal title={title} onClose={onClose} size="xl">
      {view === 'upload' ? (
        <UploadView
          loading={loading}
          fileName={fileName}
          err={err}
          hasExisting={!!existing}
          onFile={handleFile}
          onViewExisting={() => { setResult(existing); setView('report'); }}
        />
      ) : (
        <ReportView result={result} onReevaluate={() => { setView('upload'); setErr(''); }} />
      )}
    </Modal>
  );
}

function UploadView({ loading, fileName, err, hasExisting, onFile, onViewExisting }) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 text-sm text-gray-600 bg-emerald-50 border border-emerald-200 rounded-lg p-3">
        <ShoppingCart className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
        <p>
          Upload this live's Palmstreet <span className="font-medium">orders</span> export to evaluate
          its sales. This is <span className="font-medium">read-only</span> — it reads cost from your
          inventory to compute profit, but never changes any item's status. (To mark items sold, use
          Validate Sales.) Revenue is order-time gross from this file; refunds aren't reflected.
        </p>
      </div>

      <label className={`block border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition ${
        loading ? 'border-gray-200 bg-gray-50' : 'border-emerald-300 hover:border-emerald-400 hover:bg-emerald-50/40'
      }`}>
        <input
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          disabled={loading}
          onChange={(e) => onFile(e.target.files?.[0])}
        />
        {loading ? (
          <div className="flex flex-col items-center gap-2 text-gray-500">
            <Loader2 className="w-7 h-7 animate-spin" />
            <span className="text-sm">Reading {fileName}…</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <Upload className="w-7 h-7 text-emerald-600" />
            <span className="text-sm font-medium text-gray-900">Choose orders CSV / XLSX</span>
            <span className="text-xs text-gray-500">Palmstreet → Orders → Export</span>
          </div>
        )}
      </label>

      {err && (
        <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {err}
        </div>
      )}

      {hasExisting && (
        <button
          onClick={onViewExisting}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium text-emerald-700 bg-white border border-emerald-300 hover:bg-emerald-50 rounded-lg"
        >
          <FileText className="w-4 h-4" /> View last report
        </button>
      )}
    </div>
  );
}

function ReportView({ result, onReevaluate }) {
  const t = result.totals;
  const generated = result.generatedAt ? new Date(result.generatedAt) : null;
  const profitTone = t.grossProfit >= 0 ? 'blue' : 'red';
  const costedLots = t.matchedCount - t.costlessMatched; // lots that actually contributed cost

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-gray-500">
          {generated && <>Generated {generated.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</>}
          {result.fileName && <> · {result.fileName}</>}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => exportLinesCsv(result)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded-lg"
          >
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>
          <button
            onClick={onReevaluate}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-700 bg-white border border-emerald-300 hover:bg-emerald-50 rounded-lg"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Re-evaluate
          </button>
        </div>
      </div>

      {/* Headline KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
        <Kpi icon={DollarSign} tone="emerald" label="Gross sales" value={fmt$(t.grossSales)} sub={`${t.orders} orders · ${t.buyers} buyers`} />
        <Kpi icon={Boxes} tone="amber" label="COGS" value={fmt$(t.cogs)} sub={`${costedLots} lots with cost`} />
        <Kpi icon={TrendingUp} tone={profitTone} label="Gross profit" value={fmt$(t.grossProfit)} sub="matched lots only" />
        <Kpi icon={Percent} tone={profitTone} label="Margin" value={fmtPct(t.margin)} sub="profit / matched rev" />
        <Kpi icon={ShoppingCart} tone="gray" label="Lots sold" value={t.lots} sub={`${t.matchedCount} matched · ${t.unmatchedCount} unmatched`} />
        <Kpi icon={Truck} tone="gray" label="Shipping collected" value={fmt$(t.shippingCollected)} sub={t.avgSale != null ? `avg sale ${fmt$2(t.avgSale)}` : null} />
      </div>

      {/* Data-quality flags */}
      <FlagsBanner result={result} />

      {/* By variety */}
      {result.byVariety.length > 0 && <ByVariety rows={result.byVariety} />}

      {/* Top sellers */}
      <TopSellers result={result} />

      {/* Itemized table */}
      <ItemizedTable lines={result.lines} />
    </div>
  );
}

function FlagsBanner({ result }) {
  const t = result.totals;
  const dups = result.flags.duplicateSkus;
  const showExcluded = t.excludedRevenue > 0.005;
  if (!showExcluded && dups.length === 0) {
    return (
      <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
        Every sale line matched an inventory item with a recorded cost — profit covers the whole live.
      </div>
    );
  }
  return (
    <div className="space-y-2 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-3">
      {showExcluded && (
        <div className="flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <span>
            <span className="font-medium tabular-nums">{fmt$2(t.excludedRevenue)}</span> in sales is excluded from profit
            {' '}({t.unmatchedCount} unmatched line{t.unmatchedCount === 1 ? '' : 's'}
            {t.costlessMatched > 0 ? ` + ${t.costlessMatched} matched without a recorded cost` : ''}).
            Fix the SKU or set the item cost, then re-evaluate.
          </span>
        </div>
      )}
      {dups.length > 0 && (
        <div className="flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <span>
            {dups.length} SKU{dups.length === 1 ? '' : 's'} sold on more than one order (possible double-sale):{' '}
            <span className="font-medium">{dups.slice(0, 8).map(d => `${d.sku} ×${d.count}`).join(', ')}</span>
            {dups.length > 8 ? '…' : ''}
          </span>
        </div>
      )}
    </div>
  );
}

function ByVariety({ rows }) {
  const max = Math.max(1, ...rows.map(r => r.revenue));
  return (
    <div>
      <h4 className="text-sm font-medium text-gray-900 mb-2">By variety</h4>
      <div className="space-y-1.5">
        {rows.map(r => {
          const unmatched = r.variety === '(unmatched)';
          return (
            <div key={r.variety} className="flex items-center gap-2 text-xs">
              <div className="w-28 sm:w-36 truncate text-gray-700" title={r.variety}>{r.variety}</div>
              <div className="flex-1 bg-gray-100 rounded-full h-4 overflow-hidden">
                <div
                  className={`h-full rounded-full ${unmatched ? 'bg-gray-300' : 'bg-emerald-500'}`}
                  style={{ width: `${(r.revenue / max) * 100}%` }}
                />
              </div>
              <div className="w-16 text-right tabular-nums font-medium text-gray-900">{fmt$(r.revenue)}</div>
              <div className={`w-16 text-right tabular-nums ${r.hasCost ? (r.profit >= 0 ? 'text-blue-700' : 'text-red-700') : 'text-gray-400'}`}>
                {r.hasCost ? fmt$(r.profit) : '—'}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2 text-[10px] text-gray-400 mt-1">
        <span className="w-28 sm:w-36" />
        <span className="flex-1" />
        <span className="w-16 text-right">revenue</span>
        <span className="w-16 text-right">profit</span>
      </div>
    </div>
  );
}

function TopSellers({ result }) {
  const { topByRevenue, topByProfit } = result;
  if (topByRevenue.length === 0) return null;
  return (
    <div className="grid sm:grid-cols-2 gap-4">
      <TopList title="Top by revenue" lines={topByRevenue} valueOf={(l) => fmt$2(l.revenue)} />
      {topByProfit.length > 0 && (
        <TopList title="Top by profit" lines={topByProfit} valueOf={(l) => fmt$2(l.profit)} tone="blue" />
      )}
    </div>
  );
}

function TopList({ title, lines, valueOf, tone = 'emerald' }) {
  const valCls = tone === 'blue' ? 'text-blue-700' : 'text-emerald-700';
  return (
    <div>
      <h4 className="text-sm font-medium text-gray-900 mb-2">{title}</h4>
      <div className="space-y-1">
        {lines.map((l, i) => (
          <div key={l.rowKey} className="flex items-center gap-2 text-xs">
            <span className="w-4 text-gray-400 tabular-nums">{i + 1}</span>
            <span className="flex-1 truncate text-gray-700" title={l.title}>
              {l.title || l.sku}
              {l.sku && <span className="text-gray-400"> · {l.sku}</span>}
            </span>
            <span className={`tabular-nums font-medium ${valCls}`}>{valueOf(l)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ItemizedTable({ lines }) {
  const sorted = useMemo(() => [...lines].sort((a, b) => b.revenue - a.revenue), [lines]);
  return (
    <div>
      <h4 className="text-sm font-medium text-gray-900 mb-2">All sales ({lines.length})</h4>
      <div className="border border-gray-200 rounded-lg overflow-hidden">
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 sticky top-0">
              <tr className="text-gray-500 text-left">
                <th className="px-2 py-1.5 font-medium">Buyer</th>
                <th className="px-2 py-1.5 font-medium">SKU</th>
                <th className="px-2 py-1.5 font-medium">Item</th>
                <th className="px-2 py-1.5 font-medium text-right">Sale</th>
                <th className="px-2 py-1.5 font-medium text-right">Cost</th>
                <th className="px-2 py-1.5 font-medium text-right">Profit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sorted.map(l => (
                <tr key={l.rowKey} className={l.matched ? '' : 'bg-amber-50/50'}>
                  <td className="px-2 py-1.5 text-gray-700 truncate max-w-[7rem]" title={l.buyer}>{l.buyer || '—'}</td>
                  <td className="px-2 py-1.5 text-gray-500 whitespace-nowrap">{l.sku || '—'}</td>
                  <td className="px-2 py-1.5 text-gray-900 truncate max-w-[10rem]" title={l.title}>
                    {l.title || '—'}
                    {!l.matched && <span className="ml-1 text-[10px] text-amber-700">unmatched</span>}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-gray-900">{fmt$2(l.revenue)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">{l.cost != null ? fmt$2(l.cost) : '—'}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${l.profit == null ? 'text-gray-400' : l.profit >= 0 ? 'text-blue-700' : 'text-red-700'}`}>
                    {l.profit != null ? fmt$2(l.profit) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── CSV export ─────────────────────────────────────────────────────────────
function csvCell(v) {
  let s = v == null ? '' : String(v);
  // Neutralize spreadsheet formula injection: a value starting with = + - @
  // (or a control char) can execute as a formula when the CSV is opened in
  // Excel/Sheets. Buyer names and item titles are untrusted Palmstreet data.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportLinesCsv(result) {
  const headers = [
    'Buyer', 'Username', 'Order', 'Order Date', 'SKU', 'Item', 'Variety',
    'Qty', 'Sale Price', 'Shipping Fee', 'Cost', 'Profit', 'Matched',
  ];
  const rows = result.lines.map(l => [
    l.buyer, l.username, l.orderNumber,
    l.orderDate ? new Date(l.orderDate).toLocaleString() : '',
    l.sku, l.title, l.variety || '',
    l.quantity, l.revenue.toFixed(2), l.shippingFee.toFixed(2),
    l.cost != null ? l.cost.toFixed(2) : '',
    l.profit != null ? l.profit.toFixed(2) : '',
    l.matched ? 'yes' : 'no',
  ]);
  const t = result.totals;
  rows.push([]);
  rows.push(['TOTALS', '', '', '', '', '', '', t.lots, t.grossSales.toFixed(2), t.shippingCollected.toFixed(2), t.cogs.toFixed(2), t.grossProfit.toFixed(2), `${t.matchedCount}/${t.lots}`]);
  const csv = [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = (result.saleName || 'sale').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  a.href = url;
  a.download = `${safeName}-sales-eval.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
