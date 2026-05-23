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
    const e = new Error(`Unknown action: ${action}`); e.status = 400; throw e;
  }

  if (req.method === 'POST') {
    const action = req.body?.action;
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
  const { data: row, error } = await supabase
    .from('species_photos')
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
  const { speciesId, fileBase64, contentType, filename } = req.body || {};
  if (!speciesId)   { const e = new Error('speciesId required');   e.status = 400; throw e; }
  if (!fileBase64)  { const e = new Error('fileBase64 required');  e.status = 400; throw e; }
  if (!contentType) { const e = new Error('contentType required'); e.status = 400; throw e; }

  const { data: sp, error: spErr } = await supabase
    .from('species').select('id, "imageUrl"').eq('id', speciesId).maybeSingle();
  if (spErr) { const e = new Error(spErr.message); e.status = 500; throw e; }
  if (!sp)   { const e = new Error('Unknown species'); e.status = 404; throw e; }

  // Find next sortOrder for this species.
  const { data: existing, error: exErr } = await supabase
    .from('species_photos')
    .select('"sortOrder"')
    .eq('speciesId', speciesId)
    .order('sortOrder', { ascending: false })
    .limit(1);
  if (exErr) { const e = new Error(exErr.message); e.status = 500; throw e; }
  const nextSort = existing && existing[0] ? existing[0].sortOrder + 1 : 0;

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
    createdAt: new Date().toISOString(),
    createdBy: user.displayName,
  };
  const { error: insErr } = await supabase.from('species_photos').insert(row);
  if (insErr) {
    await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]).catch(() => {});
    const e = new Error(insErr.message); e.status = 500; throw e;
  }

  // Lazy migration: move the legacy species.imageUrl into species_photos
  // on the first real upload, so the catalog UI stops needing the fallback.
  if (sp.imageUrl) {
    const legacyId = newId();
    await supabase.from('species_photos').insert({
      id: legacyId,
      speciesId,
      storagePath: sp.imageUrl,
      sortOrder: -1,
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
