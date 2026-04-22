import { supabase, requireUser, newId } from '../_lib/supabase.js';
import { wrap, methodNotAllowed } from '../_lib/respond.js';
import { VARIETY_CODES } from '../../src/constants.js';

async function nextSkuForVariety(variety) {
  const code = VARIETY_CODES[variety];
  if (!code) {
    const e = new Error(`Unknown variety: ${variety}`); e.status = 400; throw e;
  }
  const prefix = `${code}-`;
  const { data } = await supabase
    .from('inventory_items')
    .select('sku')
    .like('sku', `${prefix}%`);
  const nums = (data || [])
    .map(r => parseInt(String(r.sku).slice(prefix.length), 10))
    .filter(n => !isNaN(n) && n > 0);
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return `${prefix}${next}`;
}

// POST /api/items/convert
// Atomically converts a TC item into a new Plant item.
// Body: { userId, tcId, plantData }
//   plantData = { name, variety, quantity, cost, listingPrice, notes, ... }
export default wrap(async (req, res) => {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const { userId, tcId, plantData } = req.body || {};
  const user = await requireUser(userId);

  if (!tcId) { const e = new Error('tcId required'); e.status = 400; throw e; }
  if (!plantData || typeof plantData !== 'object') {
    const e = new Error('plantData required'); e.status = 400; throw e;
  }

  // Load the TC item and sanity-check.
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

  // Insert the new plant.
  const { error: insErr } = await supabase.from('inventory_items').insert(plant);
  if (insErr) {
    if (insErr.code === '23505' && /sku/i.test(insErr.message || '')) {
      const e = new Error('SKU collision during conversion. Please retry.'); e.status = 409; throw e;
    }
    const e = new Error(insErr.message); e.status = 500; throw e;
  }

  // Mark the TC as converted and link to the new plant.
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
});
