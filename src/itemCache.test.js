import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createItemCache, FULL_EVERY_MS } from './itemCache.js';

const row = (id, changedAt, extra = {}) => ({ id, changedAt, ...extra });

// A fake server: answers whole when `since` is null, else the queued feed.
function fakeServer() {
  const calls = [];
  const feeds = [];
  let whole = [];
  let clock = 1000;
  const read = async (since) => {
    calls.push(since);
    clock += 1;
    const syncAt = new Date(Date.UTC(2026, 10, 23, 12, 0, clock % 60)).toISOString();
    if (since === null) return { items: whole, syncAt, full: true };
    return { ...(feeds.shift() || { items: [], removedIds: [] }), syncAt, full: false };
  };
  return { read, calls, feeds, setWhole: (w) => { whole = w; } };
}

test('first read is whole, later reads apply only the changes', async () => {
  const s = fakeServer();
  let t = Date.UTC(2026, 10, 23, 12, 0, 0);
  const cache = createItemCache(s.read, () => t);
  s.setWhole([row('b', '1'), row('a', '1'), row('c', '1')]);
  const first = await cache.sync('u|bae');
  assert.deepEqual(first.items.map((i) => i.id), ['a', 'b', 'c']);
  assert.equal(s.calls[0], null);

  // Nothing changed (the overlap re-sends 'a' as it was): same version.
  s.feeds.push({ items: [row('a', '1')], removedIds: [] });
  const quiet = await cache.sync('u|bae');
  assert.notEqual(s.calls[1], null);
  assert.equal(quiet.version, first.version);

  // 'b' edited, 'c' gone, 'd' new.
  s.feeds.push({ items: [row('b', '2', { status: 'sold' }), row('d', '2')], removedIds: ['c'] });
  const next = await cache.sync('u|bae');
  assert.notEqual(next.version, first.version);
  assert.deepEqual(next.items.map((i) => i.id), ['a', 'b', 'd']);
  assert.equal(next.items.find((i) => i.id === 'b').status, 'sold');
  // Callers get their own array.
  next.items.pop();
  assert.equal((await cache.sync('u|bae')).items.length, 3);
});

test('a removal and a return in one window keep the plant (moved away and back)', async () => {
  const s = fakeServer();
  const cache = createItemCache(s.read, () => Date.UTC(2026, 10, 23, 12, 0, 0));
  s.setWhole([row('a', '1')]);
  await cache.sync('k');
  s.feeds.push({ items: [row('a', '3')], removedIds: ['a'] });
  assert.deepEqual((await cache.sync('k')).items.map((i) => i.id), ['a']);
});

test('reads whole again after FULL_EVERY_MS, for another user/brand, or when the server falls back', async () => {
  const s = fakeServer();
  let t = Date.UTC(2026, 10, 23, 12, 0, 0);
  const cache = createItemCache(s.read, () => t);
  s.setWhole([row('a', '1')]);
  await cache.sync('k');
  await cache.sync('k');
  assert.equal(s.calls.filter((c) => c === null).length, 1);
  await cache.sync('other');
  assert.equal(s.calls.filter((c) => c === null).length, 2);
  t += FULL_EVERY_MS + 1;
  await cache.sync('other');
  assert.equal(s.calls.filter((c) => c === null).length, 3);

  // Server can't serve the feed (0056 not applied): its whole answer replaces the list.
  const fallback = createItemCache(async (since) => ({ items: since ? [row('z', '9')] : [row('a', '1')], syncAt: '2026-11-23T12:00:00.000Z', full: true }), () => Date.UTC(2026, 10, 23, 12, 0, 30));
  await fallback.sync('k');
  assert.deepEqual((await fallback.sync('k')).items.map((i) => i.id), ['z']);
});

test('reads run one at a time; callers that ask while one waits share it', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let reads = 0;
  const read = async () => {
    reads += 1; inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return { items: [row('a', String(reads))], syncAt: null, full: true };
  };
  const cache = createItemCache(read, () => Date.UTC(2026, 10, 23, 12, 0, 0));
  const first = cache.sync('k');
  const firstToo = cache.sync('k');     // asked before it started: shares it
  await new Promise((r) => setTimeout(r, 1));
  assert.equal(inFlight, 1);
  const second = cache.sync('k');       // asked while it runs: waits behind it…
  const third = cache.sync('k');        // …and shares that waiting read
  await Promise.all([first, firstToo, second, third]);
  assert.equal(maxInFlight, 1);
  assert.equal(reads, 2);
  assert.equal(await first, await firstToo);
  assert.equal(await second, await third);
});

test('a failed read leaves the list as it was and the next read still runs', async () => {
  let fail = false;
  const cache = createItemCache(async () => {
    if (fail) throw new Error('down');
    return { items: [row('a', '1')], syncAt: null, full: true };
  }, () => 0);
  await cache.sync('k');
  fail = true;
  await assert.rejects(cache.sync('k'), /down/);
  fail = false;
  assert.deepEqual((await cache.sync('k')).items.map((i) => i.id), ['a']);
});
