// The bench sweep: before this week's packing starts, the packer walks the
// bench, finds every plant belonging to a box that ISN'T shipping this week —
// still ON HOLD, or local pickup — and scans each barcode off a checklist, so
// those plants leave the bench (to the hold or pickup shelf) before they can
// be mixed up with current-week stock.
//
// Found-marks are per device (localStorage): the sweep is one packer with one
// scanner walking one bench, and the durable truth stays physical — the plant
// sitting on its shelf. Marks expire after 16 days (longer than the longest
// hold) so a plant held again weeks later starts unchecked; the sweep's Reset
// button clears them early.

// Exported so PackerView can listen for other tabs' writes (storage events)
// and converge instead of clobbering them with its own stale snapshot.
export const SWEEP_KEY = 'folia.packerHoldSweep';
// Longer than the longest possible hold: a Monday-of-week-W purchase holds a
// full 14 days (ships Monday of W+2), and marks made on day 1 must survive to
// the end — expiring mid-hold would un-find a shelf of already-swept plants.
const MAX_AGE_MS = 16 * 24 * 60 * 60 * 1000;

// { [itemId]: foundAtMs } with expired entries dropped.
export function loadSweepMarks() {
  try {
    const raw = JSON.parse(localStorage.getItem(SWEEP_KEY) || '{}');
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
  try { localStorage.setItem(SWEEP_KEY, JSON.stringify(marks)); } catch { /* private mode */ }
}
