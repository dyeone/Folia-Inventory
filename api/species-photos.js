import { supabase, requireUser, newId } from './_lib/supabase.js';
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
  const user = await requireUser(userId);

  if (req.method === 'GET') {
    const action = req.query?.action;
    if (action === 'signed-url') return signedUrl(req, res);
    if (action === 'list')       return listItemPhotos(req, res);
    const e = new Error(`Unknown action: ${action}`); e.status = 400; throw e;
  }

  if (req.method === 'POST') {
    const action = req.body?.action;
    // target=item routes to the per-item photo table (item_photos); the
    // default (or target=species) keeps the original species_photos path.
    // Reusing this route avoids adding a serverless function. See 0019.
    const target = req.body?.target === 'item' ? 'item' : 'species';
    if (target === 'item') {
      if (action === 'upload')  return uploadItem(req, res, user);
      if (action === 'delete')  return removeItem(req, res);
      if (action === 'reorder') return reorderItem(req, res);
      const e = new Error(`Unknown action: ${action}`); e.status = 400; throw e;
    }
    if (action === 'upload')  return upload(req, res, user);
    if (action === 'delete')  return remove(req, res);
    if (action === 'reorder') return reorder(req, res);
    const e = new Error(`Unknown action: ${action}`); e.status = 400; throw e;
  }

  return methodNotAllowed(res, ['GET', 'POST']);
});

async function signedUrl(req, res) {
  const id = req.query?.id;
  if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
  const table = req.query?.target === 'item' ? 'item_photos' : 'species_photos';
  const { data: row, error } = await supabase
    .from(table)
    .select('"storagePath"')
    .eq('id', id)
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

async function upload(req, res, user) {
  const { speciesId, fileBase64, contentType, filename, kind: rawKind } = req.body || {};
  if (!speciesId)   { const e = new Error('speciesId required');   e.status = 400; throw e; }
  if (!fileBase64)  { const e = new Error('fileBase64 required');  e.status = 400; throw e; }
  if (!contentType) { const e = new Error('contentType required'); e.status = 400; throw e; }
  const kind = rawKind || 'gallery';
  if (!['gallery', 'mother', 'father'].includes(kind)) {
    const e = new Error('kind must be gallery, mother, or father'); e.status = 400; throw e;
  }

  const { data: sp, error: spErr } = await supabase
    .from('species').select('id, "imageUrl"').eq('id', speciesId).maybeSingle();
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
      .eq('kind', kind);
    for (const p of prior || []) {
      await supabase.storage.from(STORAGE_BUCKET).remove([p.storagePath]).catch(() => {});
      await supabase.from('species_photos').delete().eq('id', p.id);
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
      createdAt: new Date().toISOString(),
      createdBy: user.displayName,
    }).then(() => supabase.from('species').update({ imageUrl: null }).eq('id', speciesId))
      .catch(() => { /* best-effort */ });
  }

  const { data: signed } = await supabase
    .storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

  return res.status(200).json({ photo: row, signedUrl: signed?.signedUrl || null });
}

async function remove(req, res) {
  const { id } = req.body || {};
  if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
  const { data: row, error } = await supabase
    .from('species_photos')
    .select('id, "speciesId", "storagePath"')
    .eq('id', id)
    .maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  if (!row)  { const e = new Error('Photo not found'); e.status = 404; throw e; }

  await supabase.storage.from(STORAGE_BUCKET).remove([row.storagePath]).catch(() => {});
  const { error: delErr } = await supabase.from('species_photos').delete().eq('id', id);
  if (delErr) { const e = new Error(delErr.message); e.status = 500; throw e; }

  // If the deleted photo was the species's primary, clear that field —
  // the catalog UI falls back to the next photo by sortOrder.
  await supabase.from('species')
    .update({ primaryPhotoId: null })
    .eq('id', row.speciesId)
    .eq('primaryPhotoId', id);

  return res.status(200).json({ ok: true });
}

async function reorder(req, res) {
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
      .eq('speciesId', speciesId);
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
async function syncItemPrimaryImage(itemId) {
  const { data: rows } = await supabase
    .from('item_photos')
    .select('"storagePath"')
    .eq('itemId', itemId)
    .order('sortOrder', { ascending: true })
    .limit(1);
  const primaryUrl = rows && rows[0] ? publicUrlFor(rows[0].storagePath) : null;

  const { data: it } = await supabase
    .from('inventory_items').select('"imageUrl"').eq('id', itemId).maybeSingle();
  const cur = it?.imageUrl || '';
  const managedPrefix = publicUrlFor(`items/${itemId}/`) || '';
  const isManaged = !cur || (managedPrefix && cur.startsWith(managedPrefix));
  if (isManaged && cur !== (primaryUrl || '')) {
    await supabase.from('inventory_items').update({ imageUrl: primaryUrl }).eq('id', itemId);
    return primaryUrl;
  }
  return cur || null;
}

async function listItemPhotos(req, res) {
  const itemId = req.query?.itemId;
  if (!itemId) { const e = new Error('itemId required'); e.status = 400; throw e; }
  const { data: rows, error } = await supabase
    .from('item_photos')
    .select('id, "itemId", "storagePath", "sortOrder"')
    .eq('itemId', itemId)
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

async function uploadItem(req, res, user) {
  const { itemId, fileBase64, contentType, filename } = req.body || {};
  if (!itemId)      { const e = new Error('itemId required');      e.status = 400; throw e; }
  if (!fileBase64)  { const e = new Error('fileBase64 required');  e.status = 400; throw e; }
  if (!contentType) { const e = new Error('contentType required'); e.status = 400; throw e; }

  const { data: it, error: itErr } = await supabase
    .from('inventory_items').select('id').eq('id', itemId).maybeSingle();
  if (itErr) { const e = new Error(itErr.message); e.status = 500; throw e; }
  if (!it)   { const e = new Error('Unknown item'); e.status = 404; throw e; }

  const { data: existing, error: exErr } = await supabase
    .from('item_photos')
    .select('"sortOrder"')
    .eq('itemId', itemId)
    .order('sortOrder', { ascending: false })
    .limit(1);
  if (exErr) { const e = new Error(exErr.message); e.status = 500; throw e; }
  const nextSort = existing && existing[0] ? existing[0].sortOrder + 1 : 0;

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

  const itemImageUrl = await syncItemPrimaryImage(itemId);

  return res.status(200).json({ photo: row, signedUrl: signed?.signedUrl || null, itemImageUrl });
}

async function removeItem(req, res) {
  const { id } = req.body || {};
  if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
  const { data: row, error } = await supabase
    .from('item_photos')
    .select('id, "itemId", "storagePath"')
    .eq('id', id)
    .maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  if (!row)  { const e = new Error('Photo not found'); e.status = 404; throw e; }

  await supabase.storage.from(STORAGE_BUCKET).remove([row.storagePath]).catch(() => {});
  const { error: delErr } = await supabase.from('item_photos').delete().eq('id', id);
  if (delErr) { const e = new Error(delErr.message); e.status = 500; throw e; }
  const itemImageUrl = await syncItemPrimaryImage(row.itemId);
  return res.status(200).json({ ok: true, itemImageUrl });
}

async function reorderItem(req, res) {
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
      .eq('itemId', itemId);
    if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  }
  const itemImageUrl = await syncItemPrimaryImage(itemId);
  return res.status(200).json({ ok: true, itemImageUrl });
}
