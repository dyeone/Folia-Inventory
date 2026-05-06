// Per-item live status, persisted in localStorage so a refresh during the
// stream doesn't lose where the streamer is.
//   queued  — not yet on Palmstreet
//   current — currently being sold
//   done    — finished

export const STORAGE_KEY = (saleId) => `live-state-${saleId}`;

export function loadState(saleId) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY(saleId));
    return raw ? JSON.parse(raw) : { itemStatus: {}, startedAt: null };
  } catch {
    return { itemStatus: {}, startedAt: null };
  }
}

export function formatElapsed(ms) {
  if (!ms || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
