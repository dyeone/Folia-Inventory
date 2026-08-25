import { api } from '../api.js';
import { bridgeOnlineNow, printPdfViaBridge, bytesToBase64, pdfToBase64 } from '../labels/useBridgePrint.js';
import { urlToBytes } from './labelPdf.js';
import { getPdfjs } from './pdfjsLoader.js';

// Label printing from the packer's iPad.
//
// The packing table has its own label printer plugged into the iPad over USB.
// Safari can't talk to USB hardware or enumerate printers, so "print" here
// means the iPadOS print sheet: we render the label PDF to images inside the
// page (Safari won't print an embedded PDF — see labelPdf.js), hide the app
// with @media print, and call window.print(). The packer picks the USB/AirPrint
// printer in that sheet the first time; iPadOS remembers it afterwards.
//
// The alternative destination is the shipping desk's 4×6 label printer via the
// Folia Bridge (Mac app) — the same durable print queue the Shipping tab uses.

// ── destination preferences (per device — they describe hardware plugged
//    into THIS iPad, so localStorage, not app_settings) ────────────────────
//
// Two independent destinations, because 4×6 shipping labels and 2×1 box tags
// usually live on different printers (e.g. labels on the iPad's USB printer,
// tags on the shipping desk's item-label printer via the bridge). The legacy
// single setting seeds both so an already-configured iPad keeps its choice.

const LEGACY_DEST_KEY = 'folia.packerPrintDest';
const DEST_KEYS = {
  shipping: 'folia.packerPrintDest.shipping',   // 4×6 carrier labels
  boxtag: 'folia.packerPrintDest.boxtag',       // 2×1 B-XXXXXX tags
  itemlabel: 'folia.packerPrintDest.itemlabel', // 2×1 plant labels (burrito wrap)
};

function readDest(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === 'bridge' || v === 'ipad' ? v : fallback;
  } catch {
    return fallback;
  }
}

export function getPrintDests() {
  return {
    // The legacy single setting governed 4×6 shipping labels in practice, so
    // it seeds only `shipping`. Box tags default to the bridge — the desk's
    // item-label printer is the only known 2×1 device; defaulting an iPad
    // configured for 4×6 labels would print tags on the wrong stock.
    shipping: readDest(DEST_KEYS.shipping, readDest(LEGACY_DEST_KEY, 'ipad')),
    boxtag: readDest(DEST_KEYS.boxtag, 'bridge'),
    // Plant labels default to the bridge for the same reason as box tags —
    // the desk's item-label printer is the only known 2×1 device.
    itemlabel: readDest(DEST_KEYS.itemlabel, 'bridge'),
  };
}

export function savePrintDest(kind, dest) {
  const key = DEST_KEYS[kind];
  if (!key) return;
  try { localStorage.setItem(key, dest === 'bridge' ? 'bridge' : 'ipad'); } catch { /* private mode */ }
}

// ── burrito wrap flow preference (per device, like the destinations) ───────
//
// On: scanning a plant starts a wrap — the app prints that plant's label,
// the packer wraps + applies it, and scanning the fresh label completes the
// pack. Off: today's single-scan pack. Default ON — the wrap verify exists
// because wrong labels went onto burritos.

const WRAP_FLOW_KEY = 'folia.packerWrapFlow';

export function getWrapFlow() {
  try { return localStorage.getItem(WRAP_FLOW_KEY) !== 'off'; } catch { return true; }
}

export function saveWrapFlow(on) {
  try { localStorage.setItem(WRAP_FLOW_KEY, on ? 'on' : 'off'); } catch { /* private mode */ }
}

// ── iPad path: PDF → page images → in-page print via the OS sheet ──────────

// Render every page of a PDF to a PNG data URL at ~300 dpi (a 4×6 label →
// 1200×1800 px) so the carrier barcode stays crisp and scannable on paper.
// The scale is bounded so an oversized page (e.g. a letter-size carrier PDF)
// can't blow past iOS Safari's canvas limits and silently render blank, and
// the page count is capped so a runaway multi-page PDF can't hold dozens of
// full-res PNGs in memory at once.
const MAX_RENDER_DIM = 2400;
const MAX_PRINT_PAGES = 10;

