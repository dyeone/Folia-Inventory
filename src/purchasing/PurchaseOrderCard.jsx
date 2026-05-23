import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

// Inline-expandable PO card. Task 13 fills in the expanded detail.
// Status dot color: gray=draft, amber=ordered, emerald=received.

const STATUS_CLASS = {
  draft:    'bg-gray-300',
  ordered:  'bg-amber-500',
  received: 'bg-emerald-500',
};

export function PurchaseOrderCard({ po }) {
  const [open, setOpen] = useState(false);
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
        <div className="border-t border-gray-100 px-4 py-3 text-sm text-gray-500">
          Detail panel — implemented in Task 13.
        </div>
      )}
    </div>
  );
}
