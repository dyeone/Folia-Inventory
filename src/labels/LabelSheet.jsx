import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Printer, Download } from 'lucide-react';
import JsBarcode from 'jsbarcode';
import { jsPDF } from 'jspdf';

function Label({ item }) {
  const svgRef = useRef(null);
  const sku = item.sku ? String(item.sku) : '';

  useEffect(() => {
    if (svgRef.current && sku) {
      try {
        JsBarcode(svgRef.current, sku, {
          format: 'CODE128',
          height: 30, // pixels drawn; width scales via SVG to fill the label
          margin: 0,
          displayValue: false, // SKU is shown separately above
        });
      } catch (e) {
        // ignore — invalid SKU characters leave the svg blank
      }
    }
  }, [sku]);

  // Sized to a standard 2" x 1" thermal label. This is both the on-screen
  // preview and the printed size.
  return (
    <div className="folia-label bg-white border border-gray-300 flex flex-col items-center justify-between text-center"
         style={{ width: '2in', height: '1in', padding: '0.08in', boxSizing: 'border-box' }}>
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

function buildPdf(items) {
  const pdf = new jsPDF({
    unit: 'in',
    format: [LABEL_W, LABEL_H],
    orientation: 'landscape',
  });
  const canvas = document.createElement('canvas');

  items.forEach((item, idx) => {
    if (idx > 0) pdf.addPage([LABEL_W, LABEL_H], 'landscape');

    // Top: name + variety — 8pt, centered, truncated to fit the label width.
    const title = `${item.name || ''}${item.variety ? ` · ${item.variety}` : ''}`;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(70);
    pdf.text(title, LABEL_W / 2, 0.18, {
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
        pdf.addImage(dataUrl, 'PNG', 0.1, 0.55, LABEL_W - 0.2, 0.4);
      }
    }
  });

  return pdf;
}

export function LabelSheet({ items, onClose }) {
  const handleDownloadPdf = () => {
    const pdf = buildPdf(items);
    const stamp = new Date().toISOString().slice(0, 10);
    pdf.save(`folia-labels-${stamp}.pdf`);
  };

  // Use the same PDF for printing — opens it in a new tab with the print
  // dialog already triggered. This sidesteps browser CSS print quirks and
  // guarantees the printed output matches the downloaded PDF exactly.
  const handlePrint = () => {
    const pdf = buildPdf(items);
    pdf.autoPrint();
    const url = pdf.output('bloburl');
    const win = window.open(url, '_blank');
    if (!win) {
      // Pop-up blocked — fall back to triggering the browser's own print
      // dialog on the on-screen preview.
      window.print();
    }
  };

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
        <div className="ml-auto flex gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-lg hover:bg-gray-200 text-gray-700">
            Close
          </button>
          <button
            onClick={handlePrint}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 bg-white hover:bg-gray-100 text-gray-700"
          >
            <Printer className="w-4 h-4" /> Print
          </button>
          <button
            onClick={handleDownloadPdf}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            <Download className="w-4 h-4" /> Download PDF
          </button>
        </div>
      </div>
      <div className="p-4 flex flex-wrap gap-2 justify-center folia-label-grid">
        {items.map(item => <Label key={item.id} item={item} />)}
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
