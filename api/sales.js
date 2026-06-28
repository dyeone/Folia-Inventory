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
      if (rawUpdates.length > 0) {
        const { error } = await supabase.from('sales').upsert(rawUpdates);
        if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      }
      return res.status(200).json({ ok: true, inserted: inserts.length, updated: rawUpdates.length });
    }
    case 'DELETE': {
      await requireAdmin(userId);
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
