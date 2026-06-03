// Carrier resolution for a shipment box.
//
// Rule (set with the operator in mind — anthuriums ship UPS):
//   1. An explicit per-box override (operator flipped it by hand, persisted
//      on shipment_boxes.carrierOverride) wins over everything.
//   2. Otherwise, any anthurium item in the box → UPS (the content default).
//   3. Otherwise fall back to the carrier stamped on the items at order-apply
//      time — which still encodes the legacy "UPS 2-Day Upgrade" line rule —
//      else USPS.
//
// The default is derived from contents at read time, so existing boxes follow
// the rule immediately (no re-upload / backfill needed). Anthurium detection
// mirrors the predicate used everywhere else: variety === 'anthurium'.

export const isAnthuriumItem = (i) => (i?.variety || '').toLowerCase() === 'anthurium';

// The content-derived default, ignoring any override. Kept separate so the UI
// can show "Auto · UPS" next to the override control.
export function derivedBoxCarrier(items, stampedCarrier) {
  if (Array.isArray(items) && items.some(isAnthuriumItem)) return 'ups';
  return (stampedCarrier || '').toLowerCase() === 'ups' ? 'ups' : 'usps';
}

// The effective carrier: override if set, else the content-derived default.
export function resolveBoxCarrier(items, carrierOverride, stampedCarrier) {
  const ov = (carrierOverride || '').toLowerCase();
  if (ov === 'usps' || ov === 'ups') return ov;
  return derivedBoxCarrier(items, stampedCarrier);
}
