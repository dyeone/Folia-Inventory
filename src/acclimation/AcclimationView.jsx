import { useMemo, useState } from 'react';
import { Search, Download, Sprout, ScanLine, CheckSquare, Square, MinusSquare, Check, Loader2, X } from 'lucide-react';
import { AcclimationModal } from '../inventory/AcclimationModal.jsx';

// Acclimation tab: every plant currently in acclimation (TCs scanned in at
// the bench or with the scan modal here), newest first, with search, an
// XLS export of name + SKU, and "Mark available" for the ones that have
// grown out. Reads the app's item list; writes go through onStatusChange
// (the same sticky-rate path the inventory uses).
//
// Selecting: click a checkbox, then shift-click another to select (or
// clear) every row between them, as in a mail app. "Clear selection"
// unticks everything — selecting never changes a plant by itself.

const when = (t) => { try { return t ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''; } catch { return ''; } };

export function AcclimationView({ items, acclimatedRate, onStatusChange, showToast }) {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  // The row the last plain click landed on — the start of a shift-click range.
  const [anchorId, setAnchorId] = useState(null);
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

  // Click: toggle one row. Shift-click: give every row from the anchor to this
  // one the state this row is switching to (tick a range, or untick it), in
  // the order on screen — search results included.
  const toggle = (id, shiftKey) => {
    const to = shown.findIndex((i) => i.id === id);
    const from = shiftKey && anchorId ? shown.findIndex((i) => i.id === anchorId) : -1;
    setSelected((prev) => {
      const n = new Set(prev);
      const tick = !prev.has(id);
      if (from >= 0 && to >= 0) {
        for (let k = Math.min(from, to); k <= Math.max(from, to); k++) {
          if (tick) n.add(shown[k].id); else n.delete(shown[k].id);
        }
      } else if (tick) n.add(id);
      else n.delete(id);
      return n;
    });
    setAnchorId(id);
  };
  // Only rows on screen count for the buttons — a search can hide ticked rows.
  const selectedShown = shown.filter((i) => selected.has(i.id));
  const allShownSelected = shown.length > 0 && selectedShown.length === shown.length;
  const toggleAll = () => setSelected(allShownSelected ? new Set() : new Set(shown.map((i) => i.id)));
  const clearSelection = () => { setSelected(new Set()); setAnchorId(null); };

  const exportXls = async () => {
    setExporting(true);
    try {
      const XLSX = await import('xlsx');
      const rows = (selectedShown.length ? selectedShown : shown).map((i) => ({ Name: i.name || '', SKU: i.sku || '' }));
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
    const ids = selectedShown.map((i) => i.id);
    if (!ids.length) return;
    setReleasing(true);
    try {
      for (const id of ids) await onStatusChange(id, 'available');
      clearSelection();
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
            {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Export XLS{selectedShown.length ? ` (${selectedShown.length})` : ''}
          </button>
          <button type="button" onClick={release} disabled={releasing || selectedShown.length === 0} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50">
            {releasing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Mark available{selectedShown.length ? ` (${selectedShown.length})` : ''}
          </button>
        </div>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[16rem] max-w-md">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, SKU or variety…" className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg" />
        </div>
        {selected.size > 0 ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-fuchsia-800">{selectedShown.length} selected</span>
            {selected.size > selectedShown.length && (
              <span className="text-gray-500">· {selected.size - selectedShown.length} more hidden by the search</span>
            )}
            <button type="button" onClick={clearSelection} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm text-gray-700 border border-gray-300 bg-white rounded-lg hover:bg-gray-50">
              <X className="w-3.5 h-3.5" /> Clear selection
            </button>
          </div>
        ) : shown.length > 1 && (
          <span className="text-xs text-gray-500">Tip: tick one plant, then shift-click another to select every plant between.</span>
        )}
      </div>
      <div className="border border-gray-200 rounded-xl bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-gray-700">
              <th className="px-3 py-2 w-8"><button type="button" onClick={toggleAll} aria-label={allShownSelected ? 'Clear selection' : 'Select all'} title={allShownSelected ? 'Clear selection' : 'Select all shown'} className="text-gray-500 hover:text-gray-900">{allShownSelected ? <CheckSquare className="w-4 h-4 text-fuchsia-700" /> : selectedShown.length ? <MinusSquare className="w-4 h-4 text-fuchsia-700" /> : <Square className="w-4 h-4" />}</button></th>
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
                {/* The whole cell is the target; a shift-click mustn't also drag-select page text. */}
                <td className="px-3 py-2 cursor-pointer" onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }} onClick={(e) => toggle(i.id, e.shiftKey)}>
                  <button type="button" aria-label={`Select ${i.sku}`} className="block text-gray-500 hover:text-gray-900">{selected.has(i.id) ? <CheckSquare className="w-4 h-4 text-fuchsia-700" /> : <Square className="w-4 h-4" />}</button>
                </td>
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
