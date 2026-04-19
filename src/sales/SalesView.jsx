import { Plus, Calendar, Layers, Download, FileCheck, Trash2 } from 'lucide-react';

export function SalesView({ sales, items, onCreate, onDelete, onBuildLineup, onReconcile, isAdmin }) {
  const exportPalmstreet = (sale) => {
    const saleItems = items
      .filter(i => i.saleId === sale.id)
      .sort((a, b) => {
        const la = parseInt(a.lotNumber) || 999999;
        const lb = parseInt(b.lotNumber) || 999999;
        return la - lb;
      });

    if (saleItems.length === 0) {
      alert('No lots in this sale yet. Click "Build Lineup" first to add items.');
      return;
    }

    const headers = [
      'Title (product name, 80 character max)*',
      'Item description*',
      'Image URL',
      'Price*',
      'Quantity* ',
      'Variation 1 name',
      'Variation 1 value ',
      'Variation 2 name',
      'Variation 2 value',
      'Variation 3 name',
      'Variation 3 value',
      'SKU',
      'Mark "Yes" for Private listing',
      'Shipping (Leave empty will follow store setting...)',
    ];

    const escape = (v) => {
      if (v === null || v === undefined || v === '') return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const buildTitle = (item) => {
      let t = item.name || '';
      if (item.variety) t = `${t} ${item.variety}`.trim();
      if (t.length > 80) t = t.slice(0, 80);
      return t;
    };

    const buildDescription = (item) => {
      const parts = [];
      if (item.name) parts.push(item.name);
      if (item.variety) parts.push(`Variety: ${item.variety}`);
      if (item.notes) parts.push(item.notes);
      return parts.join('. ');
    };

    const rows = saleItems.map(item => [
      buildTitle(item),
      buildDescription(item),
      item.imageUrl || '',
      parseFloat(item.listingPrice) || 0,
      parseInt(item.quantity) || 1,
      '', '',
      '', '',
      '', '',
      item.sku || '',
      '',
      '',
    ]);

    const csv = [
      headers.map(escape).join(','),
      ...rows.map(r => r.map(escape).join(',')),
    ].join('\n');

    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeName = sale.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    a.href = url;
    a.download = `palmstreet-${safeName}-${sale.date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Sale Events</h2>
          <p className="text-xs text-gray-500 mt-0.5">Group SKUs into auction/sale days with lot numbers</p>
        </div>
        <button onClick={onCreate} className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm rounded-lg self-start sm:self-auto">
          <Plus className="w-4 h-4" /> New Sale Event
        </button>
      </div>

      {sales.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <Calendar className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 text-sm">No sale events yet. Create one to organize your auction lineup.</p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-3">
          {sales.map(sale => {
            const saleItems = items.filter(i => i.saleId === sale.id);
            const totalValue = saleItems.reduce((s, i) => s + (parseFloat(i.listingPrice) || 0), 0);
            return (
              <div key={sale.id} className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="flex items-start justify-between mb-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-gray-900 truncate">{sale.name}</div>
                    <div className="text-xs text-gray-500">{sale.date} · {sale.platform || 'Palmstreet'}</div>
                  </div>
                  {isAdmin && (
                    <button onClick={() => onDelete(sale.id)} className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" title="Delete (admin only)">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs mb-3">
                  <div className="bg-gray-50 rounded p-2">
                    <div className="text-gray-500">Lots assigned</div>
                    <div className="font-semibold text-gray-900">{saleItems.length}</div>
                  </div>
                  <div className="bg-gray-50 rounded p-2">
                    <div className="text-gray-500">Listing total</div>
                    <div className="font-semibold text-gray-900">${totalValue.toFixed(0)}</div>
                  </div>
                </div>
                {sale.notes && <p className="text-xs text-gray-600 mb-3">{sale.notes}</p>}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => onBuildLineup(sale)}
                    className="flex items-center justify-center gap-1.5 px-3 py-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-sm font-medium rounded-lg transition"
                  >
                    <Layers className="w-4 h-4" /> Build Lineup
                  </button>
                  <button
                    onClick={() => exportPalmstreet(sale)}
                    className="flex items-center justify-center gap-1.5 px-3 py-2 bg-gray-900 hover:bg-gray-800 text-white text-sm font-medium rounded-lg transition"
                  >
                    <Download className="w-4 h-4" /> Export CSV
                  </button>
                </div>
                <button
                  onClick={() => {
                    if (saleItems.length === 0) {
                      alert('No lots in this sale yet. Click "Build Lineup" first.');
                      return;
                    }
                    onReconcile(sale);
                  }}
                  className="mt-2 w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-amber-50 hover:bg-amber-100 text-amber-800 text-sm font-medium rounded-lg transition border border-amber-200"
                >
                  <FileCheck className="w-4 h-4" /> Reconcile Orders
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
