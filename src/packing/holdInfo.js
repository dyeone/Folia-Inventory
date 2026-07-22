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

// One-week holds are WEEK-scoped, not day-counted: a hold bought in week 30
// skips ALL of week 31 and ships when week 32 begins — regardless of which
// day of week 30 it was bought. weekHoldUntil(d) = Monday 00:00 (local) of
// the week after next relative to d. Date-only strings ("2026-07-17") parse
// as LOCAL calendar dates — new Date() would read them as UTC midnight,
// which in US timezones lands on the previous local day and can shift a
// Monday purchase into the prior week.
export function weekHoldUntil(raw) {
  let d;
  if (raw instanceof Date) d = raw;
  else if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, day] = raw.split('-').map(Number);
    d = new Date(y, m - 1, day);
  } else d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  const dow = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
  monday.setDate(monday.getDate() + 14);
  return monday;
}

// Effective hold state of a box, with a real countdown:
//   • Item-based hold ("1-week hold" line) → week-scoped from that item's
//     purchase (order) date: ready when the week after next begins.
//   • Otherwise the manual button hold (holdUntil timestamp — new holds are
//     stamped with the same week rule at press time; see setBoxHold).
// Returns the holdInfo shape: { state:'none'|'holding'|'ready', daysLeft?, until? }.
export function boxHoldState(items, holdUntil) {
  const holdItem = (items || []).find(i => isHoldItem(i?.name));
  if (holdItem) {
    const purchased = holdItem.orderDate || holdItem.soldAt || holdItem.createdAt || null;
    if (purchased) {
      const until = weekHoldUntil(purchased);
      if (until) return holdInfo(until.toISOString());
    }
    return { state: 'holding' }; // hold item present but no date to count from
  }
  return holdInfo(holdUntil);
}

// Local pickup: the buyer collects the box in person, so it must NOT ship.
// Flagged the same loose way as a hold — in the box's seller note OR an item
// name/note that says "pickup" / "local pickup" / "pick up" / "pick-up".
const LOCAL_PICKUP_RE = /\b(?:local[\s-]*)?pick[\s-]*up\b/i;
export function isLocalPickupText(text) {
  return LOCAL_PICKUP_RE.test(String(text || ''));
}
export function boxIsLocalPickup(note, items) {
  if (isLocalPickupText(note)) return true;
  return (items || []).some(i => isLocalPickupText(i?.name) || isLocalPickupText(i?.notes));
}
