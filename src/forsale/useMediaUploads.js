import { useEffect, useSyncExternalStore } from 'react';
import { addPlantPhoto, savePlantVideo, videoProblem } from './media.js';
import { MAX_PHOTOS, MAX_VIDEOS, photosOf, videosOf } from './pools.js';

const isImage = (f) => /^image\//i.test(f?.type || '') || /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(f?.name || '');

// Background uploads for the For Sale tab. The queue lives at module level,
// not in the tab, so a plant's photos and video keep going up — and stay on
// screen when the tab is opened again — while the operator moves on to the
// next plant, closes the sheet or visits another tab. Two lanes:
//   photo — every photo write, one at a time: uploads (each is added to the
//           end of the gallery, so they land in the order picked) and the
//           gallery's Delete / Cover, so two writes to one plant's photos
//           never overlap and its photo list can't go stale;
//   video — videos on their own (they're big), so one never holds up the
//           next plant's photos.
//
// A job: { key, itemId, kind: 'photo' | 'video' | 'op', label, preview, pct, state }
//   state 'queued' | 'up'; preview = a local object URL (photos); pct 0..1.
//   'op' jobs (Delete / Cover) aren't drawn as tiles.

const store = {
  jobs: [],
  listeners: new Set(),
  queues: { photo: [], video: [] },
  running: { photo: false, video: false },
  seq: 0,
  // The mounted tab's handlers; kept after it unmounts so uploads that
  // finish meanwhile still land in the app's list. multiVideo: migration
  // 0055 is in (several videos per plant; before it a new one replaces).
  cbs: { onMerged: () => {}, onSettled: () => {}, showToast: () => {}, multiVideo: true },
};

const warnUnload = (e) => { e.preventDefault(); e.returnValue = ''; };

function setJobs(fn) {
  const before = store.jobs.length;
  store.jobs = fn(store.jobs);
  // Leaving the page drops uploads still going — ask first.
  if (!before && store.jobs.length) window.addEventListener('beforeunload', warnUnload);
  if (before && !store.jobs.length) window.removeEventListener('beforeunload', warnUnload);
  for (const l of store.listeners) l();
}
const patchJob = (key, patch) => setJobs((l) => l.map((j) => (j.key === key ? { ...j, ...patch } : j)));

async function pump(lane) {
  if (store.running[lane]) return;
  store.running[lane] = true;
  try {
    while (store.queues[lane].length) {
      const job = store.queues[lane].shift();
      patchJob(job.key, { state: 'up' });
      try {
        if (job.kind === 'op') {
          const patch = await job.run();
          store.cbs.onMerged([patch]);
          job.resolve(patch);
        } else if (job.kind === 'photo') {
          store.cbs.onMerged([await addPlantPhoto(job.itemId, job.file)]);
        } else {
          store.cbs.onMerged([await savePlantVideo(job.itemId, job.file, (pct) => patchJob(job.key, { pct }))]);
        }
      } catch (e) {
        if (job.kind === 'op') job.reject(e);
        else store.cbs.showToast(`${job.label}: ${e.message || 'upload failed'}`, 'error');
      }
      if (job.preview) URL.revokeObjectURL(job.preview);
      setJobs((l) => l.filter((j) => j.key !== job.key));
      if (!store.jobs.some((j) => j.itemId === job.itemId)) store.cbs.onSettled(job.itemId);
    }
  } finally {
    store.running[lane] = false;
  }
}

// Queue photos for a plant (its gallery holds MAX_PHOTOS). → how many queued.
function addPhotos(item, files, label) {
  const picked = [...(files || [])];
  const images = picked.filter(isImage);
  if (images.length < picked.length) store.cbs.showToast('Only photos can go here — videos go in the video box', 'error');
  if (!images.length) return 0;
  const waiting = store.jobs.filter((j) => j.itemId === item.id && j.kind === 'photo').length;
  const room = MAX_PHOTOS - photosOf(item).length - waiting;
  if (room <= 0) {
    store.cbs.showToast(`${label} already has ${MAX_PHOTOS} photos — delete one to add another`, 'error');
    return 0;
  }
  const take = images.slice(0, room);
  if (images.length > room) store.cbs.showToast(`Only ${room} more photo${room === 1 ? ' fits' : 's fit'} — up to ${MAX_PHOTOS} per plant`, 'error');
  const added = take.map((file) => ({
    key: `p${++store.seq}`, itemId: item.id, kind: 'photo', label, file,
    preview: URL.createObjectURL(file), pct: null, state: 'queued',
  }));
  store.queues.photo.push(...added);
  setJobs((l) => [...l, ...added]);
  pump('photo');
  return take.length;
}

// Queue videos for a plant (it holds MAX_VIDEOS, in the order picked).
// Before 0055 a plant has one video: the pick replaces it, and a newer pick
// replaces one still waiting. → how many queued.
function addVideos(item, files, label) {
  const picked = [...(files || [])];
  const ok = [];
  for (const f of picked) {
    const problem = videoProblem(f);
    if (problem) store.cbs.showToast(problem, 'error');
    else ok.push(f);
  }
  if (!ok.length) return 0;
  const job = (file) => ({ key: `v${++store.seq}`, itemId: item.id, kind: 'video', label, file, preview: null, pct: 0, state: 'queued' });
  if (!store.cbs.multiVideo) {
    const stale = store.queues.video.filter((j) => j.itemId === item.id).map((j) => j.key);
    store.queues.video = store.queues.video.filter((j) => j.itemId !== item.id);
    const one = job(ok[ok.length - 1]);
    store.queues.video.push(one);
    setJobs((l) => [...l.filter((j) => !stale.includes(j.key)), one]);
    pump('video');
    return 1;
  }
  const waiting = store.jobs.filter((j) => j.itemId === item.id && j.kind === 'video').length;
  const room = MAX_VIDEOS - videosOf(item).length - waiting;
  if (room <= 0) {
    store.cbs.showToast(`${label} already has ${MAX_VIDEOS} videos — delete one to add another`, 'error');
    return 0;
  }
  if (ok.length > room) store.cbs.showToast(`Only ${room} more video${room === 1 ? ' fits' : 's fit'} — up to ${MAX_VIDEOS} per plant`, 'error');
  const added = ok.slice(0, room).map(job);
  store.queues.video.push(...added);
  setJobs((l) => [...l, ...added]);
  pump('video');
  return added.length;
}

// A gallery change (Delete / Cover) in the photo lane, behind any photo
// still uploading. `run` returns the plant patch. → Promise of the patch.
function photoOp(itemId, run) {
  return new Promise((resolve, reject) => {
    const job = { key: `o${++store.seq}`, itemId, kind: 'op', run, resolve, reject, state: 'queued' };
    store.queues.photo.push(job);
    setJobs((l) => [...l, job]);
    pump('photo');
  });
}

const subscribe = (l) => { store.listeners.add(l); return () => store.listeners.delete(l); };
const snapshot = () => store.jobs;

export function useMediaUploads({ onMerged, onSettled, showToast, multiVideo = true }) {
  const jobs = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => { store.cbs = { onMerged, onSettled, showToast, multiVideo }; });
  return { jobs, addPhotos, addVideos, photoOp, multiVideo };
}
