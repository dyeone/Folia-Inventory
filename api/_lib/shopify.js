// Shopify sync for the For Sale tab's Shopify pool (Admin GraphQL API).
//
// Each plant in the pool is a one-off product: quantity 1, its photos (cover
// first) and its video, its price, its SKU, and its short code in the title
// so the packer can find the pot. The plants are the source of truth; reconcile()
// brings the store in line with them:
//   in the pool, for sale, priced, photographed  → ACTIVE, 1 in stock
//   in the pool but sitting in an open sale event, or missing price/photo,
//   or taken out of the pool                     → DRAFT (kept, re-activates)
//   sold anywhere / shipped / trashed / boxed   → 0 in stock, ARCHIVED
// pullOrders() goes the other way: a paid Shopify order marks its plants sold
// and opens a `shopify-…` box for the packer; once that box has a tracking
// number the order is fulfilled in Shopify (the buyer gets the email). A
// line is matched by SKU; a product made by hand in Shopify has none, so its
// title's lot number + name pick the plant (api/_lib/shopifyMatch.js), and a
// line nothing fits comes in as a placeholder for the packer to fill.
//
// No webhooks (the api function cap, and a missed webhook needs a poll
// anyway): the For Sale tab, the Shipping tab and the packer screen call
// pool-sync, throttled here to one order pull a minute per brand.
//
// Connection (per brand, Vercel env; BRAND = brand id upper-cased, `-` → `_`,
// e.g. SHOPIFY_SHOP_BAE, SHOPIFY_SHOP_BAE_GIN):
//   SHOPIFY_SHOP_<BRAND>            store subdomain (the part before .myshopify.com)
//   SHOPIFY_CLIENT_ID_<BRAND>       Dev Dashboard app, installed on the store —
//   SHOPIFY_CLIENT_SECRET_<BRAND>   tokens come from the client-credentials grant
//                                   (24 h; minted on demand, kept in memory only)
//   or SHOPIFY_ADMIN_TOKEN_<BRAND>  a pre-2026 admin custom app's shpat_ token
//   SHOPIFY_API_VERSION             optional, default 2026-10
// Scopes: write_products, write_inventory, read_locations, write_files,
// write_publications, read_orders, read_customers,
// read/write_merchant_managed_fulfillment_orders.
//
// Tokens never leave this module (not stored, not logged, not returned).
// Sync state (location / publication ids, order cursor, problems) lives in
// app_settings `shopify:<brand>` — readable by any signed-in user, so it
// holds nothing secret.
import crypto from 'crypto';
import { supabase, newId } from './supabase.js';
import { fetchAllById } from './fetchAll.js';
import { parseLineTitle, pickPlant } from './shopifyMatch.js';

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-10';
const FOR_SALE = ['available', 'listed', 'acclimated'];
export const SHOPIFY_BOX_PREFIX = 'shopify-';
const STATE_NS = 'shopify:';
const LOCK_NS = 'shopify-lock:';
const ORDER_PULL_EVERY_MS = 60 * 1000;
const MAX_PROBLEMS = 60;
// "Sync now" (and the first pull after title matching shipped) reads the
// last week of orders again, so an order that came in before its plant
// could be matched gets another go. Re-reading is harmless — every line
// that's already in a box is skipped.
const LOOKBACK_MS = 7 * 86400000;

const fail = (status, message) => { const e = new Error(message); e.status = status; return e; };
// An error about the whole connection (login, access, rate limit) rather
// than one plant — a run that hits these stops instead of failing every row.
const failAll = (status, message) => { const e = fail(status, message); e.global = true; return e; };

// ─── connection ─────────────────────────────────────────────────────────────

