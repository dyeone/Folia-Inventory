import { useState } from 'react';
import { Printer, Loader2 } from 'lucide-react';
import { useBridgePrint, pdfToBase64 } from '../labels/useBridgePrint.js';
import { buildPackingTablePdf } from './packingTablePdf.js';

// "Print list" — renders the currently visible boxes as a packing-list table
// and prints it directly to the document printer via the bridge (role
// 'document'), falling back to the browser print dialog when the bridge is
// offline or errors. getBoxes() is called at click time so it always prints
// what's on screen now (current sub-tab + filter).
export function PrintListButton({ getBoxes, kind, showToast }) {
  const { bridgeOnline, printing, printViaBridge } = useBridgePrint();
  const [busy, setBusy] = useState(false);

  // Letter-size document → open in a tab with the print dialog already armed.
  const browserPrint = (pdf) => {
    pdf.autoPrint();
    const url = pdf.output('bloburl');
    const win = window.open(url, '_blank');
    if (!win) {
      const a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      document.body.appendChild(a); a.click(); a.remove();
    }
  };

  const onClick = async () => {
    if (busy) return;
    const boxes = getBoxes() || [];
    if (boxes.length === 0) { showToast?.('Nothing to print on this tab'); return; }
    setBusy(true);
    try {
      const pdf = buildPackingTablePdf(boxes, { kind });
      if (bridgeOnline) {
        try {
          const res = await printViaBridge({ pdfBase64: pdfToBase64(pdf), role: 'document' });
          if (res?.cancelled) return;
          showToast?.(`Sent list to ${res?.printer || 'printer'}`);
          return;
        } catch (e) {
          // Bridge reachable but the print failed — fall back to the browser.
          showToast?.(`Printer error — opened browser print (${e.message})`);
          browserPrint(pdf);
          return;
        }
      }
      browserPrint(pdf);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || printing}
      title={bridgeOnline ? 'Print the list to the document printer' : 'Bridge offline — opens the browser print dialog'}
      className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 active:bg-gray-100 disabled:opacity-60"
    >
      {busy || printing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
      Print list
    </button>
  );
}
