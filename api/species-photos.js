import { supabase, requireBrand, brandIdFromReq, newId } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';

// Photo CRUD for a catalog plant (species row). Actions:
//   GET  ?action=signed-url&id=...    fresh 5-min signed URL
//   POST ?action=upload   { speciesId, fileBase64, contentType, filename? }
//   POST ?action=delete   { id }
//   POST ?action=reorder  { speciesId, orderedPhotoIds: [...] }
//
// Storage bucket = 'plant-photos'. Path convention: `<speciesId>/<photoId>.<ext>`.

const STORAGE_BUCKET = 'plant-photos';
const SIGNED_URL_TTL_SECONDS = 300;

export default wrap(async (req, res) => {
  const userId = req.method === 'GET' ? req.query?.userId : req.body?.userId;
  const { user, brandId } = await requireBrand(userId, brandIdFromReq(req));

  if (req.method === 'GET') {
    const action = req.query?.action;
    if (action === 'signed-url') return signedUrl(req, res, brandId);
    if (action === 'list')       return listItemPhotos(req, res, brandId);
    const e = new Error(`Unknown action: ${action}`); e.status = 400; throw e;
  }

  if (req.method === 'POST') {
    const action = req.body?.action;
    // target=item routes to the per-item photo table (item_photos); the
    // default (or target=species) keeps the original species_photos path.
    // Reusing this route avoids adding a serverless function. See 0019.
    const target = req.body?.target === 'item' ? 'item' : 'species';
    if (target === 'item') {
      if (action === 'upload')  return uploadItem(req, res, user, brandId);
      // One listing video per plant (For Sale tab). Videos are too big for a
      // function body (4.5 MB), so the phone uploads straight to Storage on
      // a signed URL, then commits the path here.
      if (action === 'video-upload-url') return videoUploadUrl(req, res, user, brandId);
      if (action === 'video-commit')     return videoCommit(req, res, user, brandId);
      if (action === 'video-delete')     return videoDelete(req, res, user, brandId);
      if (action === 'delete')  return removeItem(req, res, brandId);
      if (action === 'reorder') return reorderItem(req, res, brandId);
      const e = new Error(`Unknown action: ${action}`); e.status = 400; throw e;
    }
    if (action === 'upload')  return upload(req, res, user, brandId);
    if (action === 'delete')  return remove(req, res, brandId);
    if (action === 'reorder') return reorder(req, res, brandId);
    const e = new Error(`Unknown action: ${action}`); e.status = 400; throw e;
  }

  return methodNotAllowed(res, ['GET', 'POST']);
});

async function signedUrl(req, res, brandId) {
  const id = req.query?.id;
  if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
  const table = req.query?.target === 'item' ? 'item_photos' : 'species_photos';
  const { data: row, error } = await supabase
    .from(table)
    .select('"storagePath"')
    .eq('id', id)
    .eq('brandId', brandId)
    .maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  if (!row)  { const e = new Error('Photo not found'); e.status = 404; throw e; }

  const { data: signed, error: sErr } = await supabase
    .storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(row.storagePath, SIGNED_URL_TTL_SECONDS);
  if (sErr) { const e = new Error(sErr.message); e.status = 500; throw e; }
  return res.status(200).json({ url: signed.signedUrl });
}