export function shopifyEnvKey(brandId) {
  return String(brandId || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

export function shopifyConfig(brandId) {
  const k = shopifyEnvKey(brandId);
  const raw = String(process.env[`SHOPIFY_SHOP_${k}`] || '').trim();
  if (!raw) return null;
  const shop = raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/\.myshopify\.com$/i, '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(shop)) return null;
  const token = String(process.env[`SHOPIFY_ADMIN_TOKEN_${k}`] || '').trim();
  const clientId = String(process.env[`SHOPIFY_CLIENT_ID_${k}`] || '').trim();
  const clientSecret = String(process.env[`SHOPIFY_CLIENT_SECRET_${k}`] || '').trim();
  if (!token && !(clientId && clientSecret)) return null;
  return { brandId, shop, token, clientId, clientSecret };
}

const tokenCache = new Map(); // brandId → { token, exp }

async function accessToken(cfg, { fresh = false } = {}) {
  if (cfg.token) return cfg.token;
  const hit = tokenCache.get(cfg.brandId);
  if (!fresh && hit && hit.exp > Date.now() + 60_000) return hit.token;
  const r = await fetch(`https://${cfg.shop}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const why = j.error === 'shop_not_permitted'
      ? 'the app and the store must be in the same Shopify organization'
      : (j.error_description || j.error || `HTTP ${r.status}`);
    throw failAll(502, `Shopify login failed — ${why}. Check the app's client ID/secret and that it's installed on ${cfg.shop}.myshopify.com.`);
  }
  tokenCache.set(cfg.brandId, { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 86399) * 1000 });
  return j.access_token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One GraphQL call. Throttling is retried (the bucket refills at the store's
// restore rate); a 401 re-mints a client-credentials token once. GraphQL
// errors throw; userErrors are the caller's to read.
async function gql(cfg, query, variables = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = await accessToken(cfg, { fresh: attempt > 0 && !cfg.token });
    const r = await fetch(`https://${cfg.shop}.myshopify.com/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    });
    if (r.status === 401 && !cfg.token && attempt === 0) { tokenCache.delete(cfg.brandId); continue; }
    if (r.status === 401 || r.status === 403) throw failAll(502, 'Shopify refused the app\'s access — check its scopes and that it\'s still installed');
    if (r.status === 429 || r.status >= 500) { await sleep(1000 * (attempt + 1)); continue; }
    const j = await r.json().catch(() => null);
    if (!j) throw fail(502, `Shopify answered HTTP ${r.status} with no data`);
    const errs = j.errors || [];
    if (errs.some((e) => e?.extensions?.code === 'THROTTLED')) {
      const t = j.extensions?.cost?.throttleStatus;
      const need = (j.extensions?.cost?.requestedQueryCost || 50) - (t?.currentlyAvailable || 0);
      await sleep(Math.min(5000, Math.max(500, (need / (t?.restoreRate || 50)) * 1000)));
      continue;
    }
    if (errs.length) {
      const msg = errs.map((e) => e.message).join('; ');
      const whole = errs.some((e) => ['ACCESS_DENIED', 'SHOP_INACTIVE', 'MAX_COST_EXCEEDED'].includes(e?.extensions?.code));
      throw (whole ? failAll : fail)(502, `Shopify: ${msg}`.slice(0, 400));
    }
    return j.data;
  }
  throw failAll(503, 'Shopify is busy (rate limited) — the next sync will retry');
}

function userErrorText(list) {
  const errs = (list || []).filter(Boolean);
  return errs.length ? errs.map((e) => e.message).join('; ') : '';
}

// ─── shared state + lock ────────────────────────────────────────────────────

async function loadState(brandId) {
  const { data } = await supabase.from('app_settings').select('data').eq('id', STATE_NS + brandId).maybeSingle();
  return data?.data && typeof data.data === 'object' ? { ...data.data } : {};
}

async function saveState(brandId, patch, user) {
  const cur = await loadState(brandId);
  const next = { ...cur, ...patch };
  await supabase.from('app_settings').upsert({
    id: STATE_NS + brandId, data: next, updatedAt: new Date().toISOString(), updatedBy: user?.displayName || 'shopify-sync',
  });
  return next;
}

function addProblems(state, list) {
  const keep = (state.problems || []).filter((p) => !list.some((n) => n.key === p.key));
  return [...list, ...keep].slice(0, MAX_PROBLEMS);
}

// One sync per brand at a time (two devices syncing at once would each
// create the same product). Compare-and-set on an app_settings row; the
// holder's random owner id makes release delete only its own lock (a run
// that outlived its lock must not free the next holder's).
async function acquireLock(brandId, ms) {
  const id = LOCK_NS + brandId;
  const owner = crypto.randomUUID();
  const until = new Date(Date.now() + ms).toISOString();
  const { error } = await supabase.from('app_settings').insert({ id, data: { until, owner }, updatedAt: new Date().toISOString(), updatedBy: 'shopify-sync' });
  if (!error) return owner;
  if (error.code !== '23505') return null;
  const { data: cur } = await supabase.from('app_settings').select('data, "updatedAt"').eq('id', id).maybeSingle();
  if (!cur) return null;
  if (cur.data?.until && Date.parse(cur.data.until) > Date.now()) return null;
  const { data: took } = await supabase.from('app_settings')
    .update({ data: { until, owner }, updatedAt: new Date().toISOString() })
    .eq('id', id).eq('updatedAt', cur.updatedAt).select('id');
  return took && took.length ? owner : null;
}

async function releaseLock(brandId, owner) {
  if (!owner) return;
  await supabase.from('app_settings').delete().eq('id', LOCK_NS + brandId).eq('data->>owner', owner);
}

// Does this sale event hold its plants right now? An 'ongoing' event dated
// from yesterday on (an undated one always). Packing / closed events, and
// ongoing ones whose day is past, let their leftovers sell again. Mirrored
// by eventHolds in src/forsale/pools.js and used by api/_lib/pool.js.
export function eventHolds(sale, now = new Date()) {
  if (!sale || sale.status !== 'ongoing') return false;
  const d = String(sale.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return true;
  const y = new Date(now.getTime() - 86400000);
  const cutoff = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  return d >= cutoff;
}

// A website sale (platform "Website…", 2026-11-19) sells ON the website, so
// its plants stay listed; every other holding event hides them there.
// Mirrored by isWebsiteSale in src/forsale/pools.js.
export const isWebsiteSale = (sale) => /^website/i.test(String(sale?.platform || '').trim());

// Events that take their plants off the website right now.
export async function holdingSaleIds(brandId) {
  const { data } = await supabase.from('sales').select('id, status, date, platform').eq('brandId', brandId).eq('status', 'ongoing');
  return new Set((data || []).filter((s) => eventHolds(s) && !isWebsiteSale(s)).map((s) => s.id));
}

// What the For Sale tab shows about the connection. Never secrets.
export async function shopifyPublicState(brandId) {
  const cfg = shopifyConfig(brandId);
  const k = shopifyEnvKey(brandId);
  const env = {
    shop: `SHOPIFY_SHOP_${k}`,
    clientId: `SHOPIFY_CLIENT_ID_${k}`,
    clientSecret: `SHOPIFY_CLIENT_SECRET_${k}`,
    adminToken: `SHOPIFY_ADMIN_TOKEN_${k}`,
  };
  if (!cfg) return { configured: false, env };
  const s = await loadState(brandId);
  return {
    configured: true,
    env,
    shop: `${cfg.shop}.myshopify.com`,
    apiVersion: API_VERSION,
    lastOrderPullAt: s.lastOrderPullAt || null,
    lastListingSyncAt: s.lastListingSyncAt || null,
    lastError: s.lastError || null,
    problems: (s.problems || []).slice(0, 30),
  };
}

export async function dismissShopifyProblems(brandId, keys, user) {
  const s = await loadState(brandId);
  const drop = new Set(keys || []);
  await saveState(brandId, { problems: (s.problems || []).filter((p) => !drop.has(p.key)) }, user);
}

// ─── listings ───────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function details(item) {
  const o = item?.listingDetails;
  return o && typeof o === 'object' ? o : {};
}

// "Anthurium crystallinum · KM42" — the code rides in the title so the
// packing slip and the order email both carry it.
export function shopifyTitle(item) {
  const override = String(details(item).title ?? '').trim();
  const name = (override || item.name || item.sku || 'Plant').replace(/\s+/g, ' ').trim();
  const t = item.saleCode ? `${name} · ${item.saleCode}` : name;
  return t.slice(0, 255);
}

function shopifyDescription(item) {
  const override = String(details(item).description ?? '').trim();
  const lines = override
    ? override.split(/\n+/)
    : [item.name, item.variety ? `Variety: ${item.variety}` : ''].filter(Boolean);
  if (item.saleCode) lines.push(`Plant code: ${item.saleCode}`);
  lines.push('You receive the exact plant pictured.');
  return lines.map((l) => `<p>${esc(l)}</p>`).join('');
}

const priceOf = (item) => {
  const p = Number(item.listingPrice);
  return Number.isFinite(p) && p > 0 ? p.toFixed(2) : null;
};

// The plant's photos, cover first: its photo list (0053). A cover that isn't
// one of them (a pasted URL, a copied row's photo — or any cover before
// 0053) still leads: it's the picture the plant shows everywhere else.
export function photosOf(item) {
  const list = Array.isArray(item?.photoUrls) ? item.photoUrls.filter((u) => typeof u === 'string' && u) : [];
  const cover = typeof item?.imageUrl === 'string' && item.imageUrl ? item.imageUrl : null;
  return cover && !list.includes(cover) ? [cover, ...list] : list;
}
// The photos the product carries, as last synced (listings made before
// multi-photo stored just the one).
function listedPhotos(sh) {
  if (Array.isArray(sh?.photoUrls)) return sh.photoUrls;
  return sh?.imageUrl ? [sh.imageUrl] : [];
}
// The plant's videos in order (0055: several; videoUrl is the first).
export function videosOf(item) {
  const list = Array.isArray(item?.videoUrls) ? item.videoUrls.filter((u) => typeof u === 'string' && u) : [];
  const first = typeof item?.videoUrl === 'string' && item.videoUrl ? item.videoUrl : null;
  return first && !list.includes(first) ? [first, ...list] : list;
}
// The videos the product carries, as last synced (listings made before
// several videos stored just the one).
function listedVideos(sh) {
  if (Array.isArray(sh?.videoUrls)) return sh.videoUrls;
  return sh?.videoUrl ? [sh.videoUrl] : [];
}
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const mediaBehind = (item, sh) => !sameList(photosOf(item), listedPhotos(sh)) || !sameList(videosOf(item), listedVideos(sh));

function fingerprint(item) {
  return crypto.createHash('sha1')
    .update(JSON.stringify([shopifyTitle(item), shopifyDescription(item), priceOf(item), item.sku]))
    .digest('hex').slice(0, 16);
}

// The listing a plant should have right now, and why.
export function desiredListing(item, openSaleIds) {
  const forSale = !item.deletedAt && FOR_SALE.includes(item.status) && !item.shipmentBoxId;
  if (!forSale) return { want: 'gone', reason: item.deletedAt ? 'in the trash' : `plant is ${item.status}` };
  if (item.salePool !== 'shopify') return { want: 'paused', reason: 'not in the Shopify pool' };
  if (item.saleId && openSaleIds.has(item.saleId)) return { want: 'paused', reason: 'in an upcoming sale event' };
  if (!priceOf(item)) return { want: 'paused', reason: 'needs a price' };
  if (!photosOf(item).length) return { want: 'paused', reason: 'needs a photo' };
  return { want: 'active', reason: '' };
}

async function ensureLocation(cfg, state) {
  if (state.locationId) return state.locationId;
  const d = await gql(cfg, 'query { location { id name } }');
  if (!d?.location?.id) throw fail(502, 'Shopify has no primary location — add one in Settings → Locations');
  state.locationId = d.location.id;
  state.dirty = true;
  return state.locationId;
}

async function ensurePublication(cfg, state) {
  if (state.publicationId) return state.publicationId;
  // Looked up again until found (the channel may be added later).
  const d = await gql(cfg, 'query { publications(first: 50) { nodes { id catalog { title } } } }');
  const hit = (d?.publications?.nodes || []).find((p) => /online store/i.test(p?.catalog?.title || ''));
  if (hit) state.publicationId = hit.id;
  return hit ? hit.id : null;
}

// Up to 10 photos + 5 videos per plant; room to spare for strays.
const MEDIA_FIELDS = 'media(first: 50) { nodes { id mediaContentType } }';
const isVideoMedia = (n) => n.mediaContentType === 'VIDEO' || n.mediaContentType === 'EXTERNAL_VIDEO';

async function productMedia(cfg, productId) {
  const d = await gql(cfg, `query PM($id: ID!) { product(id: $id) { id ${MEDIA_FIELDS} } }`, { id: productId });
  return d?.product?.media?.nodes || [];
}

// Shopify won't fetch a video from a URL — it has to be staged: ask for an
// upload target, POST the bytes there, then attach the resourceUrl.
async function stageVideo(cfg, videoUrl, item) {
  const r = await fetch(videoUrl);
  if (!r.ok) throw fail(502, `Couldn't read the plant's video (HTTP ${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  const ext = (videoUrl.split('?')[0].split('.').pop() || 'mp4').toLowerCase();
  const mimeType = { mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v' }[ext] || 'video/mp4';
  const filename = `${(item.saleCode || item.sku || 'plant').replace(/[^\w-]+/g, '-')}.${ext}`;
  const d = await gql(cfg, `mutation Stage($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } }
  }`, { input: [{ filename, mimeType, resource: 'VIDEO', fileSize: String(buf.length), httpMethod: 'POST' }] });
  const ue = userErrorText(d?.stagedUploadsCreate?.userErrors);
  const t = d?.stagedUploadsCreate?.stagedTargets?.[0];
  if (ue || !t) throw fail(502, `Shopify video upload: ${ue || 'no upload target'}`);
  const fd = new FormData();
  for (const p of t.parameters || []) fd.append(p.name, p.value);
  fd.append('file', new Blob([buf], { type: mimeType }), filename);
  const up = await fetch(t.url, { method: 'POST', body: fd });
  if (!up.ok) throw fail(502, `Shopify video upload failed (HTTP ${up.status})`);
  return t.resourceUrl;
}

async function setQuantity(cfg, state, inventoryItemId, quantity, from) {
  const locationId = await ensureLocation(cfg, state);
  const d = await gql(cfg, `mutation Qty($input: InventorySetQuantitiesInput!, $key: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $key) { userErrors { code field message } }
  }`, {
    key: crypto.randomUUID(),
    input: {
      name: 'available', reason: 'correction',
      quantities: [{ inventoryItemId, locationId, quantity, changeFromQuantity: from ?? null }],
    },
  });
  const errs = d?.inventorySetQuantities?.userErrors || [];
  if (!errs.length) return { ok: true };
  if (errs.some((e) => e.code === 'CHANGE_FROM_QUANTITY_STALE')) return { ok: false, stale: true };
  // A variant not stocked at the location yet: activate it there instead.
  if (errs.some((e) => /stock|activ|location/i.test(`${e.code} ${e.message}`))) {
    const a = await gql(cfg, `mutation Act($item: ID!, $loc: ID!, $n: Int, $key: String!) {
      inventoryActivate(inventoryItemId: $item, locationId: $loc, available: $n) @idempotent(key: $key) { userErrors { field message } }
    }`, { item: inventoryItemId, loc: locationId, n: quantity, key: crypto.randomUUID() });
    const ae = userErrorText(a?.inventoryActivate?.userErrors);
    if (!ae) return { ok: true };
    throw fail(502, `Shopify stock: ${ae}`);
  }
  throw fail(502, `Shopify stock: ${userErrorText(errs)}`);
}

async function setStatus(cfg, productId, status) {
  const d = await gql(cfg, `mutation St($product: ProductUpdateInput!) {
    productUpdate(product: $product) { product { id status } userErrors { field message } }
  }`, { product: { id: productId, status } });
  const ue = userErrorText(d?.productUpdate?.userErrors);
  if (ue) throw fail(502, `Shopify: ${ue}`);
}

async function createListing(cfg, state, item) {
  const title = shopifyTitle(item);
  const photos = photosOf(item);
  const videos = videosOf(item);
  // Photos in gallery order (the first is the product's featured image),
  // then the videos.
  const media = photos.map((url) => ({ originalSource: url, mediaContentType: 'IMAGE', alt: title }));
  for (const url of videos) media.push({ originalSource: await stageVideo(cfg, url, item), mediaContentType: 'VIDEO', alt: title });
  const d = await gql(cfg, `mutation Create($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
    productCreate(product: $product, media: $media) {
      product { id handle variants(first: 1) { nodes { id inventoryItem { id } } } ${MEDIA_FIELDS} }
      userErrors { field message }
    }
  }`, {
    product: {
      title, descriptionHtml: shopifyDescription(item), status: 'DRAFT',
      tags: ['plant-inventory', ...(item.saleCode ? [item.saleCode] : [])],
    },
    media,
  });
  const ue = userErrorText(d?.productCreate?.userErrors);
  const p = d?.productCreate?.product;
  if (ue || !p) throw fail(502, `Shopify: ${ue || 'product not created'}`);
  const v = p.variants?.nodes?.[0];
  return {
    productId: p.id,
    handle: p.handle,
    variantId: v?.id || null,
    inventoryItemId: v?.inventoryItem?.id || null,
    status: 'DRAFT',
    photoUrls: photos,
    videoUrls: videos,
    videoUrl: videos[0] || null,
    // Title + description went up with exactly these values.
    fp: fingerprint(item),
    createdAt: new Date().toISOString(),
  };
}

// Make the product match the plant. Every step is checked against the
// stored state, so a run that died half way just carries on next time.
async function applyActive(cfg, state, item, sh) {
  if (sh.price !== priceOf(item) || sh.sku !== item.sku) {
    const d = await gql(cfg, `mutation Var($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id } userErrors { field message } }
    }`, { productId: sh.productId, variants: [{ id: sh.variantId, price: priceOf(item), inventoryItem: { sku: item.sku, tracked: true } }] });
    const ue = userErrorText(d?.productVariantsBulkUpdate?.userErrors);
    if (ue) throw fail(502, `Shopify price: ${ue}`);
    sh.price = priceOf(item);
    sh.sku = item.sku;
  }
  if (sh.fp && sh.fp !== fingerprint(item)) {
    const d = await gql(cfg, `mutation Upd($product: ProductUpdateInput!) {
      productUpdate(product: $product) { product { id } userErrors { field message } }
    }`, { product: { id: sh.productId, title: shopifyTitle(item), descriptionHtml: shopifyDescription(item) } });
    const ue = userErrorText(d?.productUpdate?.userErrors);
    if (ue) throw fail(502, `Shopify: ${ue}`);
  }
  // Photos and videos. Whatever changed is swapped out whole — the photos
  // as a set (≤ 10, Shopify fetches them from our public URLs), the videos
  // as a set (staged one by one) — against what the product holds right
  // now, so media left by a run that died half way is cleared too. The new
  // media goes up BEFORE the old comes down, so a failed add leaves the old
  // photos showing, never an empty listing. Then photos first, videos last.
  const photos = photosOf(item);
  const videos = videosOf(item);
  const photosChanged = !sameList(photos, listedPhotos(sh));
  const videoChanged = !sameList(videos, listedVideos(sh));
  if (photosChanged || videoChanged) {
    const alt = shopifyTitle(item);
    const now = await productMedia(cfg, sh.productId);
    const drop = now.filter((n) => (photosChanged && n.mediaContentType === 'IMAGE') || (videoChanged && isVideoMedia(n))).map((n) => n.id);
    const add = photosChanged ? photos.map((url) => ({ originalSource: url, mediaContentType: 'IMAGE', alt })) : [];
    if (videoChanged) for (const url of videos) add.push({ originalSource: await stageVideo(cfg, url, item), mediaContentType: 'VIDEO', alt });
    let nodes = now;
    if (add.length) {
      const d = await gql(cfg, `mutation Media($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
        productUpdate(product: $product, media: $media) { product { id ${MEDIA_FIELDS} } userErrors { field message } }
      }`, { product: { id: sh.productId }, media: add });
      const ue = userErrorText(d?.productUpdate?.userErrors);
      if (ue) throw fail(502, `Shopify media: ${ue}`);
      nodes = d?.productUpdate?.product?.media?.nodes || [];
    }
    if (drop.length) {
      const d = await gql(cfg, `mutation Del($ids: [ID!]!) { fileDelete(fileIds: $ids) { deletedFileIds userErrors { field message } } }`, { ids: drop });
      const ue = userErrorText(d?.fileDelete?.userErrors);
      if (ue && !/not found|does not exist/i.test(ue)) throw fail(502, `Shopify media: ${ue}`);
    }
    nodes = nodes.filter((n) => !drop.includes(n.id));
    sh.photoUrls = photos;
    sh.videoUrls = videos;
    sh.videoUrl = videos[0] || null;
    delete sh.imageUrl; delete sh.imageMediaId; delete sh.videoMediaId;
    // New photos land after kept videos; move the videos back to the end,
    // in their order. The moves run one after another, so sending each
    // video to the last slot in turn leaves them last, still in order.
    const vids = nodes.filter(isVideoMedia);
    const firstVid = nodes.findIndex(isVideoMedia);
    if (vids.length && firstVid !== nodes.length - vids.length) {
      await gql(cfg, `mutation Ord($id: ID!, $moves: [MoveInput!]!) { productReorderMedia(id: $id, moves: $moves) { userErrors { field message } } }`,
        { id: sh.productId, moves: vids.map((v) => ({ id: v.id, newPosition: String(nodes.length - 1) })) }).catch(() => {});
    }
  }
  if (sh.qty !== 1) {
    // Compare against what we last set; if Shopify moved it since (a
    // cancelled order restocked it, a hand edit) the app still owns this
    // one-off plant's stock, so set it outright.
    const r = await setQuantity(cfg, state, sh.inventoryItemId, 1, sh.qty ?? null);
    if (r.stale) await setQuantity(cfg, state, sh.inventoryItemId, 1, null);
    sh.qty = 1;
  }
  if (sh.status !== 'ACTIVE') {
    await setStatus(cfg, sh.productId, 'ACTIVE');
    sh.status = 'ACTIVE';
  }
  if (!sh.published) {
    const pubId = await ensurePublication(cfg, state);
    if (!pubId) throw fail(502, 'No "Online Store" sales channel found — the product is active but not on the storefront');
    const d = await gql(cfg, `mutation Pub($id: ID!, $pid: ID!) {
      publishablePublish(id: $id, input: { publicationId: $pid }) { userErrors { field message } }
    }`, { id: sh.productId, pid: pubId });
    const ue = userErrorText(d?.publishablePublish?.userErrors);
    if (ue) throw fail(502, `Shopify publish: ${ue}`);
    sh.published = true;
  }
  sh.fp = fingerprint(item);
}

// false when the row is no longer this brand's (moved / purged mid-run).
async function writeItemShopify(brandId, itemId, sh) {
  const { data, error } = await supabase.from('inventory_items').update({ shopify: sh }).eq('id', itemId).eq('brandId', brandId).select('id');
  if (error) throw fail(500, error.message);
  return !!(data && data.length);
}

// Archive a listing whose plant this brand no longer tracks (moved to the
// other brand, deleted for good). Failures queue it in the brand's state;
// every reconcile retries the queue first.
async function archiveListing(cfg, state, sh) {
  if (sh.inventoryItemId && sh.qty !== 0) await setQuantity(cfg, state, sh.inventoryItemId, 0, null).catch(() => {});
  try {
    await setStatus(cfg, sh.productId, 'ARCHIVED');
  } catch (e) {
    if (!/does not exist|not found/i.test(e.message || '')) throw e;
  }
}

export async function queueShopifyRetire(brandId, sh, user) {
  if (!sh?.productId) return;
  const state = await loadState(brandId);
  const retire = (state.retire || []).filter((r) => r.productId !== sh.productId);
  retire.push({ productId: sh.productId, inventoryItemId: sh.inventoryItemId || null, qty: sh.qty ?? null, at: new Date().toISOString() });
  await saveState(brandId, { retire: retire.slice(-200) }, user);
}

// Bring the store in line with the plants. `itemIds` = just these plants;
// null = every plant in the Shopify pool or with a listing. Takedowns go
// first (a plant sold elsewhere must leave the store before anything else
// is tried), then pauses, then listings. Stops when the time budget runs
// out or Shopify itself is failing; `remaining` = still to do.
export async function reconcileShopify(brandId, { itemIds = null, user = null, budgetMs = 30000 } = {}) {
  const cfg = shopifyConfig(brandId);
  if (!cfg) return { configured: false };
  const owner = await acquireLock(brandId, budgetMs + 60000);
  if (!owner) return { configured: true, busy: true, processed: 0, changedIds: [], remaining: null };
  const started = Date.now();
  const fullPass = !(itemIds && itemIds.length);
  const changedIds = [];
  const errors = [];
  let processed = 0;
  let remaining = 0;
  let deferred = 0;
  let streak = 0;   // consecutive connection-wide failures
  const outOfTime = () => Date.now() - started > budgetMs || streak >= 3;
  const state = await loadState(brandId);
  const retired = new Set();
  try {
    // Listings whose plant this brand no longer tracks (moved / deleted).
    for (const r of state.retire || []) {
      if (outOfTime()) break;
      try { await archiveListing(cfg, state, r); retired.add(r.productId); streak = 0; } catch (e) { if (e.global) streak += 1; }
    }

    let rows;
    if (!fullPass) {
      rows = [];
      for (let k = 0; k < itemIds.length; k += 200) {
        const { data, error } = await supabase.from('inventory_items').select('*').eq('brandId', brandId).in('id', itemIds.slice(k, k + 200));
        if (error) throw fail(500, error.message);
        rows.push(...(data || []));
      }
    } else {
      rows = await fetchAllById(() => supabase.from('inventory_items').select('*')
        .eq('brandId', brandId).or('salePool.eq.shopify,shopify.not.is.null'));
    }
    const holding = await holdingSaleIds(brandId);

    const RANK = { gone: 0, paused: 1, active: 2 };
    const recentFail = (sh) => !!sh.errorAt && Date.now() - Date.parse(sh.errorAt) < 10 * 60 * 1000;
    const plan = [];
    for (const item of rows) {
      const sh = { ...(item.shopify || {}) };
      const { want, reason } = desiredListing(item, holding);
      const listed = !!sh.productId;
      let needs;
      if (want === 'active') needs = !listed || sh.status !== 'ACTIVE' || sh.fp !== fingerprint(item) || sh.qty !== 1
        || !sh.published || mediaBehind(item, sh)
        || sh.price !== priceOf(item) || sh.sku !== item.sku;
      else if (want === 'paused') needs = listed && sh.status !== 'DRAFT' && sh.status !== 'ARCHIVED';
      else needs = listed && sh.status !== 'ARCHIVED';
      if (needs) plan.push({ item, sh, want, reason });
    }
    plan.sort((a, b) => (RANK[a.want] - RANK[b.want]) || (Number(recentFail(a.sh)) - Number(recentFail(b.sh))));

    for (const { item, sh, want, reason } of plan) {
      // A listing that failed in the last 10 minutes waits for its own
      // retry (asking for the plant by id) instead of eating every full pass.
      if (fullPass && want === 'active' && recentFail(sh)) { deferred += 1; continue; }
      if (outOfTime()) { remaining += 1; continue; }
      processed += 1;
      let createdHere = false;
      try {
        if (want === 'active') {
          if (!sh.productId) {
            Object.assign(sh, await createListing(cfg, state, item));
            createdHere = true;
            // Save the product id at once: whatever fails next, the next
            // run updates this product instead of making a second one.
            if (!(await writeItemShopify(brandId, item.id, { ...sh, error: null }))) {
              await archiveListing(cfg, state, sh).catch(() => queueShopifyRetire(brandId, sh, user));
              continue;
            }
          }
          await applyActive(cfg, state, item, sh);
        } else if (want === 'paused') {
          await setStatus(cfg, sh.productId, 'DRAFT');
          sh.status = 'DRAFT';
        } else {
          if (sh.qty !== 0 && sh.inventoryItemId) {
            await setQuantity(cfg, state, sh.inventoryItemId, 0, null);
            sh.qty = 0;
          }
          await setStatus(cfg, sh.productId, 'ARCHIVED');
          sh.status = 'ARCHIVED';
        }
        sh.reason = reason || null;
        sh.error = null;
        sh.errorAt = null;
        sh.syncedAt = new Date().toISOString();
        streak = 0;
      } catch (e) {
        if (e.global) streak += 1; else streak = 0;
        sh.error = String(e.message || e).slice(0, 300);
        sh.errorAt = new Date().toISOString();
        errors.push({ id: item.id, sku: item.sku, error: sh.error });
      }
      if (await writeItemShopify(brandId, item.id, sh)) changedIds.push(item.id);
      else if (createdHere || sh.productId) await queueShopifyRetire(brandId, sh, user).catch(() => {});
    }
    // Re-read the queue: entries added during this run must survive.
    const fresh = await loadState(brandId);
    await saveState(brandId, {
      ...(retired.size ? { retire: (fresh.retire || []).filter((r) => !retired.has(r.productId)) } : {}),
      locationId: state.locationId || null,
      publicationId: state.publicationId || null,
      lastListingSyncAt: new Date().toISOString(),
      lastError: errors.length ? `${errors.length} listing${errors.length === 1 ? '' : 's'} failed — see the plants marked in red` : null,
    }, user);
  } finally {
    await releaseLock(brandId, owner);
  }
  return { configured: true, processed, remaining, deferred, changedIds, errors: errors.slice(0, 20) };
}

// Take a listing down for good (the plant moved to another brand or is
// being deleted for good). Never throws: a failure is queued for the next
// reconcile, so no live listing is left that nothing tracks.
export async function retireShopifyListing(brandId, sh, user = null) {
  if (!sh?.productId || sh.status === 'ARCHIVED') return;
  const cfg = shopifyConfig(brandId);
  if (!cfg) { await queueShopifyRetire(brandId, sh, user).catch(() => {}); return; }
  try {
    const state = await loadState(brandId);
    await archiveListing(cfg, state, sh);
  } catch {
    await queueShopifyRetire(brandId, sh, user).catch(() => {});
  }
}

// ─── orders ─────────────────────────────────────────────────────────────────

// Five orders a page: Shopify prices a query before running it (nested
// connections multiply) and refuses anything over 1000 points. 5 orders ×
// (~8 order-level objects + 50 line items × 3) ≈ 800.
const ORDERS_QUERY = `query Orders($q: String!, $after: String) {
  orders(first: 5, after: $after, query: $q, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name number createdAt processedAt updatedAt cancelledAt test
      displayFinancialStatus displayFulfillmentStatus email
      customer { displayName }
      shippingAddress { name address1 address2 city provinceCode zip countryCodeV2 }
      totalShippingPriceSet { shopMoney { amount } }
      shippingLines(first: 1) { nodes { title } }
      lineItems(first: 50) { nodes { id sku name quantity currentQuantity discountedTotalSet { shopMoney { amount } } } }
    }
  }
}`;

const PULL_BUDGET_MS = 45000;

function requirePaidForShipping(order) {
  if (!order) throw fail(502, 'Order was not returned — check the order and app access in Shopify before shipping');
  if (order.cancelledAt) throw fail(409, 'Order is cancelled — review it in Shopify before shipping');
  if (order.displayFinancialStatus !== 'PAID') {
    throw fail(409, `Payment is ${String(order.displayFinancialStatus || 'unknown').toLowerCase()} — only paid orders can be fulfilled or send tracking updates`);
  }
}

function groupKeyOf(a) {
  return [a.name, a.address1, a.city, a.provinceCode, a.zip].map((x) => String(x || '').trim().toLowerCase()).join('|');
}

async function openShopifyBoxes(brandId) {
  const rows = await fetchAllById(() => supabase.from('inventory_items')
    .select('id, "shipmentBoxId"').eq('brandId', brandId).is('deletedAt', null)
    .eq('status', 'sold').is('packedAt', null).like('shipmentBoxId', `${SHOPIFY_BOX_PREFIX}%`));
  const byGroup = new Map();
  for (const r of rows) {
    const g = r.shipmentBoxId.slice(r.shipmentBoxId.indexOf('|') + 1);
    if (!byGroup.has(g)) byGroup.set(g, r.shipmentBoxId);
  }
  return byGroup;
}

// A placeholder's SKU names its Shopify order line, so reading the order
// again finds it — in the trash too: a placeholder the packer put a plant
// on is trashed, and must not come back.
const placeholderSku = (brandId, order, n) => `UNMATCHED-SHOP-${brandId}-${order.number}-${n}`;

// How a row reads in a problem: a plant by its code / SKU, a placeholder by its title.
const rowLabel = (r) => (r.lotKind === 'unmatched' ? `"${r.name}"` : (r.saleCode || r.sku));

// The brand's live plants a line title could mean: its code, or its lot number.
async function titleCandidates(brandId, title) {
  const t = parseLineTitle(title);
  if (!t.code && t.lot == null) return [];
  let q = supabase.from('inventory_items').select('*').eq('brandId', brandId).is('deletedAt', null);
  q = t.code ? q.eq('saleCode', t.code) : q.eq('lotNumber', t.lot);
  const { data, error } = await q;
  if (error) throw fail(500, error.message);
  return data || [];
}

// Why a line came in as a placeholder, for the Shopify problems list.
function unmatchedMessage(order, line, sku, m) {
  const where = 'it\'s in the box as a placeholder — scan the plant onto it when packing';
  const names = (m?.near || []).slice(0, 3).map((p) => p.saleCode || p.sku).join(', ');
  if (sku && !m?.near?.length) return `${order.name}: no plant has SKU ${sku} ("${line.name}") — ${where}`;
  if (m?.reason === 'ambiguous') return `${order.name}: "${line.name}" could be ${names} — ${where}`;
  if (m?.reason === 'changed') return `${order.name}: "${line.name}" looks like ${names}, but it changed while syncing — ${where}`;
  if (m?.reason === 'taken') {
    const st = m.near[0]?.status || 'sold';
    return `${order.name}: "${line.name}" looks like ${names}, but ${m.near.length === 1 ? 'it\'s' : 'they\'re'} already ${st} — ${where}. If that plant is gone, refund the line in Shopify.`;
  }
  if (m?.reason === 'no-number') return `${order.name}: "${line.name}" has no SKU and no lot number in its title — ${where}`;
  return `${order.name}: no plant for sale matches "${line.name}" — ${where}`;
}

async function ingestOrder(brandId, order, openBoxes, problems, out, user, ctx) {
  const all = order.lineItems?.nodes || [];
  const live = (l) => (l.currentQuantity ?? l.quantity) > 0;
  const p = (kind, sku, message, lineKey) => problems.push({ key: `${order.id}|${kind}|${lineKey ?? sku ?? ''}`, at: new Date().toISOString(), kind, order: order.name, sku: sku || null, message });
  if (order.test) { p('test', null, `Test order ${order.name} ignored — no plant was marked sold`); return; }

  const skus = [...new Set(all.filter((l) => l.sku).map((l) => l.sku.trim()))];
  const plants = new Map();
  if (skus.length) {
    const { data, error } = await supabase.from('inventory_items').select('*').eq('brandId', brandId).is('deletedAt', null).in('sku', skus);
    if (error) throw fail(500, error.message);
    for (const r of data || []) plants.set(r.sku, r);
  }
  const stillSoldHere = (sku) => {
    const pl = plants.get(sku);
    return pl && pl.orderId === order.name && pl.status === 'sold' ? pl : null;
  };
  // What an earlier read of this order put in boxes: plants and
  // placeholders, trashed ones too (the order # alone isn't enough — a
  // Nigel slip can carry the same "#1001").
  const { data: earlier, error: eErr } = await supabase.from('inventory_items')
    .select('id, sku, name, "saleCode", status, "lotKind", "deletedAt", shopify')
    .eq('brandId', brandId).eq('orderId', order.name);
  if (eErr) throw fail(500, eErr.message);
  const phPrefix = placeholderSku(brandId, order, '');
  const ours = (earlier || []).filter((r) => r.shopify?.orderGid === order.id || String(r.sku || '').startsWith(phPrefix));
  const lineRows = (l, n) => ours.filter((r) => (l.id && r.shopify?.lineItemGid === l.id) || r.sku === placeholderSku(brandId, order, n));
  const soldNow = (r) => !r.deletedAt && r.status === 'sold';

  if (order.cancelledAt || order.displayFinancialStatus !== 'PAID') {
    const left = new Map();
    for (const sku of skus) { const pl = stillSoldHere(sku); if (pl) left.set(pl.id, pl); }
    for (const r of ours) if (soldNow(r)) left.set(r.id, r);
    for (const r of left.values()) {
      p('cancelled', r.sku, `${order.name} was ${order.cancelledAt ? 'cancelled' : String(order.displayFinancialStatus || '').toLowerCase()} — ${rowLabel(r)} is still marked sold. Take it out of its box if it shouldn't ship.`);
    }
    return;
  }
  // A line refunded / removed from a still-paid order.
  all.forEach((l, i) => {
    if (live(l)) return;
    const r = (l.sku && stillSoldHere(l.sku.trim())) || lineRows(l, i + 1).find(soldNow);
    if (r) p('refunded', r.sku, `${order.name}: ${rowLabel(r)} was refunded or removed from the order — take it out of its box.`);
  });

  const a = order.shippingAddress || {};
  const buyer = a.name || order.customer?.displayName || '';
  // No address (local pickup / digital): never merge into anyone's box.
  const groupKey = a.address1 ? groupKeyOf(a) : `noaddr:${order.id}`;
  const boxId = openBoxes.get(groupKey) || `${SHOPIFY_BOX_PREFIX}${brandId}-${order.number}|${groupKey}`;
  const buyerAddress = {
    street1: a.address1 || '', street2: a.address2 || '', city: a.city || '', state: a.provinceCode || '',
    zip: a.zip || '', country: a.countryCodeV2 || 'US', shipmentMethod: order.shippingLines?.nodes?.[0]?.title || '',
  };
  let feeLeft = Number(order.totalShippingPriceSet?.shopMoney?.amount) || 0;
  const now = new Date().toISOString();
  const soldAt = order.processedAt || order.createdAt || now;
  const qtyOf = (l) => Math.max(1, l.currentQuantity ?? l.quantity ?? 1);
  const unitPrice = (l) => Math.round(((Number(l.discountedTotalSet?.shopMoney?.amount) || 0) / qtyOf(l)) * 100) / 100;
  const orderRef = (l) => ({ orderGid: order.id, orderName: order.name, ...(l.id ? { lineItemGid: l.id } : {}) });
  const landed = (id) => {
    feeLeft = 0;                                           // the order's shipping fee counts once
    openBoxes.set(groupKey, boxId);
    out.changedIds.push(id);
  };

  // Mark the plant sold into this order's box — only while it's still for
  // sale and in no box (two syncs, or a sale elsewhere, can't both have it).
  const claim = async (pl, l, how) => {
    const patch = {
      status: 'sold',
      soldAt,
      salePrice: unitPrice(l),
      buyer,
      buyerUsername: order.email || '',
      buyerAddress,
      shipmentBoxId: boxId,
      shipmentCarrier: 'usps',
      orderId: order.name,
      orderDate: soldAt,
      orderShippingFee: feeLeft,
      notes: [pl.notes, `Shopify ${order.name}${how ? ` (found by ${how}: "${l.name}")` : ''}`].filter(Boolean).join(' · ').slice(0, 1000),
      shopify: { ...(pl.shopify || {}), ...orderRef(l) },
      modifiedAt: now,
      modifiedBy: user?.displayName || 'shopify-sync',
    };
    const { data, error } = await supabase.from('inventory_items').update(patch)
      .eq('id', pl.id).eq('brandId', brandId).is('deletedAt', null).is('shipmentBoxId', null).in('status', FOR_SALE)
      .select('id');
    if (error) throw fail(500, error.message);
    if (!data || !data.length) return false;
    landed(pl.id);
    out.soldIds.push(pl.id);
    if (how) out.matched.push(pl.id);
    return true;
  };

  // A line no plant could be found for still ships: a placeholder in the
  // buyer's box (purple on the packer's screen), which the packer fills by
  // scanning the plant in hand (api/_lib/linkLine.js).
  const placeholder = async (l, n, sku, m) => {
    const row = {
      id: newId(),
      brandId,
      sku: placeholderSku(brandId, order, n),
      type: 'plant',
      name: String(l.name || 'Shopify order line').slice(0, 200),
      quantity: qtyOf(l),
      status: 'sold',
      lotKind: 'unmatched',
      // No lot number: the title carries it, and a number here would trip
      // the bench's duplicate-lot warning against the real pot.
      lotNumber: null,
      saleId: null,
      salePrice: unitPrice(l),
      soldAt,
      buyer,
      buyerUsername: order.email || '',
      buyerAddress,
      shipmentBoxId: boxId,
      shipmentCarrier: 'usps',
      orderId: order.name,
      orderDate: soldAt,
      orderShippingFee: feeLeft,
      notes: `Shopify ${order.name}`,
      shopify: orderRef(l),
      createdAt: now,
      createdBy: user?.displayName || 'shopify-sync',
    };
    const { error } = await supabase.from('inventory_items').insert(row);
    if (error) {
      if (error.code === '23505') return;                  // made by a sync running alongside
      throw fail(500, error.message);
    }
    landed(row.id);
    out.placeholderIds.push(row.id);
    p('unmatched', sku || null, unmatchedMessage(order, l, sku, m), l.id || n);
  };

  for (const [i, l] of all.entries()) {
    if (!live(l)) continue;
    const n = i + 1;
    const sku = String(l.sku || '').trim();
    const pl = sku ? plants.get(sku) : null;
    if (pl && pl.orderId === order.name) continue;         // already in
    if (lineRows(l, n).length) continue;                   // already in (a plant or its placeholder)
    if (order.displayFulfillmentStatus === 'FULFILLED') {
      p('fulfilled', sku || null, `${order.name} was fulfilled in Shopify before the app saw it, so "${l.name}" wasn't added to Shipping — if that plant is gone, mark it sold by hand.`, l.id || n);
      continue;
    }
    if (pl) {
      if (!FOR_SALE.includes(pl.status) || pl.shipmentBoxId) {
        p('double', sku, `${order.name} bought ${pl.saleCode || sku}, but it's already ${pl.status}${pl.orderId ? ` (order ${pl.orderId})` : ''} — refund it in Shopify`);
      } else if (!(await claim(pl, l, ''))) {
        p('double', sku, `${order.name} bought ${pl.saleCode || sku}, but it changed while syncing — check it`);
      }
      continue;
    }
    // No SKU (a product made by hand in Shopify), or a SKU no plant has:
    // the title's code or lot number + name.
    const m = pickPlant(l.name, await titleCandidates(brandId, l.name), { ongoingSaleIds: await ctx.ongoingSaleIds() });
    if (m.plant && (await claim(m.plant, l, m.how))) continue;
    await placeholder(l, n, sku, m.plant ? { reason: 'changed', near: [m.plant] } : m);
  }
}

