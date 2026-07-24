// Rolling weekly lot blocks — single source of truth for which lineup numbers
// a calendar week owns. Lineup numbers used to restart near 1 every week, but
// week-scoped shipping holds (bought week W ships week W+2) keep last week's
// labels on the packing bench next to this week's — same numbers, wrong
// plants. Each week now owns one of five fixed 200-number blocks (1–200,
// 201–400, … 801–1000) rotating by absolute week, so any two weeks whose
// plants can share the bench never share a number.

export const CYCLE = 5;   // blocks in the rotation
export const BLOCK = 200; // numbers per block
// WEEK_OFFSET is chosen so the first new-scheme week (2026-W31, absWeek 134)
// lands on block 1 (lots 201–400), pushing the 1–200 block out to week 35 —
// by then every legacy 1–160 label has aged off the bench. It also puts
// late-week-30 numbering in block 0, where the legacy counter (~161)
// continues in place.
export const WEEK_OFFSET = 2;

// Absolute week 0 starts Monday 2024-01-01.
const EPOCH = new Date(2024, 0, 1);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Parse 'YYYY-MM-DD' as a LOCAL calendar date — new Date() would read it as
// UTC midnight, which in US timezones lands on the previous local day and can
// cross a week boundary on Mondays (same convention as isoWeek in
// labels/LabelSheet.jsx).
export function parseLocal(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Local Monday 00:00 of the week containing d.
function mondayOf(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
}

// Absolute week index of a date: whole weeks between its local Monday and the
// epoch Monday. Math.round absorbs the ±1h DST drift between two local
// midnights. Accepts a Date or 'YYYY-MM-DD'; invalid/missing input means now.
export function lotWeek(input) {
  let d = input instanceof Date
    ? input
    : (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input) ? parseLocal(input) : null);
  if (!d || isNaN(d.getTime())) d = new Date();
  return Math.round((mondayOf(d) - EPOCH) / WEEK_MS);
}

// Which block a week owns, and the lot-number range that comes with it. The
// double modulo keeps pre-2024 (negative) weeks from a typo'd sale date in
// 0..CYCLE-1 instead of yielding a negative block range.
export function blockIndex(week) { return (((week + WEEK_OFFSET) % CYCLE) + CYCLE) % CYCLE; }
export function blockStart(week) { return blockIndex(week) * BLOCK + 1; }
export function blockEnd(week) { return blockStart(week) + BLOCK - 1; }

// The lot week a sale's numbering belongs to (today when the sale is undated).
export function saleWeek(sale) { return lotWeek(sale?.date); }

// ISO week number (1–53) of an absolute lot week — the "wk N" printed on
// labels, for captions shown next to the block range. A week's ISO number is
// ceil(dayOfYear of its Thursday / 7); Math.round absorbs DST drift.
export function isoWeekNum(week) {
  const thu = new Date(EPOCH.getFullYear(), EPOCH.getMonth(), EPOCH.getDate() + week * 7 + 3);
  const doy = Math.round((thu - new Date(thu.getFullYear(), 0, 1)) / 86400000) + 1;
  return Math.ceil(doy / 7);
}
