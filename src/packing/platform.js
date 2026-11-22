// Which selling platform a shipment box came from.
//
// TikTok boxes are minted by parseTikTokOrders with a `tt…` upload nonce,
// Nigel's boxes (BoyGardening order slips imported on the Shipping tab) by
// parseNigelSlips with an `ng…` nonce; every other box id (Palmstreet's
// `up…` nonce, legacy formats, BAE sync, manual boxes) reads as Palmstreet.
// The prefix is the ONLY marker — there's no column for it — so every
// automatic open-box merge is scoped by it: an order never folds into a box
// from a different platform even when the same client is behind both. Only
// a person combines across platforms: a Shopify order into its buyer's
// Palmstreet box (combineGroups.js; the Palmstreet box is kept, so the box
// still reads as Palmstreet).
export const NIGEL_PREFIX = 'ng';
// Shopify boxes are opened by the For Sale tab's Shopify sync (api/_lib/
// shopify.js) when a paid order comes in: `shopify-<order #>|<buyer key>`.
// A longer prefix than tt/ng because some retired Folia boxes were named
// after their buyer ("sh…").
export const SHOPIFY_PREFIX = 'shopify-';

export function isTikTokBoxId(id) {
  return String(id || '').startsWith('tt');
}

export function isNigelBoxId(id) {
  return String(id || '').startsWith(NIGEL_PREFIX);
}

export function isShopifyBoxId(id) {
  return String(id || '').startsWith(SHOPIFY_PREFIX);
}

// 'tiktok' | 'nigel' | 'shopify' | 'palmstreet'. Compare platforms with this
// rather than the booleans above when fencing merges — a boolean check
// partitions into only two buckets and would fold a third platform into
// Palmstreet.
export function boxPlatform(id) {
  if (isTikTokBoxId(id)) return 'tiktok';
  if (isNigelBoxId(id)) return 'nigel';
  if (isShopifyBoxId(id)) return 'shopify';
  return 'palmstreet';
}