async function upload(req, res, user, brandId) {
  const { speciesId, fileBase64, contentType, filename, kind: rawKind } = req.body || {};
  if (!speciesId)   { const e = new Error('speciesId required');   e.status = 400; throw e; }
  if (!fileBase64)  { const e = new Error('fileBase64 required');  e.status = 400; throw e; }
  if (!contentType) { const e = new Error('contentType required'); e.status = 400; throw e; }
  const kind = rawKind || 'gallery';
  if (!['gallery', 'mother', 'father'].includes(kind)) {
    const e = new Error('kind must be gallery, mother, or father'); e.status = 400; throw e;
  }

  const { data: sp, error: spErr } = await supabase
    .from('species').select('id, "imageUrl"').eq('id', speciesId).eq('brandId', brandId).maybeSingle();
  if (spErr) { const e = new Error(spErr.message); e.status = 500; throw e; }
  if (!sp)   { const e = new Error('Unknown species'); e.status = 404; throw e; }

  // Find next sortOrder within this kind. For 'mother' / 'father' there's
  // only ever one slot, so the value doesn't matter much; we still scope
  // by kind so multiple gallery uploads order correctly.
  const { data: existing, error: exErr } = await supabase
    .from('species_photos')
    .select('"sortOrder"')
    .eq('speciesId', speciesId)
    .eq('kind', kind)
    .eq('brandId', brandId)
    .order('sortOrder', { ascending: false })
    .limit(1);
  if (exErr) { const e = new Error(exErr.message); e.status = 500; throw e; }
  const nextSort = existing && existing[0] ? existing[0].sortOrder + 1 : 0;

  // Single-slot semantics for mother/father: delete any prior row of
  // the same kind before inserting the new one (including its blob).
  if (kind === 'mother' || kind === 'father') {
    const { data: prior } = await supabase
      .from('species_photos')
      .select('id, "storagePath"')
      .eq('speciesId', speciesId)
      .eq('kind', kind)
      .eq('brandId', brandId);
    for (const p of prior || []) {
      await supabase.storage.from(STORAGE_BUCKET).remove([p.storagePath]).catch(() => {});
      await supabase.from('species_photos').delete().eq('id', p.id).eq('brandId', brandId);
    }
  }

  const buf = Buffer.from(String(fileBase64), 'base64');
  if (buf.length === 0) { const e = new Error('Empty file'); e.status = 400; throw e; }

  const ext = (filename && filename.includes('.') ? filename.split('.').pop() : 'jpg')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
  const id = newId();
  const storagePath = `${speciesId}/${id}.${ext || 'jpg'}`;

  const { error: upErr } = await supabase
    .storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buf, { contentType, upsert: false });
  if (upErr) { const e = new Error(upErr.message); e.status = 500; throw e; }

  const row = {
    id,
    speciesId,
    storagePath,
    sortOrder: nextSort,
    kind,
    brandId,
    createdAt: new Date().toISOString(),
    createdBy: user.displayName,
  };
  const { error: insErr } = await supabase.from('species_photos').insert(row);
  if (insErr) {
    await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]).catch(() => {});
    const e = new Error(insErr.message); e.status = 500; throw e;
  }

  // Lazy migration: move the legacy species.imageUrl into species_photos
  // (as a gallery photo) on the first gallery upload. Skip for parent
  // photo uploads — the legacy image is a generic photo, not parentage.
  if (sp.imageUrl && kind === 'gallery') {
    const legacyId = newId();
    await supabase.from('species_photos').insert({
      id: legacyId,
      speciesId,
      storagePath: sp.imageUrl,
      sortOrder: -1,
      kind: 'gallery',
      brandId,
      createdAt: new Date().toISOString(),
      createdBy: user.displayName,
    }).then(() => supabase.from('species').update({ imageUrl: null }).eq('id', speciesId).eq('brandId', brandId))
      .catch(() => { /* best-effort */ });
  }

  const { data: signed } = await supabase
    .storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

  return res.status(200).json({ photo: row, signedUrl: signed?.signedUrl || null });
}

async function remove(req, res, brandId) {
  const { id } = req.body || {};
  if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
  const { data: row, error } = await supabase
    .from('species_photos')
    .select('id, "speciesId", "storagePath"')
    .eq('id', id)
    .eq('brandId', brandId)
    .maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  if (!row)  { const e = new Error('Photo not found'); e.status = 404; throw e; }

  await supabase.storage.from(STORAGE_BUCKET).remove([row.storagePath]).catch(() => {});
  const { error: delErr } = await supabase.from('species_photos').delete().eq('id', id).eq('brandId', brandId);
  if (delErr) { const e = new Error(delErr.message); e.status = 500; throw e; }

  // If the deleted photo was the species's primary, clear that field —
  // the catalog UI falls back to the next photo by sortOrder.
  await supabase.from('species')
    .update({ primaryPhotoId: null })
    .eq('id', row.speciesId)
    .eq('primaryPhotoId', id)
    .eq('brandId', brandId);

  return res.status(200).json({ ok: true });
}

