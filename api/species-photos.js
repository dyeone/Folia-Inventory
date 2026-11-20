import { supabase, requireBrand, brandIdFromReq, newId } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';
import { syncItemPhotos, photoPublicUrl } from './_lib/itemPhotos.js';

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
      // Listing videos (For Sale tab). Videos are too big for a
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
// Every write ends in syncItemPhotos (api/_lib/itemPhotos.js), which keeps
// the plant's imageUrl (cover) and photoUrls (all, in order) in step.
// `forSale` (the For Sale tab): the photos the operator manages there ARE the
// listing's photos, so the cover wins over a hand-pasted imageUrl.

const badReq = (status, message) => { const e = new Error(message); e.status = status; return e; };

async function listItemPhotos(req, res, brandId) {
  const itemId = req.query?.itemId;
  if (!itemId) throw badReq(400, 'itemId required');
  const { data: rows, error } = await supabase
    .from('item_photos')
    .select('id, "itemId", "storagePath", "sortOrder"')
    .eq('itemId', itemId)
    .eq('brandId', brandId)
    .order('sortOrder', { ascending: true });
  if (error) throw badReq(500, error.message);

  const photos = [];
  for (const r of rows || []) {
    const { data: signed } = await supabase
      .storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(r.storagePath, SIGNED_URL_TTL_SECONDS);
    photos.push({ ...r, url: photoPublicUrl(r.storagePath), signedUrl: signed?.signedUrl || null });
  }
  return res.status(200).json({ photos });
}

async function uploadItem(req, res, user, brandId) {
  // `primary`: make this the plant's MAIN photo (bulk "Assign photos" from
  // the Pre Sale tab — a freshly shot photo should replace whatever was
  // uploaded before). Existing photos shift down and stay in the gallery.
  // Default (false) appends, as the item editor's gallery expects.
  // `replace`: the plant keeps ONE photo — this one. The others are deleted
  // from the gallery and from Storage once it's saved.
  // `maxPhotos` (For Sale tab): refuse once the plant already has that many.
  const {
    itemId, fileBase64, contentType, filename, primary = false, replace = false, forSale = false, maxPhotos = null,
  } = req.body || {};
  if (!itemId)      throw badReq(400, 'itemId required');
  if (!fileBase64)  throw badReq(400, 'fileBase64 required');
  if (!contentType) throw badReq(400, 'contentType required');

  const { data: it, error: itErr } = await supabase
    .from('inventory_items').select('id').eq('id', itemId).eq('brandId', brandId).maybeSingle();
  if (itErr) throw badReq(500, itErr.message);
  if (!it)   throw badReq(404, 'Unknown item');

  const { data: existing, error: exErr } = await supabase
    .from('item_photos')
    .select('id, "sortOrder"')
    .eq('itemId', itemId)
    .eq('brandId', brandId)
    .order('sortOrder', { ascending: true });
  if (exErr) throw badReq(500, exErr.message);
  const prior = existing || [];
  const cap = Number(maxPhotos);
  if (!replace && Number.isFinite(cap) && cap > 0 && prior.length >= cap) {
    throw badReq(409, `This plant already has ${prior.length} photos (the most is ${cap}) — delete one first`);
  }
  let nextSort = prior.length ? prior[prior.length - 1].sortOrder + 1 : 0;
  if ((primary || replace) && prior.length) {
    // Shift everything down one so the new photo takes slot 0 (= primary).
    for (let i = prior.length - 1; i >= 0; i--) {
      const { error } = await supabase
        .from('item_photos').update({ sortOrder: i + 1 }).eq('id', prior[i].id).eq('brandId', brandId);
      if (error) throw badReq(500, error.message);
    }
    nextSort = 0;
  }

  const buf = Buffer.from(String(fileBase64), 'base64');
  if (buf.length === 0) throw badReq(400, 'Empty file');

  const ext = (filename && filename.includes('.') ? filename.split('.').pop() : 'jpg')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
  const id = newId();
  const storagePath = `items/${itemId}/${id}.${ext || 'jpg'}`;

  const { error: upErr } = await supabase
    .storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buf, { contentType, upsert: false });
  if (upErr) throw badReq(500, upErr.message);

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
    throw badReq(500, insErr.message);
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

  const synced = await syncItemPhotos(itemId, brandId, { force: !!primary || !!replace || !!forSale });

  return res.status(200).json({
    photo: row, signedUrl: signed?.signedUrl || null, itemImageUrl: synced.imageUrl, photoUrls: synced.photoUrls, primary: !!primary,
  });
}

