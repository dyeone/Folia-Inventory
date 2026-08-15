import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Loader2, Upload } from 'lucide-react';
import { api } from '../api.js';
import { PurchaseOrderCard } from './PurchaseOrderCard.jsx';
import { ImportOrderModal } from './ImportOrderModal.jsx';

const FILTERS = [
  { id: 'draft',    label: 'Draft' },
  { id: 'ordered',  label: 'Ordered' },
  { id: 'received', label: 'Received' },
];

export function OrdersPane({ varieties, species, showToast, setConfirmDialog, onItemsChanged, onSpeciesChanged }) {
  const [activeFilters, setActiveFilters] = useState(new Set(['draft', 'ordered']));
  const [pos, setPos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [importOpen, setImportOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const statuses = [...activeFilters].join(',') || 'draft,ordered';
      const fresh = await api.listPurchaseOrders(statuses);
      setPos(fresh);
      setErr('');
      onItemsChanged?.();
    } catch (e) {
      setErr(e.message || 'Load failed');
    } finally {
      setLoading(false);
    }
  }, [activeFilters, onItemsChanged]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const statuses = [...activeFilters].join(',') || 'draft,ordered';
        const fresh = await api.listPurchaseOrders(statuses);
        if (cancelled) return;
        setPos(fresh);
        setErr('');
        onItemsChanged?.();
      } catch (e) {
        if (!cancelled) setErr(e.message || 'Load failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeFilters, onItemsChanged]);

  const speciesById = useMemo(() => {
    const m = new Map();
    for (const s of species || []) m.set(s.id, s);
    return m;
  }, [species]);

  const toggleFilter = (id) => {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      if (next.size === 0) return prev; // don't allow zero filters
      return next;
    });
  };

  const createNew = async () => {
    try {
      const po = await api.createPurchaseOrder({});
      showToast?.('Draft created', 1500);
      setActiveFilters(prev => prev.has('draft') ? prev : new Set([...prev, 'draft']));
      setPos(prev => [{ ...po, lineCount: 0, unitCount: 0 }, ...prev]);
    } catch (e) {
      showToast?.(e.message || 'Create failed', 3000);
    }
  };

  return (
    <div className="space-y-3">
      <div className="bg-white rounded-xl border border-gray-200 p-3 flex items-center gap-2 flex-wrap">
        <div className="flex gap-1 bg-gray-100 p-1 rounded-lg">
          {FILTERS.map(f => {
            const active = activeFilters.has(f.id);
            return (
              <button
                key={f.id}
                onClick={() => toggleFilter(f.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${
                  active ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>
        {/* Wholesale list upload — spreadsheet in, ready-to-receive PO out.
            The modal matches rows to the catalog and (optionally) marks the
            PO ordered so it lands on the packer's receiving screen. */}
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          className="ml-auto flex items-center gap-1.5 px-3 py-2 text-sm font-medium border border-emerald-600 text-emerald-700 hover:bg-emerald-50 rounded-lg"
        >
          <Upload className="w-4 h-4" /> Import list
        </button>
        <button
          type="button"
          onClick={createNew}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg"
        >
          <Plus className="w-4 h-4" /> New PO
        </button>
      </div>

      {importOpen && (
        <ImportOrderModal
          species={species}
          varieties={varieties}
          showToast={showToast}
          onClose={() => setImportOpen(false)}
          onCreated={() => {
            // A sent-to-receiving PO is 'ordered'; make sure that filter is
            // on so the fresh order is visible, then refresh. The import can
            // also mint new catalog species — pull those into app state too,
            // or the new PO's lines would show as unknown species.
            setActiveFilters(prev => prev.has('ordered') ? prev : new Set([...prev, 'ordered']));
            onSpeciesChanged?.();
            refresh();
          }}
        />
      )}

      {loading ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-sm text-gray-500">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
        </div>
      ) : err ? (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
          {err} <button onClick={refresh} className="underline ml-2">retry</button>
        </div>
      ) : pos.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-sm text-gray-500">
          No purchase orders match these filters.
        </div>
      ) : (
        <div className="space-y-2">
          {pos.map(po => (
            <PurchaseOrderCard
              key={po.id}
              po={po}
              speciesById={speciesById}
              showToast={showToast}
              setConfirmDialog={setConfirmDialog}
              onChanged={refresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}
