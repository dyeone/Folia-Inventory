import { useState, useEffect, useMemo } from 'react';
import { AlertCircle, Plus } from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';
import { Field } from '../ui/Field.jsx';
import { VARIETIES, VARIETY_CODES } from '../constants.js';

export function BatchVarietyModal({ existingItems, onSave, onClose }) {
  const [form, setForm] = useState({
    type: 'tc',
    name: '',
    variety: '',
    quantity: 5,
    skuStart: 1,
    grossCost: '',
    netCost: '',
    profitRate: '200',
    idealPrice: '',
    listingPrice: '',
    source: '',
    acquiredAt: new Date().toISOString().slice(0, 10),
    notes: '',
    imageUrl: '',
  });
  const [err, setErr] = useState('');
  const [startManuallyEdited, setStartManuallyEdited] = useState(false);

  // Auto-compute the starting number within the selected variety's namespace.
  useEffect(() => {
    if (startManuallyEdited) return;
    const code = VARIETY_CODES[form.variety];
    if (!code) { setForm(f => ({ ...f, skuStart: 1 })); return; }
    const prefix = `${code}-`;
    const nums = existingItems
      .filter(i => String(i.sku || '').startsWith(prefix))
      .map(i => parseInt(String(i.sku).slice(prefix.length), 10))
      .filter(n => !isNaN(n) && n > 0);
    const nextStart = nums.length > 0 ? Math.max(...nums) + 1 : 1;
    setForm(f => ({ ...f, skuStart: nextStart }));
  }, [existingItems, form.variety, startManuallyEdited]);

  // Auto-calc ideal price
  useEffect(() => {
    const c = parseFloat(form.netCost);
    const p = parseFloat(form.profitRate);
    if (!isNaN(c) && !isNaN(p)) {
      setForm(f => ({ ...f, idealPrice: (c * (1 + p / 100)).toFixed(2) }));
    }
  }, [form.netCost, form.profitRate]);

  const previewSkus = useMemo(() => {
    const code = VARIETY_CODES[form.variety];
    if (!code) return [];
    const qty = parseInt(form.quantity) || 0;
    const start = parseInt(form.skuStart) || 1;
    const result = [];
    for (let i = 0; i < Math.min(qty, 5); i++) {
      result.push(`${code}-${start + i}`);
    }
    return result;
  }, [form.variety, form.skuStart, form.quantity]);

  const handleSubmit = () => {
    setErr('');
    if (!form.variety) return setErr('Variety is required');
    if (!form.name.trim()) return setErr('Plant name is required');
    const qty = parseInt(form.quantity);
    if (!qty || qty < 1) return setErr('Quantity must be at least 1');
    if (qty > 500) return setErr('Maximum 500 items per batch');

    const code = VARIETY_CODES[form.variety];
    const start = parseInt(form.skuStart) || 1;
    const existingSkuSet = new Set(existingItems.map(i => String(i.sku || '')));

    const items = [];
    const duplicates = [];
    for (let i = 0; i < qty; i++) {
      const sku = `${code}-${start + i}`;
      if (existingSkuSet.has(sku)) {
        duplicates.push(sku);
        continue;
      }
      existingSkuSet.add(sku);
      items.push({
        sku,
        type: form.type,
        name: form.name.trim(),
        variety: form.variety.trim(),
        quantity: 1,
        grossCost: form.grossCost,
        cost: form.grossCost,
        netCost: form.netCost,
        profitRate: form.profitRate,
        idealPrice: form.idealPrice,
        listingPrice: form.listingPrice || form.idealPrice,
        source: form.source,
        acquiredAt: form.acquiredAt,
        notes: form.notes,
        imageUrl: form.imageUrl,
      });
    }

    if (duplicates.length === qty) {
      setErr(`All ${qty} SKUs conflict with existing items. Try changing the starting number.`);
      return;
    }
    if (duplicates.length > 0) {
      if (!confirm(`${duplicates.length} SKU(s) already exist and will be skipped: ${duplicates.slice(0, 3).join(', ')}${duplicates.length > 3 ? '...' : ''}. Create the other ${items.length}?`)) {
        return;
      }
    }

    onSave(items);
  };

  const totalInvestment = (parseFloat(form.netCost) || 0) * (parseInt(form.quantity) || 0);
  const totalPotential = (parseFloat(form.idealPrice) || 0) * (parseInt(form.quantity) || 0);
  const totalProfit = totalPotential - totalInvestment;

  return (
    <Modal title="Add Variety (Batch)" onClose={onClose}>
      <div className="space-y-3">
        <div className="bg-sky-50 border border-sky-200 rounded-lg p-3 text-xs text-sky-900">
          <div className="font-medium mb-1">Create multiple unique SKUs for one variety</div>
          <div>Fill in the plant details — SKUs will be generated automatically.</div>
        </div>

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
          <Field label="Quantity *">
            <input type="number" min="1" max="500" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} className="input" />
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

        {previewSkus.length > 0 && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 space-y-2">
            <div className="text-xs">
              <span className="font-medium text-emerald-900">SKUs: </span>
              <span className="font-mono text-emerald-800">{previewSkus[0]}
                {previewSkus.length > 1 && ` → ${previewSkus[previewSkus.length - 1]}`}
                {parseInt(form.quantity) > 5 && ` … (${form.quantity} total)`}
              </span>
            </div>
            <Field label="Start number">
              <div className="flex gap-2">
                <input
                  type="number"
                  min="1"
                  value={form.skuStart}
                  onChange={(e) => { setForm({ ...form, skuStart: e.target.value }); setStartManuallyEdited(true); }}
                  className="input font-mono flex-1"
                />
                {startManuallyEdited && (
                  <button
                    type="button"
                    onClick={() => setStartManuallyEdited(false)}
                    className="px-2 py-1 text-xs text-gray-600 hover:text-gray-900 border border-gray-300 rounded whitespace-nowrap"
                  >
                    Auto
                  </button>
                )}
              </div>
            </Field>
          </div>
        )}

        <div className="border-t border-gray-200 pt-3">
          <div className="text-xs font-semibold text-gray-700 mb-2">Cost & Pricing (applied to all items)</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Gross Cost">
              <input type="number" step="0.01" value={form.grossCost} onChange={(e) => setForm({ ...form, grossCost: e.target.value })} className="input" placeholder="10.00" />
            </Field>
            <Field label="Net Cost (incl. overhead)">
              <input type="number" step="0.01" value={form.netCost} onChange={(e) => setForm({ ...form, netCost: e.target.value })} className="input" placeholder="15.00" />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            <Field label="Target Profit Rate (%)">
              <input type="number" step="1" value={form.profitRate} onChange={(e) => setForm({ ...form, profitRate: e.target.value })} className="input" placeholder="200" />
            </Field>
            <Field label="Ideal Sale Price">
              <input type="number" step="0.01" value={form.idealPrice} onChange={(e) => setForm({ ...form, idealPrice: e.target.value })} className="input bg-emerald-50/50" />
            </Field>
          </div>
          <div className="mt-3">
            <Field label="Listing Price (defaults to Ideal)">
              <input type="number" step="0.01" value={form.listingPrice} onChange={(e) => setForm({ ...form, listingPrice: e.target.value })} className="input" placeholder="Leave blank to use Ideal" />
            </Field>
          </div>

          {totalInvestment > 0 && (
            <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
              <div className="bg-gray-50 rounded-lg p-2">
                <div className="text-gray-500">Total cost</div>
                <div className="font-semibold text-gray-900">${totalInvestment.toFixed(2)}</div>
              </div>
              <div className="bg-emerald-50 rounded-lg p-2">
                <div className="text-emerald-600">Potential revenue</div>
                <div className="font-semibold text-emerald-900">${totalPotential.toFixed(2)}</div>
              </div>
              <div className="bg-violet-50 rounded-lg p-2">
                <div className="text-violet-600">Projected profit</div>
                <div className="font-semibold text-violet-900">${totalProfit.toFixed(2)}</div>
              </div>
            </div>
          )}
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
          <div className="mt-3">
            <Field label="Image URL">
              <input type="url" value={form.imageUrl} onChange={(e) => setForm({ ...form, imageUrl: e.target.value })} className="input" placeholder="https://..." />
            </Field>
          </div>
          <div className="mt-3">
            <Field label="Notes / Description">
              <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows="2" className="input resize-none" />
            </Field>
          </div>
        </div>

        <div className="flex gap-2 justify-end pt-2 sticky bottom-0 bg-white">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
          <button onClick={handleSubmit} className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg flex items-center gap-1.5">
            <Plus className="w-4 h-4" /> Create {form.quantity || 0} Items
          </button>
        </div>
      </div>
      <style>{`.input{width:100%;padding:.5rem .75rem;border:1px solid #d1d5db;border-radius:.5rem;font-size:.875rem;outline:none;background:white}.input:focus{border-color:#059669;box-shadow:0 0 0 3px rgba(5,150,105,.1)}`}</style>
    </Modal>
  );
}
