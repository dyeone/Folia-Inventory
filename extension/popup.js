// Popup orchestrator. Pulls the work queue from Folia (boxes that still
// need USPS labels), lets the operator pick which to process, then
// drives the content script through the 8-step Palmstreet flow for each.

const $ = (id) => document.getElementById(id);
let stopRequested = false;
let lastWeightOz = null;

document.getElementById('openOptions').addEventListener('click', (e) => {
  e.preventDefault(); chrome.runtime.openOptionsPage();
});
$('goOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('refresh').addEventListener('click', loadQueue);
$('stop').addEventListener('click', () => { stopRequested = true; });
$('modeSync').addEventListener('click', () => runQueue('sync'));
$('modeBuy').addEventListener('click', () => runQueue('buy'));
$('readScale').addEventListener('click', readScaleNow);

async function init() {
  const settings = await chrome.storage.sync.get(null);
  if (!settings.apiBase || !settings.userId) {
    show('needsConfig'); return;
  }
  const tab = await activePalmstreetTab();
  if (!tab) { show('notOnPalmstreet'); return; }
  show('ready');
  await refreshScaleStatus();
  await loadQueue();
}

function show(which) {
  for (const id of ['needsConfig', 'notOnPalmstreet', 'ready']) $(id).hidden = id !== which;
}

async function activePalmstreetTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  if (!/palmstreet\.(app|com)/.test(tab.url)) return null;
  return tab;
}

async function loadQueue() {
  const settings = await chrome.storage.sync.get(null);
  const list = $('queue');
  list.innerHTML = '';
  $('queueCount').textContent = '…';

  const resp = await sendBg({ type: 'api:pendingUsps', settings });
  if (!resp.ok) {
    $('queueCount').textContent = '!';
    list.innerHTML = `<li class="err">${resp.error}</li>`;
    return;
  }
  const boxes = resp.boxes || [];
  $('queueCount').textContent = String(boxes.length);
  if (boxes.length === 0) {
    list.innerHTML = `<li class="muted">All caught up.</li>`;
    return;
  }
  for (const b of boxes) {
    const li = document.createElement('li');
    li.className = 'queue-row';
    li.innerHTML = `
      <label class="row">
        <input type="checkbox" data-box-id="${b.shipmentBoxId}" checked />
        <div class="col">
          <strong>${escapeHtml(b.recipientName)}</strong>
          <small>@${escapeHtml(b.buyerUsername || '?')} · ${b.items.length} item${b.items.length === 1 ? '' : 's'}${b.saleName ? ` · ${escapeHtml(b.saleName)}` : ''}</small>
        </div>
      </label>`;
    list.appendChild(li);
  }
}

function getSelectedBoxes(boxes) {
  const ids = new Set(
    [...$('queue').querySelectorAll('input[type=checkbox]:checked')].map(c => c.dataset.boxId),
  );
  return boxes.filter(b => ids.has(b.shipmentBoxId));
}

async function refreshScaleStatus() {
  if (!('hid' in navigator)) {
    $('scaleLabel').textContent = 'Scale: WebHID not available'; return;
  }
  const devices = await window.FoliaScale.listPaired();
  $('scaleLabel').textContent = devices.length
    ? `Scale: ${devices[0].productName || 'paired'}`
    : 'Scale: not paired (open Settings)';
}

async function readScaleNow() {
  const oz = await window.FoliaScale.readOnceOz({ timeoutMs: 2500 });
  if (oz == null) {
    $('scaleLabel').textContent = 'Scale: no reading';
    return;
  }
  lastWeightOz = oz;
  $('scaleLabel').textContent = `Scale: ${oz.toFixed(2)} oz`;
}

