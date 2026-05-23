import { useEffect, useState } from 'react';
import { X, Loader2, ImagePlus } from 'lucide-react';
import { api } from '../api.js';
import { ImageDropZone } from './ImageDropZone.jsx';

// Single-photo slot for a mother or father plant on an Anthurium
// catalog entry. Uploading replaces any existing photo of the same
// kind (the API enforces single-slot semantics — see species-photos.js).
//
// Two modes:
//   - speciesId present       → live mode: upload immediately on file pick
//   - onStaged + stagedPreview → staged mode: caller stores the file
//                                client-side (used during catalog "create")
//
// kind: 'mother' | 'father' — drives the label, the upload's kind param,
// and which photos[] entry to display.

export function ParentPhotoSlot({
  kind,
  label,
  speciesId,
  photos,              // species.photos (filtered to this kind, optional in staged mode)
  pasteScope,
  showToast,
  onChanged,           // live mode — called after a successful mutation
  stagedPreviewUrl,    // staged mode — local preview to render
  onStaged,            // staged mode — caller wires this to handle a File
  onClearStaged,       // staged mode — caller wires this to clear the staged file
}) {
  const existing = (photos || []).find(p => p.kind === kind) || null;
  const existingId = existing?.id || null;
  // Track URL alongside the photo id it was fetched for, so we can
  // derive a "current" URL at render time without a sync setState in
  // the effect when the photo changes or is removed.
  const [urlByPhotoId, setUrlByPhotoId] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!existingId) return undefined;
    let alive = true;
    api.speciesPhotoSignedUrl(existingId)
      .then(url => { if (alive) setUrlByPhotoId({ id: existingId, url }); })
      .catch(() => {});
    return () => { alive = false; };
  }, [existingId]);

  const signedUrl = (urlByPhotoId && urlByPhotoId.id === existingId) ? urlByPhotoId.url : null;

  // Live mode upload — caller doesn't need to know how.
  const liveUpload = async (file) => {
    if (!speciesId) return;
    setBusy(true);
    try {
      const fileBase64 = await fileToBase64(file);
      await api.uploadSpeciesPhoto({
        speciesId,
        fileBase64,
        contentType: file.type || 'image/jpeg',
        filename: file.name,
        kind,
      });
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Upload failed', 3000);
    } finally {
      setBusy(false);
    }
  };

  const liveDelete = async () => {
    if (!existing) return;
    setBusy(true);
    try {
      await api.deleteSpeciesPhoto(existing.id);
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Delete failed', 3000);
    } finally {
      setBusy(false);
    }
  };

  const stagedMode = !speciesId;
  const previewUrl = stagedMode ? stagedPreviewUrl : signedUrl;

  // Renders the inner content of the dropzone, switching between
  // "empty" prompt and "filled with preview" states.
  const inner = previewUrl ? (
    <div className="relative aspect-video">
      <img src={previewUrl} alt={label} className="w-full h-full object-cover rounded-md" />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (stagedMode) onClearStaged?.();
          else liveDelete();
        }}
        disabled={busy}
        title="Remove"
        className="absolute top-1 right-1 p-1 rounded-full bg-white/90 hover:bg-red-50 text-red-600"
      >
        <X className="w-3.5 h-3.5" />
      </button>
      {busy && (
        <div className="absolute inset-0 bg-white/60 flex items-center justify-center">
          <Loader2 className="w-5 h-5 text-emerald-600 animate-spin" />
        </div>
      )}
    </div>
  ) : (
    <div className="p-4 text-center text-xs text-gray-500 space-y-1">
      <ImagePlus className="w-5 h-5 mx-auto text-gray-400" />
      <div>No {label.toLowerCase()} photo yet</div>
      <div className="text-[10px] text-gray-400">Click, drag, or paste</div>
    </div>
  );

  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500 font-medium mb-1">{label}</div>
      <ImageDropZone
        onFile={(f) => (stagedMode ? onStaged?.(f) : liveUpload(f))}
        multiple={false}
        disabled={busy}
        pasteScope={pasteScope}
      >
        {inner}
      </ImageDropZone>
    </div>
  );
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
