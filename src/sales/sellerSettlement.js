// Per-seller consignment settlement for one sale event. Pure and read-only —
// it reads the sale's inventory items (which Validate Sales already stamped
// sold + salePrice) and rolls them up per seller: what sold, gross, the
// commission we keep, and the amount we owe the seller.
//
// Money model (mirrors saleEval.costFor): for each sold seller plant, our cut
// is `price * pct/100` and the seller is owed the rest. `pct` is the effective
// commission written on the item at intake (seller default or per-plant
// override); we fall back to the seller's current default, then 0. Palmstreet
// platform fees are absorbed by the house here (not deducted from the payout) —
// the one policy knob, kept in lockstep with saleEval.

const SOLD_STATUSES = new Set(['sold', 'shipped', 'delivered']);

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Effective commission % we keep on an item: per-plant override → seller
// default → 0 (conservative: never invents commission we didn't agree to).
function effectivePct(item, seller) {
  const own = num(item.commissionPct);
  if (own != null) return own;
  const def = seller ? num(seller.defaultCommissionPct) : null;
  return def != null ? def : 0;
}

// Returns an array of per-seller groups, sorted by amount owed (desc). Each:
//   { seller, listed, sold, gross, ourCommission, owed, lines: [...] }
export function computeSellerSettlement(sale, items, sellers) {
  if (!sale) return [];
  const sellerById = new Map((sellers || []).map(s => [s.id, s]));
  const groups = new Map();

  for (const it of items || []) {
    if (it.deletedAt) continue;
    if (it.saleId !== sale.id) continue;
    if (!it.sellerId) continue;
    const seller = sellerById.get(it.sellerId) || null;

    let g = groups.get(it.sellerId);
    if (!g) {
      g = {
        seller: seller || { id: it.sellerId, name: '(unknown seller)', code: '' },
        listed: 0, sold: 0, gross: 0, ourCommission: 0, owed: 0, lines: [],
      };
      groups.set(it.sellerId, g);
    }

    const pct = effectivePct(it, seller);
    const isSold = SOLD_STATUSES.has(it.status);
    const price = isSold ? (num(it.salePrice) ?? num(it.listingPrice) ?? 0) : 0;
    const ourCut = price * pct / 100;
    const owed = price - ourCut;

    g.listed += 1;
    if (isSold) {
      g.sold += 1;
      g.gross += price;
      g.ourCommission += ourCut;
      g.owed += owed;
    }
    g.lines.push({
      id: it.id,
      sku: it.sku,
      name: it.name || '',
      variety: it.variety || '',
      status: it.status,
      sold: isSold,
      pct,
      price,
      ourCommission: isSold ? ourCut : 0,
      owed: isSold ? owed : 0,
    });
  }

  const list = [...groups.values()];
  // Within a seller, sold lots first (by price desc), then the unsold.
  for (const g of list) {
    g.lines.sort((a, b) => (a.sold === b.sold ? b.price - a.price : (a.sold ? -1 : 1)));
  }
  return list.sort((a, b) => b.owed - a.owed);
}
