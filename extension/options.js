// Settings stored in chrome.storage.sync so they roam with the user's
// Chrome profile. The popup + content script both read these.

const DEFAULTS = {
  apiBase: '',
  userId: '',
  selOrderRow: '',
  selOrderId: '',
  selBuyButton: '',
  selTracking: '',
  selPurchased: '',
  confirmEachBuy: true,
  delayMin: 800,
  delayMax: 2000,
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
}

async function save() {
  const out = {};
  for (const k of FIELDS) {
    const el = document.getElementById(k);
    if (!el) continue;
    if (el.type === 'checkbox') out[k] = !!el.checked;
    else if (el.type === 'number') out[k] = parseInt(el.value, 10) || DEFAULTS[k];
    else out[k] = (el.value || '').trim();
  }
  // Trim trailing slash from API base.
  out.apiBase = out.apiBase.replace(/\/+$/, '');
  await chrome.storage.sync.set(out);
  const s = document.getElementById('status');
  s.textContent = 'Saved';
  setTimeout(() => { s.textContent = ''; }, 1500);
}

document.getElementById('save').addEventListener('click', save);
load();
