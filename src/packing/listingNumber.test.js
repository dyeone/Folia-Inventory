import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listingNumber, listingText, listingTag, shownLot, compareListing } from './listingNumber.js';
import { findDupeLots } from './dupeLots.js';
import { buildTagRows } from './tagList.js';

// The BAE plants of 2026-11-21 (Shipping tab, one buyer's box).
const thursday = '2026-11-19T00:37:06.996Z';
const pooled = '2026-11-20T23:33:37.834Z';
const A944 = { sku: 'B-ANT-A944', lotNumber: '268', saleCode: 'A27', poolAddedAt: pooled, stagedAt: null };
const N9089 = { sku: 'BAE-NC-ANT-9089', lotNumber: '255', saleCode: 'A25', poolAddedAt: pooled, stagedAt: '2026-11-19T00:38:00Z' };
const A9641 = { sku: 'B-ANT-9641', lotNumber: null, saleCode: 'A32', poolAddedAt: pooled };
const A9660 = { sku: 'B-ANT-9660', lotNumber: '237', saleCode: null, stagedAt: thursday };
const A655 = { sku: 'B-ANT-A655', lotNumber: '244', saleCode: 'CZ48', poolAddedAt: null, stagedAt: thursday };

test('a plant sold from the pool shows its code', () => {
  assert.deepEqual(listingNumber(A9641), { text: 'A32', kind: 'code' });
  assert.deepEqual(listingNumber(A9660), { text: '237', kind: 'lot' });
  assert.equal(listingNumber({ sku: 'x' }), null);
});

test('with both, whichever the plant got last wins', () => {
  // #268 in Thursday's live, then the pool as A27 → A27.
  assert.equal(listingText(A944), 'A27');
  assert.equal(listingText(N9089), 'A25');
  // In the pool as A27 first, then staged into a live and numbered → the #.
  assert.equal(listingText({ ...A944, stagedAt: '2026-11-22T01:00:00Z', lotNumber: '12' }), '12');
  // An old random code from before codes were dated loses to the #.
  assert.equal(listingText(A655), '244');
  // Junk in saleCode is not a code.
  assert.equal(listingText({ lotNumber: '5', saleCode: '???', poolAddedAt: pooled }), '5');
});

test('toasts and summaries: "#268 · " for a lineup number, "A27 · " for a code', () => {
  assert.equal(listingTag(A9660), '#237 · ');
  assert.equal(listingTag(A944), 'A27 · ');
  assert.equal(listingTag({}), '');
});

test('an old # under a newer code is not a duplicate of another plant\'s #', () => {
  assert.equal(shownLot(A944), null);
  assert.equal(shownLot(A9660), 237);
  const other268 = { sku: 'B-ANT-1', lotNumber: '268', stagedAt: thursday, status: 'sold' };
  const boxes = [{ items: [{ ...A944, status: 'sold' }, other268] }];
  assert.equal(findDupeLots(boxes).size, 0);
  const twin = { sku: 'B-ANT-2', lotNumber: '268', stagedAt: thursday, status: 'sold' };
  assert.deepEqual([...findDupeLots([{ items: [other268, twin] }])], [268]);
});

test('bench order: numbers, then codes in code order, then neither', () => {
  const list = [{ sku: 'none' }, A944, { saleCode: 'A3', poolAddedAt: pooled }, A9660, { lotNumber: '9' }, { saleCode: 'B1', poolAddedAt: pooled }];
  assert.deepEqual([...list].sort(compareListing).map(listingText), ['9', '237', 'A3', 'A27', 'B1', '']);
});

test('the tag list exports the number the plant shows', () => {
  const sold = (p) => ({ ...p, status: 'sold', salePrice: 150, name: 'n' });
  const rows = buildTagRows([{ id: 'b1', items: [sold(A944), sold(A9660), sold(A9641)] }]);
  assert.deepEqual(rows.map((r) => r.lot), ['237', 'A27', 'A32']);
  assert.ok(rows.every((r) => !('item' in r)));
});
