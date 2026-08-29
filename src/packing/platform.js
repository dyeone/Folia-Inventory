// Which selling platform a shipment box came from.
//
// TikTok boxes are minted by parseTikTokOrders with a `tt…` upload nonce;
// every other box id (Palmstreet's `up…` nonce, legacy formats, BAE sync)
// reads as Palmstreet. The prefix is the ONLY marker — there's no column
// for it — so both Validate flows scope their open-box merging by it:
// a TikTok order never folds into a Palmstreet box (or vice versa) even
// when the same client is behind both.
export function isTikTokBoxId(id) {
  return String(id || '').startsWith('tt');
}
