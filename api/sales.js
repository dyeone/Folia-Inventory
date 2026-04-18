import { supabase } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';

export default wrap(async (req, res) => {
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
      const { error } = await supabase.from('sales').upsert(sales);
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ ok: true });
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