async function pdfToPageImages(bytes) {
  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const urls = [];
  try {
    const pages = Math.min(doc.numPages, MAX_PRINT_PAGES);
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(300 / 72, MAX_RENDER_DIM / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      urls.push(canvas.toDataURL('image/png'));
      canvas.width = 0; canvas.height = 0; // release the backing store
    }
  } finally {
    // destroy(), not cleanup() — it frees the parsed document AND terminates
    // the per-document worker; cleanup() leaks a Web Worker on every print.
    try { await doc.destroy(); } catch { /* best effort */ }
  }
  if (urls.length === 0) throw new Error('The label PDF has no pages');
  return urls;
}

// Drop the rendered pages into a print-only container and open the OS print
// sheet. The container (and its @media print rules that hide the app) stays in
// the DOM until afterprint so iPadOS can build its preview from it.
//
// Serialized: two concurrent jobs would purge each other's root and print the
// wrong document at the wrong page size (label vs tag). The chain resolves
// when window.print() returns, so queued jobs wait seconds, not the 120s
// cleanup window. A failed job must not poison the queue.
let osPrintQueue = Promise.resolve();
function printImagesViaOsSheet(dataUrls, opts) {
  const run = osPrintQueue.then(() => osPrintNow(dataUrls, opts));
  osPrintQueue = run.catch(() => {});
  return run;
}

async function osPrintNow(dataUrls, { pageSize = '4in 6in' } = {}) {
  // A dismissed print sheet can skip afterprint and leave the previous root
  // in the DOM; if it survived, the next job would print its pages too — the
  // packer could pull a stale label off the printer and stick it on the wrong
  // box. Purge any leftovers before building the new root.
  document.querySelectorAll('.packer-print-root').forEach((el) => el.remove());

  const root = document.createElement('div');
  root.className = 'packer-print-root';
  const style = document.createElement('style');
  style.textContent = `
    .packer-print-root { display: none; }
    @media print {
      body > *:not(.packer-print-root) { display: none !important; }
      .packer-print-root { display: block !important; }
      .packer-print-root img { display: block; width: 100%; break-after: page; page-break-after: always; }
      .packer-print-root img:last-of-type { break-after: auto; page-break-after: auto; }
      @page { size: ${pageSize}; margin: 0; }
    }
  `;
  root.appendChild(style);

  const images = dataUrls.map((u) => {
    const img = document.createElement('img');
    img.src = u;
    root.appendChild(img);
    return img;
  });
  document.body.appendChild(root);
  await Promise.all(images.map((img) => img.decode().catch(() => {})));

  let done = false;
  let timer = null;
  const cleanup = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    window.removeEventListener('afterprint', cleanup);
    root.remove();
  };
  window.addEventListener('afterprint', cleanup);
  // Safety net — some WebKit builds skip afterprint when the sheet is
  // dismissed without printing.
  timer = setTimeout(cleanup, 120_000);

  window.print();
}

// ── printing ───────────────────────────────────────────────────────────────

async function printPdfBytes(bytes, dest, showToast) {
  if (dest === 'bridge') {
    if (!(await bridgeOnlineNow())) {
      showToast?.('Shipping desk printer is offline — is the Mac app running? (Or switch the printer to "This iPad".)', 5000);
      return false;
    }
    const res = await printPdfViaBridge({
      pdfBase64: bytesToBase64(bytes), role: 'shipping', media: 'Custom.4x6in',
    });
    showToast?.(`Sent label to ${res?.printer || 'the shipping desk printer'}`);
    return true;
  }
  await printImagesViaOsSheet(await pdfToPageImages(bytes));
  return true;
}

// Print the shipping label already imported/bought for a box. Resolves to true
// once the label was handed off (bridge spooled it / OS sheet opened).
export async function printBoxLabel(boxId, dest, showToast) {
  try {
    const url = await api.getLabelUrl(boxId, 'label');
    return await printPdfBytes(await urlToBytes(url), dest, showToast);
  } catch (e) {
    showToast?.(e.message || 'Could not print the label', 4500);
    return false;
  }
}