async function reorder(req, res, brandId) {
  const { speciesId, orderedPhotoIds } = req.body || {};
  if (!speciesId) { const e = new Error('speciesId required'); e.status = 400; throw e; }
  if (!Array.isArray(orderedPhotoIds)) {
    const e = new Error('orderedPhotoIds must be an array'); e.status = 400; throw e;
  }
  for (let i = 0; i < orderedPhotoIds.length; i++) {
    const { error } = await supabase
      .from('species_photos')
      .update({ sortOrder: i })
      .eq('id', orderedPhotoIds[i])
      .eq('speciesId', speciesId)
      .eq('brandId', brandId);
    if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  }
  return res.status(200).json({ ok: true });
}

// ─── Per-item photos (item_photos) ──────────────────────────────────────────
// Same storage bucket as species photos; the `items/` path prefix keeps the
// two namespaces from colliding. Gallery-only (no mother/father slots).

// Stable public URL for a stored object. Only resolves once the bucket is
// public (migration 0021) — building the string never fails regardless.
function publicUrlFor(path) {
  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return data?.publicUrl || null;
}

// Keep inventory_items.imageUrl (the Palmstreet CSV "Image URL") pointed at
// the item's primary (lowest-sortOrder) photo, so dropped photos auto-fill
// the export. Only manage imageUrl when it's empty or already one of this
// item's photo URLs — a manually-entered URL is left untouched. Returns the
// resulting imageUrl.
// `force` (bulk photo assign): the operator just shot this plant, so the new
// primary wins even over a hand-pasted external imageUrl.
async function syncItemPrimaryImage(itemId, brandId, { force = false } = {}) {
  const { data: rows } = await supabase
    .from('item_photos')
    .select('"storagePath"')
    .eq('itemId', itemId)
    .eq('brandId', brandId)
    .order('sortOrder', { ascending: true })
    .limit(1);
  const primaryUrl = rows && rows[0] ? publicUrlFor(rows[0].storagePath) : null;

  const { data: it } = await supabase
    .from('inventory_items').select('"imageUrl"').eq('id', itemId).eq('brandId', brandId).maybeSingle();
  const cur = it?.imageUrl || '';
  const managedPrefix = publicUrlFor(`items/${itemId}/`) || '';
  const isManaged = !cur || (managedPrefix && cur.startsWith(managedPrefix));
  if ((force || isManaged) && cur !== (primaryUrl || '')) {
    await supabase.from('inventory_items').update({ imageUrl: primaryUrl }).eq('id', itemId).eq('brandId', brandId);
    return primaryUrl;
  }
  return cur || null;
}

async function listItemPhotos(req, res, brandId) {
  const itemId = req.query?.itemId;
  if (!itemId) { const e = new Error('itemId required'); e.status = 400; throw e; }
  const { data: rows, error } = await supabase
    .from('item_photos')
    .select('id, "itemId", "storagePath", "sortOrder"')
    .eq('itemId', itemId)
    .eq('brandId', brandId)
    .order('sortOrder', { ascending: true });
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }

  const photos = [];
  for (const r of rows || []) {
    const { data: signed } = await supabase
      .storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(r.storagePath, SIGNED_URL_TTL_SECONDS);
    photos.push({ ...r, signedUrl: signed?.signedUrl || null });
  }
  return res.status(200).json({ photos });
}

