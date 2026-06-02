// Shipping profit/loss readout for a box. Compares what the buyer paid to
// ship (summed from each item's Palmstreet "Shipping Fee" — see
// orderShippingFee) against what the label actually costs us. A negative
// net means we ate the difference, which is the whole point of surfacing
// this at buy-label time.
//
// `cost` is optional: before a label is bought it's the quoted rate; after,
// the purchased labelCost. Pass null for test labels (no real charge), and
// the note degrades to just "ship paid $X". Renders nothing if it has
// neither number to show.

const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);

export function ShippingMarginNote({ feeCollected, cost, className = '' }) {
  const paid = Number.isFinite(feeCollected) ? feeCollected : null;
  const c = Number.isFinite(cost) ? cost : null;
  if (paid == null && c == null) return null;
  const net = paid != null && c != null ? paid - c : null;
  const loss = net != null && net < 0;
  return (
    <span className={`inline-flex items-center gap-1.5 flex-wrap ${className}`}>
      {paid != null && (
        <span className="text-gray-500">ship paid {money(paid)}</span>
      )}
      {c != null && (
        <>
          <span className="text-gray-300">·</span>
          <span className="text-gray-500">label {money(c)}</span>
        </>
      )}
      {net != null && (
        <span
          className={`font-medium px-1.5 py-0.5 rounded text-[11px] border ${
            loss
              ? 'text-red-700 bg-red-50 border-red-200'
              : 'text-emerald-700 bg-emerald-50 border-emerald-200'
          }`}
        >
          {loss ? `−${money(Math.abs(net))} loss` : `+${money(net)} net`}
        </span>
      )}
    </span>
  );
}
