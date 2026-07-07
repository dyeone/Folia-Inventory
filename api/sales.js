import { supabase, requireAdmin, requireBrand, brandIdFromReq, newId } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';

const SERVER_OWNED = ['createdAt', 'createdBy'];

function stripServerOwned(sale) {
  const clean = { ...sale };
  for (const k of SERVER_OWNED) delete clean[k];
  return clean;
}

// The sale_evaluations table ships via migration 0027, applied manually in
// Supabase. Until it's applied, treat "table missing" as a soft no-op so the
// client falls back to its localStorage cache instead of erroring.
function isMissingTable(error) {
  return !!error && (error.code === '42P01' || error.code === 'PGRST205'
    || /does not exist|schema cache|find the table/i.test(error.message || ''));
}

export default wrap(async (req, res) => {
  const userId = req.method === 'GET' ? req.query?.userId : req.body?.userId;
  const { user, brandId } = await requireBrand(userId, brandIdFromReq(req));

  switch (req.method) {
    case 'GET': {
      const action = req.query?.action;
      // Load one sale's cached evaluation report.
      if (action === 'eval') {
        const saleId = req.query?.saleId;
        if (!saleId) { const e = new Error('saleId required'); e.status = 400; throw e; }
        const { data, error } = await supabase
          .from('sale_evaluations').select('result').eq('saleId', saleId).eq('brandId', brandId).maybeSingle();
        if (error) {
          if (isMissingTable(error)) return res.status(200).json({ evaluation: null, unmigrated: true });
          const e = new Error(error.message); e.status = 500; throw e;
        }
        return res.status(200).json({ evaluation: data?.result ?? null });
      }
      // Which sale events have a saved evaluation (ids only — cheap, no blobs).
      if (action === 'evalIds') {
        const { data, error } = await supabase.from('sale_evaluations').select('saleId').eq('brandId', brandId);
        if (error) {
          if (isMissingTable(error)) return res.status(200).json({ evalSaleIds: [], unmigrated: true });
          const e = new Error(error.message); e.status = 500; throw e;
        }
        return res.status(200).json({ evalSaleIds: (data || []).map(r => r.saleId) });
      }
      // Reusable per-brand sellers (consignment). Graceful no-op until 0033 is
      // applied so Folia / un-migrated brands just see an empty list.
      if (action === 'sellers-list') {
        const { data, error } = await supabase
          .from('sellers').select('*').eq('brandId', brandId).order('name');
        if (error) {
          if (isMissingTable(error)) return res.status(200).json({ sellers: [], unmigrated: true });
          const e = new Error(error.message); e.status = 500; throw e;
        }
        return res.status(200).json({ sellers: data || [] });
      }
      const { data, error } = await supabase.from('sales').select('*').eq('brandId', brandId);
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ sales: data || [] });
    }
    case 'POST': {
      // Save (upsert) a sale's evaluation report snapshot — read-only data,
      // never touches inventory.
      if (req.body?.action === 'saveEval') {
        const { saleId, result } = req.body || {};
        if (!saleId || !result) { const e = new Error('saleId and result required'); e.status = 400; throw e; }
        const row = { saleId, result, brandId, updatedAt: new Date().toISOString(), updatedBy: user.displayName };
        const { error } = await supabase.from('sale_evaluations').upsert(row, { onConflict: 'saleId' });
        if (error) {
          if (isMissingTable(error)) return res.status(200).json({ ok: false, unmigrated: true });
          const e = new Error(error.message); e.status = 500; throw e;
        }
        return res.status(200).json({ ok: true });
      }
      // Create / update a seller (consignment). `code` is the SKU prefix, so it
      // is validated to 2–8 letters and kept unique per brand (DB index).
      if (req.body?.action === 'seller-upsert') {
        const s = req.body.seller || {};
        const name = String(s.name || '').trim();
        const code = String(s.code || '').trim().toUpperCase();
        if (!name) { const e = new Error('Seller name is required'); e.status = 400; throw e; }
        if (!/^[A-Z]{2,8}$/.test(code)) {
          const e = new Error('Seller code must be 2–8 letters'); e.status = 400; throw e;
        }
        const pct = s.defaultCommissionPct == null || s.defaultCommissionPct === ''
          ? null : parseFloat(s.defaultCommissionPct);
        const dupCode = () => { const e = new Error(`Seller code "${code}" is already in use`); e.status = 409; return e; };
        const now = new Date().toISOString();
        if (s.id) {
          // Brand-guard the id so a caller can't re-brand another brand's seller.
          const { data: owned, error: oErr } = await supabase
            .from('sellers').select('id').eq('brandId', brandId).eq('id', s.id).maybeSingle();
          if (oErr) { const e = new Error(oErr.message); e.status = 500; throw e; }
          if (!owned) { const e = new Error('Seller not found'); e.status = 404; throw e; }
          const { error } = await supabase.from('sellers').update({
            name, code, defaultCommissionPct: pct,
            username: s.username || null, contact: s.contact || null,
            modifiedAt: now, modifiedBy: user.displayName,
          }).eq('brandId', brandId).eq('id', s.id);
          if (error) {
            if (error.code === '23505') throw dupCode();
            const e = new Error(error.message); e.status = 500; throw e;
          }
          return res.status(200).json({ ok: true, id: s.id });
        }
        const row = {
          id: newId(), brandId, name, code, defaultCommissionPct: pct,
          username: s.username || null, contact: s.contact || null,
          createdAt: now, createdBy: user.displayName,
        };
        const { error } = await supabase.from('sellers').insert(row);
        if (error) {
          if (error.code === '23505') throw dupCode();
          const e = new Error(error.message); e.status = 500; throw e;
        }
        return res.status(200).json({ seller: row });
      }
      const { sales } = req.body || {};
      if (!Array.isArray(sales)) {
        const e = new Error('sales must be an array'); e.status = 400; throw e;
      }
      if (sales.length === 0) return res.status(200).json({ ok: true });

      const rawInserts = sales.filter(s => !s.id).map(stripServerOwned);
      const rawUpdates = sales.filter(s => s.id).map(s => ({ ...stripServerOwned(s), brandId }));

      const now = new Date().toISOString();
      const inserts = rawInserts.map(s => ({
        ...s,
        id: newId(),
        brandId,
        createdAt: now,
        createdBy: user.displayName,
      }));

      if (inserts.length > 0) {
        const { error } = await supabase.from('sales').insert(inserts);
        if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      }
      // The upsert keys on the PK alone, so without a brand guard a caller
      // could pass another brand's sale id and overwrite / re-brand it. Filter
      // the submitted ids down to the ones that already belong to the caller's
      // brand first (one extra query, not one-per-row, so large CSV batches
      // stay fast); foreign ids are silently dropped.
      let updated = 0;
      if (rawUpdates.length > 0) {
        const ids = rawUpdates.map(s => s.id);
        const { data: owned, error: oErr } = await supabase
          .from('sales').select('id').eq('brandId', brandId).in('id', ids);
        if (oErr) { const e = new Error(oErr.message); e.status = 500; throw e; }
        const ownedIds = new Set((owned || []).map(r => r.id));
        const safe = rawUpdates.filter(s => ownedIds.has(s.id));
        if (safe.length > 0) {
          const { error } = await supabase.from('sales').upsert(safe);
          if (error) { const e = new Error(error.message); e.status = 500; throw e; }
          updated = safe.length;
        }
      }
      return res.status(200).json({ ok: true, inserted: inserts.length, updated });
    }
    case 'DELETE': {
      await requireAdmin(userId);
      // Delete a seller — refused while any inventory still references it, so a
      // seller with live consignment plants can't be orphaned (FK guard).
      if (req.body?.action === 'seller-delete') {
        const { id } = req.body || {};
        if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
        const { count, error: cErr } = await supabase
          .from('inventory_items')
          .select('id', { count: 'exact', head: true })
          .eq('brandId', brandId).eq('sellerId', id);
        if (cErr) { const e = new Error(cErr.message); e.status = 500; throw e; }
        if (count && count > 0) {
          const e = new Error(`Seller still has ${count} plant${count === 1 ? '' : 's'} in inventory — remove those first`);
          e.status = 409; throw e;
        }
        const { error } = await supabase.from('sellers').delete().eq('brandId', brandId).eq('id', id);
        if (error) { const e = new Error(error.message); e.status = 500; throw e; }
        return res.status(200).json({ ok: true });
      }
      const { ids } = req.body || {};
      if (!Array.isArray(ids) || ids.length === 0) {
        const e = new Error('ids required'); e.status = 400; throw e;
      }
      const { error } = await supabase.from('sales').delete().eq('brandId', brandId).in('id', ids);
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ ok: true });
    }
    default:
      return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
  }
});