async function uploadItem(req, res, user, brandId) {
  // `primary`: make this the plant's MAIN photo (bulk "Assign photos" from
  // the Pre Sale tab — a freshly shot photo should replace whatever was
  // uploaded before). Existing photos shift down and stay in the gallery.
  // Default (false) appends, as the item editor's gallery expects.
  // `replace` (For Sale tab): the plant keeps ONE photo — this one. The
  // others are deleted from the gallery and from Storage once it's saved.
  const { itemId, fileBase64, contentType, filename, primary = false, replace = false } = req.body || {};
  if (!itemId)      { const e = new Error('itemId required');      e.status = 400; throw e; }
  if (!fileBase64)  { const e = new Error('fileBase64 required');  e.status = 400; throw e; }
  if (!contentType) { const e = new Error('contentType required'); e.status = 400; throw e; }

  const { data: it, error: itErr } = await supabase
    .from('inventory_items').select('id').eq('id', itemId).eq('brandId', brandId).maybeSingle();
  if (itErr) { const e = new Error(itErr.message); e.status = 500; throw e; }
  if (!it)   { const e = new Error('Unknown item'); e.status = 404; throw e; }

  const { data: existing, error: exErr } = await supabase
    .from('item_photos')
    .select('id, "sortOrder"')
    .eq('itemId', itemId)
    .eq('brandId', brandId)
    .order('sortOrder', { ascending: true });
  if (exErr) { const e = new Error(exErr.message); e.status = 500; throw e; }
  const prior = existing || [];
  let nextSort = prior.length ? prior[prior.length - 1].sortOrder + 1 : 0;
  if ((primary || replace) && prior.length) {
    // Shift everything down one so the new photo takes slot 0 (= primary).
    for (let i = prior.length - 1; i >= 0; i--) {
      const { error } = await supabase
        .from('item_photos').update({ sortOrder: i + 1 }).eq('id', prior[i].id).eq('brandId', brandId);
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
    }
    nextSort = 0;
  }

  const buf = Buffer.from(String(fileBase64), 'base64');
  if (buf.length === 0) { const e = new Error('Empty file'); e.status = 400; throw e; }

  const ext = (filename && filename.includes('.') ? filename.split('.').pop() : 'jpg')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
  const id = newId();
  const storagePath = `items/${itemId}/${id}.${ext || 'jpg'}`;

  const { error: upErr } = await supabase
    .storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buf, { contentType, upsert: false });
  if (upErr) { const e = new Error(upErr.message); e.status = 500; throw e; }

  const row = {
    id,
    itemId,
    storagePath,
    sortOrder: nextSort,
    brandId,
    createdAt: new Date().toISOString(),
    createdBy: user.displayName,
  };
  const { error: insErr } = await supabase.from('item_photos').insert(row);
  if (insErr) {
    await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]).catch(() => {});
    const e = new Error(insErr.message); e.status = 500; throw e;
  }

  const { data: signed } = await supabase
    .storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

  if (replace) {
    const others = prior.map((p) => p.id);
    if (others.length) {
      const { data: gone } = await supabase.from('item_photos')
        .select('id, "storagePath"').in('id', others).eq('brandId', brandId);
      const paths = (gone || []).map((g) => g.storagePath);
      if (paths.length) await supabase.storage.from(STORAGE_BUCKET).remove(paths).catch(() => {});
      await supabase.from('item_photos').delete().in('id', others).eq('brandId', brandId);
    }
  }

  const itemImageUrl = await syncItemPrimaryImage(itemId, brandId, { force: !!primary || !!replace });

  return res.status(200).json({ photo: row, signedUrl: signed?.signedUrl || null, itemImageUrl, primary: !!primary });
}

async function removeItem(req, res, brandId) {
  const { id } = req.body || {};
  if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
  const { data: row, error } = await supabase
    .from('item_photos')
    .select('id, "itemId", "storagePath"')
    .eq('id', id)
    .eq('brandId', brandId)
    .maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  if (!row)  { const e = new Error('Photo not found'); e.status = 404; throw e; }

  await supabase.storage.from(STORAGE_BUCKET).remove([row.storagePath]).catch(() => {});
  const { error: delErr } = await supabase.from('item_photos').delete().eq('id', id).eq('brandId', brandId);
  if (delErr) { const e = new Error(delErr.message); e.status = 500; throw e; }
  const itemImageUrl = await syncItemPrimaryImage(row.itemId, brandId);
  return res.status(200).json({ ok: true, itemImageUrl });
}

async function reorderItem(req, res, brandId) {
  const { itemId, orderedPhotoIds } = req.body || {};
  if (!itemId) { const e = new Error('itemId required'); e.status = 400; throw e; }
  if (!Array.isArray(orderedPhotoIds)) {
    const e = new Error('orderedPhotoIds must be an array'); e.status = 400; throw e;
  }
  for (let i = 0; i < orderedPhotoIds.length; i++) {
    const { error } = await supabase
      .from('item_photos')
      .update({ sortOrder: i })
      .eq('id', orderedPhotoIds[i])
      .eq('itemId', itemId)
      .eq('brandId', brandId);
    if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  }
  const itemImageUrl = await syncItemPrimaryImage(itemId, brandId);
  return res.status(200).json({ ok: true, itemImageUrl });
}

// ─── One listing video per plant (For Sale tab) ─────────────────────────────
// Bucket `plant-videos` (public, 50 MB/file, video types — migration 0052).
// Path: items/<itemId>/<id>.<ext>. inventory_items.videoUrl holds the public
// URL (the Palmstreet CSV and Shopify read it). A new video replaces the
// old one; abandoned uploads in the plant's folder are swept on commit.
const VIDEO_BUCKET = 'plant-videos';
const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const VIDEO_TYPES = {
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-m4v': 'm4v',
};

