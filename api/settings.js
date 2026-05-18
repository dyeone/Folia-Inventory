import { supabase, requireUser, requireAdmin } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';

// Single-row JSON blob per settings id. Currently used only for
// id='shipping' (ship-from address + ShipStation defaults), but the
// shape lets us add other namespaces (id='financial', etc.) without
// new endpoints.

export default wrap(async (req, res) => {
  const userId = req.method === 'GET' ? req.query?.userId : req.body?.userId;
  await requireUser(userId);

  const id = req.method === 'GET' ? req.query?.id : req.body?.id;
  if (!id) {
    const e = new Error('id required'); e.status = 400; throw e;
  }

  switch (req.method) {
    case 'GET': {
      const { data, error } = await supabase
        .from('app_settings')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ settings: data || { id, data: {} } });
    }
    case 'PUT': {
      // Settings edits are admin-gated — ship-from + ShipStation defaults
      // are operationally sensitive (wrong address = misdelivered labels).
      await requireAdmin(userId);
      const data = req.body?.data;
      if (!data || typeof data !== 'object') {
        const e = new Error('data (object) required'); e.status = 400; throw e;
      }
      const { data: row, error } = await supabase
        .from('app_settings')
        .upsert({ id, data, updatedAt: new Date().toISOString(), updatedBy: userId })
        .select()
        .single();
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ settings: row });
    }
    default:
      return methodNotAllowed(res, ['GET', 'PUT']);
  }
});
