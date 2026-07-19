import { api } from '../api.js';
import { bridgeOnlineNow, printPdfViaBridge, bytesToBase64 } from '../labels/useBridgePrint.js';

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

// Fetch a label's PDF bytes from a signed Storage URL (or decode a legacy
// data: URL). Used by the bridge path, which needs the raw bytes to base64.
// Throws on a failed fetch (e.g. CORS) so the caller falls back to browser.
export async function urlToBytes(url) {
  if (url.startsWith('data:')) {
    return new Uint8Array(await dataUrlToBlob(url).arrayBuffer());
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
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
//   Preferred  → direct to the operator's printer via the Mac-app bridge
//                (kind 'label' → the label printer, 'slip' → the slip printer).
//   Fallback   → bridge offline / unreachable PDF:
//                Chromium/Firefox → silent hidden-iframe print (no tab).
//                Safari           → open the PDF in a tab; print from the viewer.
export async function openLabelPdf(shipment, kind, showToast) {
  // Carrier shipping labels (kind 'label') print on the 4×6 shipping-label
  // printer, which is separate hardware from the 2×1 item-label printer — so
  // they use the 'shipping' role, not 'label'. Slips use the slip printer.
  const role = kind === 'slip' ? 'slip' : 'shipping';
  // Carrier labels are 4×6 — force that media so the printer uses the label
  // size instead of its CUPS default (which clips the label to "half"). Slips
  // are native (80mm roll). Mirrors the item-label sheets' Custom.2x1in.
  const media = kind === 'slip' ? undefined : 'Custom.4x6in';
  const safari = isSafari();
  // Open the Safari tab synchronously so the click's user-gesture carries
  // through (avoids the pop-up blocker). If we end up printing via the bridge
  // we close this unused placeholder; otherwise we navigate it.
  const win = safari ? window.open('', '_blank') : null;
  try {
    const url = await api.getLabelUrl(shipment.id, kind);

    // 1) Direct print via the bridge (the Mac app). Force the 4×6 carrier-label
    //    media so it prints full size, not clipped to the printer's CUPS default.
    if (await bridgeOnlineNow()) {
      try {
        const res = await printPdfViaBridge({
          pdfBase64: bytesToBase64(await urlToBytes(url)), role, media,
        });
        win?.close();
        showToast?.(`Sent ${kind} to ${res?.printer || 'printer'}`);
        return;
      } catch (e) {
        // Bridge reachable but the print failed — fall through to browser print
        // so the label still comes out, and say why direct didn't work.
        showToast?.(`Printer error — using browser (${e.message})`);
      }
    }

    // 2) Browser fallback.
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

// Print many saved shipping-label PDFs as a single document — one print
// dialog for the whole batch instead of one per label. Fetches each label's
// PDF, merges them with pdf-lib (lossless page copy, so barcodes stay crisp
// and scannable), then prints the combined PDF the same way openLabelPdf does
// (Chromium/Firefox: silent hidden iframe; Safari: open in a tab).
export async function printShippingLabels(boxIds, showToast) {
  const ids = Array.from(boxIds || []);
  if (ids.length === 0) { showToast?.('No shipping labels to print'); return; }

  const safari = isSafari();
  // Open the Safari tab synchronously so the click's user-gesture carries
  // through the async work below (avoids the pop-up blocker). Closed if we end
  // up printing via the bridge instead.
  const win = safari ? window.open('', '_blank') : null;

  // 1) Direct print via the bridge — one job per label. Each label PDF is small
  //    so it fits the enqueue size cap; the bridge prints them FIFO, in order,
  //    so no client-side merge is needed.
  if (await bridgeOnlineNow()) {
    let printed = 0, failed = 0, printer;
    for (const id of ids) {
      try {
        const url = await api.getLabelUrl(id, 'label');
        const res = await printPdfViaBridge({
          pdfBase64: bytesToBase64(await urlToBytes(url)), role: 'shipping', media: 'Custom.4x6in',
        });
        printer = res?.printer || printer;
        printed++;
      } catch (e) {
        failed++;
        console.error('[printShippingLabels] bridge print failed for', id, e);
      }
    }
    if (printed > 0) {
      win?.close();
      showToast?.(failed > 0
        ? `Sent ${printed} label${printed === 1 ? '' : 's'} to ${printer || 'printer'} — ${failed} failed`
        : `Sent ${printed} label${printed === 1 ? '' : 's'} to ${printer || 'printer'}`);
      return;
    }
    // Nothing printed via the bridge — fall through to the browser merge/print.
    showToast?.('Printer error — using browser');
  }

  // 2) Browser fallback: merge all labels into one PDF and print once.
  try {
    // Fetch each label's PDF bytes (signed Storage URL, or legacy data: URL).
    const buffers = [];
    let failed = 0;
    for (const id of ids) {
      try {
        const url = await api.getLabelUrl(id, 'label');
        if (url.startsWith('data:')) {
          buffers.push(await dataUrlToBlob(url).arrayBuffer());
        } else {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`fetch ${res.status}`);
          buffers.push(await res.arrayBuffer());
        }
      } catch (e) {
        failed++;
        console.error('[printShippingLabels] could not load label for', id, e);
      }
    }
    if (buffers.length === 0) {
      win?.close();
      showToast?.('Could not load any labels');
      return;
    }

    // Merge into one PDF — lossless, so vector (ShipStation/Shippo) labels and
    // image (Palmstreet) labels both keep full fidelity.
    const { PDFDocument } = await import('pdf-lib');
    const merged = await PDFDocument.create();
    let mergedCount = 0;
    for (const buf of buffers) {
      try {
        const src = await PDFDocument.load(buf, { ignoreEncryption: true });
        const pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach((p) => merged.addPage(p));
        mergedCount++;
      } catch (e) {
        failed++;
        console.error('[printShippingLabels] could not merge a label', e);
      }
    }
    if (merged.getPageCount() === 0) {
      win?.close();
      showToast?.('Could not read any labels');
      return;
    }

    const blobUrl = URL.createObjectURL(
      new Blob([await merged.save()], { type: 'application/pdf' }),
    );
    if (safari) {
      if (!win) { showToast?.('Allow pop-ups to print labels'); return; }
      win.location.href = blobUrl;
    } else {
      printPdfBlob(blobUrl);
    }
    showToast?.(failed > 0
      ? `Printing ${mergedCount} label${mergedCount === 1 ? '' : 's'} — ${failed} couldn't be loaded`
      : `Printing ${mergedCount} label${mergedCount === 1 ? '' : 's'}`);
  } catch (e) {
    win?.close();
    showToast?.(e.message || 'Could not print labels');
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
