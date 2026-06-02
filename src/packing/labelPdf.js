import { api } from '../api.js';

// Safari (desktop + iOS) blocks silent scripted printing: window.print()
// pops a "do you want to print this webpage?" confirmation and targets the
// page, not an embedded PDF. So in Safari we open the label in a tab and let
// the operator print from the native PDF viewer (correct label, no prompt).
// Everywhere else we print silently via a hidden iframe.
function isSafari() {
  const ua = navigator.userAgent;
  return /safari/i.test(ua) && !/chrome|chromium|crios|android|edg|fxios|firefox/i.test(ua);
}

// Convert a data:application/pdf;base64,... URL into a Blob.
function dataUrlToBlob(dataUrl) {
  const base64 = dataUrl.split(',')[1] || '';
  const bytes = atob(base64);
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new Blob([buf], { type: 'application/pdf' });
}

// Print a same-origin PDF blob via a hidden iframe (Chromium/Firefox). The
// iframe's document IS the PDF, so the print dialog renders the label only —
// no tab, no wrapper page.
function printPdfBlob(blobUrl) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:0;height:0;border:0';

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    setTimeout(() => { iframe.remove(); URL.revokeObjectURL(blobUrl); }, 1000);
  };

  iframe.onload = () => {
    setTimeout(() => {
      try {
        const win = iframe.contentWindow;
        win.focus();
        win.onafterprint = cleanup;
        win.print();
        setTimeout(cleanup, 60000);
      } catch {
        window.open(blobUrl, '_blank', 'noopener');
        cleanup();
      }
    }, 250);
  };

  iframe.src = blobUrl;
  document.body.appendChild(iframe);
}

// Print a saved shipment PDF (label or slip).
//   Chromium/Firefox → silent hidden-iframe print (no tab, no download).
//   Safari           → open the PDF in a tab; print from the native viewer.
export async function openLabelPdf(shipment, kind, showToast) {
  const safari = isSafari();
  // Open the Safari tab synchronously so the click's user-gesture carries
  // through (avoids the pop-up blocker); we navigate it once we have the URL.
  const win = safari ? window.open('', '_blank') : null;
  try {
    const url = await api.getLabelUrl(shipment.id, kind);

    if (safari) {
      if (!win) { showToast?.('Allow pop-ups to print the label'); return; }
      // Signed Storage URLs render inline in Safari's PDF viewer. (data:
      // URLs are blocked by Safari, but all labels are backfilled to
      // Storage, so getLabelUrl returns an https URL.)
      win.location.href = url.startsWith('data:')
        ? URL.createObjectURL(dataUrlToBlob(url))
        : url;
      return;
    }

    if (url.startsWith('data:')) {
      printPdfBlob(URL.createObjectURL(dataUrlToBlob(url)));
      return;
    }
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      printPdfBlob(URL.createObjectURL(await res.blob()));
    } catch {
      window.open(url, '_blank', 'noopener'); // CORS fallback — print manually
    }
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
