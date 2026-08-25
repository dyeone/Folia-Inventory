import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Download } from 'lucide-react';
import JsBarcode from 'jsbarcode';
import { shortBoxCode } from './boxCode.js';
import { buildBoxLabelPdf, displayHeader } from './boxLabelPdf.js';
import { PrintControls, AutoPrintOverlay } from './PrintControls.jsx';
import { useAutoBridgePrint, printChunked } from './useBridgePrint.js';

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

// PDF construction + the header rule live in boxLabelPdf.js (shared with
// the packer's per-box "Print box tag" button).

export function BoxLabelSheet({ boxes, onClose, showToast }) {
  // Print directly on open when the printer's ready — skip the preview grid;
  // fall back to the preview only when the bridge is offline or print fails.
  // Large batches are split into per-job chunks so they fit under the cap.
  // media: force 2"×1" so the printer doesn't fall back to its CUPS default (4×6).
  const printDirect = (printViaBridge) =>
    printChunked({ items: boxes, buildPdf: buildBoxLabelPdf, role: 'label', media: 'Custom.2x1in', printViaBridge });
  const auto = useAutoBridgePrint({ printDirect, onClose, showToast });

  const handleDownloadPdf = () => {
    const pdf = buildBoxLabelPdf(boxes);
    const stamp = new Date().toISOString().slice(0, 10);
    pdf.save(`${document.documentElement.getAttribute('data-brand') || 'bae-gin'}-box-labels-${stamp}.pdf`);
  };

  // Browser-print fallback when the bridge is offline or errors.
  const printInBrowser = (pdf) => {
    pdf.autoPrint();
    const url = pdf.output('bloburl');
    const win = window.open(url, '_blank');
    if (!win) window.print();
  };

  if (auto.phase !== 'preview') {
    return createPortal(
      <AutoPrintOverlay
        label={auto.phase === 'checking'
          ? 'Connecting to printer…'
          : `Printing ${boxes.length} box ${boxes.length === 1 ? 'label' : 'labels'}…`}
        onCancel={onClose}
      />,
      document.body,
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-50 bg-gray-100 overflow-auto folia-label-sheet">
      <div className="folia-no-print sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-2">
        <h2 className="text-base font-semibold text-gray-900">
          Box labels <span className="text-gray-400 font-normal">· {boxes.length} {boxes.length === 1 ? 'box' : 'boxes'} · 2″ × 1″</span>
        </h2>
        {auto.error && <span className="text-xs text-red-600 truncate max-w-[20rem]" title={auto.error}>{auto.error}</span>}
        <div className="ml-auto flex gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-lg hover:bg-gray-200 text-gray-700">
            Close
          </button>
          <PrintControls printDirect={printDirect} buildPdf={() => buildBoxLabelPdf(boxes)} onBrowserPrint={printInBrowser} />
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
