// Keep credentials on this device, never in Chrome Sync or content-script settings.
export const SESSION_KEY = 'foliaApiSession';

export function apiBase(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use the HTTPS API origin (or localhost for development)');
  }
  return url.origin;
}

export async function sessionHeaders(settings) {
  const saved = (await chrome.storage.local.get(SESSION_KEY))[SESSION_KEY];
  if (!saved?.token || saved.apiBase !== apiBase(settings.apiBase) || saved.userId !== settings.userId) {
    throw new Error('Sign in to Folia in the extension Settings');
  }
  return { Authorization: `Bearer ${saved.token}` };
}
