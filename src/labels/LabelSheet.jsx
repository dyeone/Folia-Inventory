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

// The plant's lineup number (lotNumber) as a display string, or '' when it isn't
// a positive integer. When present it prints big on the left of the label so the
// plant is easy to spot during a live; labels for items not in a numbered
// lineup keep the plain full-width SKU layout.
function lotStr(item) {
  const n = parseInt(item?.lotNumber, 10);
  return Number.isFinite(n) && n > 0 ? String(n) : '';
}

// ISO-8601 week number (Monday-based, 1–53) of a date. Date-only strings
// ("2026-07-17") are parsed as LOCAL calendar dates — new Date() would read
// them as UTC midnight, which in US timezones lands on the previous local
// day and can cross a week boundary on Mondays.
function isoWeek(raw) {
  let d;
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, day] = raw.split('-').map(Number);
    d = new Date(y, m - 1, day);
  } else {
    d = new Date(raw);
  }
  if (isNaN(d.getTime())) return null;
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
}

// Bold "WK N" chip printed under the big lineup number. The running index
// keeps numbers unique WITHIN a week (Tue continues into Fri) but restarts
// for a new week, so two weeks' plants on the bench can share a number —
// the week chip is what tells this week's #12 from last week's, so it must
// be readable at arm's length (a tiny gray tag wasn't, and packers pulled
// the wrong week's plants). Week comes from the plant's sale date, else its
// sold date, else the print date (labels are printed in the lineup's own week).
function weekTag(item, saleById) {
  const sale = item?.saleId && saleById ? saleById.get(item.saleId) : null;
  const week = isoWeek(sale?.date || item?.soldAt || new Date());
  return week ? `WK ${week}` : '';
}

// Big-number font size (pt) picked by digit count so it fills the (wide) left
// column of a 2"×1" label and stays readable across the room during a live.
function lotFontPt(lot) {
  return lot.length <= 1 ? 60 : lot.length === 2 ? 50 : lot.length === 3 ? 34 : 26;
}

// The name to print: the operator's listing Title override (entered on the Pre
// Sale tab, and what Palmstreet lists it as) if set, else the item's own name.
// So a relabelled plant prints the new name, not the stale species name. If the
// name already starts with the lineup number (e.g. an unmatched line named
// "31 no id"), drop that prefix — the number is already printed big.
function displayName(item) {
  const d = item && item.listingDetails;
  const t = d && typeof d === 'object' && d.title != null ? String(d.title).trim() : '';
  let name = t || (item.name || '');
  const lot = lotStr(item);
  if (lot && name.startsWith(`${lot} `)) name = name.slice(lot.length + 1).trim();
  return name;
}

// The SKU to print / barcode. UNMATCHED-… and DBL-… are synthetic placeholder
// SKUs (a line that didn't match real inventory) — they're long and don't scan
// to anything, so we suppress them: those labels show just the big lineup number
// + name for identification.
function realSku(item) {
  const s = String(item?.sku || '');
  return /^(UNMATCHED|DBL)-/i.test(s) ? '' : s;
}

function Label({ item, tag, sellerName, week }) {
  const svgRef = useRef(null);
  const sku = realSku(item);
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

  const lot = lotStr(item);
  const titleLine = `${displayName(item)}${item.variety ? ` · ${item.variety}` : ''}`;

  // Sized to a standard 2" x 1" thermal label. This is both the on-screen
  // preview and the printed size. When the plant has a lineup number, it fills
  // the left; the name/SKU/barcode stack on the right.
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
            <svg ref={svgRef} style={{ width: '1.05in', height: '0.3in' }} preserveAspectRatio="none" />
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-between text-center h-full w-full">
          {top && <div className="text-[6pt] font-bold text-black leading-none">{top}</div>}
          <div className="text-[8pt] leading-tight text-gray-700 truncate w-full">{titleLine}</div>
          <div className="font-mono font-bold text-gray-900 tracking-wider leading-none" style={{ fontSize: '14pt' }}>{sku}</div>
          <svg ref={svgRef} style={{ width: '1.8in', height: '0.35in' }} preserveAspectRatio="none" />
        </div>
      )}
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

function buildPdf(items, sellerNameById, saleById) {
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
    const title = `${displayName(item)}${item.variety ? ` · ${item.variety}` : ''}`;
    const sku = realSku(item);
    const lot = lotStr(item);

    if (lot) {
      // Combined layout: the big lineup number fills the wide left column (easy
      // to read across the room during a live), with name / SKU / barcode stacked
      // in the right column. A thin divider separates the two. A bold "WK N"
      // chip under the number says which week's lineup this is — numbers can
      // repeat across weeks on the bench, and the chip has to read at arm's
      // length (its tiny gray predecessor didn't).
      const week = weekTag(item, saleById);
      const DIV = 0.82;                 // left column width / divider x
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(0);
      pdf.setFontSize(lotFontPt(lot));
      pdf.text(lot, DIV / 2, week ? 0.68 : 0.74, { align: 'center' });
      if (week) {
        pdf.setFontSize(8);
        const chipW = pdf.getTextWidth(week) + 0.1;
        pdf.setDrawColor(0);
        pdf.setLineWidth(0.012);
        pdf.roundedRect(DIV / 2 - chipW / 2, 0.73, chipW, 0.16, 0.03, 0.03);
        pdf.text(week, DIV / 2, 0.85, { align: 'center' });
      }
      pdf.setDrawColor(170);
      pdf.setLineWidth(0.008);
      pdf.line(DIV, 0.1, DIV, 0.9);

      const cx = DIV + (LABEL_W - DIV) / 2; // center of the right column
      const cw = LABEL_W - DIV - 0.04;      // right column text width
      if (topTag) {
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(6.5);
        pdf.setTextColor(0);
        pdf.text(topTag, cx, 0.15, { align: 'center', maxWidth: cw });
      }
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7);
      pdf.setTextColor(70);
      pdf.text(title, cx, topTag ? 0.29 : 0.22, { align: 'center', maxWidth: cw });
      pdf.setFont('courier', 'bold');
      pdf.setFontSize(10.5);
      pdf.setTextColor(0);
      pdf.text(sku, cx, 0.50, { align: 'center' });
      if (sku) {
        const dataUrl = barcodeDataUrl(canvas, sku);
        if (dataUrl) pdf.addImage(dataUrl, 'PNG', DIV + 0.05, 0.58, LABEL_W - DIV - 0.11, 0.34, undefined, 'FAST');
      }
      return;
    }

    // Full-width layout (no lineup number): brand tag, name, big SKU, barcode.
    if (topTag) {
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(7);
      pdf.setTextColor(0);
      pdf.text(topTag, LABEL_W / 2, 0.11, { align: 'center' });
    }
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(70);
    pdf.text(title, LABEL_W / 2, topTag ? 0.24 : 0.18, { align: 'center', maxWidth: LABEL_W - 0.15 });
    pdf.setFont('courier', 'bold');
    pdf.setFontSize(14);
    pdf.setTextColor(0);
    pdf.text(sku, LABEL_W / 2, 0.45, { align: 'center' });
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
  const buildLabelPdf = (its) => buildPdf(its, sellerNameById, saleById);

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
