import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Download } from 'lucide-react';
import JsBarcode from 'jsbarcode';
import { jsPDF } from 'jspdf';
import { PrintControls, AutoPrintOverlay } from './PrintControls.jsx';
import { useAutoBridgePrint, printChunked } from './useBridgePrint.js';

// BAE and Folia share nothing — not SKUs, varieties, or species — so a label
// has to say which brand it belongs to or it's ambiguous on the bench. We tag
// any non-Folia brand with its name (BAE → "BAE"); Folia (the default) stays
// clean. The active brand lives on <html data-brand> (set in App.jsx).
function brandTag() {
  const b = (document.documentElement.getAttribute('data-brand') || 'folia').toLowerCase();
  return b && b !== 'folia' ? b.toUpperCase() : '';
}

function Label({ item, tag, sellerName }) {
  const svgRef = useRef(null);
  const sku = item.sku ? String(item.sku) : '';
  // Consignment plants print the seller's name alongside the brand tag so the
  // bench knows whose plant it is (the SKU carries the seller code too).
  const top = [tag, sellerName].filter(Boolean).join(' · ');

  useEffect(() => {
    if (svgRef.current && sku) {
      try {
        JsBarcode(svgRef.current, sku, {
          format: 'CODE128',
          height: 30, // pixels drawn; width scales via SVG to fill the label
          margin: 0,
          displayValue: false, // SKU is shown separately above
        });
      } catch (_e) {
        // ignore — invalid SKU characters leave the svg blank
      }
    }
  }, [sku]);

  // Sized to a standard 2" x 1" thermal label. This is both the on-screen
  // preview and the printed size.
  return (
    <div className="folia-label bg-white border border-gray-300 flex flex-col items-center justify-between text-center"
         style={{ width: '2in', height: '1in', padding: '0.08in', boxSizing: 'border-box' }}>
      {top && <div className="text-[6pt] font-bold text-black leading-none">{top}</div>}
      <div className="text-[8pt] leading-tight text-gray-700 truncate w-full">
        {item.name}{item.variety ? ` · ${item.variety}` : ''}
      </div>
      <div className="font-mono font-bold text-gray-900 tracking-wider leading-none"
           style={{ fontSize: '14pt' }}>
        {sku}
      </div>
      <svg ref={svgRef} style={{ width: '1.8in', height: '0.35in' }} preserveAspectRatio="none" />
    </div>
  );
}

// One label per page, page size = 2" × 1" (standard thermal label stock).
const LABEL_W = 2;
const LABEL_H = 1;

