import { Camera, Video, CalendarDays, Images, Loader2, Globe, Check } from 'lucide-react';
import { money, readiness, shopifyBadge, photosOf, onWebsite, eventStyle } from './pools.js';

const TONE = {
  ok: 'bg-green-600 text-white',
  wait: 'bg-gray-700/80 text-white',
  warn: 'bg-amber-500 text-white',
  error: 'bg-red-600 text-white',
};

// One plant in the pool grid: its cover photo (and how many it has), code
// (big — it's how the packer finds the pot), name, price, what's missing,
// and — once pushed to the website — what its listing is doing. Tap →
// PlantSheet, or (selecting) ticks it.
// event: the upcoming sale event it's in (or null), shown as a chip in that
// event kind's colour.
export function PlantCard({ item, event, pausedSaleIds, shopifyConnected, selecting, selected, uploading, onClick }) {
  const missing = readiness(item);
  const shots = photosOf(item);
  const photoCount = shots.length;
  const badge = onWebsite(item) ? shopifyBadge(item, pausedSaleIds, shopifyConnected) : null;
  const evSt = event ? eventStyle(event) : null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selecting ? !!selected : undefined}
      className={`text-left bg-white rounded-xl border overflow-hidden flex flex-col active:scale-[0.99] transition ${
        selected ? 'border-emerald-500 ring-2 ring-emerald-200' : 'border-gray-200 hover:border-gray-300'
      }`}
    >
      {/* overflow-hidden: without it a tall (portrait) photo stretches the
          square — an aspect-ratio box grows to fit its content. */}
      <div className="relative aspect-square bg-gray-100 overflow-hidden">
        {shots[0] ? (
          <img src={shots[0]} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-gray-400 gap-1">
            <Camera className="w-7 h-7" />
            <span className="text-[11px] font-medium">Add photo</span>
          </div>
        )}
        {item.saleCode && (
          <span className="absolute top-1.5 left-1.5 px-2 py-0.5 rounded-md bg-black/80 text-white font-mono font-bold text-base tracking-wider leading-tight">
            {item.saleCode}
          </span>
        )}
        {selecting ? (
          <span className={`absolute top-1.5 right-1.5 w-6 h-6 rounded-full border-2 flex items-center justify-center ${selected ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-white/80 border-white'}`}>
            {selected && <Check className="w-4 h-4" strokeWidth={3} />}
          </span>
        ) : item.videoUrl && (
          <span className="absolute top-1.5 right-1.5 p-1 rounded-md bg-black/70 text-white" title="Has a video">
            <Video className="w-3.5 h-3.5" />
          </span>
        )}
        {badge && (
          <span className={`absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${TONE[badge.tone]}`} title={`Website: ${badge.detail}`}>
            <Globe className="w-3 h-3" /> {badge.label}
          </span>
        )}
        {(uploading || photoCount > 1) && (
          <span className="absolute bottom-1.5 right-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-black/70 text-white text-[10px] font-semibold" title={uploading ? 'Uploading' : `${photoCount} photos`}>
            {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Images className="w-3 h-3" />}
            {photoCount > 1 ? photoCount : ''}
          </span>
        )}
      </div>
      <div className="p-2 flex-1 flex flex-col gap-0.5 min-w-0">
        <div className="text-sm font-medium text-gray-900 leading-snug line-clamp-2">{item.listingDetails?.title || item.name || item.sku}</div>
        <div className="flex items-center justify-between gap-1">
          <span className="text-sm font-semibold text-gray-900">{money(item.listingPrice)}</span>
          <span className="text-[10px] font-mono text-gray-400 truncate">{item.sku}</span>
        </div>
        {event && (
          <div className={`self-start max-w-full inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] font-medium ${evSt.chip}`} title={evSt.label}>
            <CalendarDays className="w-3 h-3 shrink-0" /> <span className="truncate">{event.name}</span>
          </div>
        )}
        {missing.length > 0 && (
          <div className="text-[11px] text-amber-700">Needs {missing.join(', ')}</div>
        )}
      </div>
    </button>
  );
}
