import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combineGroups, combineRules, pickTarget, sameRecipient } from './combineGroups.js';

const addr = { street1: '60 Country Club Cv', city: 'Jackson', state: 'TN', zip: '38305' };
const ps = { id: 'up123|andie.shell', buyer: 'Andrea H', buyerUsername: 'andie.shell', buyerAddress: addr, items: [] };
const ps2 = { id: 'up456|andie.shell', buyer: 'Andrea H', buyerUsername: 'andie.shell', buyerAddress: addr, items: [] };
const shop = {
  id: 'shopify-bae-1001|andrea h|60 country club cv|jackson|tn|38305', buyer: 'Andrea H', buyerUsername: 'a@example.com',
  buyerAddress: { ...addr, street1: '60 Country Club Cv.' }, items: [{ orderId: '#1001', shopify: { orderGid: 'gid://shopify/Order/1', orderName: '#1001' } }],
};
const other = { id: 'up789|someone', buyer: 'Someone', buyerUsername: 'someone', buyerAddress: { street1: '1 Elm St', zip: '10001' }, items: [] };
const tt = { id: 'tt1|x', buyer: 'Andrea H', buyerUsername: 'andie.shell', buyerAddress: addr, items: [] };

test("a Shopify box sits with its buyer's Palmstreet boxes at the same address", () => {
  const groups = combineGroups([other, shop, ps, ps2]);
  assert.equal(groups[0].key, 'andie.shell');
  assert.deepEqual(groups[0].boxes.map((b) => b.id), [ps.id, ps2.id, shop.id]);
  assert.equal(groups.length, 2);
  // No Palmstreet box at that address → its own group.
  assert.deepEqual(combineGroups([shop, other]).map((g) => g.boxes.length), [1, 1]);
  assert.ok(sameRecipient(shop, ps));
  assert.ok(!sameRecipient(other, ps));
});

test('Shopify + Palmstreet: the Palmstreet box is kept, whichever was picked', () => {
  const sel = [shop, ps];
  const r = combineRules(sel);
  assert.equal(r.mixed, true);
  assert.equal(r.blocked, '');
  assert.deepEqual(r.orders, ['#1001']);
  assert.equal(r.canKeep(shop), false);
  assert.equal(pickTarget(sel, shop.id).id, ps.id);
  assert.equal(pickTarget([shop, ps, ps2], ps2.id).id, ps2.id);
  // Two Shopify boxes: either may be kept.
  const shop2 = { ...shop, id: 'shopify-bae-1002|g' };
  assert.equal(combineRules([shop, shop2]).mixed, false);
  assert.equal(pickTarget([shop, shop2], shop2.id).id, shop2.id);
});

test('a Shopify order never goes into a TikTok or Nigel box', () => {
  assert.match(combineRules([shop, tt]).blocked, /Shopify or Palmstreet/);
  assert.match(combineRules([shop, ps, { ...tt, id: 'ng5|x' }]).blocked, /Shopify or Palmstreet/);
  assert.equal(combineRules([ps, tt]).blocked, '');
});

test('a box with a label is the one kept — the other plants move into it', () => {
  const labeled = new Set([ps.id]);
  const hasLabel = (id) => labeled.has(id);
  const r = combineRules([ps2, ps], hasLabel);
  assert.equal(r.blocked, '');
  assert.equal(r.labeled.id, ps.id);
  assert.equal(r.canKeep(ps2), false);
  assert.equal(pickTarget([ps2, ps], ps2.id, hasLabel).id, ps.id);
  // The production case: the buyer's labeled Palmstreet box takes their Shopify order.
  assert.equal(combineRules([shop, ps], hasLabel).blocked, '');
  assert.equal(pickTarget([shop, ps], shop.id, hasLabel).id, ps.id);
  // No labels → any box may be kept, as before.
  assert.equal(pickTarget([ps, ps2], ps2.id, () => false).id, ps2.id);
});

test('two labeled boxes, or a labeled Shopify box with a Palmstreet box, are refused', () => {
  const both = (id) => id === ps.id || id === ps2.id;
  assert.match(combineRules([ps, ps2], both).blocked, /only one box can keep its label/);
  const shopLabeled = (id) => id === shop.id;
  assert.match(combineRules([shop, ps], shopLabeled).blocked, /Palmstreet box is the one kept/);
  assert.equal(pickTarget([shop, ps], ps.id, shopLabeled), null);
  // Two Shopify boxes, one labeled: that one is kept.
  const shop2 = { ...shop, id: 'shopify-bae-1002|g' };
  assert.equal(pickTarget([shop, shop2], shop.id, (id) => id === shop2.id).id, shop2.id);
});
