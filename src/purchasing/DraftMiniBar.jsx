import { useEffect, useState } from 'react';
import { ShoppingCart, ArrowRight } from 'lucide-react';
import { api } from '../api.js';

// Sticky-bottom prompt shown when there's an active draft PO.
// Polls the draft list on a small interval so it stays current as
// the operator adds plants from the catalog. (Polling is cheap —
// list endpoint is one indexed SELECT.)
export function DraftMiniBar({ onOpen }) {
  const [draft, setDraft] = useState(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const drafts = await api.listPurchaseOrders('draft');
        if (alive) setDraft(drafts && drafts[0] ? drafts[0] : null);
      } catch { /* swallow — bar is best-effort */ }
    };
    tick();
    const h = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(h); };
  }, []);

  if (!draft || (draft.lineCount === 0 && draft.unitCount === 0)) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 sm:left-auto sm:right-4 sm:bottom-4 sm:max-w-md z-30 pb-safe sm:pb-0">
      <div className="bg-gray-900 text-white sm:rounded-2xl shadow-2xl px-4 py-3 mb-14 sm:mb-0 flex items-center gap-3">
        <ShoppingCart className="w-5 h-5 text-emerald-300 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs text-gray-400">Draft PO</div>
          <div className="text-sm font-medium truncate">
            {draft.lineCount} plant{draft.lineCount === 1 ? '' : 's'} · {draft.unitCount} unit{draft.unitCount === 1 ? '' : 's'}
            {draft.supplier && ` · ${draft.supplier}`}
          </div>
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 rounded-lg shrink-0"
        >
          Open <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
