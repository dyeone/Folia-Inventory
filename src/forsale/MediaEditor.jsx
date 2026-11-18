import { useRef, useState } from 'react';
import { Camera, ImagePlus, Video, Loader2, Star, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { deletePlantPhoto, makeCoverPhoto } from './media.js';
import { MAX_PHOTOS, photosOf, photoIdOf } from './pools.js';

// One plant's listing media: its photos (up to MAX_PHOTOS, the first is the
// cover) and its one video. Picks go to the tab's background uploader
// (useMediaUploads), so the sheet can move on while they upload. Tap a photo
// for Cover / Delete — those wait their turn behind photos still uploading
// (one photo write at a time per tab), and the uploader merges the result.
// `onChanged` is for the video delete (photo writes follow Shopify via the
// uploader).
export function MediaEditor({ item, uploads, showToast, onMerged, onChanged }) {
  const photoRef = useRef(null);
  const videoRef = useRef(null);
  const [selected, setSelected] = useState(null);   // photo id showing its actions
  const [busyId, setBusyId] = useState(null);
  const [videoBusy, setVideoBusy] = useState(false);

  const label = item.saleCode || item.sku;
  const photos = photosOf(item).map((url) => ({ url, id: photoIdOf(url, item.id) }));
  const mine = uploads.jobs.filter((j) => j.itemId === item.id);
  const pendingPhotos = mine.filter((j) => j.kind === 'photo');
  const videoJob = mine.find((j) => j.kind === 'video');
  const count = photos.length + pendingPhotos.length;
  const full = count >= MAX_PHOTOS;

  const pickPhotos = (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (files.length) uploads.addPhotos(item, files, label);
  };

  const pickVideo = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) uploads.setVideo(item, file, label);
  };

  const act = async (photoId, fn, done) => {
    setBusyId(photoId);
    try {
      await uploads.photoOp(item.id, fn);
      setSelected(null);
      if (done) showToast(done);
    } catch (err) {
      showToast(err.message || 'That didn\'t work — try again', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const removePhoto = (photoId) => {
    if (!window.confirm('Delete this photo?')) return;
    act(photoId, () => deletePlantPhoto(item.id, photoId), 'Photo deleted');
  };

  const removeVideo = async () => {
    if (!window.confirm('Delete this plant\'s video?')) return;
    setVideoBusy(true);
    try {
      await api.videoDelete(item.id);
      onMerged([{ id: item.id, videoUrl: null }]);
      onChanged?.(item.id);
    } catch (err) {
      showToast(err.message || 'Could not delete the video', 'error');
    } finally {
      setVideoBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Photos */}
      <div>
        <div className="flex items-baseline justify-between mb-1.5">
          <span className="text-xs font-semibold text-gray-600">Photos <span className="font-normal text-gray-400">{count}/{MAX_PHOTOS}</span></span>
          {photos.length > 1 && <span className="text-[11px] text-gray-400">Tap a photo to make it the cover or delete it</span>}
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {photos.map((p, i) => {
            const open = selected && selected === p.id;
            return (
              <div key={p.url} className="relative aspect-square rounded-xl overflow-hidden bg-gray-100">
                <button
                  type="button" disabled={!p.id || !!busyId}
                  onClick={() => setSelected(open ? null : p.id)}
                  className="absolute inset-0 w-full h-full"
                  aria-label={i === 0 ? 'Cover photo' : `Photo ${i + 1}`}
                >
                  <img src={p.url} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
                </button>
                {i === 0 && (
                  <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/75 text-white text-[10px] font-semibold pointer-events-none">Cover</span>
                )}
                {busyId && busyId === p.id && (
                  <div className="absolute inset-0 bg-white/70 flex items-center justify-center"><Loader2 className="w-5 h-5 animate-spin text-gray-700" /></div>
                )}
                {open && !busyId && (
                  <div className="absolute inset-0 bg-black/60 flex flex-col items-stretch justify-center gap-1.5 p-2">
                    {i > 0 && (
                      <button type="button" onClick={() => act(p.id, () => makeCoverPhoto(item.id, p.id), 'Cover photo set')}
                        className="flex items-center justify-center gap-1 py-1.5 rounded-lg bg-white text-gray-900 text-xs font-semibold">
                        <Star className="w-3.5 h-3.5" /> Cover
                      </button>
                    )}
                    <button type="button" onClick={() => removePhoto(p.id)}
                      className="flex items-center justify-center gap-1 py-1.5 rounded-lg bg-red-600 text-white text-xs font-semibold">
                      <Trash2 className="w-3.5 h-3.5" /> Delete
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {pendingPhotos.map((j) => (
            <div key={j.key} className="relative aspect-square rounded-xl overflow-hidden bg-gray-100">
              {j.preview && <img src={j.preview} alt="" className={`absolute inset-0 w-full h-full object-cover ${j.state === 'up' ? 'opacity-70' : 'opacity-40'}`} />}
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-[10px] font-semibold text-gray-800">
                <Loader2 className="w-5 h-5 animate-spin" />
                {j.state === 'up' ? 'Uploading' : 'Waiting'}
              </div>
            </div>
          ))}
          {!full && (
            <button
              type="button" onClick={() => photoRef.current?.click()}
              className="aspect-square rounded-xl border-2 border-dashed border-emerald-300 bg-emerald-50/50 text-emerald-700 flex flex-col items-center justify-center gap-1 active:bg-emerald-100"
            >
              {count ? <ImagePlus className="w-6 h-6" /> : <Camera className="w-6 h-6" />}
              <span className="text-xs font-semibold">{count ? 'Add more' : 'Add photos'}</span>
            </button>
          )}
        </div>
        <input ref={photoRef} type="file" accept="image/*" multiple className="hidden" onChange={pickPhotos} />
      </div>

      {/* Video */}
      <div>
        <div className="text-xs font-semibold text-gray-600 mb-1.5">Video</div>
        <div className="flex gap-3 items-stretch">
          <div className="relative w-32 sm:w-40 aspect-[3/4] rounded-xl bg-gray-900 overflow-hidden flex items-center justify-center shrink-0">
            {item.videoUrl
              ? <video key={item.videoUrl} src={item.videoUrl} controls playsInline preload="metadata" className="w-full h-full object-cover" />
              : <Video className="w-7 h-7 text-gray-600" />}
            {(videoJob || videoBusy) && (
              <div className="absolute inset-0 bg-black/65 flex flex-col items-center justify-center gap-1.5 text-white text-xs">
                <Loader2 className="w-6 h-6 animate-spin" />
                <span>{videoBusy ? 'Working…' : videoJob.state === 'queued' ? 'Waiting…' : videoJob.pct > 0 ? `Uploading ${Math.round(videoJob.pct * 100)}%` : 'Starting…'}</span>
              </div>
            )}
          </div>
          <div className="flex-1 flex flex-col gap-2 justify-center">
            <button
              type="button" disabled={videoBusy} onClick={() => videoRef.current?.click()}
              className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-lg bg-gray-900 active:bg-black text-white text-sm font-semibold disabled:opacity-50"
            >
              <Video className="w-4 h-4" /> {item.videoUrl || videoJob ? 'Replace video' : 'Add video'}
            </button>
            {item.videoUrl && !videoJob && (
              <button type="button" disabled={videoBusy} onClick={removeVideo} className="text-xs text-gray-500 underline disabled:opacity-50">Delete video</button>
            )}
            <p className="text-[11px] text-gray-500">One video per plant, about 30 seconds (50 MB max).</p>
          </div>
        </div>
        <input ref={videoRef} type="file" accept="video/*" className="hidden" onChange={pickVideo} />
      </div>
    </div>
  );
}
