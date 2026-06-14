import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Download } from 'lucide-react';
import JsBarcode from 'jsbarcode';
import { jsPDF } from 'jspdf';
import { shortBoxCode } from './boxCode.js';
import { PrintControls } from './PrintControls.jsx';

// 2"×1" thermal label per box, encoding the box code (B-XXXXXX) in
// CODE128. Designed to be stuck on the physical box so a barcode scanner
// can identify it during pack-out / handoff to the carrier without the
// operator typing anything. Mirrors LabelSheet's structure but takes
// box rows instead of inventory items.

function Label({ box }) {
  const svgRef = useRef(null);
  const code = shortBoxCode(box.id);
  const header = displayHeader(box);

  useEffect(() => {
    if (svgRef.current && code) {
      try {
        JsBarcode(svgRef.current, code, {
          format: 'CODE128',
          height: 30,
          margin: 0,
          displayValue: false,
        });
      } catch {
        // invalid characters (shouldn't happen for B-XXXXXX) → blank
      }
    }
  }, [code]);

  return (
    <div
      className="folia-label bg-white border border-gray-300 flex flex-col items-center justify-between text-center"
      style={{ width: '2in', height: '1in', padding: '0.08in', boxSizing: 'border-box' }}
    >
      <div className="text-[9pt] leading-tight text-gray-900 font-medium truncate w-full">
        {header}
      </div>
      <div className="font-mono font-bold text-gray-900 tracking-wider leading-none" style={{ fontSize: '12pt' }}>
        {code}
      </div>
      <svg ref={svgRef} style={{ width: '1.8in', height: '0.32in' }} preserveAspectRatio="none" />
    </div>
  );
}

// Top line of the label: carrier (UPS / USPS), match-status marker,
// and a contents tag for plants that need special handling at pack-out.
// Names and @ids are intentionally omitted — the label exists to
// identify the box at the carrier-handoff station, not the buyer.
//
//   *    every item in the box is matched real inventory
//   #    at least one item is an unmatched placeholder (purple in Shipping)
//   ANT  at least one item is an Anthurium — flagged on the physical
//        tag so the packer sees it before opening the box
//
// '#' tells the packer to double-check the manifest before sealing —
// the placeholder row didn't tie to a known SKU, so something needs
// attention before this box ships.
function displayHeader(box) {
  const carrier = String(box.carrier || 'usps').toUpperCase();
  const items = box.items || [];
  const hasUnmatched = items.some(i => i.lotKind === 'unmatched');
  const hasAnthurium = items.some(i => (i.variety || '').toLowerCase() === 'anthurium');
  const marker = hasUnmatched ? '#' : '*';
  const tag = hasAnthurium ? ' · ANT' : '';
  return `${carrier} · ${marker}${tag}`;
}

const LABEL_W = 2;
const LABEL_H = 1;

function barcodeDataUrl(canvas, value) {
  try {
    JsBarcode(canvas, value, {
      format: 'CODE128',
      height: 50,
      width: 2,
      margin: 0,
      displayValue: false,
    });
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

function buildPdf(boxes) {
  const pdf = new jsPDF({
    unit: 'in',
    format: [LABEL_W, LABEL_H],
    orientation: 'landscape',
  });
  const canvas = document.createElement('canvas');

  boxes.forEach((box, idx) => {
    if (idx > 0) pdf.addPage([LABEL_W, LABEL_H], 'landscape');
    const code = shortBoxCode(box.id);
    const header = displayHeader(box);

    // Top: carrier · @username — 9pt, centered, truncated to fit.
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.setTextColor(0);
    pdf.text(header, LABEL_W / 2, 0.2, { align: 'center', maxWidth: LABEL_W - 0.15 });

    // Middle: box code — 12pt bold mono.
    pdf.setFont('courier', 'bold');
    pdf.setFontSize(12);
    pdf.setTextColor(0);
    pdf.text(code, LABEL_W / 2, 0.5, { align: 'center' });

    // Bottom: CODE128 barcode of the box code.
    const dataUrl = barcodeDataUrl(canvas, code);
    if (dataUrl) {
      pdf.addImage(dataUrl, 'PNG', 0.1, 0.58, LABEL_W - 0.2, 0.36);
    }
  });

  return pdf;
}

export function BoxLabelSheet({ boxes, onClose }) {
  const handleDownloadPdf = () => {
    const pdf = buildPdf(boxes);
    const stamp = new Date().toISOString().slice(0, 10);
    pdf.save(`folia-box-labels-${stamp}.pdf`);
  };

  // Browser-print fallback when the bridge is offline or errors.
  const printInBrowser = (pdf) => {
    pdf.autoPrint();
    const url = pdf.output('bloburl');
    const win = window.open(url, '_blank');
    if (!win) window.print();
  };

  return createPortal(
    <div className="fixed inset-0 z-50 bg-gray-100 overflow-auto folia-label-sheet">
      <div className="folia-no-print sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-2">
        <h2 className="text-base font-semibold text-gray-900">
          Box labels <span className="text-gray-400 font-normal">· {boxes.length} {boxes.length === 1 ? 'box' : 'boxes'} · 2″ × 1″</span>
        </h2>
        <div className="ml-auto flex gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-lg hover:bg-gray-200 text-gray-700">
            Close
          </button>
          <PrintControls role="label" buildPdf={() => buildPdf(boxes)} onBrowserPrint={printInBrowser} />
          <button
            onClick={handleDownloadPdf}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            <Download className="w-4 h-4" /> Download PDF
          </button>
        </div>
      </div>
      <div className="p-4 flex flex-wrap gap-2 justify-center folia-label-grid">
        {boxes.map(box => <Label key={box.id} box={box} />)}
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
    document.body,
  );
}
