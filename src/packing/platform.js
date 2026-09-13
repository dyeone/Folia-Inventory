// Which selling platform a shipment box came from.
//
// TikTok boxes are minted by parseTikTokOrders with a `tt…` upload nonce,
// Nigel's boxes (BoyGardening order slips imported on the Shipping tab) by
// parseNigelSlips with an `ng…` nonce; every other box id (Palmstreet's
// `up…` nonce, legacy formats, BAE sync, manual boxes) reads as Palmstreet.
// The prefix is the ONLY marker — there's no column for it — so every
// open-box merge is scoped by it: an order never folds into a box from a
// different platform even when the same client is behind both.
export const NIGEL_PREFIX = 'ng';

export function isTikTokBoxId(id) {
  return String(id || '').startsWith('tt');
}

export function isNigelBoxId(id) {
  return String(id || '').startsWith(NIGEL_PREFIX);
}

// 'tiktok' | 'nigel' | 'palmstreet'. Compare platforms with this rather
// than the booleans above when fencing merges — a boolean check partitions
// into only two buckets and would fold a third platform into Palmstreet.
export function boxPlatform(id) {
  if (isTikTokBoxId(id)) return 'tiktok';
  if (isNigelBoxId(id)) return 'nigel';
  return 'palmstreet';
}
