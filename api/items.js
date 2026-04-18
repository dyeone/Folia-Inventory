import { supabase } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';

export default wrap(async (req, res) => {
  switch (req.method) {
    case 'GET': {
      const { data, error } = await supabase.from('inventory_items').select('*');
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ items: data || [] });
    }
    case 'POST': {
      const { items } = req.body || {};
      if (!Array.isArray(items)) {
        const e = new Error('items must be an array'); e.status = 400; throw e;
      }
      if (items.length === 0) return res.status(200).json({ ok: true });

      // Catch duplicate SKUs within the payload itself before hitting the DB.
      const skus = items.map(i => (i.sku ?? '').toString().trim()).filter(Boolean);
      const dupeInBatch = skus.find((s, i) => skus.indexOf(s) !== i);
      if (dupeInBatch) {
        const e = new Error(`Duplicate SKU "${dupeInBatch}" in this save`); e.status = 409; throw e;
      }

      const { error } = await supabase.from('inventory_items').upsert(items);
      if (error) {
        // Postgres unique_violation = 23505
        if (error.code === '23505' && /sku/i.test(error.message || '')) {
          const e = new Error('SKU already exists — SKUs must be unique.'); e.status = 409; throw e;
        }
        const e = new Error(error.message); e.status = 500; throw e;
      }
      return res.status(200).json({ ok: true });
    }
    case 'DELETE': {
      const { ids } = req.body || {};
      if (!Array.isArray(ids) || ids.length === 0) {
        const e = new Error('ids required'); e.status = 400; throw e;
      }
      const { error } = await supabase.from('inventory_items').delete().in('id', ids);
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ ok: true });
    }
    default:
      return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
  }
});
