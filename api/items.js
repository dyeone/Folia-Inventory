import { supabase, requireUser, newId } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';

// Fields the client must never be able to set directly. The server owns these.
const SERVER_OWNED = ['createdAt', 'createdBy', 'modifiedAt', 'modifiedBy'];

function stripServerOwned(item) {
  const clean = { ...item };
  for (const k of SERVER_OWNED) delete clean[k];
  return clean;
}

// Assign SKUs to items that don't have one. Numbering is GLOBAL across all
// items; the variety code is only a prefix for identification. Example
// sequence: ANT-1, ALO-2, ANT-3, MON-4, JOR-5…
//
// Variety codes come from the `varieties` table (so admin-added varieties
// work without a code release).
async function assignMissingSkus(items) {
  const needSku = items.filter(i => !i.sku);
  if (needSku.length === 0) return;

  const { data: varieties, error: vErr } = await supabase.from('varieties').select('name, code');
  if (vErr) { const e = new Error(vErr.message); e.status = 500; throw e; }
  const codeByName = Object.fromEntries((varieties || []).map(v => [v.name, v.code]));

  for (const item of needSku) {
    if (!codeByName[item.variety]) {
      const e = new Error(`Unknown variety: ${item.variety}`); e.status = 400; throw e;
    }
  }

  // Find the current max suffix across all items (regardless of prefix).
  const { data } = await supabase.from('inventory_items').select('sku');
  const nums = (data || [])
    .map(r => {
      const m = String(r.sku || '').match(/-(\d+)$/);
      return m ? parseInt(m[1], 10) : 0;
    })
    .filter(n => n > 0);
  let next = nums.length > 0 ? Math.max(...nums) + 1 : 1;

  for (const item of needSku) {
    item.sku = `${codeByName[item.variety]}-${next++}`;
  }
}

export default wrap(async (req, res) => {
  // All item operations require an authenticated user.
  const userId = req.method === 'GET' ? req.query?.userId : req.body?.userId;
  const user = await requireUser(userId);

  switch (req.method) {
    case 'GET': {
      // Lazy purge: hard-delete anything in the trash longer than 30 days.
      // Best-effort — we don't fail the read if this errors.
      const cutoff = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
      await supabase.from('inventory_items').delete().lt('deletedAt', cutoff);

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

      // Split by presence of id: no id = insert, has id = update.
      const rawInserts = items.filter(i => !i.id).map(stripServerOwned);
      const rawUpdates = items.filter(i => i.id).map(stripServerOwned);

      // Server-generate SKUs for new items that don't have one.
      if (rawInserts.length > 0) await assignMissingSkus(rawInserts);

      const now = new Date().toISOString();
      const inserts = rawInserts.map(item => ({
        ...item,
        id: newId(),
        createdAt: now,
        createdBy: user.displayName,
      }));
      const updates = rawUpdates.map(item => ({
        ...item,
        modifiedAt: now,
        modifiedBy: user.displayName,
      }));

      // Catch duplicate SKUs within the incoming payload before hitting the DB.
      const allSkus = [...inserts, ...updates].map(i => (i.sku ?? '').toString().trim()).filter(Boolean);
      const dupeInBatch = allSkus.find((s, i) => allSkus.indexOf(s) !== i);
      if (dupeInBatch) {
        const e = new Error(`Duplicate SKU "${dupeInBatch}" in this save`); e.status = 409; throw e;
      }

      if (inserts.length > 0) {
        const { error } = await supabase.from('inventory_items').insert(inserts);
        if (error) {
          if (error.code === '23505' && /sku/i.test(error.message || '')) {
            const e = new Error('SKU already exists — someone else may have just taken it. Please retry.'); e.status = 409; throw e;
          }
          const e = new Error(error.message); e.status = 500; throw e;
        }
      }
      // For updates we use UPDATE (not UPSERT) so partial payloads — e.g.
      // restoring a soft-deleted row by sending only { id, deletedAt: null }
      // — don't trip the NOT NULL constraints on sku/type during the
      // INSERT phase of an upsert.
      if (updates.length > 0) {
        for (const item of updates) {
          const { id, ...patch } = item;
          const { error } = await supabase
            .from('inventory_items')
            .update(patch)
            .eq('id', id);
          if (error) {
            if (error.code === '23505' && /sku/i.test(error.message || '')) {
              const e = new Error('SKU already exists — SKUs must be unique.'); e.status = 409; throw e;
            }
            const e = new Error(error.message); e.status = 500; throw e;
          }
        }
      }
      return res.status(200).json({ ok: true, inserted: inserts.length, updated: updates.length });
    }

    case 'DELETE': {
      const { ids, purge } = req.body || {};
      if (!Array.isArray(ids) || ids.length === 0) {
        const e = new Error('ids required'); e.status = 400; throw e;
      }
      if (purge) {
        // Hard delete — bypass the 30-day grace. Used by the Recently
        // Deleted tab's "Delete forever" action.
        const { error } = await supabase.from('inventory_items').delete().in('id', ids);
        if (error) { const e = new Error(error.message); e.status = 500; throw e; }
        return res.status(200).json({ ok: true, purged: ids.length });
      }
      // Soft delete: items keep all their data and are recoverable for
      // 30 days from the Recently Deleted tab.
      const { error } = await supabase
        .from('inventory_items')
        .update({
          deletedAt: new Date().toISOString(),
          deletedBy: user.displayName,
        })
        .in('id', ids);
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ ok: true, deleted: ids.length });
    }

    default:
      return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
  }
});