// ── box tag (2×1 B-XXXXXX barcode label) ───────────────────────────────────

// Print one box's 2"×1" tag — the same label the Shipping tab batch-prints
// (brand · carrier header, B-XXXXXX code, CODE128 barcode). Bridge routes to
// the desk's 2×1 item-label printer (role 'label'); the iPad path opens the
// OS print sheet like shipping labels do.
export async function printBoxTag(box, dest, showToast) {
  try {
    // Lazy: keeps jspdf/jsbarcode out of the packer's initial chunk.
    const { buildBoxLabelPdf } = await import('../labels/boxLabelPdf.js');
    const pdf = buildBoxLabelPdf([box]);
    if (dest === 'bridge') {
      if (!(await bridgeOnlineNow())) {
        showToast?.('Shipping desk printer is offline — is the Mac app running? (Or switch the printer to "This iPad".)', 5000);
        return false;
      }
      const res = await printPdfViaBridge({
        pdfBase64: pdfToBase64(pdf), role: 'label', media: 'Custom.2x1in',
      });
      showToast?.(`Sent box tag to ${res?.printer || 'the shipping desk printer'}`);
      return true;
    }
    await printImagesViaOsSheet(
      await pdfToPageImages(new Uint8Array(pdf.output('arraybuffer'))),
      { pageSize: '2in 1in' },
    );
    return true;
  } catch (e) {
    showToast?.(e.message || 'Could not print the box tag', 4500);
    return false;
  }
}

// Print ONE plant's 2"×1" label — the same label the live-sale flow prints
// (big lineup # + WK chip, name, SKU barcode) — for the burrito wrap step:
// the packer wraps the plant in paper, applies this fresh label, and
// scan-verifies it against the plant. Printed without seller/sale context
// (see buildPdf's export note): seller line omitted, WK chip from soldAt.
// Batch variant for the receiving pane: one call prints a whole species
// line's labels. Bridge jobs are chunked like LabelSheet's printChunked —
// the base64 PDF rides through the Vercel enqueue request, so a big batch
// can't go in one job. The iPad path chunks too: pdfToPageImages hard-caps
// rendering at MAX_PRINT_PAGES (a memory guard sized for 4×6 carrier PDFs),
// so one big batch would silently print only its first pages — one OS
// sheet per chunk instead. No success toast on the bridge path: the bridge
// poll can resolve tens of seconds later, stomping whatever warning the
// (single-slot) toast is showing by then.
const LABELS_PER_JOB = 60;

export async function printItemLabels(items, dest, showToast) {
  if (!items?.length) return true;
  try {
    // Lazy: keeps jspdf/qrcode out of the packer's initial chunk.
    const { buildItemLabelPdf } = await import('../labels/itemLabelPdf.js');
    if (dest === 'bridge') {
      if (!(await bridgeOnlineNow())) {
        showToast?.('Label printer is offline — is the Mac app running? (Or switch plant labels to "This iPad".)', 5000);
        return false;
      }
      for (let i = 0; i < items.length; i += LABELS_PER_JOB) {
        const pdf = buildItemLabelPdf(items.slice(i, i + LABELS_PER_JOB));
        await printPdfViaBridge({
          pdfBase64: pdfToBase64(pdf), role: 'label', media: 'Custom.2x1in',
        });
      }
      return true;
    }
    for (let i = 0; i < items.length; i += MAX_PRINT_PAGES) {
      const pdf = buildItemLabelPdf(items.slice(i, i + MAX_PRINT_PAGES));
      await printImagesViaOsSheet(
        await pdfToPageImages(new Uint8Array(pdf.output('arraybuffer'))),
        { pageSize: '2in 1in' },
      );
    }
    return true;
  } catch (e) {
    showToast?.(e.message || 'Could not print the plant labels', 4500);
    return false;
  }
}

// The burrito-wrap flow's single-label print — same pipeline, one item.
export async function printItemLabel(item, dest, showToast) {
  return printItemLabels([item], dest, showToast);
}

