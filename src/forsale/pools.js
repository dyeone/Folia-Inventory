// For Sale tab rules on the client side. The server (api/_lib/pool.js,
// api/_lib/shopify.js) is authoritative; these mirror it for display.

export const POOLS = [
  { id: 'palmstreet', label: 'Palmstreet', hint: 'exported as the Palmstreet CSV' },
  { id: 'shopify', label: 'Shopify', hint: 'synced to the Shopify store' },
];
export const FOR_SALE_STATUSES = ['available', 'listed', 'acclimated'];

export const isForSale = (i) => !!i && !i.deletedAt && FOR_SALE_STATUSES.includes(i.status) && !i.shipmentBoxId;

// Plants in a pool right now (sold / boxed / trashed ones drop out).
export function poolItems(items, pool) {
  return (items || []).filter((i) => i.salePool === pool && isForSale(i));
}

// Plants that can join a pool: in stock, not in one yet.
export function joinableItems(items) {
  return (items || []).filter((i) => isForSale(i) && !i.salePool);
}

// Does a sale event hold its plants right now? An 'ongoing' event dated from
// yesterday on (an undated one always); packing / closed / past events let
// their leftovers sell again. Mirrors eventHolds in api/_lib/shopify.js —
// the Shopify pause and the calendar's "in another event" rule use it.
export function eventHolds(sale, now = new Date()) {
  if (!sale || sale.status !== 'ongoing') return false;
  const d = String(sale.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return true;
  return d >= ymd(new Date(now.getTime() - 86400000));
}

export const openSaleIdSet = (sales) => new Set((sales || []).filter((s) => eventHolds(s)).map((s) => s.id));

const priced = (i) => Number(i.listingPrice) > 0;

// What a Shopify-pool plant's listing is doing, for its card. Mirrors
// desiredListing() in api/_lib/shopify.js plus the stored sync state.
// tone: 'ok' | 'wait' | 'warn' | 'error'
export function shopifyBadge(item, openSaleIds, connected) {
  const sh = item.shopify || {};
  if (!connected) return { tone: 'wait', label: 'Not synced', detail: 'Shopify isn\'t connected yet' };
  if (sh.error) return { tone: 'error', label: 'Sync failed', detail: sh.error };
  if (item.saleId && openSaleIds.has(item.saleId)) return { tone: 'warn', label: 'Paused', detail: 'In an upcoming sale event — hidden on Shopify until it\'s back' };
  if (!priced(item)) return { tone: 'warn', label: 'Needs price', detail: 'Set a price to list it' };
  if (!item.imageUrl) return { tone: 'warn', label: 'Needs photo', detail: 'Add a photo to list it' };
  if (sh.productId && sh.status === 'ACTIVE' && sh.qty === 1 && sh.published) {
    const behind = (item.imageUrl || null) !== (sh.imageUrl || null) || (item.videoUrl || null) !== (sh.videoUrl || null)
      || sh.price !== Number(item.listingPrice).toFixed(2);
    return behind ? { tone: 'wait', label: 'Updating…', detail: 'Changes go to Shopify on the next sync' } : { tone: 'ok', label: 'Live', detail: 'Listed on Shopify' };
  }
  return { tone: 'wait', label: 'Listing…', detail: 'Goes up on the next sync' };
}

// What's missing before a plant is ready to list anywhere.
export function readiness(item) {
  const missing = [];
  if (!item.imageUrl) missing.push('photo');
  if (!item.videoUrl) missing.push('video');
  if (!priced(item)) missing.push('price');
  return missing;
}

export const money = (n) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? `$${v % 1 ? v.toFixed(2) : v.toFixed(0)}` : '—';
};

// Sale event platforms on the calendar. `platform` is the sales row's free
// text; these are the quick picks (Pre Sale + Validate Sales key off
// "Palmstreet" / "TikTok", so those keep their exact spelling).
export const EVENT_PLATFORMS = [
  { id: 'Palmstreet', label: 'Palmstreet live', dot: 'bg-green-500', chip: 'bg-green-50 text-green-800 border-green-200' },
  { id: 'Facebook', label: 'Facebook sale', dot: 'bg-blue-500', chip: 'bg-blue-50 text-blue-800 border-blue-200' },
  { id: 'TikTok', label: 'TikTok live', dot: 'bg-gray-900', chip: 'bg-gray-100 text-gray-800 border-gray-300' },
];
export function platformStyle(platform) {
  const p = String(platform || '').toLowerCase();
  return EVENT_PLATFORMS.find((x) => x.id.toLowerCase() === p)
    || { id: platform, label: platform || 'Sale', dot: 'bg-purple-500', chip: 'bg-purple-50 text-purple-800 border-purple-200' };
}

// "YYYY-MM-DD" of a sale (its date, else its start time), local.
export function saleDay(sale) {
  if (sale?.date && /^\d{4}-\d{2}-\d{2}$/.test(sale.date)) return sale.date;
  if (sale?.startTime) {
    const d = new Date(sale.startTime);
    if (!isNaN(d)) return ymd(d);
  }
  return '';
}

export function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// A Facebook post body for an event's plants: code, name, price per line.
// Still in the event (not sold, not boxed) — the ones that can be taken out.
export const isUnsoldInEvent = (i) => ['available', 'listed'].includes(i.status) && !i.shipmentBoxId && !i.deletedAt;

export function facebookPost(sale, items) {
  const lines = [...items]
    .sort((a, b) => String(a.saleCode || '').localeCompare(String(b.saleCode || '')))
    .map((i) => {
      const name = (i.listingDetails?.title || i.name || '').trim();
      return `${i.saleCode ? `${i.saleCode} · ` : ''}${name} — ${money(i.listingPrice)}`;
    });
  return [`${sale.name}`, '', ...lines, '', 'Comment the code to claim. Each plant is one of a kind — you get the exact plant pictured.'].join('\n');
}