async function removeItem(req, res, brandId) {
  const { id, forSale = false } = req.body || {};
  if (!id) throw badReq(400, 'id required');
  const { data: row, error } = await supabase
    .from('item_photos')
    .select('id, "itemId", "storagePath"')
    .eq('id', id)
    .eq('brandId', brandId)
    .maybeSingle();
  if (error) throw badReq(500, error.message);
  if (!row)  throw badReq(404, 'Photo not found');

  await supabase.storage.from(STORAGE_BUCKET).remove([row.storagePath]).catch(() => {});
  const { error: delErr } = await supabase.from('item_photos').delete().eq('id', id).eq('brandId', brandId);
  if (delErr) throw badReq(500, delErr.message);
  const synced = await syncItemPhotos(row.itemId, brandId, { force: !!forSale });
  return res.status(200).json({ ok: true, itemId: row.itemId, itemImageUrl: synced.imageUrl, photoUrls: synced.photoUrls });
}

// The listed photos go first, in the order given; any the caller didn't
// know about (a stale gallery) keep their order behind them, so two photos
// never share a slot.
async function reorderItem(req, res, brandId) {
  const { itemId, orderedPhotoIds, forSale = false } = req.body || {};
  if (!itemId) throw badReq(400, 'itemId required');
  if (!Array.isArray(orderedPhotoIds)) throw badReq(400, 'orderedPhotoIds must be an array');
  const { data: rows, error: lErr } = await supabase
    .from('item_photos')
    .select('id, "sortOrder"')
    .eq('itemId', itemId)
    .eq('brandId', brandId)
    .order('sortOrder', { ascending: true });
  if (lErr) throw badReq(500, lErr.message);
  const known = new Set((rows || []).map((r) => r.id));
  const first = [...new Set(orderedPhotoIds)].filter((id) => known.has(id));
  const rest = (rows || []).map((r) => r.id).filter((id) => !first.includes(id));
  const order = [...first, ...rest];
  const sortOf = new Map((rows || []).map((r) => [r.id, r.sortOrder]));
  for (let i = 0; i < order.length; i++) {
    if (sortOf.get(order[i]) === i) continue;
    const { error } = await supabase
      .from('item_photos')
      .update({ sortOrder: i })
      .eq('id', order[i])
      .eq('itemId', itemId)
      .eq('brandId', brandId);
    if (error) throw badReq(500, error.message);
  }
  const synced = await syncItemPhotos(itemId, brandId, { force: !!forSale });
  return res.status(200).json({ ok: true, itemImageUrl: synced.imageUrl, photoUrls: synced.photoUrls });
}

// ─── Listing videos (For Sale tab) ──────────────────────────────────────────
// Bucket `plant-videos` (public, 50 MB/file, video types — migration 0052).
// Path: items/<itemId>/<id>.<ext>. A plant holds up to MAX_VIDEOS (2026-11-20,
// operator: "each item can add more than … 1 video"): videoUrls lists their
// public URLs in the order added (0055) and videoUrl stays the first — what
// everything showing "has a video" reads. The Palmstreet CSV and Shopify put
// up every one. Before 0055 a plant keeps one video and a new one replaces it.
const VIDEO_BUCKET = 'plant-videos';
const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const MAX_VIDEOS = 5;   // keep in step with src/forsale/pools.js
// An upload never committed (the phone lost signal) is swept once it's this
// old — a younger one may be another phone's upload still on its way.
const ABANDONED_MS = 60 * 60 * 1000;
const VIDEO_TYPES = {
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-m4v': 'm4v',
};

