// Background service worker. Centralizes Folia API calls so the
// extension's auth (userId) and the API base URL aren't repeated
// across pages.

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

async function get(settings, path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${settings.apiBase}${path}${sep}userId=${encodeURIComponent(settings.userId)}`);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

async function post(settings, path, body) {
  const res = await fetch(`${settings.apiBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, userId: settings.userId }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}