function videoErr(status, message) { const e = new Error(message); e.status = status; return e; }

async function itemForVideo(itemId, brandId) {
  if (!itemId || typeof itemId !== 'string') throw videoErr(400, 'itemId required');
  const { data, error } = await supabase.from('inventory_items')
    .select('id, "videoUrl"').eq('id', itemId).eq('brandId', brandId).maybeSingle();
  if (error) {
    if (/videoUrl/.test(error.message || '')) throw videoErr(409, 'Videos need migration 0052 (for_sale_pools) — run it in the Supabase SQL editor first');
    throw videoErr(500, error.message);
  }
  if (!data) throw videoErr(404, 'Unknown item');
  return data;
}

async function videoUploadUrl(req, res, user, brandId) {
  const { itemId, contentType, size } = req.body || {};
  await itemForVideo(itemId, brandId);
  const type = String(contentType || '').toLowerCase().split(';')[0].trim();
  const ext = VIDEO_TYPES[type];
  if (!ext) throw videoErr(400, 'That file type isn\'t a video we can store (MP4, MOV or WebM)');
  const bytes = Number(size) || 0;
  if (bytes > VIDEO_MAX_BYTES) {
    throw videoErr(413, `Video is ${(bytes / 1048576).toFixed(0)} MB — the limit is 50 MB. Record a shorter clip (about 30 seconds).`);
  }
  const path = `items/${itemId}/${newId()}.${ext}`;
  const { data, error } = await supabase.storage.from(VIDEO_BUCKET).createSignedUploadUrl(path);
  if (error) {
    if (/bucket/i.test(error.message || '') && /not found|exist/i.test(error.message || '')) {
      throw videoErr(409, 'Videos need migration 0052 (it creates the plant-videos bucket) — run it in the Supabase SQL editor first');
    }
    throw videoErr(500, error.message);
  }
  return res.status(200).json({ signedUrl: data.signedUrl, path, contentType: type });
}

async function videoCommit(req, res, user, brandId) {
  const { itemId, path } = req.body || {};
  const item = await itemForVideo(itemId, brandId);
  const folder = `items/${itemId}`;
  if (typeof path !== 'string' || !path.startsWith(`${folder}/`) || path.includes('..')) {
    throw videoErr(400, 'Bad video path');
  }
  const { data: objs, error: lErr } = await supabase.storage.from(VIDEO_BUCKET).list(folder, { limit: 100 });
  if (lErr) throw videoErr(500, lErr.message);
  const name = path.slice(folder.length + 1);
  if (!(objs || []).some((o) => o.name === name)) throw videoErr(409, 'The video didn\'t finish uploading — try again');

  const videoUrl = supabase.storage.from(VIDEO_BUCKET).getPublicUrl(path).data.publicUrl;
  const { error } = await supabase.from('inventory_items')
    .update({ videoUrl, modifiedAt: new Date().toISOString(), modifiedBy: user.displayName })
    .eq('id', itemId).eq('brandId', brandId);
  if (error) throw videoErr(500, error.message);
  // One video per plant: the previous one and any abandoned uploads go.
  const stale = (objs || []).filter((o) => o.name !== name).map((o) => `${folder}/${o.name}`);
  if (stale.length) await supabase.storage.from(VIDEO_BUCKET).remove(stale).catch(() => {});
  return res.status(200).json({ videoUrl, previous: item.videoUrl || null });
}

async function videoDelete(req, res, user, brandId) {
  const { itemId } = req.body || {};
  await itemForVideo(itemId, brandId);
  const folder = `items/${itemId}`;
  const { data: objs } = await supabase.storage.from(VIDEO_BUCKET).list(folder, { limit: 100 });
  const paths = (objs || []).map((o) => `${folder}/${o.name}`);
  if (paths.length) await supabase.storage.from(VIDEO_BUCKET).remove(paths).catch(() => {});
  const { error } = await supabase.from('inventory_items')
    .update({ videoUrl: null, modifiedAt: new Date().toISOString(), modifiedBy: user.displayName })
    .eq('id', itemId).eq('brandId', brandId);
  if (error) throw videoErr(500, error.message);
  return res.status(200).json({ ok: true });
}
