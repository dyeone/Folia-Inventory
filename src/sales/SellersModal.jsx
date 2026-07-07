import { useState } from 'react';
import { AlertCircle, Plus, Pencil, Trash2, Loader2, UserPlus } from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';
import { Field } from '../ui/Field.jsx';
import { api } from '../api.js';

// Brand-level CRUD for consignment sellers. A seller is reusable across sale
// events; `code` is the SKU prefix segment (SKUs become <CODE>-<VARIETY>-<n>),
// so it's validated to 2–8 letters and kept unique per brand (server enforces).

const EMPTY = { id: null, name: '', code: '', defaultCommissionPct: '', username: '', contact: '' };

export function SellersModal({ sellers = [], isAdmin, onChanged, onClose, showToast }) {
  const [form, setForm] = useState(EMPTY);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const isEdit = !!form.id;

  const startNew = () => { setForm(EMPTY); setErr(''); };
  const startEdit = (s) => {
    setErr('');
    setForm({
      id: s.id,
      name: s.name || '',
      code: s.code || '',
      defaultCommissionPct: s.defaultCommissionPct ?? '',
      username: s.username || '',
      contact: s.contact || '',
    });
  };

  const save = async () => {
    setErr('');
    const name = form.name.trim();
    const code = form.code.trim().toUpperCase();
    if (!name) return setErr('Seller name is required');
    if (!/^[A-Z]{2,8}$/.test(code)) return setErr('Code must be 2–8 letters (used as the SKU prefix)');
    setBusy(true);
    try {
      await api.upsertSeller({
        id: form.id || undefined,
        name,
        code,
        defaultCommissionPct: form.defaultCommissionPct,
        username: form.username.trim() || null,
        contact: form.contact.trim() || null,
      });
      await onChanged?.();
      showToast?.(isEdit ? 'Seller updated' : 'Seller added');
      startNew();
    } catch (e) {
      setErr(e.message || 'Could not save seller');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s) => {
    setErr('');
    setBusy(true);
    try {
      await api.deleteSeller(s.id);
      await onChanged?.();
      showToast?.('Seller deleted');
      if (form.id === s.id) startNew();
    } catch (e) {
      // 409 when the seller still has inventory — surface it inline.
      setErr(e.message || 'Could not delete seller');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Consignment sellers" onClose={onClose} size="lg">
      <div className="space-y-4">
        {err && (
          <div className="flex items-center gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
            <AlertCircle className="w-4 h-4 flex-shrink-0" /> {err}
          </div>
        )}

        {/* Add / edit form */}
        <div className="border border-gray-200 rounded-xl p-3 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-800">
            <UserPlus className="w-4 h-4 text-emerald-600" />
            {isEdit ? `Edit ${form.name || 'seller'}` : 'Add a seller'}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Name *">
              <input
                type="text" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="input" placeholder="Jade" autoFocus
              />
            </Field>
            <Field label="Code * (SKU prefix, 2–8 letters)">
              <input
                type="text" value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                className="input font-mono uppercase" placeholder="JADE" maxLength={8}
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Default commission % (we keep)">
              <input
                type="number" step="1" min="0" max="100" value={form.defaultCommissionPct}
                onChange={(e) => setForm({ ...form, defaultCommissionPct: e.target.value })}
                className="input" placeholder="30"
              />
            </Field>
            <Field label="@username">
              <input
                type="text" value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                className="input" placeholder="optional"
              />
            </Field>
            <Field label="Contact">
              <input
                type="text" value={form.contact}
                onChange={(e) => setForm({ ...form, contact: e.target.value })}
                className="input" placeholder="phone / email"
              />
            </Field>
          </div>
          <div className="flex items-center gap-2 justify-end">
            {isEdit && (
              <button onClick={startNew} disabled={busy} className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg">
                Cancel
              </button>
            )}
            <button
              onClick={save} disabled={busy}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white rounded-lg disabled:bg-gray-300"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              {isEdit ? 'Save' : 'Add seller'}
            </button>
          </div>
        </div>

        {/* Existing sellers */}
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Sellers ({sellers.length})
          </div>
          {sellers.length === 0 ? (
            <p className="text-sm text-gray-500 py-6 text-center">No sellers yet. Add one above.</p>
          ) : (
            <ul className="divide-y divide-gray-100 border border-gray-200 rounded-xl overflow-hidden">
              {sellers.map(s => (
                <li key={s.id} className="flex items-center gap-3 px-3 py-2.5">
                  <span className="font-mono text-xs font-bold text-emerald-700 bg-emerald-50 rounded px-1.5 py-0.5 flex-shrink-0">
                    {s.code}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-gray-900 truncate">
                      {s.name}
                      {s.username ? <span className="text-gray-400 font-normal"> · @{s.username}</span> : null}
                    </span>
                    <span className="block text-xs text-gray-500">
                      {s.defaultCommissionPct != null ? `${s.defaultCommissionPct}% commission` : 'no default %'}
                      {s.contact ? ` · ${s.contact}` : ''}
                    </span>
                  </span>
                  <button
                    onClick={() => startEdit(s)} disabled={busy}
                    className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-50"
                    title="Edit"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  {isAdmin && (
                    <button
                      onClick={() => remove(s)} disabled={busy}
                      className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg disabled:opacity-50"
                      title="Delete (admin only)"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
