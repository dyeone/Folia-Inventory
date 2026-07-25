// The held-plants sweep: before this week's packing starts, the packer walks
// the bench, finds every plant belonging to a box that's still ON HOLD, and
// scans each barcode off a checklist — so held plants leave the bench (to the
// hold shelf) before they can be mixed up with current-week stock.
//
// Found-marks are per device (localStorage): the sweep is one packer with one
// scanner walking one bench, and the durable truth stays physical — the plant
// sitting on the hold shelf. Marks expire after 9 days so a plant held again
// weeks later starts unchecked; the sweep's Reset button clears them early.

const KEY = 'folia.packerHoldSweep';
const MAX_AGE_MS = 9 * 24 * 60 * 60 * 1000;

// { [itemId]: foundAtMs } with expired entries dropped.
export function loadSweepMarks() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    const now = Date.now();
    const out = {};
    for (const [id, ts] of Object.entries(raw)) {
      if (typeof ts === 'number' && now - ts < MAX_AGE_MS) out[id] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveSweepMarks(marks) {
  try { localStorage.setItem(KEY, JSON.stringify(marks)); } catch { /* private mode */ }
}
