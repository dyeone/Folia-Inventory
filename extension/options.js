// Settings stored in chrome.storage.sync so they roam with the user's
// Chrome profile. The popup + content script both read these.
import { apiBase, SESSION_KEY } from './api-auth.js';

const DEFAULTS = {
  apiBase: '',
  userId: '',
  // Which 3babes brand this extension acts on (bae-gin, BAE, …). Sent with
  // every API call so shipments are read/written under the right brand.
  brandId: 'bae-gin',
  selOpenShipping: '',
  selSearchInput: '',
  selOrderRow: '',
  selContinue: '',
  selWeightInput: '',
  selPurchaseButton: '',
  selPayButton: '',
  selLabelLink: '',
  selSlipLink: '',
  selTracking: '',
  selBackToList: '',
  // "Push tracking to Palmstreet" flow selectors (optional ones are skipped
  // when blank). selTrackingInput + selSaveTracking are required for it.
  selAddTrackingOpen: '',
  selCarrierUsps: '',
  selTrackingInput: '',
  selSaveTracking: '',
  defaultWeightOz: 32,
  confirmEachOrder: true,
  delayMin: 800,
  delayMax: 2000,
  stepTimeoutMs: 20000,
  // Live overlay (live-overlay.js) — the streamer widget on the seller
  // dashboard. Alerts fire for VIP buyers; `liveAlertRepeat` widens them to
  // repeat buyers. `liveViewerRegex` calibrates the viewer count against a
  // real broadcast (one capture group) when the built-in patterns miss.
  liveOverlay: true,
  liveAlertSound: true,
  liveAlertRepeat: true,
  liveDesktopNotify: false,
  liveViewerRegex: '',
};

const FIELDS = Object.keys(DEFAULTS);

async function load() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  for (const k of FIELDS) {
    const el = document.getElementById(k);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!stored[k];
    else el.value = stored[k] ?? '';
  }
  await refreshScaleStatus();
  await refreshSessionStatus();
}

async function save() {
  const out = {};
  for (const k of FIELDS) {
    const el = document.getElementById(k);
    if (!el) continue;
    if (el.type === 'checkbox') out[k] = !!el.checked;
    else if (el.type === 'number') out[k] = parseFloat(el.value) || DEFAULTS[k];
    else out[k] = (el.value || '').trim();
  }
  if (out.apiBase) out.apiBase = apiBase(out.apiBase);
  await chrome.storage.sync.set(out);
  const s = document.getElementById('status');
  s.textContent = 'Saved';
  setTimeout(() => { s.textContent = ''; }, 1500);
}

async function refreshSessionStatus() {
  const saved = (await chrome.storage.local.get(SESSION_KEY))[SESSION_KEY];
  document.getElementById('authStatus').textContent = saved ? 'Signed in on this device. Sessions last 12 hours.' : 'Sign in to connect the extension.';
}

document.getElementById('signIn').addEventListener('click', async () => {
  const status = document.getElementById('authStatus');
  const password = document.getElementById('authPassword');
  const button = document.getElementById('signIn');
  button.disabled = true;
  try {
    const base = apiBase(document.getElementById('apiBase').value.trim());
    const username = document.getElementById('authUsername').value.trim();
    if (!username || !password.value) throw new Error('Enter your Folia username and password');
    const response = await fetch(`${base}/api/auth`, {
      method: 'POST', credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'login', username, password: password.value, sessionMode: 'token' }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.sessionToken || !data?.user?.id) throw new Error(data?.error || `Sign-in failed (${response.status})`);
    await chrome.storage.local.set({ [SESSION_KEY]: { apiBase: base, userId: data.user.id, token: data.sessionToken } });
    document.getElementById('userId').value = data.user.id;
    document.getElementById('apiBase').value = base;
    await save();
    await refreshSessionStatus();
  } catch (e) {
    status.textContent = e.message || 'Sign-in failed';
  } finally {
    password.value = '';
    button.disabled = false;
  }
});

document.getElementById('signOut').addEventListener('click', async () => {
  await chrome.storage.local.remove(SESSION_KEY);
  await refreshSessionStatus();
});

async function refreshScaleStatus() {
  const status = document.getElementById('scaleStatus');
  if (!('hid' in navigator)) {
    status.textContent = 'WebHID not available in this browser';
    status.className = 'muted';
    return;
  }
  const devices = await window.FoliaScale.listPaired();
  if (devices.length === 0) {
    status.textContent = 'Not paired';
    status.className = 'muted';
  } else {
    status.textContent = `Paired: ${devices[0].productName || 'HID scale'}`;
    status.className = '';
  }
}

document.getElementById('save').addEventListener('click', save);
document.getElementById('pairScale').addEventListener('click', async () => {
  const status = document.getElementById('scaleStatus');
  try {
    const device = await window.FoliaScale.pair();
    await window.FoliaScale.open(device);
    status.textContent = `Paired: ${device.productName || 'HID scale'}`;
    status.className = '';
  } catch (e) {
    status.textContent = `Pair failed: ${e.message}`;
    status.className = 'err';
  }
});
document.getElementById('testScale').addEventListener('click', async () => {
  const status = document.getElementById('scaleStatus');
  try {
    const oz = await window.FoliaScale.readOnceOz({ timeoutMs: 2500 });
    if (oz == null) {
      status.textContent = 'No reading — make sure the scale is on something';
    } else {
      status.textContent = `Read: ${oz.toFixed(2)} oz`;
    }
  } catch (e) {
    status.textContent = `Read failed: ${e.message}`;
    status.className = 'err';
  }
});

load();
