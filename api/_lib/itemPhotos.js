// A plant's photos live in item_photos (one row per stored file, ordered by
// sortOrder). Two columns on the plant mirror them for everything that reads
// the plant row: imageUrl (the cover — the first photo) and photoUrls (all of
// them, in order — migration 0053; the For Sale tab's Palmstreet CSV and the
// Shopify sync list every photo). Every photo write ends in syncItemPhotos()
// so the two never drift.
import { supabase } from './supabase.js';
import { fetchAllById } from './fetchAll.js';

export const PHOTO_BUCKET = 'plant-photos';

// Stable public URL for a stored photo (the bucket is public, migration 0021).
export function photoPublicUrl(path) {
  const { data } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path);
  return data?.publicUrl || null;
}

// Before 0053 the column doesn't exist; photos still work, only the
// multi-photo exports fall back to the cover.
function photoUrlsMissing(error) {
  return !!error && (error.code === '42703' || error.code === 'PGRST204' || /photoUrls/.test(error.message || ''));
}

const byGalleryOrder = (a, b) => (a.sortOrder - b.sortOrder) || String(a.createdAt || '').localeCompare(String(b.createdAt || ''));

// Re-derive one plant's imageUrl + photoUrls from its photos. imageUrl is
// only managed while it's empty or one of this plant's own stored photos — a
// hand-pasted URL is left alone — unless `force` (the operator just shot or
// arranged this plant's photos: the For Sale tab, the bulk photo assign).
// → { imageUrl, photoUrls }
//
// Two writes to one plant's photos can overlap (another phone, or an upload
// finishing while a photo is deleted): each reads the gallery, then writes.
// The one that read first could write last and store a stale list, so after
// writing it reads again and goes round once more if the gallery moved.
async function galleryUrls(itemId, brandId) {
  const { data: rows, error } = await supabase
    .from('item_photos')
    .select('"storagePath", "sortOrder", "createdAt"')
    .eq('itemId', itemId)
    .eq('brandId', brandId);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return [...(rows || [])].sort(byGalleryOrder).map((r) => photoPublicUrl(r.storagePath)).filter(Boolean);
}

export async function syncItemPhotos(itemId, brandId, { force = false } = {}) {
  let photoUrls = await galleryUrls(itemId, brandId);
  let imageUrl = null;
  for (let round = 0; round < 4; round++) {
    const cover = photoUrls[0] || null;
    const { data: it } = await supabase
      .from('inventory_items').select('"imageUrl"').eq('id', itemId).eq('brandId', brandId).maybeSingle();
    const cur = it?.imageUrl || '';
    const managedPrefix = photoPublicUrl(`items/${itemId}/`) || '';
    const isManaged = !cur || (managedPrefix && cur.startsWith(managedPrefix));
    imageUrl = cur || null;
    if ((force || isManaged) && cur !== (cover || '')) {
      await supabase.from('inventory_items').update({ imageUrl: cover }).eq('id', itemId).eq('brandId', brandId);
      imageUrl = cover;
    }
    const { error: pErr } = await supabase.from('inventory_items')
      .update({ photoUrls }).eq('id', itemId).eq('brandId', brandId);
    if (pErr && !photoUrlsMissing(pErr)) { const e = new Error(pErr.message); e.status = 500; throw e; }
    const now = await galleryUrls(itemId, brandId);
    if (JSON.stringify(now) === JSON.stringify(photoUrls)) break;
    photoUrls = now;
  }
  return { imageUrl, photoUrls };
}

// Bring photoUrls up to date for many plants at once (a plant joining a For
// Sale pool may carry photos from the Pre Sale gallery that predate 0053).
// Writes only rows that differ. Best effort: never throws.
export async function refreshPhotoUrls(brandId, itemIds) {
  const ids = [...new Set((itemIds || []).filter(Boolean))];
  if (!ids.length) return;
  try {
    const want = new Map(ids.map((id) => [id, []]));
    for (let k = 0; k < ids.length; k += 200) {
      const chunk = ids.slice(k, k + 200);
      const rows = await fetchAllById(() => supabase.from('item_photos')
        .select('id, "itemId", "storagePath", "sortOrder", "createdAt"').eq('brandId', brandId).in('itemId', chunk));
      for (const r of rows.sort(byGalleryOrder)) want.get(r.itemId)?.push(photoPublicUrl(r.storagePath));
    }
    const stale = [];
    for (let k = 0; k < ids.length; k += 200) {
      const { data, error } = await supabase.from('inventory_items')
        .select('id, "photoUrls"').eq('brandId', brandId).in('id', ids.slice(k, k + 200));
      if (error) return;   // before 0053
      for (const r of data || []) {
        const have = Array.isArray(r.photoUrls) ? r.photoUrls : [];
        const next = want.get(r.id) || [];
        if (JSON.stringify(have) !== JSON.stringify(next) && !(r.photoUrls == null && !next.length)) stale.push([r.id, next]);
      }
    }
    for (let k = 0; k < stale.length; k += 8) {
      await Promise.all(stale.slice(k, k + 8).map(([id, photoUrls]) =>
        supabase.from('inventory_items').update({ photoUrls }).eq('id', id).eq('brandId', brandId)));
    }
  } catch { /* best effort */ }
}
