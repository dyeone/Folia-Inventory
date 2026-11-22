import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLineTitle, nameScore, namesMatch, pickPlant } from './shopifyMatch.js';

test('a title gives its lot number or plant code, and the name after it', () => {
  assert.deepEqual(parseLineTitle('154 Dark handsome x dream weaver'), { code: '', lot: 154, name: 'Dark handsome x dream weaver' });
  assert.deepEqual(parseLineTitle('#157 - Anthurium Dark&Handsome X Dream Weaver'), { code: '', lot: 157, name: 'Anthurium Dark&Handsome X Dream Weaver' });
  assert.deepEqual(parseLineTitle('No. 23 Red velvet'), { code: '', lot: 23, name: 'Red velvet' });
  assert.deepEqual(parseLineTitle('A12 Red velvet x Michelle'), { code: 'A12', lot: null, name: 'Red velvet x Michelle' });
  assert.deepEqual(parseLineTitle('Red velvet x Michelle · B7'), { code: 'B7', lot: null, name: 'Red velvet x Michelle' });
  assert.deepEqual(parseLineTitle('Anthurium Dark&Handsome'), { code: '', lot: null, name: 'Anthurium Dark&Handsome' });
  assert.equal(parseLineTitle('').lot, null);
});

test('names agree on nearly every word, not on one shared word', () => {
  const ok = (a, b) => namesMatch(nameScore(a, b), a, b);
  assert.ok(ok('Dark handsome x dream weaver', 'Anthurium Dark&Handsome X Dream Weaver'));
  assert.ok(ok('Red velvet cake x Michelle', 'Red velvet x Michelle'));
  assert.ok(ok('Anthurium Dark&Handsome X Carlablackiae', 'Anthurium Dark&Handsome X Carlablackiae'));
  assert.ok(!ok('Anthurium Dark&Handsome X Carlablackiae', 'Michelle RVC x Carla'));
  assert.ok(!ok('Red velvet cake x Michelle', 'Fort Sherman x Night dragon'));
  assert.ok(!ok('Dark handsome x dream weaver', '???'));
  assert.ok(!ok('Dark handsome x dream weaver', 'Dark Phoenix'));
});

// Lot 154 on 2026-11-21: the plant in the running Facebook purge, an older
// plant still for sale under the same number, and two long shipped.
const lot154 = [
  { id: 'a', sku: 'B-ANT-A919', lotNumber: 154, name: 'Dark handsome x dream weaver', status: 'available', saleId: 'fb' },
  { id: 'b', sku: 'B-ANT-9825', lotNumber: 154, name: 'Red tiger x Pink lemonade', status: 'available', saleId: 'old' },
  { id: 'c', sku: 'JG-ANT-7757', lotNumber: 154, name: '???', status: 'available' },
  { id: 'd', sku: 'ANT-8577', lotNumber: 154, name: 'Plum sauce Night Dragon', status: 'shipped', shipmentBoxId: 'up1' },
  { id: 'e', sku: 'UNMATCHED-upm-r70', lotNumber: 154, name: 'Dark handsome x dream weaver', status: 'sold', lotKind: 'unmatched', shipmentBoxId: 'up2' },
];

test('the lot number plus the name finds the one plant', () => {
  const m = pickPlant('154 Dark handsome x dream weaver', lot154, { ongoingSaleIds: new Set(['fb']) });
  assert.equal(m.plant?.sku, 'B-ANT-A919');
  assert.match(m.how, /lot 154/);
});

test('a plant already sold or boxed is never picked — the line waits for a person', () => {
  const sold = lot154.map((p) => (p.id === 'a' ? { ...p, status: 'sold', shipmentBoxId: 'up9' } : p));
  const m = pickPlant('154 Dark handsome x dream weaver', sold);
  assert.equal(m.plant, null);
  assert.equal(m.reason, 'taken');
  assert.deepEqual(m.near.map((p) => p.sku), ['B-ANT-A919']);
});

test('two equally good plants are left for a person; a running event breaks the tie', () => {
  const twin = { id: 'f', sku: 'B-ANT-A777', lotNumber: 154, name: 'Dark handsome x dream weaver', status: 'available', saleId: 'old' };
  const both = [...lot154, twin];
  const m = pickPlant('154 Dark handsome x dream weaver', both);
  assert.equal(m.plant, null);
  assert.equal(m.reason, 'ambiguous');
  assert.equal(m.near.length, 2);
  assert.equal(pickPlant('154 Dark handsome x dream weaver', both, { ongoingSaleIds: new Set(['fb']) }).plant?.sku, 'B-ANT-A919');
});

test('no number, wrong name, or a code whose plant is gone → no pick', () => {
  assert.equal(pickPlant('Dark handsome x dream weaver', lot154).reason, 'no-number');
  assert.equal(pickPlant('154 Carla x Carla', lot154).reason, 'none');
  const coded = [{ id: 'g', sku: 'B-ANT-1', saleCode: 'A12', status: 'sold', shipmentBoxId: 'b' }];
  assert.equal(pickPlant('A12 Red velvet', coded).reason, 'taken');
  assert.equal(pickPlant('A12 Red velvet', [{ ...coded[0], status: 'available', shipmentBoxId: null }]).plant?.sku, 'B-ANT-1');
});
