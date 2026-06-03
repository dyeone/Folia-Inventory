import { useMemo, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';
import { Field } from '../ui/Field.jsx';
import { nextSkuForCode } from '../constants.js';
import { SpeciesPicker } from './SpeciesPicker.jsx';

export function ItemFormModal({
  title, item, sales, existingItems = [],
  varieties = [], species = [],
  onCreateVariety, onCreateSpecies,
  onSave, onClose,
}) {
  // An `item` without an id is a prefill (e.g. "Add to this cultivar" on the
  // inventory list seeds variety/name/speciesId), not an edit — only treat
  // rows with a real id as edits so SKU auto-assignment still runs.
  const isEditing = !!item?.id;

  // Resolve initial catalog selection from the item (if linked) or by
  // matching the legacy variety/name fields against the catalog.
  const initialPick = (() => {
    if (item?.speciesId) {
      const sp = species.find(s => s.id === item.speciesId);
      const v = sp ? varieties.find(x => x.id === sp.varietyId) : null;
      return {
        varietyId: v?.id || '',
        varietyName: v?.name || item?.variety || '',
        speciesId: sp?.id || null,
        speciesEpithet: sp?.epithet || item?.name || '',
      };
    }
    const v = varieties.find(x => x.name === item?.variety);
    const sp = v ? species.find(s => s.varietyId === v.id && s.epithet === item?.name) : null;
    return {
      varietyId: v?.id || '',
      varietyName: v?.name || item?.variety || '',
      speciesId: sp?.id || null,
      speciesEpithet: sp?.epithet || item?.name || '',
    };
  })();

  const [pick, setPick] = useState(initialPick);
  const [form, setForm] = useState({
    sku: item?.sku || '',
    type: item?.type || 'tc',
    quantity: item?.quantity || 1,
    grossCost: item?.grossCost ?? item?.cost ?? '',
    netCost: item?.netCost ?? '',
    profitRate: item?.profitRate ?? '',
    idealPrice: item?.idealPrice ?? '',
    listingPrice: item?.listingPrice || '',
    salePrice: item?.salePrice || '',
    source: item?.source || '',
    acquiredAt: item?.acquiredAt || new Date().toISOString().slice(0, 10),
    notes: item?.notes || '',
    status: item?.status || 'available',
    saleId: item?.saleId || '',
    lotNumber: item?.lotNumber || '',
    imageUrl: item?.imageUrl || '',
  });
  const [err, setErr] = useState('');

  // Auto-generate the SKU from the selected variety (new items only).
  const sku = useMemo(() => {
    if (isEditing) return form.sku;
    const v = varieties.find(x => x.id === pick.varietyId);
    return nextSkuForCode(v?.code, existingItems);
  }, [isEditing, form.sku, pick.varietyId, varieties, existingItems]);

  // Quantity > 1 (add only) expands into that many separate, sequentially
  // numbered SKUs — each quantity 1. The server does the expansion (see
  // addItem in App.jsx); this just previews the range so adding a whole
  // variety in one shot is obvious. Editing always touches the one SKU.
  const addQty = isEditing ? 1 : Math.max(1, parseInt(form.quantity, 10) || 1);
  const skuPreview = useMemo(() => {
    if (addQty <= 1) return sku || '—';
    const m = String(sku).match(/^(.*-)(\d+)$/);
    if (!m) return sku || '—';
    return `${sku} → ${m[1]}${parseInt(m[2], 10) + addQty - 1}`;
  }, [sku, addQty]);

  const recalcIdeal = (netCost, profitRate) => {
    const c = parseFloat(netCost);
    const p = parseFloat(profitRate);
    if (!isNaN(c) && !isNaN(p)) return (c * (1 + p / 100)).toFixed(2);
    return form.idealPrice;
  };

  // Postgres rejects "" for numeric columns ("invalid input syntax for type
  // numeric"), so blank money fields become null and other numeric strings
  // get parsed into actual Numbers.
  const numOrNull = (v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (!s) return null;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  };

  const handleSubmit = () => {
    setErr('');
    if (!pick.varietyId) return setErr('Variety is required');
    if (!pick.speciesEpithet) return setErr('Species is required');
    if (!sku) return setErr('SKU could not be generated');
    if (!isEditing && existingItems.some(i => i.sku === sku)) {
      return setErr(`SKU "${sku}" already exists. Please retry.`);
    }
    const grossCost = numOrNull(form.grossCost);
    onSave({
      ...form,
      sku,
      // Denormalized columns kept in sync from the catalog pick so the
      // existing inventory list / search / sale matching keep working.
      variety: pick.varietyName,
      name: pick.speciesEpithet,
      speciesId: pick.speciesId || null,
      quantity: parseInt(form.quantity, 10) || 1,
      grossCost,
      cost: grossCost,
      netCost:      numOrNull(form.netCost),
      profitRate:   numOrNull(form.profitRate),
      idealPrice:   numOrNull(form.idealPrice),
      listingPrice: numOrNull(form.listingPrice),
      salePrice:    numOrNull(form.salePrice),
      saleId: form.saleId || null,
      lotNumber: form.lotNumber || null,
    });
  };

  return (
    <Modal title={title} onClose={onClose} size="lg">
      <div className="space-y-3">
        {err && (
          <div className="flex items-center gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
            <AlertCircle className="w-4 h-4" /> {err}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Type *">
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="input">
              <option value="tc">TC (Tissue Culture)</option>
              <option value="plant">Plant</option>
            </select>
          </Field>
          <Field label="Quantity">
            <input type="number" min="1" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} className="input" />
          </Field>
        </div>

        <SpeciesPicker
          varieties={varieties}
          species={species}
          value={pick}
          onChange={setPick}
          onCreateVariety={onCreateVariety}
          onCreateSpecies={onCreateSpecies}
        />

        <div className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-xs">
          <span className="text-gray-500">
            {isEditing ? 'SKU' : addQty > 1 ? `SKUs (auto-assigned · ${addQty})` : 'SKU (auto-assigned)'}
          </span>
          <span className="font-mono font-bold text-gray-900">{skuPreview}</span>
        </div>

        <div className="border-t border-gray-200 pt-3">
          <div className="text-xs font-semibold text-gray-700 mb-2">Cost & Pricing</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Gross Cost">
              <input type="number" step="0.01" value={form.grossCost} onChange={(e) => setForm({ ...form, grossCost: e.target.value })} className="input" placeholder="0.00" />
            </Field>
            <Field label="Net Cost (incl. overhead)">
              <input
                type="number" step="0.01" value={form.netCost}
                onChange={(e) => {
                  const v = e.target.value;
                  setForm({ ...form, netCost: v, idealPrice: recalcIdeal(v, form.profitRate) });
                }}
                className="input" placeholder="0.00"
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            <Field label="Target Profit Rate (%)">
              <input
                type="number" step="1" value={form.profitRate}
                onChange={(e) => {
                  const v = e.target.value;
                  setForm({ ...form, profitRate: v, idealPrice: recalcIdeal(form.netCost, v) });
                }}
                className="input" placeholder="200"
              />
            </Field>
            <Field label="Ideal Sale Price">
              <input type="number" step="0.01" value={form.idealPrice} onChange={(e) => setForm({ ...form, idealPrice: e.target.value })} className="input bg-emerald-50/50" placeholder="auto" />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            <Field label="Listing Price">
              <input type="number" step="0.01" value={form.listingPrice} onChange={(e) => setForm({ ...form, listingPrice: e.target.value })} className="input" placeholder="0.00" />
            </Field>
            <Field label="Sold Price">
              <input type="number" step="0.01" value={form.salePrice} onChange={(e) => setForm({ ...form, salePrice: e.target.value })} className="input" placeholder="0.00" />
            </Field>
          </div>
        </div>

        <div className="border-t border-gray-200 pt-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Source / Supplier">
              <input type="text" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} className="input" />
            </Field>
            <Field label="Acquired Date">
              <input type="date" value={form.acquiredAt} onChange={(e) => setForm({ ...form, acquiredAt: e.target.value })} className="input" />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            <Field label="Sale Event">
              <select value={form.saleId} onChange={(e) => setForm({ ...form, saleId: e.target.value })} className="input">
                <option value="">None</option>
                {sales.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Lot Number">
              <input type="text" value={form.lotNumber} onChange={(e) => setForm({ ...form, lotNumber: e.target.value })} className="input" />
            </Field>
          </div>
          <div className="mt-3">
            <Field label="Status">
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="input">
                <option value="available">Available</option>
                <option value="listed">Listed</option>
                {form.type === 'tc' && <option value="acclimated">Acclimated</option>}
                <option value="sold">Sold</option>
                <option value="shipped">Shipped</option>
                <option value="delivered">Delivered</option>
                <option value="refunded">Refunded</option>
              </select>
            </Field>
          </div>
          <div className="mt-3">
            <Field label="Image URL (for Palmstreet)">
              <input type="url" value={form.imageUrl} onChange={(e) => setForm({ ...form, imageUrl: e.target.value })} className="input" placeholder="https://..." />
            </Field>
          </div>
          <div className="mt-3">
            <Field label="Notes / Description">
              <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows="2" className="input resize-none" />
            </Field>
          </div>
        </div>

        {item && (item.createdBy || item.modifiedBy) && (
          <div className="text-xs text-gray-500 bg-gray-50 rounded-lg p-2 space-y-0.5">
            {item.createdBy && <div>Created by {item.createdBy} on {new Date(item.createdAt).toLocaleDateString()}</div>}
            {item.modifiedBy && <div>Last modified by {item.modifiedBy} on {new Date(item.modifiedAt).toLocaleDateString()}</div>}
          </div>
        )}
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-100 active:bg-gray-200 rounded-lg">Cancel</button>
          <button onClick={handleSubmit} className="px-5 py-2.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white rounded-lg">Save</button>
        </div>
      </div>
    </Modal>
  );
}
