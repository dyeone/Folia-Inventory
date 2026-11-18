import { api } from '../api.js';
import { MAX_PHOTOS } from './pools.js';

// Photo + video handling for the For Sale tab. Each plant keeps up to
// MAX_PHOTOS photos (the first is its cover) and ONE video.
//
// Photos are shrunk on the phone before upload (long side 1600 px, JPEG):
// a phone photo is 3–5 MB, over the API's request limit once base64'd and
// most of what filled the storage bucket; 1600 px is plenty for a listing.
// Videos can't be re-encoded in the browser, so they go up as recorded,
// straight to Storage on a signed URL (a function body caps at 4.5 MB),
// with a 50 MB limit — about 30 seconds of phone video.

export const PHOTO_MAX_PX = 1600;
export const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'];

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That photo couldn\'t be read — try another')); };
    img.src = url;
  });
}

// → { fileBase64, contentType: 'image/jpeg', filename, bytes }
export async function shrinkPhoto(file, maxPx = PHOTO_MAX_PX) {
  const img = await loadImage(file);
  const scale = Math.min(1, maxPx / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  if (!blob) throw new Error('Couldn\'t prepare that photo');
  const fileBase64 = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('Couldn\'t read that photo'));
    r.readAsDataURL(blob);
  });
  const base = (file.name || 'photo').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').slice(0, 40) || 'photo';
  return { fileBase64, contentType: 'image/jpeg', filename: `${base}.jpg`, bytes: blob.size };
}

// The changes a photo call made to the plant, ready to merge into the list.
const photoPatch = (itemId, r) => ({
  id: itemId,
  imageUrl: r?.itemImageUrl ?? null,
  ...(Array.isArray(r?.photoUrls) ? { photoUrls: r.photoUrls } : {}),
});

// Add one photo to the end of the plant's gallery. → patch for the plant.
export async function addPlantPhoto(itemId, file) {
  const p = await shrinkPhoto(file);
  const r = await api.uploadItemPhoto({ itemId, ...p, forSale: true, maxPhotos: MAX_PHOTOS });
  return photoPatch(itemId, r);
}

export async function deletePlantPhoto(itemId, photoId) {
  return photoPatch(itemId, await api.deleteItemPhoto(photoId, { forSale: true }));
}

// Move one photo to the front: it becomes the cover (card, CSV, Shopify).
export async function makeCoverPhoto(itemId, photoId) {
  return photoPatch(itemId, await api.reorderItemPhotos(itemId, [photoId], { forSale: true }));
}

function videoType(file) {
  const t = String(file.type || '').toLowerCase();
  if (VIDEO_TYPES.includes(t)) return t;
  const ext = String(file.name || '').split('.').pop().toLowerCase();
  return { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v' }[ext] || '';
}

// Why this file can't be the plant's video, or '' when it can.
export function videoProblem(file) {
  if (!videoType(file)) return 'That isn\'t a video we can use (MP4, MOV or WebM)';
  if (file.size > VIDEO_MAX_BYTES) {
    return `Video is ${Math.round(file.size / 1048576)} MB — the limit is 50 MB. Record a shorter clip (about 30 seconds).`;
  }
  return '';
}

// Upload the plant's one video; `onProgress(0..1)`. Returns the new videoUrl.
export async function savePlantVideo(itemId, file, onProgress) {
  const problem = videoProblem(file);
  if (problem) throw new Error(problem);
  const contentType = videoType(file);
  const { signedUrl, path } = await api.videoUploadUrl({ itemId, contentType, size: file.size, filename: file.name });
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', signedUrl);
    xhr.setRequestHeader('content-type', contentType);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
      ? resolve()
      : reject(new Error(`Video upload failed (HTTP ${xhr.status}) — try again`)));
    xhr.onerror = () => reject(new Error('Video upload failed — check the connection and try again'));
    xhr.send(file);
  });
  const r = await api.videoCommit({ itemId, path });
  return r.videoUrl;
}
