import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

// A tiny PostgREST stand-in: eq / gte / lt / not / limit / delete over
// in-memory tables; `missing` names tables/columns that don't exist yet
// (before migration 0056).
let db;
class Query {
  constructor(table) { this.table = table; this.filters = []; this.action = 'select'; this.max = Infinity; this.cols = []; }
  select() { return this; }
  delete() { this.action = 'delete'; return this; }
  eq(k, v) { this.cols.push(k); this.filters.push((r) => r[k] === v); return this; }
  gte(k, v) { this.cols.push(k); this.filters.push((r) => r[k] >= v); return this; }
  lt(k, v) { this.cols.push(k); this.filters.push((r) => r[k] < v); return this; }
  not(k, _op, v) { this.cols.push(k); this.filters.push((r) => (r[k] ?? null) !== v); return this; }
  limit(n) { this.max = n; return this; }
  then(resolve, reject) { return Promise.resolve().then(() => this.run()).then(resolve, reject); }
  run() {
    if (db.timeout === this.table) return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
    if (db.missing.includes(this.table)) return { data: null, error: { code: '42P01', message: `relation "${this.table}" does not exist` } };
    const col = this.cols.find((c) => db.missing.includes(c));
    if (col) return { data: null, error: { code: '42703', message: `column inventory_items.${col} does not exist` } };
    const rows = db.tables[this.table] ||= [];
    const hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.action === 'delete') { db.tables[this.table] = rows.filter((r) => !hit.includes(r)); return { data: null, error: null }; }
    return { data: hit.slice(0, this.max), error: null };
  }
}
const supabaseMock = mock.module(new URL('./supabase.js', import.meta.url), {
  namedExports: { supabase: { from: (t) => new Query(t) } },
});
const fetchAllMock = mock.module(new URL('./fetchAll.js', import.meta.url), {
  namedExports: { fetchAllById: async (build) => {
    const { data, error } = await build();
    if (error) throw new Error(error.message);
    return data;
  } },
});
const { feedSince, readItemFeed, itemHousekeeping, OVERLAP_MS, MAX_FEED_AGE_MS } = await import('./itemFeed.js');
after(() => { supabaseMock.restore(); fetchAllMock.restore(); });

const T = Date.UTC(2026, 10, 23, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

test('feedSince: only a recent, sane syncAt opens the feed', () => {
  assert.equal(feedSince(iso(T - 8000), T), T - 8000);
  assert.equal(feedSince(undefined, T), null);
  assert.equal(feedSince('yesterday-ish', T), null);
  assert.equal(feedSince(iso(T - MAX_FEED_AGE_MS - 1), T), null);
  assert.equal(feedSince(iso(T + 10 * 60 * 1000), T), null);
});

test('the feed is the rows stamped since (with the overlap) and the ids that left', async () => {
  db = { missing: [], tables: {
    inventory_items: [
      { id: 'old', brandId: 'bae', changedAt: iso(T - OVERLAP_MS - 60000) },
      { id: 'overlap', brandId: 'bae', changedAt: iso(T - 60000) },
      { id: 'new', brandId: 'bae', changedAt: iso(T + 3000) },
      { id: 'gin', brandId: 'bae-gin', changedAt: iso(T + 3000) },
    ],
    inventory_item_tombstones: [
      { itemId: 'gone', brandId: 'bae', goneAt: iso(T + 1000) },
      { itemId: 'gone', brandId: 'bae', goneAt: iso(T + 2000) },
      { itemId: 'long-gone', brandId: 'bae', goneAt: iso(T - OVERLAP_MS - 1000) },
      { itemId: 'gin-gone', brandId: 'bae-gin', goneAt: iso(T + 1000) },
    ],
  } };
  const feed = await readItemFeed('bae', T);
  assert.deepEqual(feed.items.map((r) => r.id).sort(), ['new', 'overlap']);
  assert.deepEqual(feed.removedIds, ['gone']);
});

test('before migration 0056 (or with too many removals) the full read answers', async () => {
  db = { missing: ['inventory_item_tombstones'], tables: {} };
  assert.equal(await readItemFeed('bae', T), null);
  db = { missing: ['changedAt'], tables: { inventory_item_tombstones: [] } };
  assert.equal(await readItemFeed('bae', T), null);
  db = { missing: [], tables: { inventory_items: [], inventory_item_tombstones: Array.from({ length: 1000 }, (_, i) => ({ itemId: `x${i}`, brandId: 'bae', goneAt: iso(T) })) } };
  assert.equal(await readItemFeed('bae', T), null);
  // Any other failure is a real error (the poll keeps its last list).
  db = { missing: [], timeout: 'inventory_item_tombstones', tables: {} };
  await assert.rejects(readItemFeed('bae', T), /statement timeout/);
  db = { missing: [], timeout: 'inventory_items', tables: { inventory_item_tombstones: [] } };
  await assert.rejects(readItemFeed('bae', T), /statement timeout/);
});

test('housekeeping purges 30-day trash and day-old tombstones of the brand only, and never throws', async () => {
  db = { missing: [], tables: {
    inventory_items: [
      { id: 'trash-old', brandId: 'bae', deletedAt: iso(T - 31 * 86400000) },
      { id: 'trash-new', brandId: 'bae', deletedAt: iso(T - 86400000) },
      { id: 'live', brandId: 'bae', deletedAt: null },
      { id: 'gin-trash-old', brandId: 'bae-gin', deletedAt: iso(T - 31 * 86400000) },
    ],
    inventory_item_tombstones: [
      { itemId: 'a', brandId: 'bae', goneAt: iso(T - 2 * 86400000) },
      { itemId: 'b', brandId: 'bae', goneAt: iso(T - 60000) },
    ],
  } };
  await itemHousekeeping('bae', T);
  assert.deepEqual(db.tables.inventory_items.map((r) => r.id), ['trash-new', 'live', 'gin-trash-old']);
  assert.deepEqual(db.tables.inventory_item_tombstones.map((r) => r.itemId), ['b']);
  db = { missing: ['inventory_item_tombstones'], tables: { inventory_items: [] } };
  await itemHousekeeping('bae', T);
});
