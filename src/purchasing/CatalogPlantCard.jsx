import { ImageOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Read-only card. The "+ Add to draft" button wires in Task 12.
// Photo display: fetches a signed URL on mount for the primary photo
// (or the first by sortOrder if no primary set, or falls back to the
// legacy species.imageUrl).
export function CatalogPlantCard({ plant, onOpenDetail, onAddToDraft, adding }) {
  const primaryPhotoId = (() => {
    if (!plant.photos || plant.photos.length === 0) return null;
    if (plant.primaryPhotoId && plant.photos.find(p => p.id === plant.primaryPhotoId)) {
      return plant.primaryPhotoId;
    }
    return plant.photos[0]?.id || null;
  })();

  const [signedUrl, setSignedUrl] = useState(null);
  useEffect(() => {
    if (!primaryPhotoId) return undefined;
    let alive = true;
    api.speciesPhotoSignedUrl(primaryPhotoId)
      .then(url => { if (alive) setSignedUrl(url); })
      .catch(() => {});
    return () => { alive = false; };
  }, [primaryPhotoId]);

  const imgUrl = primaryPhotoId ? signedUrl : (plant.imageUrl || null);

  const ws = plant.wholesalePrice;
  const ideal = plant.idealSellingPrice;
  const margin = (Number.isFinite(ws) && ws > 0 && Number.isFinite(ideal))
    ? ((ideal - ws) / ws) * 100
    : null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 hover:border-emerald-400 overflow-hidden transition flex flex-col">
      <button
        type="button"
        onClick={onOpenDetail}
        className="block text-left"
      >
        <div className="aspect-square bg-gray-100 flex items-center justify-center text-gray-300">
          {imgUrl
            ? <img src={imgUrl} alt={plant.epithet} className="w-full h-full object-cover" />
            : <ImageOff className="w-8 h-8" />}
        </div>
        <div className="p-3 space-y-2">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-gray-500 font-medium truncate">
              {plant.varietyName || ''}
            </div>
            <div className="font-semibold text-sm text-gray-900 leading-tight truncate">
              {plant.epithet}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-1 text-[11px]">
            <Stat label="Wholesale" value={fmt$(ws)} />
            <Stat label="Ideal"     value={fmt$(ideal)} />
            <Stat label="Margin"    value={margin != null ? `${margin.toFixed(0)}%` : '—'} />
          </div>
        </div>
      </button>
      {onAddToDraft && (
        <button
          type="button"
          onClick={onAddToDraft}
          disabled={adding}
          className="m-2 mt-0 flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-medium border border-emerald-300 text-emerald-700 hover:bg-emerald-50 rounded-md disabled:opacity-60"
        >
          + Add to draft
        </button>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wide text-gray-400">{label}</div>
      <div className="font-semibold text-gray-900 tabular-nums">{value}</div>
    </div>
  );
}

function fmt$(n) {
  if (n == null || !Number.isFinite(parseFloat(n))) return '—';
  return `$${parseFloat(n).toFixed(2)}`;
}
