// Content script — runs in the Palmstreet page context. Exposes three
// message handlers:
//   - count: how many order rows visible right now
//   - list:  scrape order rows into [{ orderId, recipient, alreadyPurchased }]
//   - scrape: read the tracking number off a single order row
//   - buyAndScrape: click Buy, wait for tracking, return it
//
// All DOM lookups go through CSS selectors stored in chrome.storage.sync,
// so the operator can repair the extension when Palmstreet changes their
// HTML without touching code.

const MAX_WAIT_MS = 30000;
const POLL_INTERVAL_MS = 250;

async function getSettings() {
  return await chrome.storage.sync.get(null);
}

function $$(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}
function $(selector, root = document) {
  return root.querySelector(selector);
}

function textOf(el) {
  return (el?.textContent || '').trim();
}

// Find all order rows on the current page.
function rows(settings) {
  if (!settings.selOrderRow) return [];
  return $$(settings.selOrderRow);
}

function rowFor(orderId, settings) {
  for (const row of rows(settings)) {
    const idEl = settings.selOrderId ? $(settings.selOrderId, row) : null;
    if (textOf(idEl) === String(orderId)) return row;
  }
  return null;
}

function readOrder(row, settings) {
  const orderId = textOf($(settings.selOrderId, row));
  // Recipient is opportunistic — surface it if present so the popup can
  // render a friendlier label, but don't fail when the selector isn't set.
  const recipient = '';
  const alreadyPurchased = !!(settings.selPurchased && $(settings.selPurchased, row));
  return { orderId, recipient, alreadyPurchased };
}

// Wait until predicate() returns truthy or we time out.
async function waitFor(predicate, timeoutMs = MAX_WAIT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = predicate();
    if (v) return v;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function scrapeTracking(orderId, settings) {
  const row = rowFor(orderId, settings);
  if (!row) throw new Error(`Order ${orderId} not on page`);
  if (!settings.selTracking) throw new Error('Tracking selector not configured');
  const el = $(settings.selTracking, row);
  const tracking = textOf(el);
  if (!tracking) return null;
  return tracking;
}

async function buyAndScrape(orderId, settings) {
  const row = rowFor(orderId, settings);
  if (!row) throw new Error(`Order ${orderId} not on page`);
  if (!settings.selBuyButton) throw new Error('Buy button selector not configured');
  if (!settings.selTracking) throw new Error('Tracking selector not configured');

  // Skip if Palmstreet already shows tracking on this row.
  const existing = textOf($(settings.selTracking, row));
  if (existing) return existing;

  const button = $(settings.selBuyButton, row);
  if (!button) throw new Error('Buy button not found in this row');

  // Click. Palmstreet's button likely opens a modal — the script just
  // clicks once and waits; if confirmation dialogs appear, the operator's
  // confirm-each setting in the extension popup gates the next call.
  button.click();

  // Wait for the tracking element to appear in the same row. Some
  // Palmstreet flows replace the row in place, so re-resolve on each tick.
  const tracking = await waitFor(() => {
    const fresh = rowFor(orderId, settings);
    if (!fresh) return null;
    return textOf($(settings.selTracking, fresh)) || null;
  });
  return tracking;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const settings = await getSettings();
      if (msg?.type === 'count') {
        return sendResponse(rows(settings).length);
      }
      if (msg?.type === 'list') {
        return sendResponse(
          rows(settings)
            .map(r => readOrder(r, settings))
            .filter(o => o.orderId)
        );
      }
      if (msg?.type === 'scrape') {
        const trackingNumber = await scrapeTracking(msg.orderId, settings);
        return sendResponse({ trackingNumber });
      }
      if (msg?.type === 'buyAndScrape') {
        const trackingNumber = await buyAndScrape(msg.orderId, settings);
        return sendResponse({ trackingNumber });
      }
      sendResponse({ error: `Unknown message: ${msg?.type}` });
    } catch (e) {
      sendResponse({ error: e?.message || String(e) });
    }
  })();
  return true; // async response
});