const carrierName = (c) => (String(c || 'usps').toLowerCase() === 'ups' ? 'UPS' : 'USPS');

// Shopify-order plants whose box now has a tracking number: fulfil just
// those lines in Shopify (the buyer gets the shipping email). Found by the
// order they came from, not the box prefix — a box can be combined. A
// re-bought label updates the tracking on the fulfilment already made.
async function pushFulfillments(cfg, brandId, problems, changedIds, deadline) {
  const rows = (await fetchAllById(() => supabase.from('inventory_items')
    .select('id, sku, name, "lotKind", "shipmentBoxId", status, shopify').eq('brandId', brandId).is('deletedAt', null)
    .not('shipmentBoxId', 'is', null).not('shopify->>orderGid', 'is', null)))
    .filter((r) => ['sold', 'shipped', 'delivered'].includes(r.status));
  if (!rows.length) return;
  const boxIds = [...new Set(rows.map((r) => r.shipmentBoxId))];
  const tracking = new Map();
  for (let k = 0; k < boxIds.length; k += 100) {
    const { data } = await supabase.from('shipments').select('id, "trackingNumber", carrier, "voidedAt", "isTestLabel"')
      .eq('brandId', brandId).in('id', boxIds.slice(k, k + 100));
    for (const s of data || []) if (s.trackingNumber && !s.voidedAt && !s.isTestLabel) tracking.set(s.id, s);
  }
  const problem = (orderGid, name, kind, message) => problems.push({ key: `${orderGid}|${kind}`, at: new Date().toISOString(), kind, order: name || null, sku: null, message });
  const stamp = async (r, patch) => {
    const { error } = await supabase.from('inventory_items').update({ shopify: { ...r.shopify, ...patch } }).eq('id', r.id).eq('brandId', brandId);
    if (error) throw fail(500, error.message);
    changedIds.push(r.id);
  };

  // New fulfilments, one per order + box.
  const groups = new Map();
  for (const r of rows) {
    if (r.shopify.fulfilledAt) continue;
    const t = tracking.get(r.shipmentBoxId);
    if (!t) continue;
    const key = `${r.shopify.orderGid}|${r.shipmentBoxId}`;
    if (!groups.has(key)) groups.set(key, { orderGid: r.shopify.orderGid, t, rows: [] });
    groups.get(key).rows.push(r);
  }
  for (const { orderGid, t, rows: its } of groups.values()) {
    if (Date.now() > deadline) break;
    const name = its[0]?.shopify?.orderName;
    try {
      const d = await gql(cfg, `query FO($id: ID!) {
        order(id: $id) {
          name displayFinancialStatus cancelledAt
          fulfillmentOrders(first: 5) {
            pageInfo { hasNextPage }
            nodes { id status lineItems(first: 20) {
              pageInfo { hasNextPage }
              nodes { id remainingQuantity lineItem { id sku } }
            } }
          }
        }
      }`, { id: orderGid });
      requirePaidForShipping(d?.order);
      const connection = d.order.fulfillmentOrders;
      const fos = connection?.nodes || [];
      if (connection?.pageInfo?.hasNextPage !== false || fos.some((fo) => fo.lineItems?.pageInfo?.hasNextPage !== false)) {
        throw fail(409, 'Fulfillment data is incomplete or exceeds the sync limit — review and fulfill the order in Shopify before retrying');
      }
      // Each row names its Shopify line: by the line's id when the order
      // was read with ids (plants found by title, placeholders — their own
      // SKU isn't on the line), else by SKU. Two rows on one line id are a
      // Quantity 2+ placeholder the packer split; two on one SKU are an error.
      const keyOf = (r) => (r.shopify?.lineItemGid ? `id:${r.shopify.lineItemGid}` : (String(r.sku || '').trim() ? `sku:${String(r.sku).trim()}` : null));
      const keys = new Set(its.map(keyOf).filter(Boolean));
      const skuKeys = its.map(keyOf).filter((k) => k && k.startsWith('sku:'));
      if (its.some((r) => !keyOf(r)) || new Set(skuKeys).size !== skuKeys.length) {
        throw fail(409, 'Plants have missing or duplicate SKUs — correct them before fulfilling this order');
      }
      const liKeys = (li) => [`id:${li.lineItem?.id}`, `sku:${String(li.lineItem?.sku || '').trim()}`];
      const mine = (fo) => (fo.lineItems?.nodes || []).filter((li) => liKeys(li).some((k) => keys.has(k)) && li.remainingQuantity > 0);
      if (fos.some((fo) => ['ON_HOLD', 'SCHEDULED'].includes(fo.status) && mine(fo).length)) {
        problem(orderGid, name, 'fulfil', `${name || 'An order'} is on hold in Shopify — release it there and it'll be marked shipped on the next sync`);
        continue;
      }
      const input = fos.filter((fo) => ['OPEN', 'IN_PROGRESS'].includes(fo.status))
        .map((fo) => ({ fulfillmentOrderId: fo.id, fulfillmentOrderLineItems: mine(fo).map((li) => ({ id: li.id, quantity: li.remainingQuantity })) }))
        .filter((x) => x.fulfillmentOrderLineItems.length);
      const readyKeys = new Set(fos.filter((fo) => ['OPEN', 'IN_PROGRESS'].includes(fo.status)).flatMap(mine).flatMap(liKeys));
      const missing = [...keys].filter((k) => !readyKeys.has(k));
      const shown = (list) => list.map((k) => {
        const r = its.find((x) => keyOf(x) === k);
        return r?.lotKind === 'unmatched' ? `"${r.name}"` : (r?.sku || k.slice(k.indexOf(':') + 1));
      }).join(', ');
      if (!input.length || missing.length) {
        throw fail(409, `No open fulfillment lines for ${shown(missing.length ? missing : [...keys])} — verify the order's fulfillment and app access in Shopify before retrying`);
      }
      const f = await gql(cfg, `mutation Ful($fulfillment: FulfillmentInput!) {
        fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { id } userErrors { field message } }
      }`, { fulfillment: { lineItemsByFulfillmentOrder: input, trackingInfo: { company: carrierName(t.carrier), number: t.trackingNumber }, notifyCustomer: true } });
      const ue = userErrorText(f?.fulfillmentCreate?.userErrors);
      if (ue) throw fail(502, ue);
      const fulfillmentId = f?.fulfillmentCreate?.fulfillment?.id;
      if (!fulfillmentId) throw fail(502, 'Shopify did not confirm a fulfillment — check the order in Shopify before retrying');
      const at = new Date().toISOString();
      for (const r of its) await stamp(r, { fulfilledAt: at, fulfillmentId, trackingNumber: t.trackingNumber });
    } catch (e) {
      problem(orderGid, name, 'fulfil', `Couldn't mark ${name || 'an order'} shipped in Shopify: ${String(e.message || e).slice(0, 200)}`);
    }
  }

  // Tracking changed after fulfilment (label voided and bought again).
  const moved = new Map();
  for (const r of rows) {
    const t = tracking.get(r.shipmentBoxId);
    if (!r.shopify.fulfilledAt || !r.shopify.fulfillmentId || !t || t.trackingNumber === r.shopify.trackingNumber) continue;
    if (!moved.has(r.shopify.fulfillmentId)) moved.set(r.shopify.fulfillmentId, { t, rows: [] });
    moved.get(r.shopify.fulfillmentId).rows.push(r);
  }
  for (const [fulfillmentId, { t, rows: its }] of moved) {
    if (Date.now() > deadline) break;
    try {
      const d = await gql(cfg, `query OrderPayment($id: ID!) {
        order(id: $id) { name displayFinancialStatus cancelledAt }
      }`, { id: its[0].shopify.orderGid });
      requirePaidForShipping(d?.order);
      const u = await gql(cfg, `mutation Trk($id: ID!, $info: FulfillmentTrackingInput!) {
        fulfillmentTrackingInfoUpdate(fulfillmentId: $id, trackingInfoInput: $info, notifyCustomer: true) { fulfillment { id } userErrors { field message } }
      }`, { id: fulfillmentId, info: { company: carrierName(t.carrier), number: t.trackingNumber } });
      const ue = userErrorText(u?.fulfillmentTrackingInfoUpdate?.userErrors);
      if (ue) throw fail(502, ue);
      if (u?.fulfillmentTrackingInfoUpdate?.fulfillment?.id !== fulfillmentId) {
        throw fail(502, 'Shopify did not confirm the tracking update — check the fulfillment in Shopify before retrying');
      }
      for (const r of its) await stamp(r, { trackingNumber: t.trackingNumber });
    } catch (e) {
      problem(its[0].shopify.orderGid, its[0].shopify.orderName, 'tracking', `Couldn't update the tracking number on ${its[0].shopify.orderName || 'an order'} in Shopify: ${String(e.message || e).slice(0, 200)}`);
    }
  }
}

