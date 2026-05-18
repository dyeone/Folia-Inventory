import { useState } from 'react';
import {
  X, PackageOpen, Camera, Check, ScanLine, Trash2, Loader2,
} from 'lucide-react';
import { api } from '../api.js';
import { CameraScanner } from './CameraScanner.jsx';
import { shortBoxCode, normalizeSku } from '../labels/boxCode.js';

// Admin-only: edit the items in an existing open box. Add by scanning
// (or typing) an inventory SKU, remove with the per-item trash button.
//
// Adds work like the manual-new-box flow: stamp the existing inventory
// row with this box's shipmentBoxId + buyer metadata and flip to 'sold'.
// Removes mirror "Delete all open boxes" semantics: matched items revert
// to 'listed' with cleared sale fields; lotKind='unmatched' placeholders
// are hard-purged (their deterministic UNMATCHED-* SKU would otherwise
// block a re-upload).
//
// The `box` prop is sourced from groupBoxesByBuyer in PackingView, so it
// re-derives from the items prop on every refresh — meaning after each
// API call we just call onRefreshItems and the modal sees the new items
// without local state to reconcile.

export function EditBoxItemsModal({ box, inventoryItems, onClose, onRefreshItems, showToast }) {
  const [scannerOpen, setScannerOpen] = useState(false);
  const [manualSku, setManualSku] = useState('');
  const [busyId, setBusyId] = useState(null);

  const carrierKey = (box.carrier || 'usps').toLowerCase();
  const carrierClass = carrierKey === 'ups'
    ? 'bg-amber-100 text-amber-900'
    : 'bg-blue-100 text-blue-900';

  // Take buyer info from the existing box so a scanned-in item inherits
  // the same address / username / carrier as the rest of the box.
  const stampMetadata = {
    buyer: box.buyer || '',
    buyerUsername: box.buyerUsername || '',
    buyerAddress: box.buyerAddress || {},
    shipmentBoxId: box.id,
    shipmentCarrier: carrierKey,
  };

  const handleScan = async (rawText) => {
    const sku = normalizeSku(rawText);
    if (!sku) return;

    const item = inventoryItems.find(i =>
      !i.deletedAt && normalizeSku(i.sku) === sku
    );
    if (!item) {
      showToast?.(`No inventory item with SKU ${sku}`, 'error');
      return;
    }
    if (box.items.some(b => b.id === item.id)) {
      showToast?.(`${sku} is already in this box`);
      return;
    }
    if (['sold', 'shipped', 'delivered'].includes(item.status) && item.shipmentBoxId && item.shipmentBoxId !== box.id) {
      showToast?.(`${sku} is already in another box — find it via Scan box`, 'error');
      return;
    }

    if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(20);
    try {
      await api.upsertItems([{
        id: item.id,
        status: 'sold',
        soldAt: new Date().toISOString(),
        ...stampMetadata,
      }]);
      await onRefreshItems?.();
    } catch (e) {
      showToast?.(`Failed to add ${sku}: ${e.message || 'unknown'}`, 'error');
    }
  };

  const handleManualSubmit = async (e) => {
    e.preventDefault();
    if (!manualSku.trim()) return;
    await handleScan(manualSku);
    setManualSku('');
  };

  const handleRemove = async (item) => {
    setBusyId(item.id);
    try {
      if (item.lotKind === 'unmatched') {
        // Placeholder: hard-purge so its deterministic UNMATCHED-... SKU
        // doesn't block a re-upload of the same order.
        await api.purgeItems([item.id]);
      } else {
        // Real inventory: revert to 'listed' so it's re-saleable.
        await api.upsertItems([{
          id: item.id,
          status: 'listed',
          salePrice: null,
          soldAt: null,
          buyer: null,
          buyerUsername: null,
          buyerAddress: null,
          shipmentBoxId: null,
          shipmentCarrier: null,
          orderId: null,
          orderDate: null,
        }]);
      }
      await onRefreshItems?.();
    } catch (e) {
      showToast?.(`Remove failed: ${e.message || 'unknown'}`, 'error');
    } finally {
      setBusyId(null);
    }
  };

  // Filter visible items: hide already-shipped lines — the operator can't
  // edit those out of the box anyway, and showing them clutters the list.
  const editableItems = box.items.filter(i =>
    !['shipped', 'delivered'].includes(i.status)
  );

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-stretch sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-2xl h-full sm:h-auto sm:max-h-[92vh] sm:rounded-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-gray-200 px-4 sm:px-5 py-3 sm:py-4 flex items-center justify-between flex-shrink-0">
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-gray-900 text-base sm:text-lg flex items-center gap-2">
              <PackageOpen className="w-5 h-5 text-emerald-600" />
              Edit items
            </h3>
            <p className="text-xs text-gray-500 mt-0.5 truncate">
              Box {shortBoxCode(box.id)} · {editableItems.length} item{editableItems.length === 1 ? '' : 's'} · {box.buyer || '(no buyer)'}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-2 -mr-1 text-gray-500 hover:bg-gray-100 active:bg-gray-200 rounded-lg ml-2">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-4 sm:px-5 py-2 bg-gray-50 border-b border-gray-200 flex items-center gap-2 text-xs flex-shrink-0">
          <span className={`inline-flex items-center px-2 py-0.5 font-bold tracking-wider rounded ${carrierClass}`}>
            {carrierKey.toUpperCase()}
          </span>
          {box.buyerUsername && <span className="text-gray-600 truncate">@{box.buyerUsername}</span>}
        </div>

        <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-3 space-y-1.5">
          {editableItems.length === 0 ? (
            <div className="text-center py-12 text-sm text-gray-400">
              <ScanLine className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              No items in this box yet. Scan or type a SKU to add the first one.
            </div>
          ) : (
            editableItems.map(item => {
              const isUnmatched = item.lotKind === 'unmatched';
              const isBusy = busyId === item.id;
              const bgCls = isUnmatched
                ? 'bg-purple-50 border-purple-200'
                : 'bg-emerald-50 border-emerald-200';
              const accentCls = isUnmatched ? 'text-purple-700' : 'text-emerald-700';
              return (
                <div key={item.id} className={`flex items-center gap-2 px-3 py-2 border rounded-lg ${bgCls}`}>
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-mono ${accentCls}`}>{item.sku || '(no SKU)'}</div>
                    {(item.name || item.variety) && (
                      <div className={`text-xs ${accentCls} opacity-80 truncate`}>
                        {[item.name, item.variety].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemove(item)}
                    disabled={isBusy}
                    aria-label={`Remove ${item.sku} from box`}
                    className="p-1.5 text-red-600 hover:bg-red-50 active:bg-red-100 rounded disabled:opacity-50"
                  >
                    {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <form
          onSubmit={handleManualSubmit}
          className="border-t border-gray-200 px-4 sm:px-5 py-3 flex-shrink-0 space-y-2 bg-white"
        >
          <button
            type="button"
            onClick={() => setScannerOpen(true)}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 text-base font-semibold bg-emerald-600 text-white rounded-xl active:bg-emerald-800"
          >
            <Camera className="w-5 h-5" /> Scan item to add
          </button>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={manualSku}
              onChange={(e) => setManualSku(e.target.value)}
              placeholder="or type SKU"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="flex-1 px-3 py-2 text-sm font-mono uppercase border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
            />
            <button
              type="submit"
              disabled={!manualSku.trim()}
              className="px-3 py-2 text-sm font-medium bg-gray-900 text-white rounded-lg disabled:bg-gray-300"
            >
              Add
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium bg-white border border-emerald-600 text-emerald-700 rounded-lg hover:bg-emerald-50 active:bg-emerald-100 inline-flex items-center gap-1"
            >
              <Check className="w-4 h-4" /> Done
            </button>
          </div>
        </form>
      </div>

      {scannerOpen && (
        <CameraScanner
          onScan={(text) => {
            handleScan(text);
            setScannerOpen(false);
          }}
          onClose={() => setScannerOpen(false)}
        />
      )}
    </div>
  );
}
