// Unit tests for parseLiveSnapshot — fixtures built from the node shapes
// observed during giveaway debugging (see the live-monitor section of
// index.js). Run with:
//   FOLIA_API_URL=http://test BRIDGE_TOKEN=test node --test mac-app/bridge/parse-live.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

// index.js validates env at import time; satisfy it before importing.
process.env.FOLIA_API_URL ||= 'http://test';
process.env.BRIDGE_TOKEN ||= 'test';
process.env.U2_URL ||= 'off';
const { parseLiveSnapshot } = await import('./index.js');

// content-desc attributes encode newlines as &#10; in uiautomator dumps.
const node = (cd) => `<node index="0" content-desc="${cd.replace(/\n/g, '&#10;')}" class="android.view.View" />`;
const wrap = (...nodes) => `<?xml version="1.0"?><hierarchy>${nodes.join('')}</hierarchy>`;

test('auction listing card: label + price + timer', () => {
  const snap = parseLiveSnapshot(wrap(node('ANT-12 - Anthurium crystallinum\n$3\n00:45')));
  assert.equal(snap.live, true);
  assert.equal(snap.listings.length, 1);
  assert.deepEqual(snap.listings[0], {
    label: 'ANT-12 - Anthurium crystallinum', price: 3, timer: '00:45', bids: null,
  });
});

test('bid card: price with bid count', () => {
  const snap = parseLiveSnapshot(wrap(node('$22 (+5)\nSan Jose, CA')));
  assert.equal(snap.listings[0].price, 22);
  assert.equal(snap.listings[0].bids, 5);
});

test('host card sets the current pinned item', () => {
  const snap = parseLiveSnapshot(wrap(node('folia.plants\nHost\nMonstera Thai Constellation')));
  assert.equal(snap.current, 'Monstera Thai Constellation');
  assert.equal(snap.live, true);
});

test('sold toast: buyer handle, price, and label captured', () => {
  const snap = parseLiveSnapshot(wrap(node('Sold to @plantlover99\nMON-4 - Monstera albo\n$120')));
  assert.equal(snap.sold.length, 1);
  assert.equal(snap.sold[0].buyer, 'plantlover99');
  assert.equal(snap.sold[0].price, 120);
  assert.equal(snap.sold[0].label, 'MON-4 - Monstera albo');
  // A sold toast is not also a listing.
  assert.equal(snap.listings.length, 0);
});

test('winner phrasing without @handle falls back to next line', () => {
  const snap = parseLiveSnapshot(wrap(node('Won by\njanedoe\n$45')));
  assert.equal(snap.sold[0].buyer, 'janedoe');
  assert.equal(snap.sold[0].price, 45);
});

test('no price, no host, no sold → not live', () => {
  const snap = parseLiveSnapshot(wrap(node('Settings'), node('Back')));
  assert.equal(snap.live, false);
  assert.deepEqual(snap.listings, []);
  assert.deepEqual(snap.sold, []);
});

test('prices with commas and decimals parse', () => {
  const snap = parseLiveSnapshot(wrap(node('Rare hoya\n$1,250.50\n12:30')));
  assert.equal(snap.listings[0].price, 1250.5);
});