export async function pullShopifyOrders(brandId, { user = null, force = false } = {}) {
  const cfg = shopifyConfig(brandId);
  if (!cfg) return { configured: false, changedIds: [], soldIds: [] };
  const state = await loadState(brandId);
  if (!force && state.lastOrderPullAt && Date.now() - Date.parse(state.lastOrderPullAt) < ORDER_PULL_EVERY_MS) {
    return { skipped: 'recent', changedIds: [], soldIds: [] };
  }
  const owner = await acquireLock(brandId, PULL_BUDGET_MS + 60000);
  if (!owner) return { busy: true, changedIds: [], soldIds: [] };
  const started = Date.now();
  const out = { changedIds: [], soldIds: [], matched: [], placeholderIds: [] };
  const problems = [];
  const seenOrders = new Set();
  let ingested = 0;
  let ongoing = null;
  const ctx = {
    // Events still running — a plant in one is the likelier match for a title.
    ongoingSaleIds: async () => {
      if (!ongoing) {
        const { data, error } = await supabase.from('sales').select('id').eq('brandId', brandId).eq('status', 'ongoing');
        if (error) throw fail(500, error.message);
        ongoing = new Set((data || []).map((r) => r.id));
      }
      return ongoing;
    },
  };
  try {
    const connectedAt = state.connectedAt || new Date(Date.now() - 86400000).toISOString();
    const since = state.orderCursor || connectedAt;
    // Ten minutes of overlap: an order can turn up in search a little after
    // its updated_at. Re-reading one is harmless (orderId guard, keyed problems).
    let fromMs = Date.parse(since) - 10 * 60 * 1000;
    if (force || !state.lineMatchAt) fromMs = Math.min(fromMs, Math.max(Date.parse(connectedAt), Date.now() - LOOKBACK_MS));
    const from = new Date(fromMs).toISOString();
    let cursor = since;
    const openBoxes = await openShopifyBoxes(brandId);
    let after = null;
    for (let page = 0; page < 40 && Date.now() - started < PULL_BUDGET_MS - 10000; page++) {
      const d = await gql(cfg, ORDERS_QUERY, { q: `updated_at:>'${from}'`, after });
      const conn = d?.orders;
      for (const order of conn?.nodes || []) {
        await ingestOrder(brandId, order, openBoxes, problems, out, user, ctx);
        ingested += 1;
        seenOrders.add(order.id);
        if (order.updatedAt && order.updatedAt > cursor) cursor = order.updatedAt;
      }
      if (!conn?.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    await pushFulfillments(cfg, brandId, problems, out.changedIds, started + PULL_BUDGET_MS);
    const fresh = await loadState(brandId);
    // "No SKU" notes from before title matching: the order was just read
    // again, and its lines are now in a box (a plant or a placeholder).
    const stale = (pr) => ['no-sku', 'unknown-sku'].includes(pr.kind) && seenOrders.has(String(pr.key).split('|')[0]);
    await saveState(brandId, {
      connectedAt,
      orderCursor: cursor,
      lastOrderPullAt: new Date().toISOString(),
      lineMatchAt: state.lineMatchAt || new Date().toISOString(),
      problems: addProblems({ problems: (fresh.problems || []).filter((pr) => !stale(pr)) }, problems),
      lastError: null,
    }, user);
  } catch (e) {
    await saveState(brandId, { lastOrderPullAt: new Date().toISOString(), lastError: String(e.message || e).slice(0, 300) }, user).catch(() => {});
    throw e;
  } finally {
    await releaseLock(brandId, owner);
  }
  return {
    configured: true, ingested, changedIds: out.changedIds, soldIds: out.soldIds,
    matched: out.matched.length, placeholders: out.placeholderIds.length, problems: problems.length,
  };
}
