// Background service worker. Centralizes Folia API calls so the
// extension's auth (userId) and the API base URL aren't repeated
// across pages. Also keeps an UNPACKED install current: see the
// self-reload section at the bottom.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type?.startsWith('api:')) return false;

  (async () => {
    try {
      const { settings } = msg;
      if (!settings?.apiBase || !settings?.userId) {
        throw new Error('API base or userId not configured');
      }
      let resp;
      switch (msg.type) {
        case 'api:pendingUsps':
          resp = await get(settings, '/api/shipments?action=pending&carrier=usps');
          sendResponse({ ok: true, boxes: resp.boxes || [] });
          break;
        case 'api:withTracking':
          // Boxes that already have a tracking number recorded — the queue
          // for pushing tracking back into Palmstreet.
          resp = await get(settings, '/api/shipments?action=with-tracking');
          sendResponse({ ok: true, boxes: resp.boxes || [] });
          break;
        case 'api:liveShowGet':
          // Re-seed the live monitor after a mid-show page reload.
          noteLiveActivity();
          resp = await get(settings, '/api/settings?action=live-show-get');
          sendResponse({ ok: true, show: resp.show || null, updatedAt: resp.updatedAt || null });
          break;
        case 'api:liveShowSave':
          noteLiveActivity();
          await post(settings, '/api/settings', { action: 'live-show-save', show: msg.show });
          sendResponse({ ok: true });
          break;
        case 'api:liveScanGet':
          // Last scan from the web app's scan screen, for the overlay's
          // "just scanned" card (recommended price + sell note).
          resp = await get(settings, '/api/settings?action=live-show-scan-get');
          sendResponse({ ok: true, scan: resp.scan || null, updatedAt: resp.updatedAt || null });
          break;
        case 'api:liveShowBuyers':
          // Lifetime buyer tiers (VIP / repeat) for the live overlay's alerts.
          resp = await get(settings, '/api/settings?action=live-show-buyers');
          sendResponse({ ok: true, buyers: resp.buyers || {}, count: resp.count || 0, generatedAt: resp.generatedAt || null });
          break;
        case 'api:recordTracking':
          resp = await post(settings, '/api/shipments', {
            action: 'record-tracking',
            shipmentBoxId: msg.shipmentBoxId,
            matchByOrderId: msg.matchByOrderId,
            trackingNumber: msg.trackingNumber,
            weightOz: msg.weightOz,
            labelPdfBase64: msg.labelPdfBase64,
            slipPdfBase64: msg.slipPdfBase64,
          });
          sendResponse({ ok: true, shipment: resp.shipment });
          break;
        default:
          throw new Error(`Unknown api message: ${msg.type}`);
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || 'Request failed' });
    }
  })();

  return true;
});

// Desktop notifications for the live overlay. Content scripts can't call
// chrome.notifications themselves, so the overlay asks the worker.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'notify') return false;
  try {
    chrome.notifications.create('', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon128.png'),
      title: String(msg.title || 'BAE live').slice(0, 80),
      message: String(msg.message || '').slice(0, 200),
      priority: 2,
      silent: !!msg.silent,
    }, () => {
      const err = chrome.runtime.lastError;
      sendResponse(err ? { ok: false, error: err.message } : { ok: true });
    });
  } catch (e) {
    sendResponse({ ok: false, error: e?.message || 'notify failed' });
  }
  return true;
});

async function get(settings, path) {
  const sep = path.includes('?') ? '&' : '?';
  // brandId scopes the call to the chosen 3babes brand (Folia, BAE, …). When
  // unset the server defaults to Folia, so older extension configs keep working.
  const brand = settings.brandId ? `&brandId=${encodeURIComponent(settings.brandId)}` : '';
  const res = await fetch(`${settings.apiBase}${path}${sep}userId=${encodeURIComponent(settings.userId)}${brand}`);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

async function post(settings, path, body) {
  const res = await fetch(`${settings.apiBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, userId: settings.userId, brandId: settings.brandId || undefined }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

// ── Self-reload for the unpacked install ─────────────────────────────
// The Mac app (or a git pull) refreshes the extension folder on disk, but
// Chrome keeps running the old files until the extension reloads. Once a
// minute compare the manifest version on disk with the running one and
// reload when it changes — but only after live activity has been quiet for
// a few minutes, because a reload orphans the dashboard tab's content
// scripts mid-show. On every (re)load the content scripts are re-injected
// into open Palmstreet tabs, so an already-open dashboard picks up the new
// code; the scripts themselves stop an orphaned earlier instance first.
// Packed (Web Store) installs never see a version change here, so this is
// inert for them.

const RELOAD_ALARM = 'folia-reload-check';
const LIVE_QUIET_MS = 3 * 60 * 1000;
const CONTENT_SCRIPTS = ['content.js', 'live-monitor.js', 'live-overlay.js'];
const PALMSTREET_URLS = ['https://*.palmstreet.app/*', 'https://*.palmstreet.com/*'];

// storage.session survives service-worker restarts (in-memory, per browser
// session) — a plain variable would read 0 after every idle unload.
function noteLiveActivity() {
  try { chrome.storage.session.set({ lastLiveActivity: Date.now() }); } catch { /* pre-102 Chrome */ }
}
async function lastLiveActivity() {
  try { return (await chrome.storage.session.get({ lastLiveActivity: 0 })).lastLiveActivity || 0; }
  catch { return 0; }
}

async function diskManifestVersion() {
  const res = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
  const m = await res.json();
  return m?.version || null;
}

async function checkForNewFiles() {
  try {
    const running = chrome.runtime.getManifest().version;
    const disk = await diskManifestVersion();
    if (!disk || disk === running) return;
    if (Date.now() - (await lastLiveActivity()) < LIVE_QUIET_MS) return; // mid-show: next minute
    chrome.runtime.reload();
  } catch { /* unreadable manifest (mid-copy?) — try again next minute */ }
}

chrome.alarms.get(RELOAD_ALARM, (a) => {
  if (!a) chrome.alarms.create(RELOAD_ALARM, { periodInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === RELOAD_ALARM) checkForNewFiles(); });

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'install' && details.reason !== 'update') return;
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: PALMSTREET_URLS }); } catch { return; }
  for (const t of tabs) {
    if (!t.id) continue;
    chrome.scripting.executeScript({ target: { tabId: t.id }, files: CONTENT_SCRIPTS }).catch(() => {
      // e.g. a chrome-error page or a tab that's discarded — the next
      // navigation injects normally.
    });
  }
});
