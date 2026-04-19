import { useState } from 'react';
import { Modal } from '../ui/Modal.jsx';
import { Field } from '../ui/Field.jsx';

export function SaleFormModal({ onSave, onClose }) {
  const [form, setForm] = useState({
    name: '',
    date: new Date().toISOString().slice(0, 10),
    platform: 'Palmstreet',
    notes: '',
  });
  return (
    <Modal title="New Sale Event" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Event Name *">
          <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input" placeholder="Friday TC Sale" />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Date">
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="input" />
          </Field>
          <Field label="Platform">
            <input type="text" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })} className="input" />
          </Field>
        </div>
        <Field label="Notes">
          <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows="2" className="input resize-none" />
        </Field>
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
          <button onClick={() => form.name && onSave(form)} disabled={!form.name} className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white rounded-lg">Create</button>
        </div>
      </div>
      <style>{`.input{width:100%;padding:.5rem .75rem;border:1px solid #d1d5db;border-radius:.5rem;font-size:.875rem;outline:none;background:white}.input:focus{border-color:#059669;box-shadow:0 0 0 3px rgba(5,150,105,.1)}`}</style>
    </Modal>
  );
}
