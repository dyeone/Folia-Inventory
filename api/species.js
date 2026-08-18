import { supabase, requireAdmin, requireBrand, brandIdFromReq, newId } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';

// Catalog of species/cultivar rows under a variety. Any active user can
// list and create (so staff can add new plants on the fly); only admins
// can edit or delete (so accidental renames don't desync linked items).

// Mirrors PRICE_MAX / IMPORT_LINES_MAX in api/purchase-orders.js and
// MAX_ROWS in src/purchasing/sheetParsing.js — one vendor sheet is the
// upstream source for all three caps.
const PRICE_MAX = 100000;
const BULK_PRICE_MAX_ROWS = 500;

export default wrap(async (req, res) => {
  const userId = req.method === 'GET' ? req.query?.userId : req.body?.userId;
  const { user, brandId } = await requireBrand(userId, brandIdFromReq(req));

  // Combine two species into one (used when renaming or re-parenting a species
  // to a name+variety that already exists). Re-points everything — items adopt
  // the survivor's variety — then removes the duplicate; see mergeSpecies.
  if (req.method === 'POST' && req.body?.action === 'merge') {
    return mergeSpecies(req, res, userId, user, brandId);
  }

  // Bulk wholesale-price update (vendor sent a new price list). Admin-only:
  // prices are the admin's domain, same posture as PO editing. Runs the
  // updates in parallel chunks so a 300-row list doesn't take a minute.
  if (req.method === 'POST' && req.body?.action === 'bulk-price') {
    await requireAdmin(userId);
    const { prices } = req.body || {};
    if (!Array.isArray(prices) || prices.length === 0 || prices.length > BULK_PRICE_MAX_ROWS) {
      const e = new Error(`prices must be a non-empty array (max ${BULK_PRICE_MAX_ROWS})`); e.status = 400; throw e;
    }
    const clean = prices.map((p, i) => {
      const n = parseFloat(p?.wholesalePrice);
      if (!p?.id || typeof p.id !== 'string' || !Number.isFinite(n) || n < 0 || n > PRICE_MAX) {
        const e = new Error(`Row ${i + 1}: id and a wholesalePrice of 0–${PRICE_MAX} required`); e.status = 400; throw e;
      }
      return { id: p.id, wholesalePrice: n };
    });
    // Note: the species table carries no modifiedAt/modifiedBy — only the
    // price column moves.
    let updated = 0;
    for (let i = 0; i < clean.length; i += 20) {
      const results = await Promise.all(clean.slice(i, i + 20).map(p =>
        supabase
          .from('species')
          .update({ wholesalePrice: p.wholesalePrice })
          .eq('id', p.id)
          .eq('brandId', brandId)
          .select('id'),
      ));
      for (const r of results) {
        if (r.error) { const e = new Error(r.error.message); e.status = 500; throw e; }
        updated += (r.data || []).length;
      }
    }
    return res.status(200).json({ updated });
  }

  switch (req.method) {
    case 'GET': {
      // Paginated: supabase-js silently caps selects at 1000 rows (recurring
      // project gotcha). The vendor price-list flow matches an entire sheet
      // against this list — a truncated catalog would silently show real
      // species as "unmatched" and their prices would never update.
      let species = [];
      for (let from = 0; ; from += 1000) {
        const { data: page, error } = await supabase
          .from('species')
          .select('*')
          .eq('brandId', brandId)
          // The id tiebreak keeps page boundaries stable — offset pages over
          // non-unique epithets can drop/duplicate rows on ties otherwise.
          .order('epithet')
          .order('id')
          .range(from, from + 999);
        if (error) { const e = new Error(error.message); e.status = 500; throw e; }
        species = species.concat(page || []);
        if (!page || page.length < 1000) break;
      }
      // Photos: fetch by brand (paginated) instead of .in(speciesId) — a
      // 1000+-id `in` list would blow past URL limits, and every photo row
      // belongs to a brand species anyway.
      let photos = [];
      if (species.length) {
        for (let from = 0; ; from += 1000) {
          const { data: p, error: pe } = await supabase
            .from('species_photos')
            .select('id, "speciesId", "storagePath", "sortOrder", "kind"')
            .eq('brandId', brandId)
            .order('sortOrder')
            .order('id')
            .range(from, from + 999);
          if (pe) { const e = new Error(pe.message); e.status = 500; throw e; }
          photos = photos.concat(p || []);
          if (!p || p.length < 1000) break;
        }
      }
      const photosBySpecies = new Map();
      for (const ph of photos) {
        if (!photosBySpecies.has(ph.speciesId)) photosBySpecies.set(ph.speciesId, []);
        photosBySpecies.get(ph.speciesId).push(ph);
      }
      // Packer logins fetch the catalog only for line NAMES on the
      // receiving pane — strip wholesale pricing so bench clients can't
      // reconstruct the costs the purchase-orders API hides from them.
      const stripForPacker = user.role === 'packer';
      const out = (species || []).map(s => {
        const row = stripForPacker
          ? (({ wholesalePrice, idealSellingPrice, ...rest }) => rest)(s)
          : s;
        return { ...row, photos: photosBySpecies.get(s.id) || [] };
      });
      return res.status(200).json({ species: out });
    }

    case 'POST': {
      const { varietyId, epithet, commonName, notes, imageUrl,
              wholesalePrice, idealSellingPrice } = req.body || {};
      if (!varietyId) { const e = new Error('varietyId required'); e.status = 400; throw e; }
      // Length caps match the purchase-orders pattern — species now also get
      // created from uploaded supplier spreadsheets, so cells can't become
      // megabyte-long catalog names.
      const cleanEpithet = String(epithet || '').trim().slice(0, 200);
      if (!cleanEpithet) { const e = new Error('epithet required'); e.status = 400; throw e; }
      const { data: vrow } = await supabase
        .from('varieties').select('id').eq('id', varietyId).eq('brandId', brandId).maybeSingle();
      if (!vrow) { const e = new Error('Unknown variety'); e.status = 400; throw e; }

      const parseMoney = (v, name) => {
        if (v === undefined || v === null || v === '') return null;
        const n = parseFloat(v);
        if (!Number.isFinite(n) || n < 0) {
          const e = new Error(`${name} must be a non-negative number`); e.status = 400; throw e;
        }
        return n;
      };

      const row = {
        id: newId(),
        brandId,
        varietyId,
        epithet: cleanEpithet,
        commonName: commonName ? String(commonName).trim().slice(0, 200) : null,
        notes: notes ? String(notes).slice(0, 2000) : null,
        imageUrl: imageUrl ? String(imageUrl).trim().slice(0, 1000) : null,
        wholesalePrice: parseMoney(wholesalePrice, 'wholesalePrice'),
        idealSellingPrice: parseMoney(idealSellingPrice, 'idealSellingPrice'),
        createdAt: new Date().toISOString(),
        createdBy: user.displayName,
      };
      const { error } = await supabase.from('species').insert(row);
      if (error) {
        if (error.code === '23505') {
          const e = new Error(`Species "${cleanEpithet}" already exists in this variety`); e.status = 409; throw e;
        }
        const e = new Error(error.message); e.status = 500; throw e;
      }
      return res.status(200).json({ species: { ...row, photos: [] } });
    }

    case 'PATCH': {
      const { id, varietyId, epithet, commonName, notes, imageUrl, profitRate,
              wholesalePrice, idealSellingPrice, primaryPhotoId } = req.body || {};
      if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
      // Renames / reparenting are structural and need admin; pricing +
      // photo selection are operational and any active user can change.
      const wantsStructural = varietyId !== undefined || epithet !== undefined
        || commonName !== undefined || notes !== undefined || imageUrl !== undefined;
      if (wantsStructural) await requireAdmin(userId);

      // Validate the target variety exists before the update, so a bad id gets
      // a clean 400 (matching POST) instead of a raw FK 500.
      if (varietyId !== undefined) {
        const { data: vrow } = await supabase
          .from('varieties').select('id').eq('id', varietyId).eq('brandId', brandId).maybeSingle();
        if (!vrow) { const e = new Error('Unknown variety'); e.status = 400; throw e; }
      }

      const parseMoneyOrNull = (v, name) => {
        if (v === null || v === '') return null;
        const n = parseFloat(v);
        if (!Number.isFinite(n) || n < 0) {
          const e = new Error(`${name} must be a non-negative number`); e.status = 400; throw e;
        }
        return n;
      };

      const patch = {};
      if (varietyId !== undefined) patch.varietyId = varietyId;
      if (epithet !== undefined) patch.epithet = String(epithet).trim();
      if (commonName !== undefined) patch.commonName = commonName ? String(commonName).trim() : null;
      if (notes !== undefined) patch.notes = notes || null;
      if (imageUrl !== undefined) patch.imageUrl = imageUrl ? String(imageUrl).trim() : null;
      if (profitRate !== undefined) {
        if (profitRate === null || profitRate === '') {
          patch.profitRate = null;
        } else {
          const n = parseFloat(profitRate);
          if (!Number.isFinite(n)) { const e = new Error('profitRate must be a number'); e.status = 400; throw e; }
          patch.profitRate = n;
        }
      }
      if (wholesalePrice    !== undefined) patch.wholesalePrice    = parseMoneyOrNull(wholesalePrice,    'wholesalePrice');
      if (idealSellingPrice !== undefined) patch.idealSellingPrice = parseMoneyOrNull(idealSellingPrice, 'idealSellingPrice');
      if (primaryPhotoId    !== undefined) patch.primaryPhotoId    = primaryPhotoId || null;
      if (Object.keys(patch).length === 0) {
        const e = new Error('No fields to update'); e.status = 400; throw e;
      }

      const { error } = await supabase.from('species').update(patch).eq('id', id).eq('brandId', brandId);
      if (error) {
        // A duplicate (varietyId, epithet) means another species already has
        // this name — the UI offers to combine them; surface a clear message
        // rather than the raw constraint if that path is ever bypassed.
        if (error.code === '23505') {
          const e = new Error('Another species in this variety already has that name — combine them instead.'); e.status = 409; throw e;
        }
        const e = new Error(error.message); e.status = 500; throw e;
      }

      // Sync the denormalized item.name/variety so display + search stay
      // accurate when an admin renames a species.
      if (patch.epithet !== undefined || patch.varietyId !== undefined) {
        const { data: srow } = await supabase
          .from('species').select('epithet, varietyId').eq('id', id).eq('brandId', brandId).maybeSingle();
        if (srow) {
          const sync = {};
          if (patch.epithet !== undefined) sync.name = srow.epithet;
          if (patch.varietyId !== undefined) {
            const { data: vrow } = await supabase
              .from('varieties').select('name').eq('id', srow.varietyId).eq('brandId', brandId).maybeSingle();
            if (vrow) sync.variety = vrow.name;
          }
          if (Object.keys(sync).length > 0) {
            await supabase.from('inventory_items').update(sync).eq('speciesId', id).eq('brandId', brandId);
          }
        }
      }
      return res.status(200).json({ ok: true });
    }

    case 'DELETE': {
      await requireAdmin(userId);
      const { id } = req.body || {};
      if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
      const { count } = await supabase
        .from('inventory_items')
        .select('id', { count: 'exact', head: true })
        .eq('speciesId', id)
        .eq('brandId', brandId);
      if (count && count > 0) {
        const e = new Error(`Species still has ${count} items — reassign or delete those first`); e.status = 409; throw e;
      }
      const { error } = await supabase.from('species').delete().eq('id', id).eq('brandId', brandId);
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ ok: true });
    }

    default:
      return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'DELETE']);
  }
});

