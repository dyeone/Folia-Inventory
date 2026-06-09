import { supabase, requireUser, newId } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';

// Fields the client must never be able to set directly. The server owns these.
const SERVER_OWNED = ['createdAt', 'createdBy', 'modifiedAt', 'modifiedBy'];

// Supabase caps un-ranged selects at 1000 rows by default. Paginate so we
// actually return everything for tables that can grow past that. Pass a
// builder thunk because Supabase queries are single-use awaitables.
async function fetchAll(buildQuery) {
  const PAGE = 1000;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await buildQuery().range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

function stripServerOwned(item) {
  const clean = { ...item };
  for (const k of SERVER_OWNED) delete clean[k];
  return clean;
}

// Largest numeric SKU suffix across all inventory items, computed in SQL.
//
// Why an RPC instead of `order('sku', desc).limit(N)`? Supabase's order is
// lexicographic — with mixed-width suffixes and prefixes, `MON-99` sorts
// above `ANT-2000`. The top-N window can miss the true max entirely, which
// caused new SKUs to collide with existing numbers under a different
// variety prefix. The RPC (defined in migration 0007) extracts the suffix
// in regex and takes max(int), which is correct regardless of width.
async function findMaxSkuSuffix() {
  const { data, error } = await supabase.rpc('inventory_max_sku_suffix');
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return data ?? 0;
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

  let next = (await findMaxSkuSuffix()) + 1;
  for (const item of needSku) {
    item.sku = `${codeByName[item.variety]}-${next++}`;
  }
}

// Pick the next global SKU number for a given variety. Used by /convert.
// Variety codes live in the `varieties` table (the old VARIETY_CODES
// constants.js export is gone) so we look them up here.
async function nextSkuForVariety(variety) {
  const { data: row, error: vErr } = await supabase
    .from('varieties')
    .select('code')
    .eq('name', variety)
    .maybeSingle();
  if (vErr) { const e = new Error(vErr.message); e.status = 500; throw e; }
  const code = row?.code;
  if (!code) {
    const e = new Error(`Unknown variety: ${variety}`); e.status = 400; throw e;
  }
  const next = (await findMaxSkuSuffix()) + 1;
  return `${code}-${next}`;
}

export default wrap(async (req, res) => {
  // All item operations require an authenticated user.
  const userId = req.method === 'GET' ? req.query?.userId : req.body?.userId;
  const user = await requireUser(userId);

  // Sub-action dispatch — "convert" used to live at /api/items/convert
  // but was inlined here to stay under Vercel's 12-function Hobby cap.
  // The action travels in the query string for GET, body for POST.
  const action = req.method === 'GET' ? req.query?.action : req.body?.action;
  if (action === 'convert') return convertItem(req, res, user);

  switch (req.method) {
    case 'GET': {
      // Lazy purge: hard-delete anything in the trash longer than 30 days.
      // The not-null guard is defense in depth — `lt` already excludes NULL
      // by SQL semantics, but one ORM quirk would silently nuke production
      // data, so we make the intent explicit.
      // Best-effort — we don't fail the read if this errors.
      const cutoff = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
      await supabase
        .from('inventory_items')
        .delete()
        .not('deletedAt', 'is', null)
        .lt('deletedAt', cutoff);

      const data = await fetchAll(() => supabase.from('inventory_items').select('*'));
      return res.status(200).json({ items: data });
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

      // Self-heal Validate-Sales placeholder rows. Each unmatched order
      // line generates a deterministic UNMATCHED-<boxId>-<rowKey> SKU
      // (see SalesUploadModal.handleApply). If an earlier upload of the
      // same file left a row (alive or soft-deleted) with that SKU, the
      // unique constraint on `sku` would reject the new insert. Hard-
      // delete any existing row whose SKU collides with an incoming
      // placeholder insert before proceeding. Placeholders are throwaway
      // — nothing of value gets lost here.
      const placeholderSkus = rawInserts
        .map(i => i.sku)
        .filter(s => typeof s === 'string' && s.startsWith('UNMATCHED-'));
      if (placeholderSkus.length > 0) {
        const { error: delErr } = await supabase
          .from('inventory_items')
          .delete()
          .in('sku', placeholderSkus);
        if (delErr) { const e = new Error(delErr.message); e.status = 500; throw e; }
      }

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
        // Batch in chunks of 500 so very large imports don't hit Postgres
        // parameter limits or Vercel body-size limits in a single request.
        // SKUs are pre-assigned above so order between batches is irrelevant.
        const CHUNK = 500;
        for (let i = 0; i < inserts.length; i += CHUNK) {
          const batch = inserts.slice(i, i + CHUNK);
          const { error } = await supabase.from('inventory_items').insert(batch);
          if (error) {
            if (error.code === '23505' && /sku/i.test(error.message || '')) {
              const e = new Error('SKU already exists — someone else may have just taken it. Please retry.'); e.status = 409; throw e;
            }
            const e = new Error(error.message); e.status = 500; throw e;
          }
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
      // Batch the .in() calls — PostgREST inlines every id into the URL
      // (?id=in.(...)), so a few hundred ids can blow past proxy URL-length
      // limits and come back as a generic 400. 200 per batch is well under
      // every reasonable proxy cap.
      const CHUNK = 200;
      // Deleting inventory is admin-only — the UI gates were client-side
      // only, leaving the endpoint open to any active user. One exception:
      // any active user may purge UNMATCHED-* placeholder rows, because
      // Validate Sales / box-delete cleanup creates and removes those as
      // part of normal staff workflows.
      if (user.role !== 'admin') {
        if (!purge) {
          const e = new Error('Only admins can delete items'); e.status = 403; throw e;
        }
        const skus = [];
        for (let i = 0; i < ids.length; i += CHUNK) {
          const { data, error } = await supabase
            .from('inventory_items')
            .select('sku')
            .in('id', ids.slice(i, i + CHUNK));
          if (error) { const e = new Error(error.message); e.status = 500; throw e; }
          skus.push(...(data || []));
        }
        if (skus.some(r => !(r.sku || '').startsWith('UNMATCHED-'))) {
          const e = new Error('Only admins can delete items'); e.status = 403; throw e;
        }
      }
      if (purge) {
        // Hard delete — bypass the 30-day grace. Used by the Recently
        // Deleted tab's "Delete forever" action.
        for (let i = 0; i < ids.length; i += CHUNK) {
          const batch = ids.slice(i, i + CHUNK);
          const { error } = await supabase.from('inventory_items').delete().in('id', batch);
          if (error) { const e = new Error(error.message); e.status = 500; throw e; }
        }
        return res.status(200).json({ ok: true, purged: ids.length });
      }
      // Soft delete: items keep all their data and are recoverable for
      // 30 days from the Recently Deleted tab.
      const patch = {
        deletedAt: new Date().toISOString(),
        deletedBy: user.displayName,
      };
      for (let i = 0; i < ids.length; i += CHUNK) {
        const batch = ids.slice(i, i + CHUNK);
        const { error } = await supabase.from('inventory_items').update(patch).in('id', batch);
        if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      }
      return res.status(200).json({ ok: true, deleted: ids.length });
    }

    default:
      return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
  }
});

// POST /api/items?action=convert
// Body: { userId, action: 'convert', tcId, plantData }
// Atomically converts a TC item into a new Plant item.
async function convertItem(req, res, user) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const { tcId, plantData } = req.body || {};
  if (!tcId) { const e = new Error('tcId required'); e.status = 400; throw e; }
  if (!plantData || typeof plantData !== 'object') {
    const e = new Error('plantData required'); e.status = 400; throw e;
  }

  const { data: tc, error: tcErr } = await supabase
    .from('inventory_items')
    .select('*')
    .eq('id', tcId)
    .maybeSingle();
  if (tcErr) { const e = new Error(tcErr.message); e.status = 500; throw e; }
  if (!tc) { const e = new Error('TC item not found'); e.status = 404; throw e; }
  if (tc.type !== 'tc') { const e = new Error('Item is not a TC — cannot convert'); e.status = 400; throw e; }
  if (tc.status === 'converted') { const e = new Error('Item is already converted'); e.status = 409; throw e; }

  const variety = plantData.variety || tc.variety;
  const newSku = await nextSkuForVariety(variety);
  const now = new Date().toISOString();

  const plant = {
    ...tc,
    ...plantData,
    id: newId(),
    sku: newSku,
    type: 'plant',
    status: 'available',
    saleId: null,
    lotNumber: null,
    variety,
    convertedFromTcId: tc.id,
    convertedFromSku: tc.sku,
    convertedAt: now,
    convertedBy: user.displayName,
    createdAt: now,
    createdBy: user.displayName,
    modifiedAt: null,
    modifiedBy: null,
  };

  const { error: insErr } = await supabase.from('inventory_items').insert(plant);
  if (insErr) {
    if (insErr.code === '23505' && /sku/i.test(insErr.message || '')) {
      const e = new Error('SKU collision during conversion. Please retry.'); e.status = 409; throw e;
    }
    const e = new Error(insErr.message); e.status = 500; throw e;
  }

  const { error: updErr } = await supabase
    .from('inventory_items')
    .update({
      status: 'converted',
      convertedToPlantId: plant.id,
      modifiedAt: now,
      modifiedBy: user.displayName,
    })
    .eq('id', tc.id);
  if (updErr) {
    // Best-effort rollback: delete the plant we just inserted.
    await supabase.from('inventory_items').delete().eq('id', plant.id);
    const e = new Error(`Failed to mark TC as converted: ${updErr.message}`); e.status = 500; throw e;
  }

  res.status(201).json({
    plant,
    tc: { ...tc, status: 'converted', convertedToPlantId: plant.id, modifiedAt: now, modifiedBy: user.displayName },
  });
}