function videoErr(status, message) { const e = new Error(message); e.status = status; return e; }

const videoUrlsMissing = (error) => !!error
  && (error.code === '42703' || error.code === 'PGRST204' || /videoUrls/.test(error.message || ''));

// The plant's videos in order: its list, led by videoUrl if that isn't in it.
function videosOf(row) {
  const list = Array.isArray(row?.videoUrls) ? row.videoUrls.filter((u) => typeof u === 'string' && u) : [];
  const first = typeof row?.videoUrl === 'string' && row.videoUrl ? row.videoUrl : null;
  return first && !list.includes(first) ? [first, ...list] : list;
}

// → { row, multi, videos } — multi: 0055 is in, the plant can hold several.
async function itemForVideo(itemId, brandId) {
  if (!itemId || typeof itemId !== 'string') throw videoErr(400, 'itemId required');
  const read = (cols) => supabase.from('inventory_items')
    .select(cols).eq('id', itemId).eq('brandId', brandId).maybeSingle();
  let multi = true;
  let { data, error } = await read('id, "videoUrl", "videoUrls"');
  if (videoUrlsMissing(error)) {
    multi = false;
    ({ data, error } = await read('id, "videoUrl"'));
  }
  if (error) {
    if (/videoUrl/.test(error.message || '')) throw videoErr(409, 'Videos need migration 0052 (for_sale_pools) — run it in the Supabase SQL editor first');
    throw videoErr(500, error.message);
  }
  if (!data) throw videoErr(404, 'Unknown item');
  return { row: data, multi, videos: videosOf(data) };
}

// Change the plant's video list (videoUrl follows its first). The write is
// a compare-and-set on the list as read, so two phones changing one plant's
// videos at once can't drop each other's: the loser reads again and redoes
// its change. `edit(current)` → the new list, or null for no change.
async function changeVideos(itemId, brandId, user, edit) {
  for (let round = 0; round < 4; round++) {
    const { row } = await itemForVideo(itemId, brandId);
    const cur = videosOf(row);
    const next = edit(cur);
    if (!next) return cur;
    let q = supabase.from('inventory_items')
      .update({ videoUrls: next.length ? next : null, videoUrl: next[0] || null, modifiedAt: new Date().toISOString(), modifiedBy: user.displayName })
      .eq('id', itemId).eq('brandId', brandId);
    q = row.videoUrls == null ? q.is('videoUrls', null) : q.eq('videoUrls', JSON.stringify(row.videoUrls));
    q = row.videoUrl == null ? q.is('videoUrl', null) : q.eq('videoUrl', row.videoUrl);
    const { data, error } = await q.select('id');
    if (error) throw videoErr(500, error.message);
    if (data && data.length) return next;
  }
  throw videoErr(409, 'Someone else is changing this plant\'s videos right now — try again');
}

const fullMessage = (n) => `This plant already has ${n} videos (the most is ${MAX_VIDEOS}) — delete one first`;

