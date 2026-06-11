import { useMemo, useRef, useState } from 'react';
import {
  Upload, FileText, AlertTriangle, RefreshCw, Download, Loader2, Check,
  TrendingUp, DollarSign, Boxes, Truck, Percent, ShoppingCart, Search, X,
  CalendarClock, Link2, Coins, FileImage, FileDown,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { Modal } from '../ui/Modal.jsx';
import { Kpi } from '../financial/FinancialChrome.jsx';
import { fmt$, fmt$2, fmtPct } from '../financial/financialHelpers.js';
import { parsePalmstreetOrders } from '../packing/parsePalmstreetOrders.js';
import {
  evaluateSale, applyManualMatch, loadEval, saveEval,
  LABOR_PER_BOX, SHIPPING_COST_PER_BOX, SELLER_COMMISSION_RATE,
} from './saleEval.js';

// The live's calendar day (YYYY-MM-DD, local). Prefer the plain `date` field;
// fall back to startTime. Used to check every order is dated on the live day.
function liveDayOf(sale) {
  if (sale?.date && /^\d{4}-\d{2}-\d{2}/.test(sale.date)) return sale.date.slice(0, 10);
  if (sale?.startTime) {
    const d = new Date(sale.startTime);
    if (!isNaN(d.getTime())) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${dd}`;
    }
  }
  return null;
}

// Per-live sales evaluation popup. Two views:
//   'upload' — drop/pick a Palmstreet orders CSV; parse + compute (READ-ONLY,
//              never touches inventory) and cache the result per sale id.
//   'report' — the financial dashboard for the cached result.
// `mode` ('evaluate' | 'report') picks the initial view.
export function SaleEvalModal({ sale, items, mode = 'evaluate', showToast, onGenerated, onClose }) {
  const existing = useMemo(() => loadEval(sale.id), [sale.id]);
  const saleDay = useMemo(() => liveDayOf(sale), [sale]);
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
      const res = evaluateSale(boxes, items, { fileName: file.name, saleName: sale.name, saleDay });
      const saved = saveEval(sale.id, res);
      setResult(res);
      setView('report');
      onGenerated?.();
      if (saved) {
        showToast?.(`Evaluated ${res.totals.lots} ${res.totals.lots === 1 ? 'sale' : 'sales'}`);
      } else {
        // localStorage quota (or private-mode block): the report shows now, but
        // hasEval() stays false so the "Financial Report" button won't appear.
        showToast?.('Report shown, but too large to save — re-upload to view it again later.', 'error');
      }
    } catch (e) {
      setErr(e.message || 'Could not read that file');
    }
    setLoading(false);
  };

  // Manual match override (read-only — recompute + re-cache this report only).
  const onMatch = (rowKey, item) => {
    if (!result) return;
    const next = applyManualMatch(result, rowKey, item);
    setResult(next);
    if (!saveEval(sale.id, next)) {
      showToast?.('Match applied, but the report is too large to save — it may not persist.', 'error');
    }
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
        <ReportView
          result={result}
          items={items}
          onMatch={onMatch}
          onReevaluate={() => { setView('upload'); setErr(''); }}
          showToast={showToast}
        />
      )}
    </Modal>
  );
}

function UploadView({ loading, fileName, err, hasExisting, onFile, onViewExisting }) {
  const fileRef = useRef(null);
  const [dragging, setDragging] = useState(false);

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

      <div
        onDragOver={(e) => { if (loading) return; e.preventDefault(); if (!dragging) setDragging(true); }}
        onDragLeave={(e) => { if (e.currentTarget.contains(e.relatedTarget)) return; setDragging(false); }}
        onDrop={(e) => {
          if (loading) return;
          e.preventDefault();
          setDragging(false);
          onFile(e.dataTransfer?.files?.[0]);
        }}
        onClick={() => !loading && fileRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition ${
          loading ? 'border-gray-200 bg-gray-50 cursor-default'
          : dragging ? 'border-emerald-500 bg-emerald-50'
          : 'border-emerald-300 hover:border-emerald-400 hover:bg-emerald-50/40'
        }`}
      >
        <input
          ref={fileRef}
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
            <span className="text-sm font-medium text-gray-900">
              {dragging ? 'Drop the file to evaluate' : 'Drop, or choose orders CSV / XLSX'}
            </span>
            <span className="text-xs text-gray-500">Palmstreet → Orders → Export</span>
          </div>
        )}
      </div>

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

