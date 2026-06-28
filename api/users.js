import { supabase, stripUser, requireAdmin } from './_lib/supabase.js';
import { hashPassword } from './_lib/hash.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';

// Keep only real brand ids; fall back to ['folia'] so a user always has at
// least one accessible brand. Validated against the brands table so an admin
// can't grant access to a brand that doesn't exist.
async function sanitizeBrandIds(input) {
  const { data: brands } = await supabase.from('brands').select('id');
  const valid = new Set((brands || []).map(b => b.id));
  const arr = Array.isArray(input) ? [...new Set(input.filter(b => valid.has(b)))] : [];
  return arr.length ? arr : ['folia'];
}

export default wrap(async (req, res) => {
  switch (req.method) {
    case 'GET': {
      const { data, error } = await supabase
        .from('users')
        .select('*')
        .order('createdAt', { ascending: true });
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ users: (data || []).map(stripUser) });
    }

    case 'POST': {
      // Admin creates a new user (with specified role + brand access).
      const { username, password, displayName, role, brandIds, adminUserId } = req.body || {};
      await requireAdmin(adminUserId);

      if (!username?.trim() || !password) {
        const e = new Error('username and password required'); e.status = 400; throw e;
      }
      if (password.length < 6) {
        const e = new Error('Password must be at least 6 characters'); e.status = 400; throw e;
      }
      if (!['admin', 'staff', 'packer'].includes(role)) {
        const e = new Error('Role must be admin, staff, or packer'); e.status = 400; throw e;
      }

      const normalized = username.trim().toLowerCase();
      const { data: existing } = await supabase.from('users').select('id').eq('username', normalized).maybeSingle();
      if (existing) { const e = new Error('Username already taken'); e.status = 409; throw e; }

      const user = {
        id: `${Date.now()}${Math.random().toString(36).slice(2, 7)}`,
        username: normalized,
        displayName: displayName?.trim() || username.trim(),
        passwordHash: hashPassword(password),
        role,
        createdAt: new Date().toISOString(),
        active: true,
        brandIds: await sanitizeBrandIds(brandIds),
      };

      const { error } = await supabase.from('users').insert(user);
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(201).json({ user: stripUser(user) });
    }

    case 'PATCH': {
      // Admin updates role / active / resets password.
      const { id, patch, newPassword, adminUserId } = req.body || {};
      await requireAdmin(adminUserId);
      if (!id) { const e = new Error('id required'); e.status = 400; throw e; }

      const update = {};
      if (patch && typeof patch === 'object') {
        if ('role' in patch) {
          if (!['admin', 'staff', 'packer'].includes(patch.role)) {
            const e = new Error('Role must be admin, staff, or packer'); e.status = 400; throw e;
          }
          update.role = patch.role;
        }
        if ('active' in patch) update.active = patch.active;
        if ('brandIds' in patch) update.brandIds = await sanitizeBrandIds(patch.brandIds);
      }
      if (newPassword) {
        if (newPassword.length < 6) {
          const e = new Error('Password must be at least 6 characters'); e.status = 400; throw e;
        }
        update.passwordHash = hashPassword(newPassword);
      }
      if (Object.keys(update).length === 0) {
        const e = new Error('nothing to update'); e.status = 400; throw e;
      }

      // Prevent demoting or deactivating the last active admin.
      if ((update.role && update.role !== 'admin') || update.active === false) {
        const { data: admins } = await supabase
          .from('users')
          .select('id')
          .eq('role', 'admin')
          .eq('active', true);
        const adminIds = (admins || []).map(a => a.id);
        if (adminIds.length === 1 && adminIds[0] === id) {
          const e = new Error('Cannot demote or deactivate the only admin'); e.status = 400; throw e;
        }
      }

      const { error } = await supabase.from('users').update(update).eq('id', id);
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ ok: true });
    }

    case 'DELETE': {
      const { ids, adminUserId } = req.body || {};
      await requireAdmin(adminUserId);
      if (!Array.isArray(ids) || ids.length === 0) {
        const e = new Error('ids required'); e.status = 400; throw e;
      }
      if (ids.includes(adminUserId)) {
        const e = new Error("You can't delete your own account"); e.status = 400; throw e;
      }
      const { error } = await supabase.from('users').delete().in('id', ids);
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ ok: true });
    }

    default:
      return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'DELETE']);
  }
});
