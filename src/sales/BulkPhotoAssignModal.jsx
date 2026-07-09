import { useEffect, useRef, useState } from 'react';
import { Images, ArrowDownUp, Upload, X, ImagePlus, Loader2, AlertTriangle } from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';
import { api } from '../api.js';

// Bulk-assign a batch of photos to the staged listings in the fixed lineup
// order. Each photo maps to one listing by position: photo #k → lineup plant #k.
// A "Reverse" toggle flips the whole batch (for when you shot the row
// back-to-front), and any single photo can be dragged to a different plant.
// On confirm, each photo uploads to its plant via the existing item-photo API.

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const r = String(reader.result || '');
      const comma = r.indexOf(',');
      resolve(comma >= 0 ? r.slice(comma + 1) : r);
    };
    reader.readAsDataURL(file);
  });
}

let PHOTO_SEQ = 0;

export function BulkPhotoAssignModal({ sale, orderedItems = [], onUploaded, showToast, onClose }) {
  // Working order of the photos. Position i pairs with orderedItems[i].
  const [photos, setPhotos] = useState([]);
  const [dragIdx, setDragIdx] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const fileRef = useRef(null);

  // Revoke object URLs on unmount (ref so the cleanup sees the latest list).
  const photosRef = useRef(photos);
  useEffect(() => { photosRef.current = photos; }, [photos]);
  useEffect(() => () => photosRef.current.forEach(p => URL.revokeObjectURL(p.url)), []);

  const addFiles = (fileList) => {
    const imgs = Array.from(fileList || []).filter(f => f.type?.startsWith('image/'));
    if (!imgs.length) return;
    // Sort by filename (numeric-aware) so IMG_001..IMG_012 line up in order.
    imgs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const added = imgs.map(f => ({ id: `p${PHOTO_SEQ++}`, file: f, url: URL.createObjectURL(f), name: f.name }));
    setPhotos(prev => [...prev, ...added]);
  };

  const reverse = () => setPhotos(p => [...p].reverse());
  const movePhoto = (from, to) => setPhotos(p => {
    if (from == null || to == null || from === to || from < 0) return p;
    const next = [...p];
    const [moved] = next.splice(from, 1);
    next.splice(Math.min(to, next.length), 0, moved);
    return next;
  });
  const removePhoto = (idx) => setPhotos(p => {
    const next = [...p];
    const [x] = next.splice(idx, 1);
    if (x) URL.revokeObjectURL(x.url);
    return next;
  });

  const pairedCount = orderedItems.filter((_, i) => photos[i]).length;
  const extraPhotos = Math.max(0, photos.length - orderedItems.length);
  const rowCount = Math.max(orderedItems.length, photos.length);

  const doUpload = async () => {
    const pairs = orderedItems.map((it, i) => ({ it, photo: photos[i] })).filter(p => p.photo);
    if (!pairs.length) return;
    setUploading(true);
    setProgress(0);
    let done = 0, failed = 0;
    for (const { it, photo } of pairs) {
      try {
        const fileBase64 = await fileToBase64(photo.file);
        await api.uploadItemPhoto({
          itemId: it.id,
          fileBase64,
          contentType: photo.file.type || 'image/jpeg',
          filename: photo.file.name,
        });
      } catch {
        failed += 1;
      }
      done += 1;
      setProgress(done);
    }
    setUploading(false);
    try { await onUploaded?.(); } catch { /* refresh best-effort */ }
    if (failed) showToast?.(`Uploaded ${pairs.length - failed}/${pairs.length} photos · ${failed} failed`, 'error');
    else showToast?.(`Uploaded ${pairs.length} photo${pairs.length === 1 ? '' : 's'}`);
    onClose();
  };

  return (
    <Modal title={`Assign photos · ${sale?.name || ''}`} onClose={uploading ? () => {} : onClose} size="xl">
      <div className="space-y-3">
        <div className="flex items-start gap-2 text-xs text-gray-500 bg-sky-50/70 rounded-lg px-3 py-2">
          <Images className="w-4 h-4 text-sky-600 flex-shrink-0 mt-0.5" />
          Each photo maps to one listing in lineup order (photo #1 → plant #1). Use <b className="mx-1 font-semibold">Reverse</b>
          if you shot the row back-to-front, or drag a photo onto a different plant.
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-sky-600 hover:bg-sky-700 text-white disabled:bg-gray-300"
          >
            <ImagePlus className="w-4 h-4" /> Add photos
          </button>
          <input
            ref={fileRef} type="file" accept="image/*" multiple className="hidden"
            onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
          />
          <button
            onClick={reverse}
            disabled={uploading || photos.length < 2}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            <ArrowDownUp className="w-4 h-4" /> Reverse
          </button>
          <span className="text-xs text-gray-500 ml-auto">
            {photos.length} photo{photos.length === 1 ? '' : 's'} · {orderedItems.length} listing{orderedItems.length === 1 ? '' : 's'}
          </span>
        </div>

        {(photos.length > orderedItems.length || (photos.length > 0 && photos.length < orderedItems.length)) && (
          <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            {extraPhotos > 0
              ? `${extraPhotos} extra photo${extraPhotos === 1 ? '' : 's'} won't be assigned (more photos than listings).`
              : `${orderedItems.length - photos.length} listing${orderedItems.length - photos.length === 1 ? '' : 's'} will have no photo.`}
          </div>
        )}

        {/* Drop area when empty */}
        {photos.length === 0 && (
          <div
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
            onClick={() => fileRef.current?.click()}
            className="border-2 border-dashed border-gray-300 rounded-xl py-10 text-center text-sm text-gray-500 cursor-pointer hover:border-sky-400 hover:bg-sky-50/40"
          >
            <ImagePlus className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            Drop photos here or click to choose — they'll line up with the plants below.
          </div>
        )}

        {/* Paired rows: plant (fixed order) ← photo (draggable) */}
        {photos.length > 0 && (
          <div className="max-h-[52vh] overflow-y-auto divide-y divide-gray-100 border border-gray-200 rounded-xl">
            {Array.from({ length: rowCount }).map((_, i) => {
              const it = orderedItems[i];
              const photo = photos[i];
              return (
                <div
                  key={it?.id || `empty-${i}`}
                  onDragOver={(e) => { if (dragIdx != null) e.preventDefault(); }}
                  onDrop={(e) => { e.preventDefault(); movePhoto(dragIdx, i); setDragIdx(null); }}
                  className="flex items-center gap-3 px-3 py-2"
                >
                  <span className="w-6 text-center text-base font-bold text-gray-800 tabular-nums flex-shrink-0">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    {it ? (
                      <>
                        <div className="text-sm font-medium text-gray-900 truncate">{it.name || it.sku}</div>
                        <div className="text-xs text-gray-500 font-mono">{it.sku}</div>
                      </>
                    ) : (
                      <div className="text-xs text-gray-400 italic">no listing at this position</div>
                    )}
                  </div>
                  {photo ? (
                    <div
                      draggable={!uploading}
                      onDragStart={() => setDragIdx(i)}
                      onDragEnd={() => setDragIdx(null)}
                      className={`relative flex-shrink-0 ${uploading ? '' : 'cursor-grab active:cursor-grabbing'} ${dragIdx === i ? 'opacity-40' : ''}`}
                      title="Drag to a different plant"
                    >
                      <img src={photo.url} alt={photo.name} className="w-14 h-14 object-cover rounded-lg border border-gray-200" />
                      {!uploading && (
                        <button
                          onClick={() => removePhoto(i)}
                          className="absolute -top-1.5 -right-1.5 bg-white border border-gray-300 rounded-full p-0.5 text-gray-500 hover:text-red-600 shadow-sm"
                          title="Remove photo"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="w-14 h-14 rounded-lg border-2 border-dashed border-gray-200 flex-shrink-0" />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-sm text-gray-500">
            {uploading ? `Uploading ${progress}/${pairedCount}…` : `${pairedCount} photo${pairedCount === 1 ? '' : 's'} will be assigned`}
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} disabled={uploading} className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-40">
              Cancel
            </button>
            <button
              onClick={doUpload}
              disabled={uploading || pairedCount === 0}
              className="flex items-center gap-1.5 px-5 py-2 text-sm font-medium bg-sky-600 hover:bg-sky-700 active:bg-sky-800 text-white rounded-lg disabled:bg-gray-300"
            >
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} Assign {pairedCount || ''} photo{pairedCount === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
