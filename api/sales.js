import { supabase, requireUser, newId } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';

const SERVER_OWNED = ['createdAt', 'createdBy'];

function stripServerOwned(sale) {
  const clean = { ...sale };
  for (const k of SERVER_OWNED) delete clean[k];
  return clean;
}

export default wrap(async (req, res) => {
  const userId = req.method === 'GET' ? req.query?.userId : req.body?.userId;
  const user = await requireUser(userId);

  switch (req.method) {
    case 'GET': {
      const { data, error } = await supabase.from('sales').select('*');
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ sales: data || [] });
    }
    case 'POST': {
      const { sales } = req.body || {};
      if (!Array.isArray(sales)) {
        const e = new Error('sales must be an array'); e.status = 400; throw e;
      }
      if (sales.length === 0) return res.status(200).json({ ok: true });

      const rawInserts = sales.filter(s => !s.id).map(stripServerOwned);
      const rawUpdates = sales.filter(s => s.id).map(stripServerOwned);

      const now = new Date().toISOString();
      const inserts = rawInserts.map(s => ({
        ...s,
        id: newId(),
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
      const { ids } = req.body || {};
      if (!Array.isArray(ids) || ids.length === 0) {
        const e = new Error('ids required'); e.status = 400; throw e;
      }
      const { error } = await supabase.from('sales').delete().in('id', ids);
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ ok: true });
    }
    default:
      return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
  }
});
