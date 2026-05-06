// Content script — runs in the Palmstreet page context. The popup drives
// the flow by sending one `processOrder` message per box; this script
// performs the 8-step Palmstreet sequence:
//
//   1. click selOpenShipping     (go to "ready to ship" list)
//   2. type selSearchInput = buyerUsername
//   3a. click selOrderRow        (first match)
//   3b. click selContinue
//   4. type selWeightInput = weightOz
//   5. click selPurchaseButton
//   6. click selPayButton
//   7. extract href from selLabelLink, fetch the PDF bytes
//   8. extract href from selSlipLink, fetch the PDF bytes
//   read selTracking, return { trackingNumber, labelPdfBase64, slipPdfBase64 }
//
// All selectors come from chrome.storage.sync; each step has its own
// timeout. Failures abort cleanly with a clear error.

const POLL_INTERVAL_MS = 200;

async function getSettings() {
  return await chrome.storage.sync.get(null);
}

const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const $ = (s, r = document) => r.querySelector(s);
const text = (el) => (el?.textContent || '').trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randDelay = (min, max) => Math.floor((min || 0) + Math.random() * Math.max(1, (max || 0) - (min || 0)));

async function waitForSelector(selector, timeoutMs) {
  if (!selector) throw new Error('Selector not configured');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const el = $(selector);
    if (el) return el;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${selector}`);
}

// Wait for the first selector that has the given text content (substring,
// case-insensitive). Used to disambiguate when there are multiple order
// rows but we want the one matching the buyer username.
async function waitForRowMatching(selector, needle, timeoutMs) {
  const target = (needle || '').toLowerCase();
  if (!target) throw new Error('No username to match against');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const el of $$(selector)) {
      if (text(el).toLowerCase().includes(target)) return el;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`No matching order row for "${needle}"`);
}

// Type into an input as a real user would — fires input + change events
// so React/Vue/etc. controlled inputs see the new value.
async function typeInto(el, value) {
  el.focus();
  // Native setter for React-controlled inputs.
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, '');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  setter.call(el, String(value));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function fetchAsBase64(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Fetch ${url}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  // Convert to base64 (chunked to avoid stack overflow on big PDFs).
  let binary = '';
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function processOrder({ box, weightOz }, settings) {
  const t = settings.stepTimeoutMs || 20000;
  const sleepBetween = () => sleep(randDelay(settings.delayMin, settings.delayMax));

  // 1. Open the shipping list.
  if (settings.selOpenShipping) {
    const open = $(settings.selOpenShipping);
    if (open) { open.click(); await sleepBetween(); }
  }

  // 2. Search by buyer username.
  const searchInput = await waitForSelector(settings.selSearchInput, t);
  await typeInto(searchInput, box.buyerUsername || box.recipientName);
  await sleepBetween();

  // 3a. Click the matching order row.
  const row = await waitForRowMatching(settings.selOrderRow, box.buyerUsername || box.recipientName, t);
  row.click();
  await sleepBetween();

  // 3b. Click Continue.
  const cont = await waitForSelector(settings.selContinue, t);
  cont.click();
  await sleepBetween();

  // 4. Type the weight.
  const weightInput = await waitForSelector(settings.selWeightInput, t);
  await typeInto(weightInput, weightOz);
  await sleepBetween();

  // 5. Click Purchase Label.
  const purchase = await waitForSelector(settings.selPurchaseButton, t);
  purchase.click();
  await sleepBetween();

  // 6. Click Pay.
  const pay = await waitForSelector(settings.selPayButton, t);
  pay.click();
  await sleepBetween();

  // 7+8. Wait for the label + slip links, fetch each as PDF bytes.
  const labelEl = await waitForSelector(settings.selLabelLink, t);
  const slipEl = settings.selSlipLink ? await waitForSelector(settings.selSlipLink, t).catch(() => null) : null;
  const labelHref = labelEl.href || labelEl.getAttribute('href');
  if (!labelHref) throw new Error('Shipping label has no href to fetch');
  const slipHref = slipEl ? (slipEl.href || slipEl.getAttribute('href')) : null;

  const [labelPdfBase64, slipPdfBase64] = await Promise.all([
    fetchAsBase64(labelHref),
    slipHref ? fetchAsBase64(slipHref) : Promise.resolve(null),
  ]);

  // Tracking text — best-effort.
  let trackingNumber = '';
  if (settings.selTracking) {
    const trackEl = $(settings.selTracking);
    trackingNumber = text(trackEl);
  }

  // Optional: navigate back to the list for the next iteration.
  if (settings.selBackToList) {
    const back = $(settings.selBackToList);
    if (back) back.click();
  }

  return {
    trackingNumber,
    labelPdfBase64,
    slipPdfBase64,
    weightOz,
  };
}

// Light-touch sync mode: read tracking from the page without clicking
// anything. Useful after manual labels.
async function syncOnly({ box }, settings) {
  if (!settings.selTracking) throw new Error('Tracking selector not configured');
  // Scope tracking lookup to a row matching the buyer username when the
  // page is the orders list; otherwise fall back to the first match
  // anywhere on the page (post-payment screens).
  let trackingEl = null;
  if (settings.selOrderRow) {
    const row = $$(settings.selOrderRow).find(r =>
      text(r).toLowerCase().includes(String(box.buyerUsername || '').toLowerCase()),
    );
    if (row) trackingEl = $(settings.selTracking, row);
  }
  trackingEl = trackingEl || $(settings.selTracking);
  return { trackingNumber: text(trackingEl) };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const settings = await getSettings();
      if (msg?.type === 'ping') return sendResponse({ ok: true });
      if (msg?.type === 'processOrder') {
        const r = await processOrder(msg.payload, settings);
        return sendResponse({ ok: true, ...r });
      }
      if (msg?.type === 'syncOnly') {
        const r = await syncOnly(msg.payload, settings);
        return sendResponse({ ok: true, ...r });
      }
      sendResponse({ ok: false, error: `Unknown message: ${msg?.type}` });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
});
