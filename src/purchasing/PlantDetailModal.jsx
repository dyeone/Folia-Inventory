import { useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { api } from '../api.js';
import { PhotoGallery } from './PhotoGallery.jsx';

// Edit (or create) a catalog plant. `initial` is null for create mode.
// PhotoGallery mounts in Task 11. onSaved(species) → called with the
// updated/created species row so the parent can refresh its cache.

export function PlantDetailModal({ initial, varieties, onClose, onSaved, showToast }) {
  const isCreate = !initial;
  const [varietyId, setVarietyId] = useState(initial?.varietyId || (varieties?.[0]?.id || ''));
  const [epithet, setEpithet] = useState(initial?.epithet || '');
  const [commonName, setCommonName] = useState(initial?.commonName || '');
  const [wholesalePrice, setWholesalePrice] = useState(
    initial?.wholesalePrice != null ? String(initial.wholesalePrice) : ''
  );
  const [idealSellingPrice, setIdealSellingPrice] = useState(
    initial?.idealSellingPrice != null ? String(initial.idealSellingPrice) : ''
  );
  const [profitRate, setProfitRate] = useState(
    initial?.profitRate != null ? String(initial.profitRate) : ''
  );
  const [notes, setNotes] = useState(initial?.notes || '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setErr('');
    if (!varietyId) { setErr('Variety required'); return; }
    if (!epithet.trim()) { setErr('Name required'); return; }
    setSaving(true);
    try {
      const body = {
        varietyId,
        epithet: epithet.trim(),
        commonName: commonName.trim() || null,
        wholesalePrice: wholesalePrice === '' ? null : parseFloat(wholesalePrice),
        idealSellingPrice: idealSellingPrice === '' ? null : parseFloat(idealSellingPrice),
        notes: notes || null,
      };
      let saved;
      if (isCreate) {
        saved = await api.createSpecies(body);
      } else {
        await api.updateSpecies({
          id: initial.id,
          patch: {
            ...body,
            profitRate: profitRate === '' ? null : parseFloat(profitRate),
          },
        });
        saved = { ...initial, ...body, profitRate: profitRate === '' ? null : parseFloat(profitRate) };
      }
      onSaved?.(saved);
      showToast?.(isCreate ? 'Plant created' : 'Saved', 2000);
      onClose();
    } catch (e) {
      setErr(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-base font-semibold">{isCreate ? 'New plant' : 'Edit plant'}</h2>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-gray-100">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <Field label="Variety">
            <select
              value={varietyId}
              onChange={(e) => setVarietyId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg"
            >
              {(varieties || []).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </Field>
          {!isCreate && (
            <Field label="Photos">
              <PhotoGallery
                speciesId={initial.id}
                photos={initial.photos || []}
                primaryPhotoId={initial.primaryPhotoId}
                onChanged={() => onSaved?.(initial)}
                showToast={showToast}
              />
            </Field>
          )}
          <Field label="Name / epithet">
            <input value={epithet} onChange={(e) => setEpithet(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg" />
          </Field>
          <Field label="Common name">
            <input value={commonName} onChange={(e) => setCommonName(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Wholesale ($)">
              <input type="number" step="0.01" value={wholesalePrice}
                onChange={(e) => setWholesalePrice(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg" />
            </Field>
            <Field label="Ideal sell ($)">
              <input type="number" step="0.01" value={idealSellingPrice}
                onChange={(e) => setIdealSellingPrice(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg" />
            </Field>
          </div>
          {!isCreate && (
            <Field label="Profit rate (%)">
              <input type="number" step="0.1" value={profitRate}
                onChange={(e) => setProfitRate(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg" />
            </Field>
          )}
          <Field label="Notes">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg resize-y" />
          </Field>
          {err && <div className="text-sm text-red-600">{err}</div>}
        </div>

        <div className="px-5 py-3 border-t border-gray-200 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg hover:bg-gray-100">Cancel</button>
          <button onClick={save} disabled={saving}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg disabled:opacity-60">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-wide text-gray-500 font-medium mb-1">{label}</div>
      {children}
    </label>
  );
}
