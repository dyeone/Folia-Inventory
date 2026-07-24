import { useState } from 'react';
import { Modal } from '../ui/Modal.jsx';
import { Field } from '../ui/Field.jsx';

// Combine the date + HH:MM strings into an ISO timestamp (local time).
// Returns null if either input is empty.
function toIsoLocal(date, time) {
  if (!date) return null;
  const t = time || '00:00';
  const d = new Date(`${date}T${t}`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function SaleFormModal({ initial, onSave, onClose, isBae }) {
  const isEdit = Boolean(initial?.id);
  // BAE sells finished plants only (no tissue culture), so its events default to
  // plants-only and hide the TC toggles.
  const itemTypeOptions = isBae
    ? [{ v: 'plant', label: 'Plants only' }]
    : [
        { v: 'tc', label: 'TC only' },
        { v: 'plant', label: 'Plants only' },
        { v: 'both', label: 'TC + Plants' },
      ];
  // LOCAL calendar day, never toISOString: a 7pm PT sale is the NEXT day in
  // UTC, so the ISO slice advanced the date one day on every edit. sale.date
  // now decides the week's lot block (src/sales/lotBlock.js), so that drift
  // would shift a sale into the wrong 200-number range.
  const localYmd = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const initialDate = initial?.startTime
    ? localYmd(new Date(initial.startTime))
    : (initial?.date || localYmd(new Date()));
  const initialTime = initial?.startTime
    ? new Date(initial.startTime).toTimeString().slice(0, 5)
    : '19:00';

  const [form, setForm] = useState({
    name: initial?.name || '',
    date: initialDate,
    startTimeHm: initialTime,
    durationMinutes: initial?.durationMinutes ?? 60,
    itemTypes: initial?.itemTypes || (isBae ? 'plant' : 'both'),
    platform: initial?.platform || 'Palmstreet',
    notes: initial?.notes || '',
  });

  const handleSave = () => {
    if (!form.name.trim()) return;
    const startTime = toIsoLocal(form.date, form.startTimeHm);
    onSave({
      ...(initial?.id ? { id: initial.id } : {}),
      name: form.name.trim(),
      date: form.date,
      startTime,
      durationMinutes: parseInt(form.durationMinutes, 10) || null,
      itemTypes: form.itemTypes,
      platform: form.platform,
      notes: form.notes,
      ...(isEdit ? {} : { status: 'ongoing' }),
    });
  };

  return (
    <Modal title={isEdit ? 'Edit Sale Event' : 'New Sale Event'} onClose={onClose} size="lg">
      <div className="space-y-4">
        <Field label="Event Name *">
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="input text-base"
            placeholder="Friday Aurea Drop"
            autoFocus
          />
        </Field>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Field label="Date">
            <input
              type="date"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              className="input"
            />
          </Field>
          <Field label="Start time">
            <input
              type="time"
              value={form.startTimeHm}
              onChange={(e) => setForm({ ...form, startTimeHm: e.target.value })}
              className="input"
            />
          </Field>
          <Field label="Length (min)">
            <input
              type="number"
              min="0"
              step="15"
              value={form.durationMinutes}
              onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })}
              className="input"
            />
          </Field>
        </div>
        <Field label="Item types">
          <div className="flex gap-1 bg-gray-100 p-1 rounded-lg">
            {itemTypeOptions.map(opt => (
              <button
                key={opt.v}
                type="button"
                onClick={() => setForm({ ...form, itemTypes: opt.v })}
                className={`flex-1 px-3 py-2 text-sm font-medium rounded-md transition ${
                  form.itemTypes === opt.v
                    ? 'bg-white text-emerald-700 shadow-sm'
                    : 'text-gray-600 active:bg-gray-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Platform">
          <input
            type="text"
            value={form.platform}
            onChange={(e) => setForm({ ...form, platform: e.target.value })}
            className="input"
          />
        </Field>
        <Field label="Notes">
          <textarea
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            rows="2"
            className="input resize-none"
          />
        </Field>
        <div className="flex gap-2 justify-end pt-3">
          <button onClick={onClose} className="px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-100 active:bg-gray-200 rounded-lg">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!form.name.trim()}
            className="px-5 py-2.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 disabled:bg-gray-300 text-white rounded-lg"
          >
            {isEdit ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
