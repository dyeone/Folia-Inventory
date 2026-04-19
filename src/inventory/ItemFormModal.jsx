import { useState, useEffect } from 'react';
import { AlertCircle } from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';
import { Field } from '../ui/Field.jsx';
import { VARIETIES, nextSkuForVariety } from '../constants.js';

export function ItemFormModal({ title, item, sales, existingItems = [], onSave, onClose }) {
  const isEditing = !!item;
  const [form, setForm] = useState({
    sku: item?.sku || '',
    type: item?.type || 'tc',
    name: item?.name || '',
    variety: item?.variety || '',
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
  useEffect(() => {
    if (isEditing) return;
    setForm(f => ({ ...f, sku: nextSkuForVariety(f.variety, existingItems) }));
  }, [isEditing, form.variety, existingItems]);

  // Auto-calc ideal price from net cost × (1 + profit rate/100)
  const recalcIdeal = (netCost, profitRate) => {
    const c = parseFloat(netCost);
    const p = parseFloat(profitRate);
    if (!isNaN(c) && !isNaN(p)) {
      return (c * (1 + p / 100)).toFixed(2);
    }
    return form.idealPrice;
  };

  const handleSubmit = () => {
    if (!form.variety) return setErr('Variety is required');
    if (!form.name.trim()) return setErr('Name is required');
    if (!form.sku) return setErr('SKU could not be generated — pick a variety first');
    if (!isEditing && existingItems.some(i => i.sku === form.sku)) {
      return setErr(`SKU "${form.sku}" already exists. Please retry.`);
    }
    onSave({
      ...form,
      cost: form.grossCost, // backward compat
      saleId: form.saleId || null,
      lotNumber: form.lotNumber || null,
    });
  };

  return (
    <Modal title={title} onClose={onClose}>
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
        <Field label="Variety *">
          <select value={form.variety} onChange={(e) => setForm({ ...form, variety: e.target.value })} className="input">
            <option value="">Select variety…</option>
            {VARIETIES.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </Field>
        <Field label="Plant Name *">
          <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input" placeholder="e.g. Monstera Albo Japanese" />
        </Field>

        <div className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-xs">
          <span className="text-gray-500">{isEditing ? 'SKU' : 'SKU (auto-assigned)'}</span>
          <span className="font-mono font-bold text-gray-900">{form.sku || '—'}</span>
        </div>

        <div className="border-t border-gray-200 pt-3">
          <div className="text-xs font-semibold text-gray-700 mb-2">Cost & Pricing</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Gross Cost">
              <input
                type="number" step="0.01" value={form.grossCost}
                onChange={(e) => setForm({ ...form, grossCost: e.target.value })}
                className="input" placeholder="0.00"
              />
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
              <input
                type="number" step="0.01" value={form.idealPrice}
                onChange={(e) => setForm({ ...form, idealPrice: e.target.value })}
                className="input bg-emerald-50/50" placeholder="auto"
              />
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
                <option value="sold">Sold</option>
                <option value="shipped">Shipped</option>
                <option value="delivered">Delivered</option>
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
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
          <button onClick={handleSubmit} className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg">Save</button>
        </div>
      </div>
      <style>{`.input{width:100%;padding:.5rem .75rem;border:1px solid #d1d5db;border-radius:.5rem;font-size:.875rem;outline:none;background:white}.input:focus{border-color:#059669;box-shadow:0 0 0 3px rgba(5,150,105,.1)}`}</style>
    </Modal>
  );
}
