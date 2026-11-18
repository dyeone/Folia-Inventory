import { api } from '../api.js';

// Photo + video handling for the For Sale tab. Each plant keeps ONE photo
// and ONE video.
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

// The plant's one photo becomes this one; returns the new imageUrl.
export async function savePlantPhoto(itemId, file) {
  const p = await shrinkPhoto(file);
  const r = await api.uploadItemPhoto({ itemId, ...p, replace: true });
  return r.itemImageUrl || null;
}

function videoType(file) {
  const t = String(file.type || '').toLowerCase();
  if (VIDEO_TYPES.includes(t)) return t;
  const ext = String(file.name || '').split('.').pop().toLowerCase();
  return { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v' }[ext] || '';
}

// Upload the plant's one video; `onProgress(0..1)`. Returns the new videoUrl.
export async function savePlantVideo(itemId, file, onProgress) {
  const contentType = videoType(file);
  if (!contentType) throw new Error('That isn\'t a video we can use (MP4, MOV or WebM)');
  if (file.size > VIDEO_MAX_BYTES) {
    throw new Error(`Video is ${Math.round(file.size / 1048576)} MB — the limit is 50 MB. Record a shorter clip (about 30 seconds).`);
  }
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