// Renders a CODE128 barcode into a hidden canvas and returns it as a PNG data
// URL, ready to embed in a jsPDF page.
function barcodeDataUrl(canvas, value) {
  try {
    JsBarcode(canvas, value, {
      format: 'CODE128',
      height: 50,      // drawing height in px
      width: 2,        // bar width multiplier
      margin: 0,
      displayValue: false,
    });
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

function buildPdf(items, sellerNameById) {
  const pdf = new jsPDF({
    unit: 'in',
    format: [LABEL_W, LABEL_H],
    orientation: 'landscape',
  });
  const canvas = document.createElement('canvas');
  const tag = brandTag();

  items.forEach((item, idx) => {
    if (idx > 0) pdf.addPage([LABEL_W, LABEL_H], 'landscape');

    // Top line: brand tag (e.g. BAE) plus, for consignment plants, the seller's
    // name — so the bench can tell whose plant it is. BAE and Folia share no
    // SKUs/varieties, so non-Folia labels are marked to avoid bench mix-ups;
    // Folia (the default, no sellers) prints without a top line.
    const sellerName = item.sellerId && sellerNameById ? sellerNameById.get(item.sellerId) : null;
    const topTag = [tag, sellerName].filter(Boolean).join(' · ').slice(0, 28);
    if (topTag) {
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(7);
      pdf.setTextColor(0);
      pdf.text(topTag, LABEL_W / 2, 0.11, { align: 'center' });
    }

    // Name + variety — 8pt, centered, truncated to the label width. Drops a
    // touch when a top line occupies the first row.
    const title = `${item.name || ''}${item.variety ? ` · ${item.variety}` : ''}`;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(70);
    pdf.text(title, LABEL_W / 2, topTag ? 0.24 : 0.18, {
      align: 'center',
      maxWidth: LABEL_W - 0.15,
    });

    // Middle: SKU — 14pt bold monospace, centered.
    const sku = String(item.sku || '');
    pdf.setFont('courier', 'bold');
    pdf.setFontSize(14);
    pdf.setTextColor(0);
    pdf.text(sku, LABEL_W / 2, 0.45, { align: 'center' });

    // Bottom: barcode image (0.1" side gutters, ~0.4" tall).
    if (sku) {
      const dataUrl = barcodeDataUrl(canvas, sku);
      if (dataUrl) {
        // 'FAST' = FlateDecode the embedded PNG; a 1-bit barcode compresses
        // hard, which keeps big batches well under the per-job size cap.
        pdf.addImage(dataUrl, 'PNG', 0.1, 0.55, LABEL_W - 0.2, 0.4, undefined, 'FAST');
      }
    }
  });

  return pdf;
}

export function LabelSheet({ items, sellers, onClose, showToast }) {
  // Resolve sellerId → name once so both the preview and the PDF can print the
  // seller on consignment labels. Empty for Folia / any non-consignment batch.
  const sellerNameById = useMemo(
    () => new Map((sellers || []).map(s => [s.id, s.name])),
    [sellers],
  );
  const buildLabelPdf = (its) => buildPdf(its, sellerNameById);

  // Print directly on open when the printer's ready — skip the preview grid.
  // Only when the bridge is offline (or the direct print fails) do we fall back
  // to showing the preview below so the operator can browser-print. Large
  // batches are split into per-job chunks so they fit under the request cap.
  // media: force 2"×1" so the printer uses the label size, not its CUPS default
  // (the iDPRT defaults to 4×6, which is why prints came out 4×6).
  const printDirect = (printViaBridge) =>
    printChunked({ items, buildPdf: buildLabelPdf, role: 'label', media: 'Custom.2x1in', printViaBridge });
  const auto = useAutoBridgePrint({ printDirect, onClose, showToast });

  const handleDownloadPdf = () => {
    const pdf = buildLabelPdf(items);
    const stamp = new Date().toISOString().slice(0, 10);
    pdf.save(`folia-labels-${stamp}.pdf`);
  };

  // Browser-print fallback (used when the bridge is offline or errors): open
  // the PDF in a new tab with the print dialog already triggered. Sidesteps
  // browser CSS print quirks and matches the downloaded PDF exactly.
  const printInBrowser = (pdf) => {
    pdf.autoPrint();
    const url = pdf.output('bloburl');
    const win = window.open(url, '_blank');
    if (!win) {
      // Pop-up blocked — fall back to the browser's own print dialog on the
      // on-screen preview.
      window.print();
    }
  };

  // Auto-printing (or still checking the printer): show a minimal overlay
  // instead of the preview grid. The grid only renders in the 'preview' phase.
  if (auto.phase !== 'preview') {
    return createPortal(
      <AutoPrintOverlay
        label={auto.phase === 'checking'
          ? 'Connecting to printer…'
          : `Printing ${items.length} ${items.length === 1 ? 'label' : 'labels'}…`}
        onCancel={onClose}
      />,
      document.body,
    );
  }

  // Render through a portal so this becomes a direct child of <body>.
  // That lets the @media print rules reliably hide everything except the
  // sheet itself — otherwise the React root (also a body child) contains the
  // sheet and gets hidden along with it.
  return createPortal(
    <div className="fixed inset-0 z-50 bg-gray-100 overflow-auto folia-label-sheet">
      <div className="folia-no-print sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-2">
        <h2 className="text-base font-semibold text-gray-900">
          Labels <span className="text-gray-400 font-normal">· {items.length} {items.length === 1 ? 'item' : 'items'} · 2″ × 1″</span>
        </h2>
        {auto.error && <span className="text-xs text-red-600 truncate max-w-[20rem]" title={auto.error}>{auto.error}</span>}
        <div className="ml-auto flex gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-lg hover:bg-gray-200 text-gray-700">
            Close
          </button>
          <PrintControls printDirect={printDirect} buildPdf={() => buildLabelPdf(items)} onBrowserPrint={printInBrowser} />
          <button
            onClick={handleDownloadPdf}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            <Download className="w-4 h-4" /> Download PDF
          </button>
        </div>
      </div>
      <div className="p-4 flex flex-wrap gap-2 justify-center folia-label-grid">
        {items.map(item => (
          <Label
            key={item.id}
            item={item}
            tag={brandTag()}
            sellerName={item.sellerId ? sellerNameById.get(item.sellerId) : null}
          />
        ))}
      </div>
      <style>{`
        @media print {
          .folia-no-print { display: none !important; }
          body > *:not(.folia-label-sheet) { display: none !important; }
          .folia-label-sheet {
            position: static !important;
            overflow: visible !important;
            background: white !important;
            padding: 0 !important;
          }
          .folia-label-grid {
            display: block !important;
            gap: 0 !important;
            padding: 0 !important;
          }
          .folia-label {
            width: 2in !important;
            height: 1in !important;
            margin: 0 !important;
            border: none !important;
            page-break-after: always !important;
            break-after: page !important;
            page-break-inside: avoid !important;
            break-inside: avoid !important;
          }
          .folia-label:last-child {
            page-break-after: auto !important;
            break-after: auto !important;
          }
          @page { size: 2in 1in; margin: 0; }
        }
      `}</style>
    </div>,
    document.body
  );
}
