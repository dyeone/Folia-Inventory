// Popup orchestrator. Talks to the content script (which lives on the
// Palmstreet tab) and to the background service worker (which makes
// authenticated requests to the Folia API).

const $ = (id) => document.getElementById(id);
let stopRequested = false;

document.getElementById('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
document.getElementById('goOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
document.getElementById('rescan').addEventListener('click', init);
document.getElementById('stop').addEventListener('click', () => { stopRequested = true; });

document.getElementById('modeSync').addEventListener('click', () => runQueue('sync'));
document.getElementById('modeBuy').addEventListener('click', () => runQueue('buy'));

async function init() {
  stopRequested = false;
  $('progress').hidden = true;
  $('needsConfig').hidden = true;
  $('notOnPalmstreet').hidden = true;
  $('ready').hidden = true;

  const settings = await chrome.storage.sync.get(null);
  // The bare minimum needed to do anything.
  const configured = settings.apiBase && settings.userId && settings.selOrderRow && settings.selOrderId;
  if (!configured) {
    $('needsConfig').hidden = false;
    return;
  }

  const tab = await activePalmstreetTab();
  if (!tab) {
    $('notOnPalmstreet').hidden = false;
    return;
  }

  $('ready').hidden = false;

  // Ask the content script how many orders are on this page.
  const count = await sendToTab(tab.id, { type: 'count' }).catch(() => null);
  $('orderCount').textContent = count == null ? '?' : String(count);
  // Disable Buy if selectors for Buy + Tracking aren't set yet.
  $('modeBuy').disabled = !(settings.selBuyButton && settings.selTracking);
  if ($('modeBuy').disabled) $('modeBuy').title = 'Set the Buy button + tracking selectors in Settings to enable';
}

async function activePalmstreetTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  if (!/palmstreet\.(app|com)/.test(tab.url)) return null;
  return tab;
}

function sendToTab(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(resp);
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randDelay(min, max) {
  return Math.floor(min + Math.random() * Math.max(1, max - min));
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

async function runQueue(mode) {
  stopRequested = false;
  const settings = await chrome.storage.sync.get(null);
  const tab = await activePalmstreetTab();
  if (!tab) { $('notOnPalmstreet').hidden = false; return; }

  $('progress').hidden = false;
  $('log').innerHTML = '';
  setProgress(0, 0);

  // Pull the order list from the content script.
  let orders;
  try {
    orders = await sendToTab(tab.id, { type: 'list' });
  } catch (e) {
    logRow(`Could not read orders: ${e.message}`, 'err');
    return;
  }
  if (!orders?.length) { logRow('No orders found on this page.', 'warn'); return; }

  setProgress(0, orders.length);
  let done = 0;
  let synced = 0;
  let skipped = 0;

  for (const o of orders) {
    if (stopRequested) { logRow('Stopped.', 'warn'); break; }

    const label = `${o.orderId}${o.recipient ? ` · ${o.recipient}` : ''}`;
    if (mode === 'buy' && !o.alreadyPurchased) {
      if (settings.confirmEachBuy && !confirm(`Buy USPS label for ${label}?`)) {
        logRow(`Skipped ${label}`, 'warn');
        skipped++;
        done++; setProgress(done, orders.length);
        continue;
      }
      try {
        const result = await sendToTab(tab.id, { type: 'buyAndScrape', orderId: o.orderId });
        if (result?.error) throw new Error(result.error);
        if (!result?.trackingNumber) {
          logRow(`No tracking after buy for ${label}`, 'err');
          done++; setProgress(done, orders.length);
          continue;
        }
        await postTracking(settings, o.orderId, result.trackingNumber);
        logRow(`Bought + synced ${label} → ${result.trackingNumber}`, 'ok');
        synced++;
      } catch (e) {
        logRow(`Buy failed for ${label}: ${e.message}`, 'err');
      }
    } else {
      // Sync-only mode, or buy-mode with already-purchased orders.
      try {
        const result = await sendToTab(tab.id, { type: 'scrape', orderId: o.orderId });
        if (result?.error) throw new Error(result.error);
        if (!result?.trackingNumber) {
          logRow(`No tracking visible for ${label}`, 'warn');
          done++; setProgress(done, orders.length);
          continue;
        }
        await postTracking(settings, o.orderId, result.trackingNumber);
        logRow(`Synced ${label} → ${result.trackingNumber}`, 'ok');
        synced++;
      } catch (e) {
        logRow(`Sync failed for ${label}: ${e.message}`, 'err');
      }
    }

    done++;
    setProgress(done, orders.length);
    await sleep(randDelay(settings.delayMin || 800, settings.delayMax || 2000));
  }

  logRow(`Done · synced ${synced}, skipped ${skipped}, processed ${done}/${orders.length}`, 'ok');
}

function postTracking(settings, orderId, trackingNumber) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'recordTracking', settings, orderId, trackingNumber },
      (resp) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        if (!resp?.ok) return reject(new Error(resp?.error || 'API error'));
        resolve(resp);
      },
    );
  });
}

init();
