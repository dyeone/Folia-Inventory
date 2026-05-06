// Background service worker. Centralizes the network call to the Folia
// Inventory API so we have one place to change the endpoint and so the
// auth user id never lives in the page context.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'recordTracking') return false;

  (async () => {
    try {
      const { settings, orderId, trackingNumber } = msg;
      if (!settings?.apiBase || !settings?.userId) {
        throw new Error('API base or userId not configured');
      }
      const res = await fetch(`${settings.apiBase}/api/shipments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'record-tracking',
          matchByOrderId: String(orderId),
          trackingNumber,
          userId: settings.userId,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      sendResponse({ ok: true, shipment: data?.shipment });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || 'Request failed' });
    }
  })();

  // Indicate async response.
  return true;
});
