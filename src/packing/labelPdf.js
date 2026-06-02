import { api } from '../api.js';

// Open a saved shipment PDF (label or slip) in a new tab so the operator
// can print it any time after purchase. Fetches a fresh signed URL each
// time (they expire). Falls back to a Blob download for legacy data: URLs
// (pre-Storage rows) since <a href="data:..."> downloads are flaky.
export async function openLabelPdf(shipment, kind, showToast) {
  try {
    const url = await api.getLabelUrl(shipment.id, kind);
    if (url.startsWith('data:')) {
      const base64 = url.split(',')[1] || '';
      const bytes = atob(base64);
      const buf = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
      const blob = new Blob([buf], { type: 'application/pdf' });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${kind}-${shipment.trackingNumber || shipment.id}.pdf`;
      a.click();
      URL.revokeObjectURL(blobUrl);
    } else {
      window.open(url, '_blank', 'noopener');
    }
  } catch (e) {
    showToast?.(e.message || `Could not open ${kind}`);
  }
}

// Copy a tracking number (or any text) to the clipboard with a toast.
export async function copyText(text, showToast, label = 'tracking') {
  try {
    await navigator.clipboard.writeText(text);
    showToast?.(`Copied ${label}`);
  } catch {
    showToast?.('Copy failed — try again');
  }
}
