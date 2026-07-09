import { createPortal } from 'react-dom';
import { Download } from 'lucide-react';
import { jsPDF } from 'jspdf';
import { PrintControls, AutoPrintOverlay } from './PrintControls.jsx';
import { useAutoBridgePrint, printChunked } from './useBridgePrint.js';

// Big-number "lineup" labels for the live: a huge lot number filling a 2"×1"
// thermal label, with the plant name + SKU small underneath, so the operator can
// grab plant #7 across the room during a live. The number is the item's
// lotNumber (its 1..N position in the fixed lineup). Prints through the same
// bridge path as the SKU labels (role 'label', media Custom.2x1in).

const LABEL_W = 2;
const LABEL_H = 1;

function lotOf(item) {
  const s = String(item?.lotNumber ?? '').trim();
  return s || '—';
}

// On-screen preview — mirrors the printed 2"×1" label.
function NumberLabel({ item }) {
  const name = item.name || '';
  const variety = item.variety ? ` · ${item.variety}` : '';
  return (
    <div className="folia-label bg-white border border-gray-300 flex flex-col items-center justify-between text-center"
         style={{ width: '2in', height: '1in', padding: '0.06in', boxSizing: 'border-box' }}>
      <div className="text-[7pt] leading-none text-gray-600 truncate w-full">{name}{variety}</div>
      <div className="font-extrabold text-black leading-none" style={{ fontSize: '40pt' }}>{lotOf(item)}</div>
      <div className="text-[8pt] font-mono leading-none text-gray-700 truncate w-full">{item.sku || ''}</div>
    </div>
  );
}

function buildPdf(items) {
  const pdf = new jsPDF({ unit: 'in', format: [LABEL_W, LABEL_H], orientation: 'landscape' });

  items.forEach((item, idx) => {
    if (idx > 0) pdf.addPage([LABEL_W, LABEL_H], 'landscape');

    // Plant name + variety — small, top.
    const title = `${item.name || ''}${item.variety ? ` · ${item.variety}` : ''}`;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(90);
    pdf.text(title, LABEL_W / 2, 0.17, { align: 'center', maxWidth: LABEL_W - 0.12 });

    // The big lineup number — dominant, centered.
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(40);
    pdf.setTextColor(0);
    pdf.text(lotOf(item), LABEL_W / 2, 0.72, { align: 'center' });

    // SKU — small, bottom, monospace so it reads like the SKU label.
    pdf.setFont('courier', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(40);
    pdf.text(String(item.sku || ''), LABEL_W / 2, 0.94, { align: 'center' });
  });

  return pdf;
}

export function NumberLabelSheet({ items, onClose, showToast }) {
  const printDirect = (printViaBridge) =>
    printChunked({ items, buildPdf, role: 'label', media: 'Custom.2x1in', printViaBridge });
  const auto = useAutoBridgePrint({ printDirect, onClose, showToast });

  const handleDownloadPdf = () => {
    const pdf = buildPdf(items);
    const stamp = new Date().toISOString().slice(0, 10);
    pdf.save(`folia-lineup-labels-${stamp}.pdf`);
  };

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
          : `Printing ${items.length} lineup ${items.length === 1 ? 'label' : 'labels'}…`}
        onCancel={onClose}
      />,
      document.body,
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-50 bg-gray-100 overflow-auto folia-label-sheet">
      <div className="folia-no-print sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-2">
        <h2 className="text-base font-semibold text-gray-900">
          Lineup labels <span className="text-gray-400 font-normal">· {items.length} {items.length === 1 ? 'item' : 'items'} · 2″ × 1″</span>
        </h2>
        {auto.error && <span className="text-xs text-red-600 truncate max-w-[20rem]" title={auto.error}>{auto.error}</span>}
        <div className="ml-auto flex gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-lg hover:bg-gray-200 text-gray-700">Close</button>
          <PrintControls printDirect={printDirect} buildPdf={() => buildPdf(items)} onBrowserPrint={printInBrowser} />
          <button
            onClick={handleDownloadPdf}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            <Download className="w-4 h-4" /> Download PDF
          </button>
        </div>
      </div>
      <div className="p-4 flex flex-wrap gap-2 justify-center folia-label-grid">
        {items.map(item => <NumberLabel key={item.id} item={item} />)}
      </div>
      <style>{`
        @media print {
          .folia-no-print { display: none !important; }
          body > *:not(.folia-label-sheet) { display: none !important; }
          .folia-label-sheet { position: static !important; overflow: visible !important; background: white !important; padding: 0 !important; }
          .folia-label-grid { display: block !important; gap: 0 !important; padding: 0 !important; }
          .folia-label {
            width: 2in !important; height: 1in !important; margin: 0 !important; border: none !important;
            page-break-after: always !important; break-after: page !important;
            page-break-inside: avoid !important; break-inside: avoid !important;
          }
          .folia-label:last-child { page-break-after: auto !important; break-after: auto !important; }
          @page { size: 2in 1in; margin: 0; }
        }
      `}</style>
    </div>,
    document.body
  );
}