// ── test label ─────────────────────────────────────────────────────────────

// A 4×6 test page that goes through the exact same pipeline as a real label,
// so a good test print means real labels will come out right. The edge frame
// makes clipping / wrong media size obvious at a glance.
async function buildTestLabelPdf(destName) {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'in', format: [4, 6], orientation: 'portrait' });
  pdf.setLineWidth(0.02);
  pdf.rect(0.08, 0.08, 3.84, 5.84);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(22);
  pdf.text('BAE-GIN PACKING', 2, 1.0, { align: 'center' });
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(14);
  pdf.text('Printer test label', 2, 1.4, { align: 'center' });
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(44);
  pdf.text('4 × 6 in', 2, 3.1, { align: 'center' });
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(12);
  pdf.text(destName, 2, 4.2, { align: 'center' });
  pdf.text(new Date().toLocaleString(), 2, 4.5, { align: 'center' });
  pdf.setFontSize(10);
  pdf.setTextColor(110);
  pdf.text('If the frame is cut off, check the printer’s paper size.', 2, 5.6, { align: 'center' });
  return pdf;
}

// isCancelled lets the settings sheet stop the bridge status poll when it
// closes mid-test, so no zombie polling or late toasts after dismissal.
// A 2×1 test tag through the same pipeline as real box tags. The edge frame
// makes clipping / wrong media size obvious; no barcode, so a stray test
// print can never be mistaken for (or scanned as) a real box tag.
async function buildTestTagPdf(destName) {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'in', format: [2, 1], orientation: 'landscape' });
  pdf.setLineWidth(0.015);
  pdf.rect(0.05, 0.05, 1.9, 0.9);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.text('BOX TAG TEST · 2 × 1 in', 1, 0.35, { align: 'center' });
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7);
  pdf.text(destName, 1, 0.55, { align: 'center' });
  pdf.text('If the frame is cut off, check the label size.', 1, 0.75, { align: 'center' });
  return pdf;
}

export async function printTestTag(dest, showToast, isCancelled) {
  try {
    const pdf = await buildTestTagPdf(dest === 'bridge' ? 'via the shipping desk (Mac)' : 'via this iPad');
    if (dest === 'bridge') {
      if (!(await bridgeOnlineNow())) {
        showToast?.('Shipping desk printer is offline — is the Mac app running?', 4500);
        return false;
      }
      const res = await printPdfViaBridge({
        pdfBase64: pdfToBase64(pdf), role: 'label', media: 'Custom.2x1in',
      }, isCancelled);
      if (res?.cancelled) return true;
      showToast?.(`Sent test tag to ${res?.printer || 'the shipping desk printer'}`);
      return true;
    }
    await printImagesViaOsSheet(
      await pdfToPageImages(new Uint8Array(pdf.output('arraybuffer'))),
      { pageSize: '2in 1in' },
    );
    return true;
  } catch (e) {
    showToast?.(e.message || 'Could not print the test tag', 4500);
    return false;
  }
}

export async function printTestLabel(dest, showToast, isCancelled) {
  try {
    const destName = dest === 'bridge' ? 'Destination: shipping desk (Mac)' : 'Destination: this iPad';
    const pdf = await buildTestLabelPdf(destName);
    if (dest === 'bridge') {
      if (!(await bridgeOnlineNow())) {
        showToast?.('Shipping desk printer is offline — is the Mac app running?', 4500);
        return false;
      }
      const res = await printPdfViaBridge({
        pdfBase64: pdfToBase64(pdf), role: 'shipping', media: 'Custom.4x6in',
      }, isCancelled);
      if (res?.cancelled) return true;
      showToast?.(`Sent test label to ${res?.printer || 'the shipping desk printer'}`);
      return true;
    }
    await printImagesViaOsSheet(await pdfToPageImages(new Uint8Array(pdf.output('arraybuffer'))));
    return true;
  } catch (e) {
    showToast?.(e.message || 'Could not print the test label', 4500);
    return false;
  }
}
