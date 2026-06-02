import { api } from '../api.js';

// Convert a data:application/pdf;base64,... URL into a Blob.
function dataUrlToBlob(dataUrl) {
  const base64 = dataUrl.split(',')[1] || '';
  const bytes = atob(base64);
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new Blob([buf], { type: 'application/pdf' });
}

// Print a same-origin PDF blob via a hidden iframe. The iframe's document
// IS the PDF, so the print dialog renders the label itself — no new tab, no
// wrapper page (which printed as blank pages before). The blob must be
// same-origin for contentWindow.print() to be allowed.
function printPdfBlob(blobUrl) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  // Off-screen (not display:none / visibility:hidden) so the PDF fully loads
  // and the print job captures it.
  iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:0;height:0;border:0';

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    setTimeout(() => { iframe.remove(); URL.revokeObjectURL(blobUrl); }, 1000);
  };

  iframe.onload = () => {
    // Small delay lets the PDF plugin finish laying out before we print.
    setTimeout(() => {
      try {
        const win = iframe.contentWindow;
        win.focus();
        win.onafterprint = cleanup;
        win.print();
        // Fallback cleanup if onafterprint never fires (PDF viewers vary).
        setTimeout(cleanup, 60000);
      } catch {
        // Same-origin print blocked — open the PDF so the operator can print.
        window.open(blobUrl, '_blank', 'noopener');
        cleanup();
      }
    }, 250);
  };

  iframe.src = blobUrl;
  document.body.appendChild(iframe);
}

// Print a saved shipment PDF (label or slip): pops the print dialog directly,
// no file download and no visible tab. Inline (data:) labels become a blob;
// Storage signed URLs are fetched into a same-origin blob so the hidden
// iframe can print them. If the fetch is blocked (CORS), we fall back to
// opening the PDF in a tab so it can still be printed manually.
export async function openLabelPdf(shipment, kind, showToast) {
  try {
    const url = await api.getLabelUrl(shipment.id, kind);
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
