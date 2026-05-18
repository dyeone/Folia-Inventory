import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Printer, Download, X, Loader2 } from 'lucide-react';
import { jsPDF } from 'jspdf';
import { shortBoxCode } from './boxCode.js';

// Per-box shipping slip — what goes inside the package so the customer
// sees a manifest of what they ordered.
//
// Target printer: Star TSP100III thermal receipt printer.
//   paper width:   80mm
//   printable:     72mm (4mm margin each side, ~576 dots at 203 dpi)
//   length:        continuous roll (variable)
//
// jsPDF is set to mm units with a pre-calculated total height from the
// item count, so the receipt is auto-sized and the cutter trims cleanly
// without a long blank tail.

const SLIP_W_MM = 80;
const SLIP_MARGIN = 4;
const SLIP_PRINT_W = SLIP_W_MM - SLIP_MARGIN * 2; // 72mm

// Height budget per section (mm). Used both for total-height
// pre-calculation and as the y-cursor advance after each block.
const H = {
  margin: SLIP_MARGIN,
  // Logo image height + a small bottom gap. No separate caption beneath
  // — the logo already carries the brand mark, the line of text under it
  // was redundant and ate vertical space on a thermal slip.
  logo: 42,
  divider: 3,
  customerBlock: 14,
  // Box code + carrier + date now share one line, so the block is one
  // text line tall plus a small bottom gap.
  boxBlock: 8,
  itemsHeader: 5,
  // SKU + name + qty on two tight rows.
  itemRow: 7,
  // Single-line footer (was two lines).
  footer: 7,
};

// Logo image is drawn centered at this size (mm). H.logo above must be
// >= this + a few mm of breathing room.
const LOGO_SIZE_MM = 40;

// Convert public/logo.png → 1-bit black-on-transparent data URL,
// cached at module scope so a session of repeated prints doesn't
// re-fetch + re-decode.
//
// The threshold pass matters because the TSP100III is a 1-bit thermal
// printer: any grayscale gets dithered into mottled patches that look
// ugly on a slip. We pre-convert to solid black silhouette + transparent
// background so the bitmap reaches the driver already binarized and
// prints as a crisp logo.
const LOGO_LUMA_THRESHOLD = 160;  // pixels lighter than this → transparent
let _logoDataUrlCache = null;
function loadLogoDataUrl() {
  if (_logoDataUrlCache) return Promise.resolve(_logoDataUrlCache);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
          // Rec.601 luminance — close enough for a 2-color decision.
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          if (a < 128 || lum > LOGO_LUMA_THRESHOLD) {
            data[i + 3] = 0;
          } else {
            data[i] = 0;
            data[i + 1] = 0;
            data[i + 2] = 0;
            data[i + 3] = 255;
          }
        }
        ctx.putImageData(imageData, 0, 0);
        _logoDataUrlCache = canvas.toDataURL('image/png');
        resolve(_logoDataUrlCache);
      } catch {
        resolve(null);
      }
    };
    // Fall through with a null logo rather than blocking the print. The
    // slip is still readable without the brand mark on top.
    img.onerror = () => resolve(null);
    img.src = '/logo.png';
  });
}

