import { supabase, requireUser, newId } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';
import { VARIETY_CODES } from '../src/constants.js';

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
async function assignMissingSkus(items) {
  const needSku = items.filter(i => !i.sku);
  if (needSku.length === 0) return;

  // Validate varieties up front so we don't half-assign and fail.
  for (const item of needSku) {
    if (!VARIETY_CODES[item.variety]) {
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
    item.sku = `${VARIETY_CODES[item.variety]}-${next++}`;
  }
}

export default wrap(async (req, res) => {
  // All item operations require an authenticated user.
  const userId = req.method === 'GET' ? req.query?.userId : req.body?.userId;
  const user = await requireUser(userId);

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
      if (updates.length > 0) {
        const { error } = await supabase.from('inventory_items').upsert(updates);
        if (error) {
          if (error.code === '23505' && /sku/i.test(error.message || '')) {
            const e = new Error('SKU already exists — SKUs must be unique.'); e.status = 409; throw e;
          }
          const e = new Error(error.message); e.status = 500; throw e;
        }
      }
      return res.status(200).json({ ok: true, inserted: inserts.length, updated: updates.length });
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
