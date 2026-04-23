import { useState, useEffect } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';
import { Field } from '../ui/Field.jsx';
import { nextSkuForCode } from '../constants.js';
import { SpeciesPicker } from './SpeciesPicker.jsx';

export function ConvertModal({
  item, existingItems = [],
  varieties = [], species = [],
  onCreateVariety, onCreateSpecies,
  onConvert, onClose,
}) {
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
    sku: '',
    cost: item.cost || '',
    listingPrice: '',
    notes: item.notes || '',
    quantity: item.quantity || 1,
  });

  useEffect(() => {
    const v = varieties.find(x => x.id === pick.varietyId);
    setForm(f => ({ ...f, sku: nextSkuForCode(v?.code, existingItems) }));
  }, [pick.varietyId, varieties, existingItems]);

  return (
    <Modal title={`Convert ${item.sku} to Plant`} onClose={onClose} size="lg">
      <div className="space-y-3">
        <div className="bg-sky-50 border border-sky-200 rounded-lg p-3 text-xs text-sky-900">
          <div className="font-medium mb-1">Converting tissue culture to plant</div>
          <div>The original TC SKU will be marked as "converted" and a new Plant SKU will be created, preserving the lineage.</div>
        </div>
        <div className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-xs">
          <span className="text-gray-500">New Plant SKU (auto-assigned)</span>
          <span className="font-mono font-bold text-gray-900">{form.sku || '—'}</span>
        </div>

        <SpeciesPicker
          varieties={varieties}
          species={species}
          value={pick}
          onChange={setPick}
          onCreateVariety={onCreateVariety}
          onCreateSpecies={onCreateSpecies}
        />

        <Field label="Quantity">
          <input type="number" min="1" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} className="input" />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Adjusted Cost">
            <input type="number" step="0.01" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} className="input" />
          </Field>
          <Field label="New Listing Price">
            <input type="number" step="0.01" value={form.listingPrice} onChange={(e) => setForm({ ...form, listingPrice: e.target.value })} className="input" />
          </Field>
        </div>
        <Field label="Notes">
          <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows="2" className="input resize-none" />
        </Field>
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-100 active:bg-gray-200 rounded-lg">Cancel</button>
          <button
            onClick={() => onConvert({
              ...form,
              name: pick.speciesEpithet,
              variety: pick.varietyName,
              speciesId: pick.speciesId || null,
            })}
            disabled={!form.sku || !pick.speciesEpithet}
            className="px-5 py-2.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 disabled:bg-gray-300 text-white rounded-lg flex items-center gap-1.5"
          >
            <ArrowRightLeft className="w-4 h-4" /> Convert
          </button>
        </div>
      </div>
    </Modal>
  );
}
