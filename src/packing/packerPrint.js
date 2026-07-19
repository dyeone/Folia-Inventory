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

// ── destination preference (per device — it describes hardware plugged into
//    THIS iPad, so localStorage, not app_settings) ──────────────────────────

const DEST_KEY = 'folia.packerPrintDest';

export function getPrintDest() {
  try {
    return localStorage.getItem(DEST_KEY) === 'bridge' ? 'bridge' : 'ipad';
  } catch {
    return 'ipad';
  }
}

export function savePrintDest(dest) {
  try { localStorage.setItem(DEST_KEY, dest === 'bridge' ? 'bridge' : 'ipad'); } catch { /* private mode */ }
}

// ── iPad path: PDF → page images → in-page print via the OS sheet ──────────

// Render every page of a PDF to a PNG data URL at ~300 dpi (a 4×6 label →
// 1200×1800 px) so the carrier barcode stays crisp and scannable on paper.
async function pdfToPageImages(bytes) {
  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const urls = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 300 / 72 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      urls.push(canvas.toDataURL('image/png'));
      canvas.width = 0; canvas.height = 0; // release the backing store
    }
  } finally {
    try { await doc.cleanup?.(); } catch { /* best effort */ }
  }
  if (urls.length === 0) throw new Error('The label PDF has no pages');
  return urls;
}

// Drop the rendered pages into a print-only container and open the OS print
// sheet. The container (and its @media print rules that hide the app) stays in
// the DOM until afterprint so iPadOS can build its preview from it.
async function printImagesViaOsSheet(dataUrls) {
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
      @page { size: 4in 6in; margin: 0; }
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
  const cleanup = () => {
    if (done) return;
    done = true;
    window.removeEventListener('afterprint', cleanup);
    root.remove();
  };
  window.addEventListener('afterprint', cleanup);
  // Safety net — some WebKit builds skip afterprint when the sheet is
  // dismissed without printing.
  setTimeout(cleanup, 120_000);

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
  pdf.text('FOLIA PACKING', 2, 1.0, { align: 'center' });
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

export async function printTestLabel(dest, showToast) {
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
      });
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
