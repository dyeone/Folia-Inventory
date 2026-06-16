// Derive a box's one-week-hold state from its holdUntil timestamp vs. now.
//   none    → not on hold
//   holding → still counting down (daysLeft = whole days remaining, min 1)
//   ready   → the week has elapsed, time to ship
// Shared by the Shipping desk (PackingView) and the packer UI (PackerView)
// so the countdown + "ready" cutover behave identically in both.
export function holdInfo(holdUntil) {
  if (!holdUntil) return { state: 'none' };
  const until = new Date(holdUntil);
  if (isNaN(until.getTime())) return { state: 'none' };
  const ms = until.getTime() - Date.now();
  if (ms <= 0) return { state: 'ready', until };
  return { state: 'holding', until, daysLeft: Math.max(1, Math.ceil(ms / 86400000)) };
}

// Operators also mark a hold the manual way: they drop a placeholder line into
// the box named like a one-week hold (e.g. "1-week hold (Not for rehabs or
// fresh imports)"). A box that contains such an item is on hold regardless of
// any holdUntil timestamp. Matches "1-week hold", "one week hold", "1 wk hold".
const HOLD_ITEM_RE = /\b(?:1|one)\s*-?\s*w(?:ee)?k\s*hold\b/i;
export function isHoldItem(name) {
  return HOLD_ITEM_RE.test(String(name || ''));
}
export function boxHasHoldItem(items) {
  return (items || []).some(i => isHoldItem(i?.name));
}
