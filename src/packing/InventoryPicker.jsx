import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';

// Modal that lets the user manually link a Palmstreet order row to an
// inventory SKU when the auto-match in matchInventory.js can't decide.
// `preferredItems` floats the sale-event lineup to the top so picks
// don't accidentally grab a same-name SKU from a different sale.
export function InventoryPicker({ title, inventoryItems, preferredItems, onPick, onClose }) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    const pool = inventoryItems
      .filter(i => i.status === 'available' || i.status === 'listed');
    const prefIds = new Set((preferredItems || []).map(i => i.id));
    const sorted = [...pool].sort((a, b) => {
      const ap = prefIds.has(a.id) ? 0 : 1;
      const bp = prefIds.has(b.id) ? 0 : 1;
      return ap - bp;
    });
    if (!query) return sorted.slice(0, 50);
    return sorted.filter(i => (
      i.sku?.toLowerCase().includes(query) ||
      i.name?.toLowerCase().includes(query) ||
      i.variety?.toLowerCase().includes(query) ||
      String(i.lotNumber || '').toLowerCase().includes(query)
    )).slice(0, 100);
  }, [q, inventoryItems, preferredItems]);

  // Re-focus the search input when opened.
  useEffect(() => {
    const t = setTimeout(() => {
      document.getElementById('inv-picker-search')?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-lg md:max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-gray-200 px-4 sm:px-5 py-3 sm:py-4 flex items-center justify-between">
          <div className="min-w-0">
            <h3 className="font-semibold text-gray-900 text-base sm:text-lg">Link to inventory</h3>
            <p className="text-xs sm:text-sm text-gray-500 truncate">{title}</p>
          </div>
          <button onClick={onClose} className="p-2 -mr-1 text-gray-500 hover:bg-gray-100 active:bg-gray-200 rounded-lg" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-3 sm:p-4">
          <input
            id="inv-picker-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search SKU, name, variety, lot #"
            className="w-full px-3 py-3 border border-gray-300 rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
        </div>
        <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
          {filtered.length === 0 ? (
            <div className="text-center text-sm text-gray-500 py-6">No matching items</div>
          ) : (
            filtered.map(i => (
              <button
                key={i.id}
                onClick={() => onPick(i.id)}
                className="w-full px-4 py-3 text-left hover:bg-emerald-50 active:bg-emerald-100"
              >
                <div className="text-sm sm:text-base font-medium text-gray-900 truncate">{i.name}{i.variety ? ` · ${i.variety}` : ''}</div>
                <div className="text-xs sm:text-sm text-gray-500 font-mono mt-0.5">
                  {i.sku}{i.lotNumber ? ` · Lot #${i.lotNumber}` : ''} · {i.status}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
