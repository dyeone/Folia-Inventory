// Settings stored in chrome.storage.sync so they roam with the user's
// Chrome profile. The popup + content script both read these.

const DEFAULTS = {
  apiBase: '',
  userId: '',
  // Which 3babes brand this extension acts on (Folia, BAE, …). Sent with every
  // API call so shipments are read/written under the right brand.
  brandId: 'folia',
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
  out.apiBase = out.apiBase.replace(/\/+$/, '');
  await chrome.storage.sync.set(out);
  const s = document.getElementById('status');
  s.textContent = 'Saved';
  setTimeout(() => { s.textContent = ''; }, 1500);
}

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
