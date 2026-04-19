import { useState, useMemo } from 'react';
import { X, FileCheck, Upload, AlertCircle, Check } from 'lucide-react';
import * as XLSX from 'xlsx';

export function ReconcileModal({ sale, items, onApply, onClose }) {
  const [fileName, setFileName] = useState('');
  const [parsedRows, setParsedRows] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [markUnsoldAs, setMarkUnsoldAs] = useState('unassign');

  const lineupItems = useMemo(() => items.filter(i => i.saleId === sale.id), [items, sale.id]);

  const matches = useMemo(() => {
    if (!parsedRows) return null;
    const skuMap = new Map();
    lineupItems.forEach(i => {
      if (i.sku) skuMap.set(String(i.sku).trim().toLowerCase(), i);
    });

    const matched = [];
    const unmatched = [];
    const matchedIds = new Set();

    parsedRows.forEach(row => {
      const key = String(row.sku || '').trim().toLowerCase();
      if (key && skuMap.has(key)) {
        const item = skuMap.get(key);
        matched.push({ row, item });
        matchedIds.add(item.id);
      } else {
        unmatched.push(row);
      }
    });

    const unsold = lineupItems.filter(i => !matchedIds.has(i.id));
    return { matched, unmatched, unsold };
  }, [parsedRows, lineupItems]);

  const handleFile = async (file) => {
    setErr('');
    setLoading(true);
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      if (!rows.length) {
        setErr('No rows found in the spreadsheet.');
        setLoading(false);
        return;
      }

      const firstRow = rows[0];
      const keys = Object.keys(firstRow);
      const findKey = (patterns) => {
        for (const p of patterns) {
          const found = keys.find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '').includes(p));
          if (found) return found;
        }
        return null;
      };

      const skuKey = findKey(['sku']);
      const priceKey = findKey(['soldprice', 'saleprice', 'price', 'amount', 'total']);
      const qtyKey = findKey(['quantity', 'qty']);
      const titleKey = findKey(['title', 'productname', 'itemname', 'product']);
      const buyerKey = findKey(['buyer', 'customer', 'username']);
      const orderKey = findKey(['orderid', 'ordernumber', 'order']);

      if (!skuKey) {
        setErr(`Couldn't find a SKU column. Available columns: ${keys.join(', ')}`);
        setLoading(false);
        return;
      }

      const parsed = rows.map(r => ({
        sku: String(r[skuKey] || '').trim(),
        price: priceKey ? parseFloat(r[priceKey]) || 0 : 0,
        quantity: qtyKey ? parseInt(r[qtyKey]) || 1 : 1,
        title: titleKey ? String(r[titleKey] || '') : '',
        buyer: buyerKey ? String(r[buyerKey] || '') : '',
        orderId: orderKey ? String(r[orderKey] || '') : '',
        raw: r,
      })).filter(r => r.sku);

      setParsedRows(parsed);
    } catch (e) {
      setErr(`Could not read file: ${e.message}`);
    }
    setLoading(false);
  };

  const handleApply = () => {
    if (!matches) return;
    const updates = [];

    matches.matched.forEach(({ row, item }) => {
      const finalSalePrice = row.price > 0 ? row.price : parseFloat(item.listingPrice) || 0;
      const cost = parseFloat(item.grossCost ?? item.cost) || 0;
      const profit = cost > 0 ? finalSalePrice - cost : null;
      const profitRate = cost > 0 ? ((finalSalePrice - cost) / cost) * 100 : null;
      updates.push({
        id: item.id,
        status: 'sold',
        salePrice: finalSalePrice,
        soldAt: new Date().toISOString(),
        buyer: row.buyer || item.buyer,
        orderId: row.orderId || null,
        actualProfit: profit,
        actualProfitRate: profitRate,
      });
    });

    matches.unsold.forEach(item => {
      const update = { id: item.id };
      if (markUnsoldAs === 'unassign') {
        update.saleId = null;
        update.lotNumber = null;
        update.status = 'available';
      } else if (markUnsoldAs === 'available') {
        update.status = 'available';
      } else {
        return;
      }
      updates.push(update);
    });

    onApply(updates);
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-stretch sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-3xl h-full sm:h-auto sm:max-h-[90vh] sm:rounded-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-gray-200 px-4 py-3 flex items-center justify-between flex-shrink-0">
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-gray-900 flex items-center gap-2">
              <FileCheck className="w-4 h-4 text-amber-600" />
              Reconcile Orders · <span className="truncate">{sale.name}</span>
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">Import Palmstreet orders to mark sold items and return unsold to inventory</p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-500 hover:bg-gray-100 rounded ml-2">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {!parsedRows && (
            <div>
              <label className="block">
                <div className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center hover:border-emerald-400 hover:bg-emerald-50/50 cursor-pointer transition">
                  <Upload className="w-8 h-8 text-gray-400 mx-auto mb-2" />
                  <div className="text-sm font-medium text-gray-900">
                    {loading ? 'Reading file...' : 'Upload Palmstreet orders file'}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">.xlsx or .csv</div>
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
                <div className="font-medium text-gray-900 mb-1">What happens next:</div>
                <ul className="space-y-0.5 list-disc list-inside">
                  <li>SKUs in the orders file that match your sale lineup → marked sold with sale price</li>
                  <li>Lineup items NOT in the orders → returned to available inventory</li>
                  <li>You'll see a preview before anything is saved</li>
                </ul>
              </div>
            </div>
          )}

          {parsedRows && matches && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="text-sm">
                  <span className="text-gray-500">File:</span>{' '}
                  <span className="font-medium text-gray-900">{fileName}</span>
                  <span className="text-gray-500"> · {parsedRows.length} order rows</span>
                </div>
                <button onClick={() => { setParsedRows(null); setFileName(''); }} className="text-xs text-gray-600 hover:text-gray-900">
                  Choose different file
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                  <div className="text-xs text-emerald-700">Will mark sold</div>
                  <div className="text-2xl font-semibold text-emerald-900">{matches.matched.length}</div>
                </div>
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <div className="text-xs text-amber-700">Returning to inventory</div>
                  <div className="text-2xl font-semibold text-amber-900">{matches.unsold.length}</div>
                </div>
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
                  <div className="text-xs text-gray-600">Unmatched orders</div>
                  <div className="text-2xl font-semibold text-gray-900">{matches.unmatched.length}</div>
                </div>
              </div>

              {matches.unsold.length > 0 && (
                <div className="bg-white border border-gray-200 rounded-lg p-3">
                  <div className="text-sm font-medium text-gray-900 mb-2">
                    For the {matches.unsold.length} unsold {matches.unsold.length === 1 ? 'item' : 'items'}:
                  </div>
                  <div className="space-y-1.5">
                    <label className="flex items-start gap-2 text-sm cursor-pointer">
                      <input type="radio" name="unsold" checked={markUnsoldAs === 'unassign'} onChange={() => setMarkUnsoldAs('unassign')} className="mt-1" />
                      <div>
                        <div className="text-gray-900">Return to available inventory</div>
                        <div className="text-xs text-gray-500">Unassign from this sale, clear lot number, status = available</div>
                      </div>
                    </label>
                    <label className="flex items-start gap-2 text-sm cursor-pointer">
                      <input type="radio" name="unsold" checked={markUnsoldAs === 'available'} onChange={() => setMarkUnsoldAs('available')} className="mt-1" />
                      <div>
                        <div className="text-gray-900">Mark available but keep sale assignment</div>
                        <div className="text-xs text-gray-500">Useful if you want to re-run the same sale</div>
                      </div>
                    </label>
                    <label className="flex items-start gap-2 text-sm cursor-pointer">
                      <input type="radio" name="unsold" checked={markUnsoldAs === 'keep'} onChange={() => setMarkUnsoldAs('keep')} className="mt-1" />
                      <div>
                        <div className="text-gray-900">Don't change unsold items</div>
                        <div className="text-xs text-gray-500">Only mark the sold ones</div>
                      </div>
                    </label>
                  </div>
                </div>
              )}

              {matches.matched.length > 0 && (
                <details className="bg-white border border-gray-200 rounded-lg" open>
                  <summary className="px-3 py-2 cursor-pointer text-sm font-medium text-gray-900 bg-emerald-50 border-b border-emerald-200 rounded-t-lg flex items-center justify-between">
                    <span>Matched Sales ({matches.matched.length})</span>
                    {(() => {
                      const withCost = matches.matched.filter(({ row, item }) => {
                        const sp = row.price || parseFloat(item.listingPrice) || 0;
                        const cost = parseFloat(item.grossCost ?? item.cost) || 0;
                        return sp > 0 && cost > 0;
                      });
                      if (withCost.length === 0) return null;
                      const rates = withCost.map(({ row, item }) => {
                        const sp = row.price || parseFloat(item.listingPrice) || 0;
                        const cost = parseFloat(item.grossCost ?? item.cost);
                        return ((sp - cost) / cost) * 100;
                      });
                      const avgRate = rates.reduce((a, b) => a + b, 0) / rates.length;
                      return (
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                          avgRate >= 200 ? 'bg-emerald-200 text-emerald-900' :
                          avgRate >= 100 ? 'bg-blue-200 text-blue-900' :
                          avgRate >= 0 ? 'bg-amber-200 text-amber-900' :
                          'bg-red-200 text-red-900'
                        }`}>
                          Avg {avgRate >= 0 ? '+' : ''}{avgRate.toFixed(0)}%
                        </span>
                      );
                    })()}
                  </summary>
                  <div className="divide-y divide-gray-100 max-h-60 overflow-y-auto">
                    {matches.matched.map(({ row, item }, idx) => {
                      const sp = row.price || parseFloat(item.listingPrice) || 0;
                      const cost = parseFloat(item.grossCost ?? item.cost) || 0;
                      const hasProfit = sp > 0 && cost > 0;
                      const rate = hasProfit ? ((sp - cost) / cost) * 100 : null;
                      return (
                        <div key={idx} className="flex items-center justify-between px-3 py-2 text-xs">
                          <div className="min-w-0 flex-1">
                            <div className="font-medium text-gray-900 truncate">{item.name}{item.variety ? ` · ${item.variety}` : ''}</div>
                            <div className="text-gray-500 font-mono">{item.sku}{row.buyer && ` · ${row.buyer}`}</div>
                          </div>
                          <div className="text-right ml-2 whitespace-nowrap">
                            <div className="text-emerald-700 font-medium">${sp.toFixed(2)}</div>
                            {hasProfit ? (
                              <div className={`text-xs font-medium ${
                                rate >= 100 ? 'text-emerald-600' : rate >= 0 ? 'text-amber-600' : 'text-red-600'
                              }`}>
                                {rate >= 0 ? '+' : ''}{rate.toFixed(0)}%
                              </div>
                            ) : cost === 0 ? (
                              <div className="text-xs text-gray-400">no cost</div>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </details>
              )}

              {matches.unsold.length > 0 && (
                <details className="bg-white border border-gray-200 rounded-lg">
                  <summary className="px-3 py-2 cursor-pointer text-sm font-medium text-gray-900 bg-amber-50 border-b border-amber-200 rounded-t-lg">
                    Unsold — Returning to Inventory ({matches.unsold.length})
                  </summary>
                  <div className="divide-y divide-gray-100 max-h-60 overflow-y-auto">
                    {matches.unsold.map(item => (
                      <div key={item.id} className="flex items-center justify-between px-3 py-2 text-xs">
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-gray-900 truncate">{item.name}</div>
                          <div className="text-gray-500 font-mono">
                            {item.sku}{item.lotNumber && ` · Lot #${item.lotNumber}`}
                          </div>
                        </div>
                        <div className="text-gray-500 ml-2 whitespace-nowrap">
                          ${parseFloat(item.listingPrice || 0).toFixed(0)}
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {matches.unmatched.length > 0 && (
                <details className="bg-white border border-gray-200 rounded-lg">
                  <summary className="px-3 py-2 cursor-pointer text-sm font-medium text-gray-900 bg-gray-50 border-b border-gray-200 rounded-t-lg">
                    Unmatched Orders ({matches.unmatched.length}) — will be ignored
                  </summary>
                  <div className="px-3 py-2 text-xs text-gray-600 bg-gray-50/50">
                    These order rows didn't match any SKU in this sale's lineup. Double-check the SKU column if this looks wrong.
                  </div>
                  <div className="divide-y divide-gray-100 max-h-40 overflow-y-auto">
                    {matches.unmatched.map((row, idx) => (
                      <div key={idx} className="flex items-center justify-between px-3 py-2 text-xs">
                        <div className="min-w-0 flex-1">
                          <div className="text-gray-900 truncate">{row.title || '(no title)'}</div>
                          <div className="text-gray-500 font-mono">{row.sku || '(no SKU)'}</div>
                        </div>
                        <div className="text-gray-500 ml-2 whitespace-nowrap">${row.price.toFixed(2)}</div>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
        </div>

        {parsedRows && (
          <div className="border-t border-gray-200 px-4 py-3 flex items-center justify-end gap-2 flex-shrink-0 bg-white">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
            <button onClick={handleApply} className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg flex items-center gap-1.5">
              <Check className="w-4 h-4" /> Apply Reconciliation
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
