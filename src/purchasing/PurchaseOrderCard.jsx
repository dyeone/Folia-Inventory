import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { PurchaseOrderLineRow } from './PurchaseOrderLineRow.jsx';

const STATUS_CLASS = {
  draft:    'bg-gray-300',
  ordered:  'bg-amber-500',
  received: 'bg-emerald-500',
};

export function PurchaseOrderCard({ po, speciesById, showToast, onChanged, setConfirmDialog }) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState(null);
  const [, setReceivedItems] = useState([]); // Task 15 uses
  // Initial true so the first expand shows the spinner; the async IIFE
  // below flips it false in finally().
  const [loading, setLoading] = useState(true);
  const [savingHeader, setSavingHeader] = useState(false);

  // Local header state — initialized once from props. Edits stick until
  // saved-or-discarded; subsequent prop changes (e.g., parent refresh)
  // don't blow away mid-typed input. After save, onChanged() bubbles up
  // and the parent reloads the list — the new prop will match local state.
  const [supplier,    setSupplier]    = useState(po.supplier || '');
  const [shippingFee, setShippingFee] = useState(String(po.shippingFee ?? 0));
  const [notes,       setNotes]       = useState(po.notes || '');

  // Fetch lines on first expand. Uses async IIFE so setState only fires
  // via await resolution (satisfies the react-hooks/set-state-in-effect rule).
  useEffect(() => {
    if (!open || lines !== null) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const { lines: ls, receivedItems: ri } = await api.getPurchaseOrder(po.id);
        if (cancelled) return;
        setLines(ls);
        setReceivedItems(ri || []);
      } catch (e) {
        if (!cancelled) showToast?.(e.message || 'Load failed', 3000);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, lines, po.id, showToast]);

  const refreshLines = async () => {
    try {
      const { lines: ls, receivedItems: ri } = await api.getPurchaseOrder(po.id);
      setLines(ls);
      setReceivedItems(ri || []);
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Load failed', 3000);
    }
  };

  const flushHeader = async (patch) => {
    setSavingHeader(true);
    try {
      await api.updatePurchaseOrderHeader({ id: po.id, ...patch });
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Save failed', 3000);
    } finally {
      setSavingHeader(false);
    }
  };

  const deletePo = () => {
    setConfirmDialog?.({
      title: 'Delete this draft?',
      message: 'This removes the PO and all its lines. Cannot be undone (it goes through the 30-day soft-delete pattern).',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        try {
          await api.deletePurchaseOrder(po.id);
          showToast?.('Deleted', 1500);
          onChanged?.();
        } catch (e) {
          showToast?.(e.message || 'Delete failed', 3000);
        }
      },
    });
  };

  const isDraft = po.status === 'draft';

  return (
    <div className="bg-white rounded-xl border border-gray-200">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-gray-50"
      >
        <div className="mt-0.5 text-gray-400">
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-sm">
            <span className={`inline-block w-2 h-2 rounded-full ${STATUS_CLASS[po.status] || 'bg-gray-300'}`} />
            <span className="font-medium text-gray-900 capitalize">{po.status}</span>
            <span className="text-gray-500">·</span>
            <span className="text-gray-700">{new Date(po.createdAt).toISOString().slice(0, 10)}</span>
            {po.supplier && (
              <>
                <span className="text-gray-500">·</span>
                <span className="text-gray-700 truncate">{po.supplier}</span>
              </>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {po.lineCount} {po.lineCount === 1 ? 'line' : 'lines'}
            {' · '}
            {po.unitCount} {po.unitCount === 1 ? 'unit' : 'units'}
            {po.shippingFee > 0 && ` + $${parseFloat(po.shippingFee).toFixed(2)} ship`}
          </div>
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-100">
          {/* Header editors */}
          <div className="px-4 py-3 grid grid-cols-1 md:grid-cols-3 gap-3 bg-gray-50/60">
            <Field label="Supplier">
              <input
                type="text"
                value={supplier}
                onChange={(e) => setSupplier(e.target.value)}
                onBlur={() => supplier !== (po.supplier || '') && flushHeader({ supplier })}
                disabled={po.status === 'received' || savingHeader}
                className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:bg-gray-100"
              />
            </Field>
            <Field label="Shipping ($)">
              <input
                type="number"
                step="0.01"
                value={shippingFee}
                onChange={(e) => setShippingFee(e.target.value)}
                onBlur={() => parseFloat(shippingFee) !== Number(po.shippingFee) && flushHeader({ shippingFee: parseFloat(shippingFee) || 0 })}
                disabled={po.status === 'received' || savingHeader}
                className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:bg-gray-100"
              />
            </Field>
            <Field label="Notes">
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onBlur={() => notes !== (po.notes || '') && flushHeader({ notes })}
                disabled={po.status === 'received' || savingHeader}
                className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:bg-gray-100"
              />
            </Field>
          </div>

          {/* Lines */}
          {loading ? (
            <div className="p-6 text-center text-sm text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading lines…
            </div>
          ) : !lines || lines.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-500">
              No lines yet. Add plants from the Catalog tab.
            </div>
          ) : (
            <div>
              {lines.map(line => (
                <PurchaseOrderLineRow
                  key={line.id}
                  line={line}
                  species={speciesById?.get(line.speciesId)}
                  poStatus={po.status}
                  poId={po.id}
                  showToast={showToast}
                  onChanged={refreshLines}
                />
              ))}
            </div>
          )}

          {/* Footer actions */}
          {isDraft && lines && (
            <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={deletePo}
                disabled={savingHeader}
                className="flex items-center gap-1.5 px-3 py-2 text-sm border border-red-200 text-red-700 rounded-lg hover:bg-red-50"
              >
                <Trash2 className="w-4 h-4" /> Delete PO
              </button>
              {/* Mark ordered button lives here in Task 14. */}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-wide text-gray-500 font-medium mb-1">{label}</div>
      {children}
    </label>
  );
}