// POST /api/species  body: { action: 'merge', fromId, intoId }
// Combine `fromId` into `intoId`. Used when an admin renames (or re-parents) a
// species to a name+variety that already exists, so two duplicate cultivars
// become one. Items adopt the survivor's variety, so this also handles a
// duplicate that was mis-categorized under two different varieties. Re-points every reference, then deletes the duplicate:
//   1. inventory_items   → speciesId + denormalized name = survivor's epithet
//   2. species_photos    → speciesId (both photo sets land on the survivor)
//   3. delete the now-unreferenced `fromId` species.
//
// Purchase-order history is deliberately NOT auto-merged: folding two PO lines
// would have to sum quantities and re-home the per-unit received-items audit
// trail across tables with no cross-statement transaction available here, and
// a partial failure could double-count or corrupt receiving records. So if the
// species being combined has any PO lines, we refuse with a clear message
// rather than risk the accounting. The common case (duplicate imported
// cultivars with no purchasing history) combines cleanly.
//
// The re-point + delete steps are individually idempotent: a mid-way failure
// only leaves an already-emptied duplicate that a re-run removes. Admin-only.
async function mergeSpecies(req, res, userId, user, brandId) {
  await requireAdmin(userId);
  const { fromId, intoId } = req.body || {};
  if (!fromId || !intoId) { const e = new Error('fromId and intoId required'); e.status = 400; throw e; }
  if (fromId === intoId) { const e = new Error('Cannot combine a species into itself'); e.status = 400; throw e; }

  const { data: rows, error: selErr } = await supabase
    .from('species').select('id, "varietyId", epithet').in('id', [fromId, intoId]).eq('brandId', brandId);
  if (selErr) { const e = new Error(selErr.message); e.status = 500; throw e; }
  const from = rows?.find(r => r.id === fromId);
  const into = rows?.find(r => r.id === intoId);
  if (!from || !into) { const e = new Error('Species not found'); e.status = 404; throw e; }

  // Items adopt the survivor's variety too — combine can move a species across
  // varieties (e.g. fixing a duplicate that was mis-categorized under two).
  const { data: vrow, error: vErr } = await supabase
    .from('varieties').select('name').eq('id', into.varietyId).eq('brandId', brandId).maybeSingle();
  if (vErr) { const e = new Error(vErr.message); e.status = 500; throw e; }
  const intoVarietyName = vrow?.name || null;

  // Refuse if the species being combined carries purchase-order history — its
  // PO lines have an ON DELETE RESTRICT FK (so the delete below would fail) and
  // folding them safely needs a transaction we don't have here.
  const { count: poCount, error: poErr } = await supabase
    .from('purchase_order_lines')
    .select('id', { count: 'exact', head: true })
    .eq('speciesId', fromId)
    .eq('brandId', brandId);
  if (poErr) { const e = new Error(poErr.message); e.status = 500; throw e; }
  if (poCount && poCount > 0) {
    const e = new Error(`"${from.epithet}" has purchase-order history and can't be auto-combined. Remove its purchase-order lines first, then combine.`);
    e.status = 409; throw e;
  }

  const now = new Date().toISOString();

  // 1. Re-point inventory items (alive + trashed) to the survivor — its
  //    speciesId, denormalized name, and variety.
  const itemPatch = { speciesId: intoId, name: into.epithet, modifiedAt: now, modifiedBy: user.displayName };
  if (intoVarietyName) itemPatch.variety = intoVarietyName;
  const { data: movedItems, error: itErr } = await supabase
    .from('inventory_items')
    .update(itemPatch)
    .eq('speciesId', fromId)
    .eq('brandId', brandId)
    .select('id');
  if (itErr) { const e = new Error(itErr.message); e.status = 500; throw e; }

  // 2. Re-point photos onto the survivor. The mother/father parent slots are
  //    single per species, so demote the merged-in species' parent photos to
  //    'gallery' first — the survivor keeps its own parent slots and gains the
  //    rest as gallery photos (nothing is lost), avoiding duplicate slots.
  const { error: demoteErr } = await supabase
    .from('species_photos').update({ kind: 'gallery' })
    .eq('speciesId', fromId).neq('kind', 'gallery').eq('brandId', brandId);
  if (demoteErr) { const e = new Error(demoteErr.message); e.status = 500; throw e; }
  const { error: phErr } = await supabase
    .from('species_photos').update({ speciesId: intoId }).eq('speciesId', fromId).eq('brandId', brandId);
  if (phErr) { const e = new Error(phErr.message); e.status = 500; throw e; }

  // 3. Remove the now-unreferenced duplicate (no PO lines, items + photos moved).
  const { error: delErr } = await supabase.from('species').delete().eq('id', fromId).eq('brandId', brandId);
  if (delErr) { const e = new Error(delErr.message); e.status = 500; throw e; }

  return res.status(200).json({ ok: true, merged: true, intoId, removedId: fromId, items: movedItems?.length || 0 });
}
