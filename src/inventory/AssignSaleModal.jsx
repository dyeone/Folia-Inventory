import { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';
import { Field } from '../ui/Field.jsx';

export function AssignSaleModal({ item, sales, items, onAssign, onClose }) {
  const [saleId, setSaleId] = useState('');
  const [lotNumber, setLotNumber] = useState('');
  const [err, setErr] = useState('');

  const submit = () => {
    if (!saleId) return setErr('Pick a sale event');
    if (lotNumber) {
      const dup = items.find(i => i.id !== item.id && i.saleId === saleId && i.lotNumber === lotNumber);
      if (dup) return setErr(`Lot #${lotNumber} is already used by ${dup.sku}`);
    }
    onAssign(saleId, lotNumber || null);
  };

  return (
    <Modal title={`Assign ${item.sku} to Sale`} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Sale Event">
          {sales.length === 0 ? (
            <div className="text-xs text-gray-500 p-3 bg-gray-50 rounded-lg">No sale events yet. Create one first.</div>
          ) : (
            <select value={saleId} onChange={(e) => setSaleId(e.target.value)} className="input">
              <option value="">-- Pick sale --</option>
              {sales.map(s => <option key={s.id} value={s.id}>{s.name} ({s.date})</option>)}
            </select>
          )}
        </Field>
        <Field label="Lot Number (optional)">
          <input type="text" value={lotNumber} onChange={(e) => setLotNumber(e.target.value)} className="input" placeholder="e.g. 12" />
        </Field>
        {err && (
          <div className="flex items-center gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
            <AlertCircle className="w-4 h-4" /> {err}
          </div>
        )}
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
          <button onClick={submit} className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg">Assign</button>
        </div>
      </div>
      <style>{`.input{width:100%;padding:.5rem .75rem;border:1px solid #d1d5db;border-radius:.5rem;font-size:.875rem;outline:none;background:white}.input:focus{border-color:#059669;box-shadow:0 0 0 3px rgba(5,150,105,.1)}`}</style>
    </Modal>
  );
}
