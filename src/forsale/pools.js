// For Sale tab rules on the client side. The server (api/_lib/pool.js,
// api/_lib/shopify.js) is authoritative; these mirror it for display.

// ONE pool (2026-11-19). A plant's salePool says whether it's also on the
// website (the values predate the single pool; see api/_lib/pool.js):
export const IN_POOL = 'palmstreet';    // in the pool only — Palmstreet CSV, sale events
export const ON_WEBSITE = 'shopify';    // pushed to the website (the Shopify store)
export const FOR_SALE_STATUSES = ['available', 'listed', 'acclimated'];

export const isForSale = (i) => !!i && !i.deletedAt && FOR_SALE_STATUSES.includes(i.status) && !i.shipmentBoxId;
export const onWebsite = (i) => i?.salePool === ON_WEBSITE;

// Plants in the pool right now (sold / boxed / trashed ones drop out).
export function poolItems(items) {
  return (items || []).filter((i) => i.salePool && isForSale(i));
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

// A website sale sells ON the website: its plants stay listed there. Every
// other open event hides them on the website until it's over. Mirrors
// isWebsiteSale / holdingSaleIds in api/_lib/shopify.js.
export const isWebsiteSale = (sale) => /^website/i.test(String(sale?.platform || '').trim());
export const pauseSaleIdSet = (sales) => new Set((sales || []).filter((s) => eventHolds(s) && !isWebsiteSale(s)).map((s) => s.id));

// Upcoming events a plant can be put in, soonest first.
export function openEvents(sales) {
  return (sales || []).filter((s) => eventHolds(s))
    .sort((a, b) => (saleDay(a) || '9999').localeCompare(saleDay(b) || '9999') || String(a.name).localeCompare(String(b.name)));
}

const priced = (i) => Number(i.listingPrice) > 0;

// Photos per plant in the For Sale tab (the server refuses past it too).
export const MAX_PHOTOS = 10;

// The plant's photos, cover first: its photo list (0053). A cover that isn't
// one of them (a pasted URL, a copied row's photo — or any cover before
// 0053) still leads: it's the picture the plant shows everywhere else.
// Mirrors photosOf in api/_lib/shopify.js.
export function photosOf(item) {
  const list = Array.isArray(item?.photoUrls) ? item.photoUrls.filter((u) => typeof u === 'string' && u) : [];
  const cover = typeof item?.imageUrl === 'string' && item.imageUrl ? item.imageUrl : null;
  return cover && !list.includes(cover) ? [cover, ...list] : list;
}

// A stored photo's id from its URL (…/plant-photos/items/<itemId>/<id>.<ext>);
// null for a pasted URL, which the gallery shows but can't delete or move.
export function photoIdOf(url, itemId) {
  const m = /\/plant-photos\/items\/([\w-]+)\/([\w-]+)\.[a-z0-9]+(?:\?|$)/i.exec(String(url || ''));
  return m && m[1] === String(itemId) ? m[2] : null;
}

function listedPhotos(sh) {
  if (Array.isArray(sh?.photoUrls)) return sh.photoUrls;
  return sh?.imageUrl ? [sh.imageUrl] : [];
}

// What a website plant's listing is doing, for its card. Mirrors
// desiredListing() in api/_lib/shopify.js plus the stored sync state.
// pausedSaleIds: pauseSaleIdSet(sales). tone: 'ok' | 'wait' | 'warn' | 'error'
export function shopifyBadge(item, pausedSaleIds, connected) {
  const sh = item.shopify || {};
  if (!connected) return { tone: 'wait', label: 'Waiting', detail: 'Shopify isn\'t connected for this brand yet — it goes up once it is' };
  if (sh.error) return { tone: 'error', label: 'Sync failed', detail: sh.error };
  if (item.saleId && pausedSaleIds.has(item.saleId)) return { tone: 'warn', label: 'Paused', detail: 'In an upcoming sale event — hidden on the website until it\'s over' };
  if (!priced(item)) return { tone: 'warn', label: 'Needs price', detail: 'Set a price to list it' };
  if (!photosOf(item).length) return { tone: 'warn', label: 'Needs photo', detail: 'Add a photo to list it' };
  if (sh.productId && sh.status === 'ACTIVE' && sh.qty === 1 && sh.published) {
    const behind = photosOf(item).join('\n') !== listedPhotos(sh).join('\n') || (item.videoUrl || null) !== (sh.videoUrl || null)
      || sh.price !== Number(item.listingPrice).toFixed(2);
    return behind ? { tone: 'wait', label: 'Updating…', detail: 'Changes go to the website on the next sync' } : { tone: 'ok', label: 'Live', detail: 'Listed on the website' };
  }
  return { tone: 'wait', label: 'Going up…', detail: 'Goes up on the next sync' };
}

// What's missing before a plant is ready to list anywhere.
export function readiness(item) {
  const missing = [];
  if (!photosOf(item).length) missing.push('photo');
  if (!item.videoUrl) missing.push('video');
  if (!priced(item)) missing.push('price');
  return missing;
}

export const money = (n) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? `$${v % 1 ? v.toFixed(2) : v.toFixed(0)}` : '—';
};

// Sale event kinds on the calendar. `platform` is the sales row's free
// text; these are the quick picks (Pre Sale + Validate Sales key off
// "Palmstreet" / "TikTok", so those keep their exact spelling). 2026-11-19:
// the operator sorts plants into Palmstreet purge / Palmstreet live /
// Website sale events. A purge gets the Palmstreet CSV like a live; a
// website sale keeps its plants listed on the website (isWebsiteSale).
export const EVENT_PLATFORMS = [
  { id: 'Palmstreet', label: 'Palmstreet live', dot: 'bg-green-500', chip: 'bg-green-50 text-green-800 border-green-200' },
  { id: 'Palmstreet purge', label: 'Palmstreet purge', dot: 'bg-amber-500', chip: 'bg-amber-50 text-amber-800 border-amber-200' },
  { id: 'Website', label: 'Website sale', dot: 'bg-indigo-500', chip: 'bg-indigo-50 text-indigo-800 border-indigo-200' },
  { id: 'Facebook', label: 'Facebook sale', dot: 'bg-blue-500', chip: 'bg-blue-50 text-blue-800 border-blue-200' },
  { id: 'TikTok', label: 'TikTok live', dot: 'bg-gray-900', chip: 'bg-gray-100 text-gray-800 border-gray-300' },
];
export function platformStyle(platform) {
  const p = String(platform || '').toLowerCase();
  return EVENT_PLATFORMS.find((x) => x.id.toLowerCase() === p)
    || { id: platform, label: platform || 'Sale', dot: 'bg-purple-500', chip: 'bg-purple-50 text-purple-800 border-purple-200' };
}
// An event's kind for display: its platform — and a Palmstreet event named
// "purge" (how purges were made before the kind existed) reads as a purge.
export function eventStyle(sale) {
  const p = String(sale?.platform || '').trim().toLowerCase();
  if ((p === 'palmstreet' || !p) && /purge/i.test(sale?.name || '')) return platformStyle('Palmstreet purge');
  return platformStyle(sale?.platform || 'Palmstreet');
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
