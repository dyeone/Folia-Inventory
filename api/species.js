import { supabase, requireUser, requireAdmin, newId } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';

// Catalog of species/cultivar rows under a variety. Any active user can
// list and create (so staff can add new plants on the fly); only admins
// can edit or delete (so accidental renames don't desync linked items).

export default wrap(async (req, res) => {
  const userId = req.method === 'GET' ? req.query?.userId : req.body?.userId;
  const user = await requireUser(userId);

  switch (req.method) {
    case 'GET': {
      const { data: species, error } = await supabase
        .from('species')
        .select('*')
        .order('epithet');
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      const ids = (species || []).map(s => s.id);
      let photos = [];
      if (ids.length) {
        const { data: p, error: pe } = await supabase
          .from('species_photos')
          .select('id, "speciesId", "storagePath", "sortOrder", "kind"')
          .in('speciesId', ids)
          .order('sortOrder');
        if (pe) { const e = new Error(pe.message); e.status = 500; throw e; }
        photos = p || [];
      }
      const photosBySpecies = new Map();
      for (const ph of photos) {
        if (!photosBySpecies.has(ph.speciesId)) photosBySpecies.set(ph.speciesId, []);
        photosBySpecies.get(ph.speciesId).push(ph);
      }
      const out = (species || []).map(s => ({
        ...s,
        photos: photosBySpecies.get(s.id) || [],
      }));
      return res.status(200).json({ species: out });
    }

    case 'POST': {
      const { varietyId, epithet, commonName, notes, imageUrl,
              wholesalePrice, idealSellingPrice } = req.body || {};
      if (!varietyId) { const e = new Error('varietyId required'); e.status = 400; throw e; }
      const cleanEpithet = String(epithet || '').trim();
      if (!cleanEpithet) { const e = new Error('epithet required'); e.status = 400; throw e; }
      const { data: vrow } = await supabase
        .from('varieties').select('id').eq('id', varietyId).maybeSingle();
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
        varietyId,
        epithet: cleanEpithet,
        commonName: commonName ? String(commonName).trim() : null,
        notes: notes ? String(notes) : null,
        imageUrl: imageUrl ? String(imageUrl).trim() : null,
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

      const { error } = await supabase.from('species').update(patch).eq('id', id);
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }

      // Sync the denormalized item.name/variety so display + search stay
      // accurate when an admin renames a species.
      if (patch.epithet !== undefined || patch.varietyId !== undefined) {
        const { data: srow } = await supabase
          .from('species').select('epithet, varietyId').eq('id', id).maybeSingle();
        if (srow) {
          const sync = {};
          if (patch.epithet !== undefined) sync.name = srow.epithet;
          if (patch.varietyId !== undefined) {
            const { data: vrow } = await supabase
              .from('varieties').select('name').eq('id', srow.varietyId).maybeSingle();
            if (vrow) sync.variety = vrow.name;
          }
          if (Object.keys(sync).length > 0) {
            await supabase.from('inventory_items').update(sync).eq('speciesId', id);
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
        .eq('speciesId', id);
      if (count && count > 0) {
        const e = new Error(`Species still has ${count} items — reassign or delete those first`); e.status = 409; throw e;
      }
      const { error } = await supabase.from('species').delete().eq('id', id);
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ ok: true });
    }

    default:
      return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'DELETE']);
  }
});
