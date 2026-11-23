// The plant list, kept in memory and brought up to date with the server's
// change feed (GET /api/items?since=…, api/_lib/itemFeed.js) instead of
// being downloaded whole on every read.
//
// The Shipping tab and every packer device read the list every 8 s, and
// dozens of actions re-read it after a write. Each read used to fetch every
// plant of the brand (~7,000 rows / ~9 MB); on the Nano database that ran
// the disk-read budget dry and the database stopped answering. Now the
// first read is whole, and later ones send the `syncAt` the last answer
// returned and get only the rows changed since, plus the ids that left.
//
// - Reads run one after another. A read that is waiting for the one ahead
//   of it is shared by every caller that asks meanwhile (it starts after all
//   of them asked, so it sees their writes) — a stalled server can't pile up
//   a queue of polls.
// - Every FULL_EVERY_MS, or when the feed is older than the server serves,
//   the read is whole again: a safety net that heals anything a feed missed.
// - The cache belongs to one user + brand (costs are stripped per role); a
//   different key reads everything again.
// - `version` changes only when the list does, so an 8 s poll can skip
//   re-rendering thousands of rows when nothing moved.
// - Callers get a new array each time; the plant objects in it are shared
//   between reads and must not be mutated.

export const FULL_EVERY_MS = 15 * 60 * 1000;
// Under the server's own limit (itemFeed.js MAX_FEED_AGE_MS = 30 min).
export const FEED_MAX_AGE_MS = 20 * 60 * 1000;

// A row the feed sent again (its overlap window) that hasn't changed.
function sameRow(a, b) {
  if (a.changedAt && b.changedAt) return a.changedAt === b.changedAt;
  return JSON.stringify(a) === JSON.stringify(b);
}

// read(since | null) → { items, removedIds?, syncAt?, full? } (the server's
// answer; an answer without `full: false` is a whole list).
export function createItemCache(read, now = () => Date.now()) {
  let state = null;        // { key, byId, syncAt, fullAt, version, list }
  let version = 0;
  let tail = Promise.resolve();
  let waiting = null;      // { key, promise } — queued, not started yet

  async function run(key) {
    const t = now();
    const feedOk = !!state && state.key === key && !!state.syncAt
      && t - state.fullAt < FULL_EVERY_MS
      && t - Date.parse(state.syncAt) < FEED_MAX_AGE_MS;
    const r = await read(feedOk ? state.syncAt : null);
    if (!Array.isArray(r?.items)) throw new Error('Unexpected answer from the server');
    if (!feedOk || r.full !== false) {
      state = { key, byId: new Map(r.items.map((i) => [i.id, i])), syncAt: r.syncAt || null, fullAt: t, version: ++version, list: null };
      return;
    }
    let changed = false;
    for (const id of r.removedIds || []) if (state.byId.delete(id)) changed = true;
    for (const it of r.items) {
      const prev = state.byId.get(it.id);
      if (!prev || !sameRow(prev, it)) { state.byId.set(it.id, it); changed = true; }
    }
    if (r.syncAt) state.syncAt = r.syncAt;
    if (changed) { state.version = ++version; state.list = null; }
  }

  // Same order the server's whole read returns: by id.
  function snapshot() {
    if (!state.list) state.list = [...state.byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { items: state.list.slice(), version: state.version };
  }

  return {
    // → { items, version }
    sync(key) {
      if (waiting && waiting.key === key) return waiting.promise;
      const entry = { key };
      entry.promise = tail
        .then(() => { if (waiting === entry) waiting = null; return run(key); })
        .then(snapshot);
      waiting = entry;
      tail = entry.promise.catch(() => {});
      return entry.promise;
    },
    reset() { state = null; },
  };
}
