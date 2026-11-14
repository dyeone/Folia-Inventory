// The packer puts a plant in hand on a placeholder line (the client side is
// src/packing/placeholderLink.js). A line sold without a SKU or lineup number
// — a giveaway, a Buy Now look-alike — is a purple placeholder in its buyer's
// box; the plant takes that line's place: its sale, buyer, order, box. The
// line goes to the trash, or gives up one unit if it was Quantity 2+.

const LINKABLE_STATUS = ['available', 'listed', 'acclimated', 'sold'];

// An open placeholder line a plant can be put on: live, unpacked, sold, in a
// box that isn't Nigel's (his slip lines are never our inventory).
export function isOpenLine(i) {
  return !!i && !i.deletedAt
    && i.lotKind === 'unmatched'
    && /^UNMATCHED-/i.test(String(i.sku || ''))
    && i.status === 'sold'
    && !!i.shipmentBoxId
    && !String(i.shipmentBoxId).startsWith('ng')
    && !i.packedAt;
}

// A plant that can go on a line: our inventory, in no box yet.
export function isLinkablePlant(i) {
  return !!i && !i.deletedAt && i.lotKind !== 'unmatched'
    && !i.shipmentBoxId && LINKABLE_STATUS.includes(i.status);
}

// The two writes. The plant is left unpacked: the packer prints its label
// (now with its own QR) and the next scan packs it. A Quantity 2+ line keeps
// its other units at $0, fee 0 and no refund — price, fee and refund move to
// the plant and are counted once (the same convention as Validate Sales'
// extra-units line); the fee is 0, not null, so a re-upload's top-up doesn't
// refill it.
export function linkPatches(plant, line, now) {
  const plantPatch = {
    status: 'sold',
    salePrice: line.salePrice ?? null,
    soldAt: line.soldAt || line.orderDate || now,
    buyer: line.buyer ?? null,
    buyerUsername: line.buyerUsername ?? null,
    buyerAddress: line.buyerAddress ?? null,
    shipmentBoxId: line.shipmentBoxId,
    shipmentCarrier: line.shipmentCarrier ?? null,
    orderId: line.orderId ?? null,
    orderDate: line.orderDate ?? null,
    orderShippingFee: line.orderShippingFee ?? null,
    notes: line.notes || plant.notes || null,
    packedAt: null,
    shippedAt: null,
    ...(plant.saleId || !line.saleId ? {} : { saleId: line.saleId }),
    ...(Number(line.refundedAmount) > 0 ? { refundedAmount: line.refundedAmount, refundedAt: line.refundedAt ?? null } : {}),
  };
  const units = Math.max(1, parseInt(line.quantity, 10) || 1);
  const linePatch = units > 1
    ? {
      quantity: units - 1,
      salePrice: 0,
      orderShippingFee: line.orderShippingFee == null ? null : 0,
      refundedAmount: 0,
      refundedAt: null,
    }
    : { deletedAt: now };
  return { plantPatch, linePatch };
}
