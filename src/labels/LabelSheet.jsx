import { useEffect, useRef } from 'react';
import { Printer } from 'lucide-react';
import JsBarcode from 'jsbarcode';

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

export function LabelSheet({ items, onClose }) {
  return (
    <div className="fixed inset-0 z-50 bg-gray-100 overflow-auto folia-label-sheet">
      <div className="folia-no-print sticky top-0 bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-2">
        <h2 className="text-base font-semibold text-gray-900">
          Print labels <span className="text-gray-400 font-normal">· {items.length} {items.length === 1 ? 'item' : 'items'} · 2″ × 1″</span>
        </h2>
        <div className="ml-auto flex gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-lg hover:bg-gray-200 text-gray-700">
            Close
          </button>
          <button onClick={() => window.print()} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white">
            <Printer className="w-4 h-4" /> Print
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
          }
          .folia-label-grid {
            display: flex !important;
            flex-wrap: wrap !important;
            gap: 0 !important;
            padding: 0 !important;
            justify-content: flex-start !important;
          }
          .folia-label {
            width: 2in !important;
            height: 1in !important;
            margin: 0 !important;
            border: 1px solid #666 !important;
            page-break-inside: avoid !important;
            break-inside: avoid !important;
          }
          /* Letter paper: 3 labels across × 10 down = 30 per page */
          @page { size: letter; margin: 0.25in; }
        }
      `}</style>
    </div>
  );
}
