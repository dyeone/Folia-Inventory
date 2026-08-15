import { useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Download } from 'lucide-react';
import { PrintControls, AutoPrintOverlay } from './PrintControls.jsx';
import { useAutoBridgePrint, printChunked } from './useBridgePrint.js';
// The PDF builder + label display helpers live in itemLabelPdf.js (like
// boxLabelPdf.js) so non-component code — the packer's burrito-wrap reprint —
// can share them without this component file exporting non-components.
import {
  buildItemLabelPdf, brandTag, realSku, lotStr, displayName, weekTag,
  qrDataUrl, QR_SIZE_LOT, QR_SIZE_FULL,
} from './itemLabelPdf.js';

function Label({ item, tag, sellerName, week }) {
  const sku = realSku(item);
  // Consignment plants print the seller's name alongside the brand tag so the
  // bench knows whose plant it is (the SKU carries the seller code too).
  const top = [tag, sellerName].filter(Boolean).join(' · ');

  // QR, not CODE128 — same swap as the PDF builder (see itemLabelPdf.js):
  // a barcode squeezed into the 2"×1" label was too fine to print/scan.
  // Rendered through the shared qrDataUrl into an <img> so preview and PDF
  // can't drift — and because qrcode's own toCanvas stomps the target's
  // CSS size (sets style.width to the pixel count), blowing up the layout.
  const qrSrc = useMemo(
    () => (sku ? qrDataUrl(document.createElement('canvas'), sku) : null),
    [sku],
  );

  const lot = lotStr(item);
  const titleLine = `${displayName(item)}${item.variety ? ` · ${item.variety}` : ''}`;

  // Sized to a standard 2" x 1" thermal label. This is both the on-screen
  // preview and the printed size. When the plant has a lineup number, it fills
  // the left; the name/SKU/QR stack on the right. Known acceptable drift:
  // this preview truncates the title via CSS in the app font, while the PDF
  // truncates by canvas/vector measure — the cut point can differ by a
  // character or two. Geometry and the QR itself are shared, so nothing
  // scannable can drift.
  return (
    <div className="folia-label bg-white border border-gray-300"
         style={{ width: '2in', height: '1in', padding: '0.06in', boxSizing: 'border-box' }}>
      {lot ? (
        <div className="flex items-stretch h-full w-full">
          <div className="flex flex-col items-center justify-center pr-1 border-r border-gray-300" style={{ width: '0.78in' }}>
            <span className="font-extrabold text-black leading-none"
                  style={{ fontSize: lot.length >= 4 ? '30pt' : lot.length === 3 ? '38pt' : '46pt' }}>{lot}</span>
            {week && (
              <span className="font-bold text-black leading-none"
                    style={{ fontSize: '8pt', marginTop: '0.02in', padding: '0.02in 0.05in', border: '0.012in solid #000', borderRadius: '0.03in' }}>
                {week}
              </span>
            )}
          </div>
          <div className="flex-1 min-w-0 flex flex-col items-center justify-between text-center pl-1">
            {top && <div className="text-[6pt] font-bold text-black leading-none truncate w-full">{top}</div>}
            <div className="text-[7pt] leading-tight text-gray-700 truncate w-full">{titleLine}</div>
            <div className="font-mono font-bold text-gray-900 leading-none" style={{ fontSize: '10.5pt' }}>{sku}</div>
            {qrSrc && <img src={qrSrc} alt="" style={{ width: `${QR_SIZE_LOT}in`, height: `${QR_SIZE_LOT}in` }} />}
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-between text-center h-full w-full">
          {top && <div className="text-[6pt] font-bold text-black leading-none">{top}</div>}
          <div className="text-[8pt] leading-tight text-gray-700 truncate w-full">{titleLine}</div>
          <div className="font-mono font-bold text-gray-900 tracking-wider leading-none" style={{ fontSize: '14pt' }}>{sku}</div>
          {qrSrc && <img src={qrSrc} alt="" style={{ width: `${QR_SIZE_FULL}in`, height: `${QR_SIZE_FULL}in` }} />}
        </div>
      )}
    </div>
  );
}

export function LabelSheet({ items, sellers, sales, onClose, showToast }) {
  // Resolve sellerId → name once so both the preview and the PDF can print the
  // seller on consignment labels. Empty for Folia / any non-consignment batch.
  const sellerNameById = useMemo(
    () => new Map((sellers || []).map(s => [s.id, s.name])),
    [sellers],
  );
  // saleId → sale, for the "WK N" chip under lineup numbers (week comes from
  // the sale's date). Optional — without it the chip falls back to soldAt /
  // the print date.
  const saleById = useMemo(
    () => new Map((sales || []).map(s => [s.id, s])),
    [sales],
  );
  const buildLabelPdf = (its) => buildItemLabelPdf(its, sellerNameById, saleById);

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
            week={weekTag(item, saleById)}
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