async function videoUploadUrl(req, res, user, brandId) {
  const { itemId, contentType, size } = req.body || {};
  const { multi, videos } = await itemForVideo(itemId, brandId);
  if (multi && videos.length >= MAX_VIDEOS) throw videoErr(409, fullMessage(videos.length));
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

// The uploaded file joins the plant's videos (before 0055 it replaces the
// one video). → { videoUrl (the first), videoUrls (all, after 0055) }
async function videoCommit(req, res, user, brandId) {
  const { itemId, path } = req.body || {};
  const { multi } = await itemForVideo(itemId, brandId);
  const folder = `items/${itemId}`;
  if (typeof path !== 'string' || !path.startsWith(`${folder}/`) || path.includes('..')) {
    throw videoErr(400, 'Bad video path');
  }
  const { data: objs, error: lErr } = await supabase.storage.from(VIDEO_BUCKET).list(folder, { limit: 100 });
  if (lErr) throw videoErr(500, lErr.message);
  const name = path.slice(folder.length + 1);
  if (!(objs || []).some((o) => o.name === name)) throw videoErr(409, 'The video didn\'t finish uploading — try again');

  const url = supabase.storage.from(VIDEO_BUCKET).getPublicUrl(path).data.publicUrl;
  let videos;
  if (multi) {
    try {
      videos = await changeVideos(itemId, brandId, user, (cur) => {
        if (cur.includes(url)) return null;   // a retried commit
        if (cur.length >= MAX_VIDEOS) throw videoErr(409, fullMessage(cur.length));
        return [...cur, url];
      });
    } catch (e) {
      // Filled up from another phone meanwhile: this upload has no home.
      if (e.status === 409) await supabase.storage.from(VIDEO_BUCKET).remove([path]).catch(() => {});
      throw e;
    }
  } else {
    const { error } = await supabase.from('inventory_items')
      .update({ videoUrl: url, modifiedAt: new Date().toISOString(), modifiedBy: user.displayName })
      .eq('id', itemId).eq('brandId', brandId);
    if (error) throw videoErr(500, error.message);
    videos = [url];
  }
  // Files in the folder no video of the plant points at: the one replaced
  // (before 0055) and uploads never committed. Young strays are left — they
  // may be another phone's upload about to commit.
  const prefix = supabase.storage.from(VIDEO_BUCKET).getPublicUrl(`${folder}/`).data.publicUrl;
  const keep = new Set(videos.filter((u) => u.startsWith(prefix)).map((u) => u.slice(prefix.length).split('?')[0]));
  const now = Date.now();
  const stale = (objs || []).filter((o) => {
    if (keep.has(o.name)) return false;
    if (!multi) return true;
    const t = Date.parse(o.created_at || o.updated_at || '');
    return !Number.isFinite(t) || now - t > ABANDONED_MS;
  }).map((o) => `${folder}/${o.name}`);
  if (stale.length) await supabase.storage.from(VIDEO_BUCKET).remove(stale).catch(() => {});
  return res.status(200).json({ videoUrl: videos[0] || null, ...(multi ? { videoUrls: videos } : {}) });
}

// { itemId, url } deletes that one video; without `url` (or before 0055)
// every video of the plant goes.
async function videoDelete(req, res, user, brandId) {
  const { itemId, url } = req.body || {};
  const { multi, videos: had } = await itemForVideo(itemId, brandId);
  const folder = `items/${itemId}`;
  const prefix = supabase.storage.from(VIDEO_BUCKET).getPublicUrl(`${folder}/`).data.publicUrl;
  if (url && !had.includes(url)) {
    // Already gone (another phone, or a double tap).
    return res.status(200).json({ ok: true, videoUrl: had[0] || null, ...(multi ? { videoUrls: had } : {}) });
  }
  if (url && multi) {
    const videos = await changeVideos(itemId, brandId, user, (cur) => (cur.includes(url) ? cur.filter((u) => u !== url) : null));
    if (url.startsWith(prefix) && !videos.includes(url)) {
      const name = url.slice(prefix.length).split('?')[0];
      if (name && !name.includes('/') && !name.includes('..')) {
        await supabase.storage.from(VIDEO_BUCKET).remove([`${folder}/${name}`]).catch(() => {});
      }
    }
    return res.status(200).json({ ok: true, videoUrl: videos[0] || null, videoUrls: videos });
  }
  const { data: objs } = await supabase.storage.from(VIDEO_BUCKET).list(folder, { limit: 100 });
  const paths = (objs || []).map((o) => `${folder}/${o.name}`);
  const { error } = await supabase.from('inventory_items')
    .update({ videoUrl: null, ...(multi ? { videoUrls: null } : {}), modifiedAt: new Date().toISOString(), modifiedBy: user.displayName })
    .eq('id', itemId).eq('brandId', brandId);
  if (error) throw videoErr(500, error.message);
  if (paths.length) await supabase.storage.from(VIDEO_BUCKET).remove(paths).catch(() => {});
  return res.status(200).json({ ok: true, videoUrl: null, ...(multi ? { videoUrls: [] } : {}) });
}
