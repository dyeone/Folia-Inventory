import { StickyNote, MapPin } from 'lucide-react';

// Does this note look like the buyer/seller communicated a new shipping
// address? Drives the inline "Change address" shortcut below.
const ADDRESS_NOTE_RE = /\b(address|ship\s*to)\b/i;

// Per-item notes strip. Takes the raw inventory_items.notes string
// (a ' · '-joined list of "Seller: …" / "Buyer: …" entries written by
// parsePalmstreetOrders.js at upload time) and renders each entry on
// its own row with a colored badge. Used in:
//   - PackingView item rows  (admin Shipping tab, both Ready and Shipped)
//   - PackerView item rows   (mobile packer workflow)
//
// Legacy rows whose notes don't carry a prefix render as a generic
// "Note" badge.
//
// onChangeAddress(noteText) — optional. When provided, notes that mention
// an address get a "Change address" button that jumps straight into the
// box's address editor with the note text shown for reference (Shipping
// tab only; the packer view can't edit addresses).
export function ItemNotes({ raw, onChangeAddress }) {
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
            {onChangeAddress && ADDRESS_NOTE_RE.test(text) && (
              <button
                type="button"
                onClick={() => onChangeAddress(text)}
                title="Open the address editor with this note shown for reference"
                className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-md border border-amber-600 bg-white text-amber-900 hover:bg-amber-50 active:bg-amber-100"
              >
                <MapPin className="w-3 h-3" /> Change address
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
