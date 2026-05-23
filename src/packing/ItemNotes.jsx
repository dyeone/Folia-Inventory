import { StickyNote } from 'lucide-react';

// Per-item notes strip. Takes the raw inventory_items.notes string
// (a ' · '-joined list of "Seller: …" / "Buyer: …" entries written by
// parsePalmstreetOrders.js at upload time) and renders each entry on
// its own row with a colored badge. Used in:
//   - PackingView item rows  (admin Shipping tab, both Ready and Shipped)
//   - PackerView item rows   (mobile packer workflow)
//
// Legacy rows whose notes don't carry a prefix render as a generic
// "Note" badge.
export function ItemNotes({ raw }) {
  if (!raw) return null;
  const notes = String(raw).split(' · ').map((s) => s.trim()).filter(Boolean);
  if (notes.length === 0) return null;
  return (
    <div className="mt-1.5 px-3 py-2 rounded border-2 border-amber-500 border-l-4 border-l-orange-500 bg-amber-200 text-sm text-amber-950 space-y-1.5 shadow-inner">
      {notes.map((n, i) => {
        const isSeller = n.startsWith('Seller: ');
        const isBuyer  = n.startsWith('Buyer: ');
        const text  = isSeller ? n.slice(8) : isBuyer ? n.slice(7) : n;
        const label = isSeller ? 'Seller' : isBuyer ? 'Buyer' : 'Note';
        const badgeClass = isSeller
          ? 'bg-amber-800 text-amber-50'
          : isBuyer
          ? 'bg-indigo-800 text-indigo-50'
          : 'bg-gray-800 text-gray-50';
        return (
          <div key={i} className="flex items-start gap-2">
            <StickyNote className="w-4 h-4 mt-0.5 shrink-0 text-orange-600" />
            <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide shrink-0 ${badgeClass}`}>
              {label}
            </span>
            <span className="flex-1 leading-snug font-semibold">{text}</span>
          </div>
        );
      })}
    </div>
  );
}
