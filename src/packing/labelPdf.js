import { api } from '../api.js';

// Convert a data:application/pdf;base64,... URL into a Blob.
function dataUrlToBlob(dataUrl) {
  const base64 = dataUrl.split(',')[1] || '';
  const bytes = atob(base64);
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new Blob([buf], { type: 'application/pdf' });
}

// Write a full-tab PDF viewer into an already-open window and auto-trigger
// the print dialog once it renders. The src must be same-origin (a blob:
// URL) for the auto-print to fire — cross-origin iframes can't be printed
// programmatically. The PDF still shows inline either way, so the operator
// can print from the viewer's own controls if auto-print is blocked.
function renderAndPrint(win, src) {
  win.document.open();
  win.document.write(
    '<!doctype html><html><head><meta charset="utf-8"><title>Shipping label</title></head>' +
    '<body style="margin:0">' +
    '<iframe id="lbl" src="' + src + '" style="border:0;position:fixed;inset:0;width:100%;height:100%"></iframe>' +
    '<script>var f=document.getElementById("lbl");f.onload=function(){' +
    'try{f.contentWindow.focus();f.contentWindow.print();}catch(e){}};</scr' + 'ipt>' +
    '</body></html>'
  );
  win.document.close();
}

// Open a saved shipment PDF (label or slip) in a NEW TAB with the browser's
// inline PDF viewer and pop the print dialog — no file download.
//
// The window is opened synchronously (before any await) so the click's
// user-gesture carries through and pop-up blockers leave it alone. Storage
// signed URLs are fetched into a same-origin blob so the embedded viewer can
// auto-print; if that fetch is blocked by CORS we fall back to opening the
// signed URL directly (inline view, manual print).
export async function openLabelPdf(shipment, kind, showToast) {
  const win = window.open('', '_blank');
  if (win) {
    win.document.write('<!doctype html><title>Shipping label</title>' +
      '<body style="margin:0;font:14px system-ui;padding:1.5rem;color:#555">Preparing label…</body>');
  }
  try {
    const url = await api.getLabelUrl(shipment.id, kind);
    let src;
    if (url.startsWith('data:')) {
      src = URL.createObjectURL(dataUrlToBlob(url));
    } else {
      // Fetch the signed URL into a same-origin blob so auto-print works.
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`fetch ${res.status}`);
        src = URL.createObjectURL(await res.blob());
      } catch {
        src = url; // CORS / network fallback — open the URL directly.
      }
    }
    if (!win) { showToast?.('Allow pop-ups to print the label'); return; }
    renderAndPrint(win, src);
  } catch (e) {
    win?.close();
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
