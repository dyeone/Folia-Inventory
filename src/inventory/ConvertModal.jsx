import { useState, useEffect } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';
import { Field } from '../ui/Field.jsx';
import { VARIETIES, nextSkuForVariety } from '../constants.js';

export function ConvertModal({ item, existingItems = [], onConvert, onClose }) {
  const [form, setForm] = useState({
    sku: nextSkuForVariety(item.variety || '', existingItems),
    name: item.name,
    variety: item.variety || '',
    cost: item.cost || '',
    listingPrice: '',
    notes: item.notes || '',
    quantity: item.quantity || 1,
  });

  // Keep the new SKU in sync if the user switches variety.
  useEffect(() => {
    setForm(f => ({ ...f, sku: nextSkuForVariety(f.variety, existingItems) }));
  }, [form.variety, existingItems]);

  return (
    <Modal title={`Convert ${item.sku} to Plant`} onClose={onClose}>
      <div className="space-y-3">
        <div className="bg-sky-50 border border-sky-200 rounded-lg p-3 text-xs text-sky-900">
          <div className="font-medium mb-1">Converting tissue culture to plant</div>
          <div>The original TC SKU will be marked as "converted" and a new Plant SKU will be created, preserving the lineage.</div>
        </div>
        <div className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-xs">
          <span className="text-gray-500">New Plant SKU (auto-assigned)</span>
          <span className="font-mono font-bold text-gray-900">{form.sku}</span>
        </div>
        <Field label="Plant Name *">
          <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input" />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Variety *">
            <select value={form.variety} onChange={(e) => setForm({ ...form, variety: e.target.value })} className="input">
              <option value="">Select variety…</option>
              {VARIETIES.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="Quantity">
            <input type="number" min="1" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} className="input" />
          </Field>
        </div>
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
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
          <button onClick={() => onConvert(form)} disabled={!form.sku || !form.name} className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white rounded-lg flex items-center gap-1.5">
            <ArrowRightLeft className="w-4 h-4" /> Convert
          </button>
        </div>
      </div>
      <style>{`.input{width:100%;padding:.5rem .75rem;border:1px solid #d1d5db;border-radius:.5rem;font-size:.875rem;outline:none;background:white}.input:focus{border-color:#059669;box-shadow:0 0 0 3px rgba(5,150,105,.1)}`}</style>
    </Modal>
  );
}
