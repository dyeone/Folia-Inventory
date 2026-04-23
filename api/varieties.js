import { supabase, requireUser, requireAdmin, newId } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';

// Catalog of variety/genus rows. Any active user can list and create
// varieties; only admins can edit or delete (so an accidental rename
// doesn't break linked items / SKU prefixes).

export default wrap(async (req, res) => {
  const userId = req.method === 'GET' ? req.query?.userId : req.body?.userId;
  const user = await requireUser(userId);

  switch (req.method) {
    case 'GET': {
      const { data, error } = await supabase
        .from('varieties')
        .select('*')
        .order('name');
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ varieties: data || [] });
    }

    case 'POST': {
      const { name, code } = req.body || {};
      const cleanName = String(name || '').trim();
      const cleanCode = String(code || '').trim().toUpperCase();
      if (!cleanName) { const e = new Error('Name is required'); e.status = 400; throw e; }
      if (!/^[A-Z]{2,6}$/.test(cleanCode)) {
        const e = new Error('Code must be 2–6 uppercase letters'); e.status = 400; throw e;
      }
      const row = {
        id: newId(),
        name: cleanName,
        code: cleanCode,
        createdAt: new Date().toISOString(),
        createdBy: user.displayName,
      };
      const { error } = await supabase.from('varieties').insert(row);
      if (error) {
        if (error.code === '23505') {
          const e = new Error(`Variety "${cleanName}" already exists`); e.status = 409; throw e;
        }
        const e = new Error(error.message); e.status = 500; throw e;
      }
      return res.status(200).json({ variety: row });
    }

    case 'PATCH': {
      await requireAdmin(userId);
      const { id, name, code } = req.body || {};
      if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
      const patch = {};
      if (name !== undefined) patch.name = String(name).trim();
      if (code !== undefined) {
        const c = String(code).trim().toUpperCase();
        if (!/^[A-Z]{2,6}$/.test(c)) {
          const e = new Error('Code must be 2–6 uppercase letters'); e.status = 400; throw e;
        }
        patch.code = c;
      }
      const { error } = await supabase.from('varieties').update(patch).eq('id', id);
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ ok: true });
    }

    case 'DELETE': {
      await requireAdmin(userId);
      const { id } = req.body || {};
      if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
      // Refuse if any species still references it.
      const { count } = await supabase
        .from('species')
        .select('id', { count: 'exact', head: true })
        .eq('varietyId', id);
      if (count && count > 0) {
        const e = new Error(`Variety still has ${count} species — delete those first`); e.status = 409; throw e;
      }
      const { error } = await supabase.from('varieties').delete().eq('id', id);
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ ok: true });
    }

    default:
      return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'DELETE']);
  }
});
