import { useEffect, useRef, useState } from 'react';
import { Upload, Star, X, Loader2, ImagePlus } from 'lucide-react';
import { api } from '../api.js';

// Photo CRUD widget for a single species. Caller passes the parent
// species (so we can show + edit primaryPhotoId), and onChanged after
// any mutation so the parent can refresh.
//
// Display: signed URLs cached locally for the modal session — each
// photo refetches its URL on mount, then reuses. (Signed URLs are
// 5 minutes; we never live long enough in this modal to hit expiry.)

export function PhotoGallery({ speciesId, photos, primaryPhotoId, onChanged, showToast }) {
  const [busy, setBusy] = useState(false);
  const [urls, setUrls] = useState({}); // photoId → signed URL
  const [draggingId, setDraggingId] = useState(null);
  const fileRef = useRef(null);
  const photoIdsKey = photos.map(p => p.id).join(',');

  useEffect(() => {
    let alive = true;
    (async () => {
      for (const ph of photos) {
        if (!alive) return;
        // Skip if we already have a URL for this id.
        let already = false;
        setUrls(prev => {
          if (prev[ph.id]) { already = true; }
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
  }, [photoIdsKey]);

  const handleUpload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const b64 = await fileToBase64(file);
      const { photo, signedUrl } = await api.uploadSpeciesPhoto({
        speciesId,
        fileBase64: b64,
        contentType: file.type || 'image/jpeg',
        filename: file.name,
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
    const ordered = [...photos];
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

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => handleUpload(e.target.files?.[0])}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-60"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          Upload photo
        </button>
        <div className="text-xs text-gray-500">Drag to reorder · click ★ to set primary</div>
      </div>

      {photos.length === 0 ? (
        <div className="bg-gray-50 border border-dashed border-gray-300 rounded-lg p-6 text-center text-sm text-gray-500">
          <ImagePlus className="w-6 h-6 mx-auto mb-1 text-gray-400" />
          No photos yet.
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {photos.map((ph, idx) => {
            const isPrimary = primaryPhotoId === ph.id || (!primaryPhotoId && idx === 0);
            return (
              <div
                key={ph.id}
                draggable
                onDragStart={() => setDraggingId(ph.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => reorderTo(ph.id)}
                className={`relative aspect-square rounded-lg overflow-hidden border-2 ${
                  isPrimary ? 'border-emerald-500' : 'border-gray-200'
                } ${draggingId === ph.id ? 'opacity-50' : ''}`}
              >
                {urls[ph.id]
                  ? <img src={urls[ph.id]} alt="" className="w-full h-full object-cover" draggable={false} />
                  : <div className="w-full h-full bg-gray-100 flex items-center justify-center">
                      <Loader2 className="w-4 h-4 text-gray-400 animate-spin" />
                    </div>}
                <button
                  type="button"
                  onClick={() => setPrimary(ph.id)}
                  disabled={busy || isPrimary}
                  title={isPrimary ? 'Primary photo' : 'Make primary'}
                  className={`absolute top-1 left-1 p-1 rounded-full bg-white/90 hover:bg-white ${isPrimary ? 'text-emerald-600' : 'text-gray-400'}`}
                >
                  <Star className="w-3.5 h-3.5" fill={isPrimary ? 'currentColor' : 'none'} />
                </button>
                <button
                  type="button"
                  onClick={() => remove(ph.id)}
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