function ReportView({ result, items, onMatch, onReevaluate, showToast }) {
  const t = result.totals;
  const generated = result.generatedAt ? new Date(result.generatedAt) : null;
  const profitTone = t.grossProfit >= 0 ? 'blue' : 'red';
  const costedLots = t.matchedCount - t.costlessMatched; // lots that actually contributed cost
  const reportRef = useRef(null);
  const [exporting, setExporting] = useState('');

  const onExport = async (format) => {
    if (!reportRef.current || exporting) return;
    setExporting(format);
    try {
      if (format === 'png') await exportReportPng(reportRef.current, result.saleName);
      else await exportReportPdf(reportRef.current, result.saleName);
    } catch (e) {
      showToast?.(`Could not export ${format.toUpperCase()}: ${e.message || 'failed'}`, 'error');
    }
    setExporting('');
  };
  const btn = 'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg disabled:opacity-50';

  return (
    <div ref={reportRef} className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-gray-500">
          {generated && <>Generated {generated.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</>}
          {result.saleDay && <> · live day {result.saleDay}</>}
          {result.fileName && <> · {result.fileName}</>}
        </div>
        <div className="flex flex-wrap gap-2" data-export-hide>
          <button onClick={() => onExport('png')} disabled={!!exporting} className={`${btn} text-gray-700 bg-white border border-gray-300 hover:bg-gray-50`}>
            {exporting === 'png' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileImage className="w-3.5 h-3.5" />} PNG
          </button>
          <button onClick={() => onExport('pdf')} disabled={!!exporting} className={`${btn} text-gray-700 bg-white border border-gray-300 hover:bg-gray-50`}>
            {exporting === 'pdf' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileDown className="w-3.5 h-3.5" />} PDF
          </button>
          <button onClick={() => exportLinesCsv(result)} className={`${btn} text-gray-700 bg-white border border-gray-300 hover:bg-gray-50`}>
            <Download className="w-3.5 h-3.5" /> CSV
          </button>
          <button onClick={onReevaluate} className={`${btn} text-emerald-700 bg-white border border-emerald-300 hover:bg-emerald-50`}>
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
        <Kpi icon={Truck} tone="gray" label="Shipping collected" value={fmt$(t.shippingCollected)} sub={`${t.boxes} ${t.boxes === 1 ? 'box' : 'boxes'}`} />
      </div>

      {/* Net-profit waterfall */}
      <NetProfit totals={t} />

      {/* Data-quality checklist */}
      <FlagsBanner result={result} />

      {/* Manual matching of unmatched lines */}
      <UnmatchedSection result={result} items={items} onMatch={onMatch} />

      {/* By variety */}
      {result.byVariety.length > 0 && <ByVariety rows={result.byVariety} />}

      {/* Top sellers */}
      <TopSellers result={result} />

      {/* Itemized table */}
      <ItemizedTable lines={result.lines} />
    </div>
  );
}

function NetProfit({ totals }) {
  const t = totals;
  const rows = [
    { label: 'Gross sales', value: t.grossSales, neg: false },
    { label: 'Shipping collected', value: t.shippingCollected, neg: false },
    { label: 'COGS', value: t.cogs, neg: true },
    { label: `Seller commission (${Math.round(SELLER_COMMISSION_RATE * 100)}% of gross sales)`, value: t.sellerCommission, neg: true },
    { label: `Labor ($${LABOR_PER_BOX} × ${t.boxes} ${t.boxes === 1 ? 'box' : 'boxes'})`, value: t.labor, neg: true },
    { label: `Shipping cost ($${SHIPPING_COST_PER_BOX} × ${t.boxes} ${t.boxes === 1 ? 'box' : 'boxes'})`, value: t.shippingCost, neg: true },
  ];
  const netTone = t.netProfit >= 0 ? 'text-blue-700' : 'text-red-700';

  return (
    <div className="border border-gray-200 rounded-xl p-4">
      <div className="flex items-center gap-1.5 mb-2">
        <Coins className="w-4 h-4 text-gray-400" />
        <h4 className="text-sm font-medium text-gray-900">Net profit</h4>
      </div>
      <div className="space-y-1 text-sm">
        {rows.map(r => (
          <div key={r.label} className="flex items-center justify-between">
            <span className="text-gray-600">{r.label}</span>
            <span className={`tabular-nums ${r.neg ? 'text-red-600' : 'text-gray-900'}`}>
              {r.neg ? '- ' : '+ '}{fmt$2(r.value)}
            </span>
          </div>
        ))}
        <div className="border-t border-gray-200 my-1.5" />
        <div className="flex items-center justify-between">
          <span className="font-semibold text-gray-900">Net profit</span>
          <span className={`font-semibold tabular-nums ${netTone}`}>{fmt$2(t.netProfit)}</span>
        </div>
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>Net margin (net profit / gross sales)</span>
          <span className="tabular-nums">{fmtPct(t.netMargin)}</span>
        </div>
      </div>
      {t.excludedRevenue > 0.005 && (
        <p className="text-[11px] text-amber-700 mt-2">
          COGS is missing for {fmt$2(t.excludedRevenue)} of unmatched sales — net profit is overstated until they're matched below.
        </p>
      )}
    </div>
  );
}

function Checkline({ ok, children }) {
  return (
    <div className={`flex items-start gap-2 ${ok ? 'text-emerald-700' : 'text-amber-900'}`}>
      {ok
        ? <Check className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
        : <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />}
      <span>{children}</span>
    </div>
  );
}

function FlagsBanner({ result }) {
  const t = result.totals;
  const { duplicateSkus, offDayLines, undatedCount } = result.flags;
  const dataOk = t.excludedRevenue <= 0.005;
  const dayOk = !!result.saleDay && offDayLines.length === 0 && undatedCount === 0;
  const dupOk = duplicateSkus.length === 0;

  return (
    <div className="space-y-1.5 text-sm bg-gray-50 border border-gray-200 rounded-lg p-3">
      {/* Profit coverage */}
      <Checkline ok={dataOk}>
        {dataOk
          ? 'Every sale line has a known cost — profit covers the whole live.'
          : <>
              <span className="font-medium tabular-nums">{fmt$2(t.excludedRevenue)}</span> in sales is excluded from profit
              {' '}({t.unmatchedCount} unmatched{t.costlessMatched > 0 ? ` + ${t.costlessMatched} matched without a cost` : ''}).
              Match them below to fold their cost in.
            </>}
      </Checkline>

      {/* Same-day check */}
      {result.saleDay ? (
        <Checkline ok={dayOk}>
          {dayOk
            ? <>All {t.lots} sales are dated on the live day ({result.saleDay}).</>
            : <>
                {offDayLines.length > 0 && (
                  <><span className="font-medium">{offDayLines.length}</span> sale{offDayLines.length === 1 ? '' : 's'} dated outside the live day ({result.saleDay}): <span className="font-medium">{offDayLines.slice(0, 6).map(l => l.sku || l.buyer || '?').join(', ')}</span>{offDayLines.length > 6 ? '…' : ''}. </>
                )}
                {undatedCount > 0 && <>{undatedCount} sale{undatedCount === 1 ? '' : 's'} have no order date to check. </>}
                Wrong file, or orders bled from another day?
              </>}
        </Checkline>
      ) : (
        <Checkline ok={false}>This live has no date set, so order dates couldn't be checked.</Checkline>
      )}

      {/* Possible double-sales */}
      {!dupOk && (
        <Checkline ok={false}>
          {duplicateSkus.length} SKU{duplicateSkus.length === 1 ? '' : 's'} sold on more than one order (possible double-sale):{' '}
          <span className="font-medium">{duplicateSkus.slice(0, 8).map(d => `${d.sku} ×${d.count}`).join(', ')}</span>
          {duplicateSkus.length > 8 ? '…' : ''}
        </Checkline>
      )}
    </div>
  );
}

function UnmatchedSection({ result, items, onMatch }) {
  const unmatched = result.flags.unmatchedLines;
  const manual = result.lines.filter(l => l.manual);
  if (unmatched.length === 0 && manual.length === 0) return null;

  return (
    <div>
      <h4 className="text-sm font-medium text-gray-900 mb-1 flex items-center gap-1.5">
        <Link2 className="w-4 h-4 text-gray-400" /> Unmatched lines
        {unmatched.length > 0 && <span className="text-gray-400 font-normal">({unmatched.length})</span>}
      </h4>
      <p className="text-xs text-gray-500 mb-2">
        No inventory SKU matched these. Match one to fold its cost into profit — this only affects
        this report, never your inventory.
      </p>
      <div className="space-y-1.5">
        {unmatched.map(l => (
          <div key={l.rowKey} className="flex flex-col sm:flex-row sm:items-center gap-2 bg-amber-50/60 border border-amber-200 rounded-lg px-3 py-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-gray-900 truncate">{l.title || l.sku || '—'}</div>
              <div className="text-[11px] text-gray-500 truncate">
                {l.buyer || '—'} · {l.sku || 'no SKU'} · {fmt$2(l.revenue)}
                {l.offDay && <span className="text-amber-700"> · off-day</span>}
              </div>
            </div>
            <ItemPicker items={items} onPick={(item) => onMatch(l.rowKey, item)} />
          </div>
        ))}
        {manual.map(l => (
          <div key={l.rowKey} className="flex items-center gap-2 bg-blue-50/60 border border-blue-200 rounded-lg px-3 py-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-gray-900 truncate">
                {l.title}
                <span className="ml-1.5 text-[10px] font-medium text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded-full">manual</span>
              </div>
              <div className="text-[11px] text-gray-500 truncate">
                {l.sku || 'no SKU'} · cost {l.cost != null ? fmt$2(l.cost) : '—'} · profit {l.profit != null ? fmt$2(l.profit) : '—'}
              </div>
            </div>
            <button
              onClick={() => onMatch(l.rowKey, null)}
              className="flex items-center gap-1 px-2 py-1 text-xs text-gray-600 hover:text-red-600 hover:bg-red-50 rounded"
            >
              <X className="w-3.5 h-3.5" /> Clear
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// Inline searchable item picker (suggestions render below the input rather than
// absolutely, so they never clip against the scrollable modal).
function ItemPicker({ items, onPick }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const live = useMemo(() => items.filter(i => !i.deletedAt), [items]);
  const suggestions = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return live
      .filter(i => `${i.name || ''} ${i.sku || ''} ${i.variety || ''}`.toLowerCase().includes(s))
      .slice(0, 12);
  }, [live, q]);

  return (
    <div className="w-full sm:w-60 flex-shrink-0">
      <div className="relative">
        <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Match to item…"
          className="w-full pl-8 pr-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
        />
      </div>
      {open && suggestions.length > 0 && (
        <div className="mt-1 border border-gray-200 rounded-lg bg-white max-h-44 overflow-y-auto shadow-sm">
          {suggestions.map(i => {
            const c = parseFloat(i.grossCost ?? i.cost);
            return (
              <button
                key={i.id}
                onClick={() => { onPick(i); setQ(''); setOpen(false); }}
                className="w-full px-3 py-1.5 text-left hover:bg-emerald-50"
              >
                <div className="text-sm text-gray-900 truncate">{i.name || '(no name)'}</div>
                <div className="text-[11px] text-gray-500 truncate">
                  {i.sku}{i.variety ? ` · ${i.variety}` : ''}{Number.isFinite(c) ? ` · cost ${fmt$2(c)}` : ' · no cost'}
                </div>
              </button>
            );
          })}
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
        <div className="max-h-72 overflow-y-auto" data-export-expand>
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
                <tr key={l.rowKey} className={!l.matched ? 'bg-amber-50/50' : l.offDay ? 'bg-amber-50/30' : ''}>
                  <td className="px-2 py-1.5 text-gray-700 truncate max-w-[7rem]" title={l.buyer}>{l.buyer || '—'}</td>
                  <td className="px-2 py-1.5 text-gray-500 whitespace-nowrap">{l.sku || '—'}</td>
                  <td className="px-2 py-1.5 text-gray-900 truncate max-w-[10rem]" title={l.title}>
                    {l.title || '—'}
                    {!l.matched && <span className="ml-1 text-[10px] text-amber-700">unmatched</span>}
                    {l.manual && <span className="ml-1 text-[10px] text-blue-700">manual</span>}
                    {l.offDay && <span className="ml-1 text-[10px] text-amber-700 inline-flex items-center gap-0.5"><CalendarClock className="w-3 h-3" />off-day</span>}
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
    'Qty', 'Sale Price', 'Shipping Fee', 'Cost', 'Profit', 'Matched', 'Manual', 'Off-day',
  ];
  const rows = result.lines.map(l => [
    l.buyer, l.username, l.orderNumber,
    l.orderDate ? new Date(l.orderDate).toLocaleString() : '',
    l.sku, l.title, l.variety || '',
    l.quantity, l.revenue.toFixed(2), l.shippingFee.toFixed(2),
    l.cost != null ? l.cost.toFixed(2) : '',
    l.profit != null ? l.profit.toFixed(2) : '',
    l.matched ? 'yes' : 'no',
    l.manual ? 'yes' : 'no',
    l.offDay ? 'yes' : 'no',
  ]);
  const t = result.totals;
  const sumRow = (label, amount) => {
    const r = Array(headers.length).fill('');
    r[0] = label;
    r[11] = amount == null ? '' : amount.toFixed(2);
    return r;
  };
  rows.push([]);
  rows.push(['TOTALS', '', '', '', '', '', '', t.lots, t.grossSales.toFixed(2), t.shippingCollected.toFixed(2), t.cogs.toFixed(2), t.grossProfit.toFixed(2), `${t.matchedCount}/${t.lots}`, '', '']);
  rows.push(sumRow(`Seller commission (${Math.round(SELLER_COMMISSION_RATE * 100)}%)`, t.sellerCommission));
  rows.push(sumRow(`Labor ($${LABOR_PER_BOX} x ${t.boxes} boxes)`, t.labor));
  rows.push(sumRow(`Shipping cost ($${SHIPPING_COST_PER_BOX} x ${t.boxes} boxes)`, t.shippingCost));
  rows.push(sumRow('Net profit', t.netProfit));
  rows.push(['Net margin', '', '', '', '', '', '', '', '', '', '', t.netMargin == null ? '' : `${t.netMargin.toFixed(1)}%`]);
  const csv = [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\n');
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `${slugName(result.saleName)}-sales-eval.csv`);
}

// ── Image / PDF export ───────────────────────────────────────────────────────
const slugName = (s) => (s || 'sale').replace(/[^a-z0-9]+/gi, '-').toLowerCase();

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Rasterize the report node. onclone expands inner-scroll regions and hides the
// export buttons so the snapshot is the full report, not a clipped viewport.
// html2canvas + jsPDF are dynamically imported so they stay out of the main bundle.
async function captureReport(node) {
  const { default: html2canvas } = await import('html2canvas');
  return html2canvas(node, {
    backgroundColor: '#ffffff',
    scale: 2,
    useCORS: true,
    onclone: (doc) => {
      doc.querySelectorAll('[data-export-expand]').forEach((el) => {
        el.style.maxHeight = 'none';
        el.style.overflow = 'visible';
      });
      doc.querySelectorAll('[data-export-hide]').forEach((el) => { el.style.display = 'none'; });
    },
  });
}

async function exportReportPng(node, saleName) {
  const canvas = await captureReport(node);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('canvas is empty');
  downloadBlob(blob, `${slugName(saleName)}-report.png`);
}

async function exportReportPdf(node, saleName) {
  const canvas = await captureReport(node);
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const margin = 24;
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const imgW = pageW - margin * 2;
  const fullImgH = (canvas.height * imgW) / canvas.width;
  const contentH = pageH - margin * 2;

  if (fullImgH <= contentH) {
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', margin, margin, imgW, fullImgH);
  } else {
    // Tall report: slice the canvas into page-height chunks across pages.
    // max(1,…) guarantees the loop always advances (never a zero-height slice).
    const slicePx = Math.max(1, Math.floor((contentH * canvas.width) / imgW));
    let y = 0;
    let first = true;
    while (y < canvas.height) {
      const h = Math.min(slicePx, canvas.height - y);
      const slice = document.createElement('canvas');
      slice.width = canvas.width;
      slice.height = h;
      slice.getContext('2d').drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
      if (!first) pdf.addPage();
      pdf.addImage(slice.toDataURL('image/png'), 'PNG', margin, margin, imgW, (h * imgW) / canvas.width);
      slice.width = 0; slice.height = 0; // release the slice canvas to cap peak memory
      first = false;
      y += h;
    }
  }
  pdf.save(`${slugName(saleName)}-report.pdf`);
}
