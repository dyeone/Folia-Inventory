// Who's who in the Combine orders modal, and which box a combine keeps.
//
// Boxes group by buyer — the Palmstreet username first (the Shipping tab's
// own grouping). A Shopify order's box carries the buyer's email there
// instead (api/_lib/shopify.js), so the same person's Shopify and Palmstreet
// boxes would sit apart: a Shopify box joins the group of a Palmstreet box
// at the same street address + ZIP.
//
// Shopify and Palmstreet boxes can be combined (operator, 2026-11-22); the
// Palmstreet box is the one kept. Its Shopify plants keep their order, so
// the box's tracking still reaches Shopify (pushFulfillments finds them by
// order), while Validate Sales only knows Palmstreet lines in a box that
// reads as Palmstreet (platform.js). TikTok and Nigel boxes never take a
// Shopify order. api/items.js combine-boxes enforces the same.
import { boxPlatform } from './platform.js';

export const buyerKey = (b) => String(b?.buyerUsername || b?.buyer || 'unknown').toLowerCase();

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// "60 country club cv|38305" — '' without a street and ZIP.
export function addressKey(b) {
  const a = b?.buyerAddress || {};
  const street = norm(a.street1);
  const zip = String(a.zip || '').trim().slice(0, 5);
  return street && zip ? `${street}|${zip}` : '';
}

export const sameRecipient = (a, b) => buyerKey(a) === buyerKey(b)
  || (!!addressKey(a) && addressKey(a) === addressKey(b));

const isShopify = (b) => boxPlatform(b?.id) === 'shopify';

// → [{ key, name, username, boxes }], buyers with the most boxes first.
export function combineGroups(boxes) {
  const groups = new Map();
  const byAddress = new Map();     // Palmstreet box address → its group key
  const add = (key, b) => {
    if (!groups.has(key)) {
      groups.set(key, { key, name: b.buyer || b.buyerUsername || 'Unknown buyer', username: b.buyerUsername || '', boxes: [] });
    }
    groups.get(key).boxes.push(b);
  };
  for (const b of boxes || []) {
    if (isShopify(b)) continue;
    const key = buyerKey(b);
    add(key, b);
    const ak = addressKey(b);
    if (ak && boxPlatform(b.id) === 'palmstreet' && !byAddress.has(ak)) byAddress.set(ak, key);
  }
  for (const b of boxes || []) {
    if (!isShopify(b)) continue;
    add(byAddress.get(addressKey(b)) || buyerKey(b), b);
  }
  return [...groups.values()].sort(
    (a, b) => (b.boxes.length - a.boxes.length) || a.name.localeCompare(b.name),
  );
}

// The rules for one selection: whether it mixes a Shopify order with
// another platform's box, whether that's allowed, and which boxes may be
// kept.
export function combineRules(selected) {
  const list = selected || [];
  const shopify = list.filter(isShopify);
  const mixed = shopify.length > 0 && shopify.length < list.length;
  const blocked = mixed && list.some((b) => ['tiktok', 'nigel'].includes(boxPlatform(b.id)))
    ? 'Shopify boxes combine only with Shopify or Palmstreet boxes'
    : '';
  // Shopify order names moving into a Palmstreet box ("#1001").
  const orders = mixed
    ? [...new Set(shopify.flatMap((b) => (b.items || []).map((i) => i.shopify?.orderName || i.orderId).filter(Boolean)))]
    : [];
  return { mixed, blocked, orders, canKeep: (b) => !mixed || !isShopify(b) };
}

// The kept box: the one picked, when it may be kept; else the first that may.
export function pickTarget(selected, keepId) {
  const { canKeep } = combineRules(selected);
  const picked = (selected || []).find((b) => b.id === keepId);
  return (picked && canKeep(picked) ? picked : (selected || []).find(canKeep)) || null;
}
