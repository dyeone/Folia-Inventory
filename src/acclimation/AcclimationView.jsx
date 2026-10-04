import { useMemo, useState } from 'react';
import { Search, Download, Sprout, ScanLine, CheckSquare, Square, Check, Loader2 } from 'lucide-react';
import { AcclimationModal } from '../inventory/AcclimationModal.jsx';

// Acclimation tab: every plant currently in acclimation (TCs scanned in at
// the bench or with the scan modal here), newest first, with search, an
// XLS export of name + SKU, and "Mark available" for the ones that have
// grown out. Reads the app's item list; writes go through onStatusChange
// (the same sticky-rate path the inventory uses).

const when = (t) => { try { return t ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''; } catch { return ''; } };

export function AcclimationView({ items, acclimatedRate, onStatusChange, showToast }) {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [scanOpen, setScanOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [releasing, setReleasing] = useState(false);

  const all = useMemo(() => (items || [])
    .filter((i) => i.status === 'acclimated' && !i.deletedAt)
    .sort((a, b) => new Date(b.modifiedAt || b.createdAt || 0) - new Date(a.modifiedAt || a.createdAt || 0)), [items]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((i) => [i.sku, i.name, i.variety].some((v) => String(v || '').toLowerCase().includes(needle))) : all;
  }, [all, q]);

  const toggle = (id) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allShownSelected = shown.length > 0 && shown.every((i) => selected.has(i.id));
  const toggleAll = () => setSelected(allShownSelected ? new Set() : new Set(shown.map((i) => i.id)));

  const exportXls = async () => {
    setExporting(true);
    try {
      const XLSX = await import('xlsx');
      const rows = (selected.size ? shown.filter((i) => selected.has(i.id)) : shown).map((i) => ({ Name: i.name || '', SKU: i.sku || '' }));
      const ws = XLSX.utils.json_to_sheet(rows, { header: ['Name', 'SKU'] });
      ws['!cols'] = [{ wch: 40 }, { wch: 18 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Acclimation');
      XLSX.writeFile(wb, `acclimation-${new Date().toISOString().slice(0, 10)}.xlsx`);
      showToast?.(`Exported ${rows.length} plant${rows.length === 1 ? '' : 's'}`);
    } catch (e) {
      showToast?.(e.message || 'Export failed', 'error');
    } finally {
      setExporting(false);
    }
  };

  const release = async () => {
    const ids = shown.filter((i) => selected.has(i.id)).map((i) => i.id);
    if (!ids.length) return;
    setReleasing(true);
    try {
      for (const id of ids) await onStatusChange(id, 'available');
      setSelected(new Set());
      showToast?.(`${ids.length} plant${ids.length === 1 ? '' : 's'} marked available`);
    } catch (e) {
      showToast?.(e.message || 'Could not update', 'error');
    } finally {
      setReleasing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Sprout className="w-6 h-6 text-fuchsia-700" />
          <h2 className="text-lg font-semibold text-gray-900">Acclimation</h2>
          <span className="text-sm text-gray-500">{all.length} plant{all.length === 1 ? '' : 's'} in acclimation</span>
        </div>
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <button type="button" onClick={() => setScanOpen(true)} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-fuchsia-800 border border-fuchsia-300 bg-fuchsia-50 rounded-lg hover:bg-fuchsia-100"><ScanLine className="w-4 h-4" /> Scan to acclimate</button>
          <button type="button" onClick={exportXls} disabled={exporting || shown.length === 0} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50">
            {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Export XLS{selected.size ? ` (${selected.size})` : ''}
          </button>
          <button type="button" onClick={release} disabled={releasing || selected.size === 0} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50">
            {releasing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Mark available{selected.size ? ` (${selected.size})` : ''}
          </button>
        </div>
      </div>
      <div className="relative max-w-md">
        <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, SKU or variety…" className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg" />
      </div>
      <div className="border border-gray-200 rounded-xl bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-gray-700">
              <th className="px-3 py-2 w-8"><button type="button" onClick={toggleAll} aria-label="Select all" className="text-gray-500 hover:text-gray-900">{allShownSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}</button></th>
              <th className="px-3 py-2 font-semibold">Name</th>
              <th className="px-3 py-2 font-semibold">SKU</th>
              <th className="px-3 py-2 font-semibold">Variety</th>
              <th className="px-3 py-2 font-semibold">Since</th>
              <th className="px-3 py-2 font-semibold">By</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((i) => (
              <tr key={i.id} className={`border-t border-gray-100 ${selected.has(i.id) ? 'bg-fuchsia-50' : ''}`}>
                <td className="px-3 py-2"><button type="button" onClick={() => toggle(i.id)} aria-label={`Select ${i.sku}`} className="text-gray-500 hover:text-gray-900">{selected.has(i.id) ? <CheckSquare className="w-4 h-4 text-fuchsia-700" /> : <Square className="w-4 h-4" />}</button></td>
                <td className="px-3 py-2 font-medium text-gray-900">{i.name}</td>
                <td className="px-3 py-2 font-mono text-xs text-gray-700">{i.sku}</td>
                <td className="px-3 py-2 text-gray-600">{i.variety}</td>
                <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{when(i.modifiedAt || i.createdAt)}</td>
                <td className="px-3 py-2 text-gray-600">{i.modifiedBy || ''}</td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-500">{all.length ? `Nothing matches "${q}".` : 'Nothing in acclimation. Scan TCs at the bench, or use Scan to acclimate here.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {scanOpen && (
        <AcclimationModal items={items} acclimatedRate={acclimatedRate} onStatusChange={onStatusChange} onClose={() => setScanOpen(false)} />
      )}
    </div>
  );
}
