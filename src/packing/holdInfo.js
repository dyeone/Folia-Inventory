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
