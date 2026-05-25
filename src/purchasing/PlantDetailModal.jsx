import { useEffect, useMemo, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { api } from '../api.js';
import { PhotoGallery } from './PhotoGallery.jsx';
import { ParentPhotoSlot } from './ParentPhotoSlot.jsx';

// Edit (or create) a catalog plant. Photo support spans both modes:
//   - edit mode:   PhotoGallery + parent slots upload directly via the API
//   - create mode: files are staged client-side; after Save creates the
//                  species, each staged file is uploaded with its kind.
//
// onSaved(species) → called with the updated/created species row so the
// parent can refresh its cache.

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

  // Staged uploads — only used in create mode. Each gallery item gets
  // a temp local id for keying + remove. Mother/father are single slots.
  const [stagedGallery, setStagedGallery] = useState([]); // [{ id, previewUrl, file }]
  const [stagedMother, setStagedMother]   = useState(null); // { previewUrl, file } | null
  const [stagedFather, setStagedFather]   = useState(null);

  // Revoke object URLs on unmount / when the staged file changes, so we
  // don't leak Blob memory if the user adds + removes many photos.
  useEffect(() => () => {
    for (const g of stagedGallery) URL.revokeObjectURL(g.previewUrl);
    if (stagedMother?.previewUrl) URL.revokeObjectURL(stagedMother.previewUrl);
    if (stagedFather?.previewUrl) URL.revokeObjectURL(stagedFather.previewUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Anthurium check — drives whether the parent-photo slots render.
  // String compare (case-insensitive) so a misspelled-but-close variety
  // name still works without a config flag.
  const selectedVarietyName = useMemo(() => {
    return (varieties || []).find(v => v.id === varietyId)?.name || '';
  }, [varieties, varietyId]);
  const isAnthurium = selectedVarietyName.toLowerCase() === 'anthurium';

  const stageGallery = (file) => {
    const previewUrl = URL.createObjectURL(file);
    const id = `staged-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setStagedGallery(prev => [...prev, { id, previewUrl, file }]);
  };
  const removeStagedGallery = (id) => {
    setStagedGallery(prev => {
      const dropped = prev.find(g => g.id === id);
      if (dropped) URL.revokeObjectURL(dropped.previewUrl);
      return prev.filter(g => g.id !== id);
    });
  };
  const stageParent = (which, file) => {
    const previewUrl = URL.createObjectURL(file);
    const setter = which === 'mother' ? setStagedMother : setStagedFather;
    setter(prev => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
      return { previewUrl, file };
    });
  };
  const clearStagedParent = (which) => {
    const setter = which === 'mother' ? setStagedMother : setStagedFather;
    setter(prev => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
  };

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
        // Flush staged photos. Per-file errors surface as toasts but
        // don't block — the species exists and the user can retry from
        // edit mode if a single upload failed.
        const uploads = [];
        for (const g of stagedGallery) {
          uploads.push(uploadStaged(saved.id, g.file, 'gallery'));
        }
        if (isAnthurium && stagedMother) uploads.push(uploadStaged(saved.id, stagedMother.file, 'mother'));
        if (isAnthurium && stagedFather) uploads.push(uploadStaged(saved.id, stagedFather.file, 'father'));
        const results = await Promise.allSettled(uploads);
        const failed = results.filter(r => r.status === 'rejected').length;
        if (failed > 0) {
          showToast?.(`Plant created, but ${failed} photo${failed === 1 ? '' : 's'} failed to upload`, 4000);
        }
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

  // Pre-filter photos to the relevant kinds for the live-mode widgets.
  const galleryPhotos = (initial?.photos || []).filter(p => (p.kind || 'gallery') === 'gallery');
  const parentPhotos  = (initial?.photos || []).filter(p => p.kind === 'mother' || p.kind === 'father');

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

          <Field label="Photos">
            <PhotoGallery
              speciesId={isCreate ? null : initial.id}
              photos={galleryPhotos}
              primaryPhotoId={initial?.primaryPhotoId}
              onChanged={() => onSaved?.(initial)}
              showToast={showToast}
              staged={isCreate ? stagedGallery : undefined}
              onStaged={isCreate ? stageGallery : undefined}
              onClearStaged={isCreate ? removeStagedGallery : undefined}
            />
          </Field>

          {isAnthurium && (
            <div className="grid grid-cols-2 gap-3">
              <ParentPhotoSlot
                kind="mother"
                label="Mother plant"
                speciesId={isCreate ? null : initial.id}
                photos={parentPhotos}
                showToast={showToast}
                onChanged={() => onSaved?.(initial)}
                stagedPreviewUrl={isCreate ? stagedMother?.previewUrl : null}
                onStaged={isCreate ? ((f) => stageParent('mother', f)) : undefined}
                onClearStaged={isCreate ? (() => clearStagedParent('mother')) : undefined}
              />
              <ParentPhotoSlot
                kind="father"
                label="Father plant"
                speciesId={isCreate ? null : initial.id}
                photos={parentPhotos}
                showToast={showToast}
                onChanged={() => onSaved?.(initial)}
                stagedPreviewUrl={isCreate ? stagedFather?.previewUrl : null}
                onStaged={isCreate ? ((f) => stageParent('father', f)) : undefined}
                onClearStaged={isCreate ? (() => clearStagedParent('father')) : undefined}
              />
            </div>
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

async function uploadStaged(speciesId, file, kind) {
  const fileBase64 = await fileToBase64(file);
  await api.uploadSpeciesPhoto({
    speciesId,
    fileBase64,
    contentType: file.type || 'image/jpeg',
    filename: file.name,
    kind,
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload  = () => {
      const r = String(reader.result || '');
      const comma = r.indexOf(',');
      resolve(comma >= 0 ? r.slice(comma + 1) : r);
    };
    reader.readAsDataURL(file);
  });
}

function Field({ label, children }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-wide text-gray-500 font-medium mb-1">{label}</div>
      {children}
    </label>
  );
}
