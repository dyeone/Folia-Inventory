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
  // Date-only strings — INCLUDING ones an import already converted to a
  // UTC-midnight instant ("2026-07-20T00:00:00.000Z") — are calendar dates,
  // not instants: read them as LOCAL, or a Monday purchase reads as the
  // prior Sunday in US timezones and the hold releases a full week early.
  const dateOnly = typeof raw === 'string'
    && /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.0+)?(?:Z|\+00:00)?)?$/.exec(raw);
  if (raw instanceof Date) d = raw;
  else if (dateOnly) d = new Date(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3]);
  else d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  const dow = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
  monday.setDate(monday.getDate() + 14);
  return monday;
}

// Explicit release marker for holdUntil. A real timestamp can't distinguish
// "the operator released this hold" from a stale pre-release-era button
// stamp — operators pressed "Hold 1 week" on item-held boxes for years as a
// harmless no-op, so elapsed stamps exist in prod, and any rule where a past
// stamp outranks a live item hold would flip buyer-paid holds to "OK to
// ship" at deploy. The epoch sentinel is unambiguous. Mirrored in
// api/shipments.js setBoxHold (the server can't import client modules).
export const HOLD_RELEASED = '1970-01-01T00:00:00.000Z';

// Compare as an INSTANT, never as a string: holdUntil is a timestamptz
// column and PostgREST re-serializes it on every read (offset form,
// '1970-01-01T00:00:00+00:00'), so string equality would silently miss in
// production and Clear hold would no-op. Epoch 0 can never be a legitimate
// stamp — real ones are server-bounded to now..+31d and the column was born
// in 2026. The !!holdUntil guard is load-bearing: new Date(null) is also
// epoch 0.
export function isHoldReleased(holdUntil) {
  return !!holdUntil && new Date(holdUntil).getTime() === 0;
}

// Effective hold state of a box, with a real countdown:
//   • isHoldReleased(holdUntil) → the desk explicitly released the hold
//     (the "1-week hold" line a buyer bought is sale data and can't be
//     deleted, so release is a sentinel that outranks it) → 'ready'.
//   • Otherwise the box holds while ANY un-released source says so — the
//     button stamp (week-scoped at press time) or the item-based week from
//     the hold line's purchase date — and the LATER window wins, so a stale
//     or short button stamp can never cut a buyer-paid item hold short.
// Returns the holdInfo shape: { state:'none'|'holding'|'ready', daysLeft?, until? }.
export function boxHoldState(items, holdUntil) {
  if (isHoldReleased(holdUntil)) return { state: 'ready' };
  const stamp = holdInfo(holdUntil);
  const holdItem = (items || []).find(i => isHoldItem(i?.name));
  let item = { state: 'none' };
  if (holdItem) {
    const purchased = holdItem.orderDate || holdItem.soldAt || holdItem.createdAt || null;
    const until = purchased ? weekHoldUntil(purchased) : null;
    item = until ? holdInfo(until.toISOString()) : { state: 'holding' }; // no date to count from
  }
  if (stamp.state === 'holding' && item.state === 'holding') {
    return (item.until && stamp.until && item.until > stamp.until) ? item : stamp;
  }
  if (item.state === 'holding') return item;
  if (stamp.state === 'holding') return stamp;
  if (stamp.state === 'ready' || item.state === 'ready') {
    return { state: 'ready', until: item.until || stamp.until };
  }
  return { state: 'none' };
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
