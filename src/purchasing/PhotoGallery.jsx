import { useEffect, useState } from 'react';
import { Star, X, Loader2 } from 'lucide-react';
import { api } from '../api.js';
import { ImageDropZone } from './ImageDropZone.jsx';

// Photo CRUD widget for the catalog gallery (kind='gallery' photos).
// Caller passes the parent species (so we can show + edit
// primaryPhotoId), and onChanged after any mutation so the parent can
// refresh. Mother/father parent slots live in <ParentPhotoSlot /> —
// distinct kind, distinct widget.
//
// Two modes:
//   - speciesId present → live mode: upload immediately on file pick
//   - staged prop set   → staged mode: caller stores files client-side
//                         (used during catalog "create")
//
// Live-mode signed URLs cached locally for the modal session — fetched
// once per photo id, reused. (Signed URLs are 5 minutes; this modal
// never lives that long.)

export function PhotoGallery({
  speciesId,
  photos,                  // gallery photos for this species (kind='gallery')
  primaryPhotoId,
  onChanged,
  showToast,
  // Staged-mode props (used while creating the species). The gallery
  // becomes a write-only preview surface: existing 'photos' is empty,
  // and the dropzone forwards each file to onStaged.
  staged,                  // [{ id, previewUrl, file }] | undefined
  onStaged,                // (file) → void — caller stages
  onClearStaged,           // (id) → void — caller drops a staged item
}) {
  const stagedMode = !speciesId;
  const [busy, setBusy] = useState(false);
  const [urls, setUrls] = useState({}); // photoId → signed URL
  const [draggingId, setDraggingId] = useState(null);
  const photoIdsKey = (photos || []).map(p => p.id).join(',');

  useEffect(() => {
    if (stagedMode || !photos || photos.length === 0) return undefined;
    let alive = true;
    (async () => {
      for (const ph of photos) {
        if (!alive) return;
        // Skip if a URL already exists for this photo id.
        let already = false;
        setUrls(prev => {
          if (prev[ph.id]) already = true;
          return prev;
        });
        if (already) continue;
        try {
          const url = await api.speciesPhotoSignedUrl(ph.id);
          if (alive) setUrls(prev => ({ ...prev, [ph.id]: url }));
        } catch { /* skip */ }
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoIdsKey, stagedMode]);

  const liveUpload = async (file) => {
    if (!speciesId) return;
    setBusy(true);
    try {
      const b64 = await fileToBase64(file);
      const { photo, signedUrl } = await api.uploadSpeciesPhoto({
        speciesId,
        fileBase64: b64,
        contentType: file.type || 'image/jpeg',
        filename: file.name,
        kind: 'gallery',
      });
      if (signedUrl) setUrls(u => ({ ...u, [photo.id]: signedUrl }));
      onChanged?.();
      showToast?.('Photo uploaded', 1800);
    } catch (e) {
      showToast?.(e.message || 'Upload failed', 3000);
    } finally {
      setBusy(false);
    }
  };

  const setPrimary = async (id) => {
    setBusy(true);
    try {
      await api.updateSpecies({ id: speciesId, patch: { primaryPhotoId: id } });
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Set primary failed', 3000);
    } finally { setBusy(false); }
  };

  const remove = async (id) => {
    setBusy(true);
    try {
      await api.deleteSpeciesPhoto(id);
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Delete failed', 3000);
    } finally { setBusy(false); }
  };

  const reorderTo = async (dropTargetId) => {
    if (!draggingId || draggingId === dropTargetId) return;
    const ordered = [...(photos || [])];
    const fromIdx = ordered.findIndex(p => p.id === draggingId);
    const toIdx   = ordered.findIndex(p => p.id === dropTargetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = ordered.splice(fromIdx, 1);
    ordered.splice(toIdx, 0, moved);
    setDraggingId(null);
    setBusy(true);
    try {
      await api.reorderSpeciesPhotos({ speciesId, orderedPhotoIds: ordered.map(p => p.id) });
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Reorder failed', 3000);
    } finally { setBusy(false); }
  };

  // In staged mode we render the staged previews; in live mode, the photos prop.
  const visible = stagedMode
    ? (staged || []).map(s => ({ id: s.id, previewUrl: s.previewUrl, staged: true }))
    : (photos || []).map(p => ({ id: p.id, previewUrl: urls[p.id], staged: false }));

  return (
    <div className="space-y-2">
      <ImageDropZone
        onFile={(f) => (stagedMode ? onStaged?.(f) : liveUpload(f))}
        disabled={busy}
      />
      {visible.length === 0 ? null : (
        <div className="grid grid-cols-3 gap-2">
          {visible.map((ph, idx) => {
            // Primary star is only meaningful in live mode (server-side state).
            const isPrimary = !stagedMode && (primaryPhotoId === ph.id || (!primaryPhotoId && idx === 0));
            const draggable = !stagedMode;
            return (
              <div
                key={ph.id}
                draggable={draggable}
                onDragStart={() => draggable && setDraggingId(ph.id)}
                onDragOver={(e) => draggable && e.preventDefault()}
                onDrop={() => draggable && reorderTo(ph.id)}
                className={`relative aspect-square rounded-lg overflow-hidden border-2 ${
                  isPrimary ? 'border-emerald-500' : 'border-gray-200'
                } ${draggingId === ph.id ? 'opacity-50' : ''}`}
              >
                {ph.previewUrl
                  ? <img src={ph.previewUrl} alt="" className="w-full h-full object-cover" draggable={false} />
                  : <div className="w-full h-full bg-gray-100 flex items-center justify-center">
                      <Loader2 className="w-4 h-4 text-gray-400 animate-spin" />
                    </div>}
                {!stagedMode && (
                  <button
                    type="button"
                    onClick={() => setPrimary(ph.id)}
                    disabled={busy || isPrimary}
                    title={isPrimary ? 'Primary photo' : 'Make primary'}
                    className={`absolute top-1 left-1 p-1 rounded-full bg-white/90 hover:bg-white ${isPrimary ? 'text-emerald-600' : 'text-gray-400'}`}
                  >
                    <Star className="w-3.5 h-3.5" fill={isPrimary ? 'currentColor' : 'none'} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => (stagedMode ? onClearStaged?.(ph.id) : remove(ph.id))}
                  disabled={busy}
                  className="absolute top-1 right-1 p-1 rounded-full bg-white/90 hover:bg-red-50 text-red-600"
                  title="Delete"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
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