async function pickWeight(box, settings) {
  // Prefer a fresh scale reading. Fall back to the last manual entry,
  // then the configured default, then a prompt.
  let oz = await window.FoliaScale.readOnceOz({ timeoutMs: 1500 }).catch(() => null);
  if (oz != null && oz > 0) {
    lastWeightOz = oz;
    return oz;
  }
  if (lastWeightOz != null && lastWeightOz > 0) return lastWeightOz;
  const def = parseFloat(settings.defaultWeightOz);
  if (Number.isFinite(def) && def > 0 && !settings.confirmEachOrder) return def;
  const entered = prompt(
    `Weight (oz) for ${box.recipientName}` + (Number.isFinite(def) && def > 0 ? `\n(default: ${def})` : ''),
    Number.isFinite(def) && def > 0 ? String(def) : '',
  );
  const num = parseFloat(entered);
  if (!Number.isFinite(num) || num <= 0) throw new Error('Cancelled');
  return num;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randDelay(min, max) {
  return Math.floor((min || 0) + Math.random() * Math.max(1, (max || 0) - (min || 0)));
}

function logRow(text, tone = '') {
  const li = document.createElement('li');
  if (tone) li.className = tone;
  li.textContent = text;
  $('log').appendChild(li);
  $('log').scrollTop = $('log').scrollHeight;
}
function setProgress(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  $('progFill').style.width = `${pct}%`;
  $('progLabel').textContent = `${done} / ${total}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function sendBg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(resp || { ok: false, error: 'No response' });
    });
  });
}
function sendTab(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(resp || { ok: false, error: 'No response' });
    });
  });
}

async function runQueue(mode) {
  stopRequested = false;
  const settings = await chrome.storage.sync.get(null);
  const tab = await activePalmstreetTab();
  if (!tab) { show('notOnPalmstreet'); return; }

  const all = await sendBg({ type: 'api:pendingUsps', settings });
  if (!all.ok) { alert(all.error); return; }
  const selected = getSelectedBoxes(all.boxes || []);
  if (selected.length === 0) { alert('No boxes selected.'); return; }

  $('progress').hidden = false;
  $('log').innerHTML = '';
  setProgress(0, selected.length);

  let done = 0;
  let synced = 0;

  for (const box of selected) {
    if (stopRequested) { logRow('Stopped.', 'warn'); break; }
    const label = `${box.recipientName} (@${box.buyerUsername || '?'})`;

    if (settings.confirmEachOrder && !confirm(`Process ${label}?`)) {
      logRow(`Skipped ${label}`, 'warn');
      done++; setProgress(done, selected.length);
      continue;
    }

    try {
      if (mode === 'sync') {
        const r = await sendTab(tab.id, { type: 'syncOnly', payload: { box } });
        if (!r.ok) throw new Error(r.error);
        if (!r.trackingNumber) { logRow(`No tracking visible for ${label}`, 'warn'); }
        else {
          await postTracking(settings, box, { trackingNumber: r.trackingNumber });
          synced++;
          logRow(`Synced ${label} → ${r.trackingNumber}`, 'ok');
        }
      } else {
        const weightOz = await pickWeight(box, settings);
        const r = await sendTab(tab.id, { type: 'processOrder', payload: { box, weightOz } });
        if (!r.ok) throw new Error(r.error);
        if (!r.trackingNumber) {
          logRow(`Bought, no tracking for ${label}`, 'warn');
        }
        await postTracking(settings, box, {
          trackingNumber: r.trackingNumber || '(missing)',
          weightOz: r.weightOz,
          labelPdfBase64: r.labelPdfBase64,
          slipPdfBase64: r.slipPdfBase64,
        });
        synced++;
        logRow(`Bought + synced ${label} → ${r.trackingNumber || 'no tracking'}`, 'ok');
      }
    } catch (e) {
      logRow(`Failed ${label}: ${e.message}`, 'err');
    }

    done++;
    setProgress(done, selected.length);
    await sleep(randDelay(settings.delayMin, settings.delayMax));
  }

  logRow(`Done · ${synced}/${done} synced`, 'ok');
  await loadQueue();
}

async function postTracking(settings, box, extras) {
  const resp = await sendBg({
    type: 'api:recordTracking',
    settings,
    shipmentBoxId: box.shipmentBoxId,
    ...extras,
  });
  if (!resp.ok) throw new Error(resp.error);
  return resp.shipment;
}

init();
