import { useState } from 'react';
import {
  ChevronDown, ChevronRight, Truck, ShoppingCart, PackageCheck,
  MapPin, Box, Send, RotateCcw, Download as DownloadIcon,
} from 'lucide-react';
import { api } from '../api.js';

// Fetch a fresh signed URL for the label PDF and either open it (signed
// URLs from Storage are direct downloads) or convert a legacy data: URL
// into a blob and download. Signed URLs expire in 5 min so we never cache.
async function downloadLabelPdf(shipment, showToast) {
  try {
    const url = await api.getLabelUrl(shipment.id);
    if (url.startsWith('data:')) {
      // Legacy inline label — wrap in a Blob to trigger a download with a
      // sane filename. Direct <a download href="data:..."> is unreliable.
      const base64 = url.split(',')[1] || '';
      const bytes = atob(base64);
      const buf = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
      const blob = new Blob([buf], { type: 'application/pdf' });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `label-${shipment.trackingNumber || shipment.id}.pdf`;
      a.click();
      URL.revokeObjectURL(blobUrl);
    } else {
      // Storage signed URL — open in a new tab so the browser's PDF
      // viewer / native print dialog handles it.
      window.open(url, '_blank', 'noopener');
    }
  } catch (e) {
    showToast?.(e.message || 'Could not open label');
  }
}

// One row of the packing list: recipient + items + label/ship actions.
// All the buy/void/ship handlers come from the parent so this stays a
// pure presentation component.
export function ShipBoxCard({ box, shipment, showToast, onShip, onBuyLabel, onVoidLabel }) {
  const [open, setOpen] = useState(true);
  const allShipped = box.items.every(i => ['shipped', 'delivered'].includes(i.status));
  const hasActiveLabel = shipment && !shipment.voidedAt;
  const a = box.address || {};
  const addressLine = [
    a.street1,
    a.street2,
    [a.city, a.state, a.zip].filter(Boolean).join(', '),
    a.country && a.country !== 'US' ? a.country : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className={`bg-white border rounded-xl overflow-hidden ${
      allShipped ? 'border-emerald-300' : 'border-gray-200'
    }`}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-start gap-3 px-4 py-3 hover:bg-gray-50 text-left"
      >
        <div className="mt-0.5 text-gray-400">
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-gray-900">{box.recipientName}</span>
            {box.username && <span className="text-xs text-gray-500">@{box.username}</span>}
            {box.carrier && (
              <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded border ${
                box.carrier === 'ups'
                  ? 'text-amber-800 bg-amber-50 border-amber-200'
                  : 'text-blue-800 bg-blue-50 border-blue-200'
              }`}>
                <Truck className="w-3 h-3" /> {box.carrier.toUpperCase()}
              </span>
            )}
            {a.shipmentMethod && (
              <span className="inline-flex items-center gap-1 text-[11px] text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">
                {a.shipmentMethod}
              </span>
            )}
            {hasActiveLabel && (
              <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded border ${
                shipment.isTestLabel
                  ? 'text-amber-800 bg-amber-50 border-amber-200'
                  : 'text-emerald-800 bg-emerald-50 border-emerald-200'
              }`}>
                <ShoppingCart className="w-3 h-3" />
                Label{shipment.isTestLabel ? ' (test)' : ''}
              </span>
            )}
            {allShipped && (
              <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200">
                <PackageCheck className="w-3 h-3" /> Shipped
              </span>
            )}
          </div>
          {addressLine && (
            <div className="text-xs text-gray-500 mt-0.5 flex items-start gap-1">
              <MapPin className="w-3 h-3 mt-0.5 flex-shrink-0" />
              <span>{addressLine}</span>
            </div>
          )}
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-sm font-medium text-gray-900">
            {box.items.length} {box.items.length === 1 ? 'item' : 'items'}
          </div>
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-100">
          <div className="divide-y divide-gray-100">
            {box.items.map(item => (
              <div key={item.id} className="px-4 py-2.5 flex items-start gap-3">
                <Box className="w-3.5 h-3.5 text-gray-400 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-900 truncate">
                    {item.name}{item.variety ? ` · ${item.variety}` : ''}
                  </div>
                  <div className="text-xs text-gray-500 font-mono">
                    {item.sku}
                    {item.lotNumber ? ` · Lot #${item.lotNumber}` : ''}
                    {item.salePrice ? ` · $${parseFloat(item.salePrice).toFixed(2)}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {hasActiveLabel && (
            <div className="px-4 py-2.5 bg-gray-50 border-t border-gray-100 flex items-center gap-3 flex-wrap text-xs">
              <div className="flex items-center gap-1.5 text-gray-700">
                <Truck className="w-3.5 h-3.5 text-gray-500" />
                <span className="font-mono">{shipment.trackingNumber || '(no tracking)'}</span>
              </div>
              {shipment.labelCost != null && !shipment.isTestLabel && (
                <span className="text-gray-500">${parseFloat(shipment.labelCost).toFixed(2)}</span>
              )}
              <span className="text-gray-400">{shipment.serviceCode}</span>
              <div className="ml-auto flex items-center gap-1">
                <button
                  onClick={() => downloadLabelPdf(shipment, showToast)}
                  className="flex items-center gap-1 px-2 py-1 text-emerald-700 hover:bg-emerald-50 rounded"
                >
                  <DownloadIcon className="w-3.5 h-3.5" /> Print
                </button>
                {!allShipped && (
                  <button
                    onClick={onVoidLabel}
                    className="flex items-center gap-1 px-2 py-1 text-gray-600 hover:bg-red-50 hover:text-red-600 rounded"
                  >
                    <RotateCcw className="w-3.5 h-3.5" /> Void
                  </button>
                )}
              </div>
            </div>
          )}
          {!allShipped && (
            <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 flex justify-end gap-2 flex-wrap">
              {!hasActiveLabel && (
                <button
                  onClick={onBuyLabel}
                  className="flex items-center gap-1.5 px-4 py-2.5 bg-white border border-emerald-300 text-emerald-700 hover:bg-emerald-50 text-sm font-medium rounded-lg"
                >
                  <ShoppingCart className="w-4 h-4" /> Buy {box.carrier?.toUpperCase()} Label
                </button>
              )}
              <button
                onClick={onShip}
                className="flex items-center gap-1.5 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white text-sm font-medium rounded-lg"
              >
                <Send className="w-4 h-4" /> Mark Shipped
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
