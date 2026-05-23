import { StickyNote } from 'lucide-react';

// Always-visible notes strip for a box. Used by the Ready and Shipped
// cards so customer instructions are visible without expanding either.
// Each note is prefixed with "Seller: " or "Buyer: " at upload time
// (parsePalmstreetOrders.js); legacy rows without a prefix fall through
// as a generic "Note" badge.
export function BoxNotes({ notes }) {
  if (!notes || notes.length === 0) return null;
  return (
    <div className="px-3 py-2 border-t-2 border-amber-400 bg-amber-100 text-sm text-amber-950 space-y-1.5">
      {notes.map((n, i) => {
        const isSeller = n.startsWith('Seller: ');
        const isBuyer  = n.startsWith('Buyer: ');
        const text  = isSeller ? n.slice(8) : isBuyer ? n.slice(7) : n;
        const label = isSeller ? 'Seller' : isBuyer ? 'Buyer' : 'Note';
        const badgeClass = isSeller
          ? 'bg-amber-700 text-amber-50'
          : isBuyer
          ? 'bg-indigo-700 text-indigo-50'
          : 'bg-gray-700 text-gray-50';
        return (
          <div key={i} className="flex items-start gap-2">
            <StickyNote className="w-4 h-4 mt-0.5 shrink-0 text-amber-700" />
            <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide shrink-0 ${badgeClass}`}>
              {label}
            </span>
            <span className="flex-1 leading-snug font-medium">{text}</span>
          </div>
        );
      })}
    </div>
  );
}