function formatDate(d) {
  try {
    return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

async function buildPdf(box) {
  const visibleItems = box.items.filter(i => !i.deletedAt);
  // Order: still-sold (about to ship) first, then already-shipped.
  // Same intent as the on-screen packing list.
  const itemOrder = (i) => (i.status === 'sold' ? 0 : 1);
  const items = [...visibleItems].sort((a, b) => itemOrder(a) - itemOrder(b));

  const totalH =
    H.margin * 2 +
    H.logo +
    H.divider +
    H.customerBlock +
    H.boxBlock +
    H.divider +
    H.itemsHeader +
    items.length * H.itemRow +
    H.divider +
    H.footer;

  const pdf = new jsPDF({ unit: 'mm', format: [SLIP_W_MM, totalH], orientation: 'portrait' });
  const logo = await loadLogoDataUrl();

  let y = H.margin;

  // Logo — centered, LOGO_SIZE_MM square. No separate text caption.
  if (logo) {
    pdf.addImage(logo, 'PNG', (SLIP_W_MM - LOGO_SIZE_MM) / 2, y, LOGO_SIZE_MM, LOGO_SIZE_MM);
  }
  y += H.logo;

  pdf.setDrawColor(0);
  pdf.line(H.margin, y, SLIP_W_MM - H.margin, y);
  y += 3;

  // Customer block — SHIP TO label + name + @username, tighter spacing.
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7);
  pdf.setTextColor(0);
  pdf.text('SHIP TO', H.margin, y);
  y += 3.5;
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(12);
  pdf.setTextColor(0);
  const name = (box.buyer || '(no name)').slice(0, 40);
  pdf.text(name, H.margin, y);
  y += 5;
  if (box.buyerUsername) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(0);
    pdf.text(`@${box.buyerUsername}`, H.margin, y);
    y += 4;
  }

  // Box block — code + carrier + date on a single line.
  const code = shortBoxCode(box.id);
  const carrierLabel = String(box.carrier || 'usps').toUpperCase();
  pdf.setFont('courier', 'bold');
  pdf.setFontSize(10);
  pdf.setTextColor(0);
  pdf.text(code, H.margin, y);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.text(`${carrierLabel}  ·  ${formatDate(new Date())}`, SLIP_W_MM - H.margin, y, { align: 'right' });
  y += 4;

  pdf.setDrawColor(0);
  pdf.line(H.margin, y, SLIP_W_MM - H.margin, y);
  y += 3;

  // Items header.
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(8);
  pdf.setTextColor(0);
  pdf.text(`ITEMS · ${items.length}`, H.margin, y);
  y += H.itemsHeader - 2;

  // Items list — SKU on top, title below, tight spacing.
  for (const item of items) {
    const sku = item.sku || '';
    const titleParts = [item.name, item.variety].filter(Boolean);
    const title = titleParts.join(' · ').slice(0, 40);

    pdf.setFont('courier', 'bold');
    pdf.setFontSize(9);
    pdf.setTextColor(0);
    pdf.text(sku, H.margin, y);
    if (item.quantity > 1) {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.text(`x${item.quantity}`, SLIP_W_MM - H.margin, y, { align: 'right' });
    }
    y += 3;
    if (title) {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(0);
      pdf.text(title, H.margin, y, { maxWidth: SLIP_PRINT_W });
      y += 3.5;
    } else {
      y += 0.5;
    }
    y += 0.5;
  }

  pdf.setDrawColor(0);
  pdf.line(H.margin, y, SLIP_W_MM - H.margin, y);
  y += 4;

  // Footer — single line.
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor(0);
  pdf.text('Thank you  ·  Folia Society', SLIP_W_MM / 2, y, { align: 'center' });

  return pdf;
}

export function ShippingSlipSheet({ box, onClose }) {
  const [busy, setBusy] = useState(false);

  // Preview iframe — we re-render the PDF blob on mount so the operator
  // can sanity-check before printing.
  const [previewUrl, setPreviewUrl] = useState(null);
  const urlRef = useRef(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pdf = await buildPdf(box);
      const url = pdf.output('bloburl');
      if (cancelled) { URL.revokeObjectURL(url); return; }
      urlRef.current = url;
      setPreviewUrl(url);
    })();
    return () => {
      cancelled = true;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [box]);

  const handlePrint = async () => {
    setBusy(true);
    try {
      const pdf = await buildPdf(box);
      pdf.autoPrint();
      const url = pdf.output('bloburl');
      const win = window.open(url, '_blank');
      if (!win) window.print();
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = async () => {
    setBusy(true);
    try {
      const pdf = await buildPdf(box);
      pdf.save(`folia-slip-${shortBoxCode(box.id)}.pdf`);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 bg-gray-100 overflow-auto">
      <div className="sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-2">
        <h2 className="text-base font-semibold text-gray-900">
          Shipping slip <span className="text-gray-400 font-normal">· {shortBoxCode(box.id)} · 80mm</span>
        </h2>
        <div className="ml-auto flex gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-lg hover:bg-gray-200 text-gray-700 flex items-center gap-1">
            <X className="w-4 h-4" /> Close
          </button>
          <button
            onClick={handlePrint}
            disabled={busy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 bg-white hover:bg-gray-100 text-gray-700 disabled:opacity-60"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
            Print
          </button>
          <button
            onClick={handleDownload}
            disabled={busy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-60"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Download PDF
          </button>
        </div>
      </div>
      <div className="flex justify-center py-6 px-3">
        {previewUrl ? (
          <iframe
            src={previewUrl}
            title="Shipping slip preview"
            className="bg-white shadow-xl border border-gray-200 rounded-lg"
            style={{ width: '320px', height: '720px' }}
          />
        ) : (
          <div className="text-sm text-gray-500 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Building preview...
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
