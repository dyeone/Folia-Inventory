import { useEffect, useRef, useState } from 'react';
import { Printer, Loader2 } from 'lucide-react';
import { useBridgePrint, pdfToBase64 } from './useBridgePrint.js';

// Minimal full-screen overlay shown while a sheet auto-prints on open, instead
// of the preview grid. Just enough to confirm something is happening, with a
// Cancel escape hatch in case the bridge hangs.
export function AutoPrintOverlay({ label, onCancel }) {
  return (
    <div className="fixed inset-0 z-50 bg-gray-100 flex items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-gray-700">
        <Loader2 className="w-7 h-7 animate-spin text-emerald-600" />
        <div className="text-sm font-medium">{label}</div>
        <button onClick={onCancel} className="mt-1 text-xs text-gray-400 hover:text-gray-600">
          Cancel
        </button>
      </div>
    </div>
  );
}

// Shared print button cluster for the label/slip sheets.
//
// One click sends the PDF straight to the operator's configured printer through
// the Mac-app bridge when it's online; if the bridge is offline — or errors
// mid-print — it falls back to the browser print dialog so the operator is
// never stuck. A small chip shows printer status and the last result.
//
// Props:
//   role           'label' | 'slip' | 'document' — selects the bridge's printer
//   buildPdf       () => jsPDF | Promise<jsPDF>   — builds the PDF on demand
//   onBrowserPrint (pdf) => void                  — the sheet's browser-print path
//   media          optional CUPS media string (e.g. 'Custom.2x1in')
export function PrintControls({ role, buildPdf, onBrowserPrint, media }) {
  const { bridgeOnline, printing, printViaBridge } = useBridgePrint();
  const [msg, setMsg] = useState(null); // { text, error } | null
  // Re-entrancy guard covering the WHOLE handler, including the async buildPdf —
  // `printing` from the hook only flips after the PDF is built, so without this
  // a rapid double-click on the async slip could build + enqueue twice.
  const [busy, setBusy] = useState(false);
  const msgTimer = useRef(null);

  useEffect(() => () => clearTimeout(msgTimer.current), []);
  const flash = (text, error = false) => {
    setMsg({ text, error });
    clearTimeout(msgTimer.current);
    msgTimer.current = setTimeout(() => setMsg(null), 5000);
  };

  const doPrint = async () => {
    if (busy) return;
    setBusy(true);
    try {
      let pdf;
      try { pdf = await buildPdf(); }
      catch (e) { flash(`Couldn’t build the PDF: ${e.message}`, true); return; }

      if (bridgeOnline) {
        try {
          const res = await printViaBridge({ pdfBase64: pdfToBase64(pdf), role, media });
          if (res?.cancelled) return; // sheet closed mid-print
          flash(`Sent to ${res.printer || 'printer'}`);
          return;
        } catch (e) {
          // Bridge reachable but the print failed — fall back so the label still
          // comes out, and tell the operator why the direct path didn't work.
          flash(`Printer error — using browser print (${e.message})`, true);
          onBrowserPrint(pdf);
          return;
        }
      }
      onBrowserPrint(pdf);
    } finally {
      setBusy(false);
    }
  };

  const doBrowser = async () => {
    if (busy) return;
    setBusy(true);
    try {
      let pdf;
      try { pdf = await buildPdf(); }
      catch (e) { flash(`Couldn’t build the PDF: ${e.message}`, true); return; }
      onBrowserPrint(pdf);
    } finally {
      setBusy(false);
    }
  };

  const chip = msg
    ? { text: msg.text, cls: msg.error ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700' }
    : bridgeOnline == null ? null
      : bridgeOnline
        ? { text: 'Printer ready', cls: 'bg-emerald-50 text-emerald-700' }
        : { text: 'Printer offline', cls: 'bg-gray-100 text-gray-500' };

  return (
    <>
      {chip && (
        <span
          title={chip.text}
          className={`hidden sm:inline-flex items-center max-w-[18rem] truncate px-2 py-1 rounded-md text-xs font-medium ${chip.cls}`}
        >
          {chip.text}
        </span>
      )}
      <button
        onClick={doPrint}
        disabled={busy || printing}
        title={bridgeOnline ? 'Print directly to the configured printer' : 'Bridge offline — opens the browser print dialog'}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 bg-white hover:bg-gray-100 text-gray-700 disabled:opacity-60"
      >
        {busy || printing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />} Print
      </button>
      <button
        onClick={doBrowser}
        disabled={busy || printing}
        title="Print with the browser dialog instead"
        className="px-2 py-1.5 text-sm rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-60"
      >
        Browser
      </button>
    </>
  );
}
