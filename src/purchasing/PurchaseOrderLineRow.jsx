import { useEffect, useState } from 'react';
import { Trash2, Loader2, Check } from 'lucide-react';
import { api } from '../api.js';

// One line in an expanded PO. Editing rules:
//   - poStatus = draft    → quantityOrdered + unitWholesalePrice editable; remove allowed
//   - poStatus = ordered  → quantityReceived input + Receive button (Task 14)
//   - poStatus = received → fully read-only (Task 14)

export function PurchaseOrderLineRow({ line, species, receivedItemIds = [], poStatus, poId, showToast, onChanged }) {
  // Local form state — initialized once from props, not reset on prop
  // changes. Preserving mid-typed input across refreshes is a feature.
  const [qty, setQty]     = useState(String(line.quantityOrdered));
  const [price, setPrice] = useState(String(line.unitWholesalePrice));
  const [busy, setBusy]   = useState(false);
  const [photoUrl, setPhotoUrl] = useState(null);

  // Resolve a thumbnail signed URL.
  const primaryPhotoId = (() => {
    const photos = species?.photos || [];
    if (photos.length === 0) return null;
    if (species?.primaryPhotoId && photos.find(p => p.id === species.primaryPhotoId)) {
      return species.primaryPhotoId;
    }
    return photos[0]?.id || null;
  })();

  useEffect(() => {
    if (!primaryPhotoId) return undefined;
    let alive = true;
    api.speciesPhotoSignedUrl(primaryPhotoId)
      .then(url => { if (alive) setPhotoUrl(url); })
      .catch(() => {});
    return () => { alive = false; };
  }, [primaryPhotoId]);

  const imgUrl = primaryPhotoId ? photoUrl : (species?.imageUrl || null);

  const saveQty = async () => {
    const n = parseInt(qty, 10);
    if (!Number.isFinite(n) || n <= 0) {
      setQty(String(line.quantityOrdered));
      return;
    }
    if (n === line.quantityOrdered) return;
    setBusy(true);
    try {
      await api.updatePurchaseOrderLine({ id: poId, lineId: line.id, quantityOrdered: n });
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Update failed', 3000);
      setQty(String(line.quantityOrdered));
    } finally { setBusy(false); }
  };

  const savePrice = async () => {
    const n = parseFloat(price);
    if (!Number.isFinite(n) || n < 0) {
      setPrice(String(line.unitWholesalePrice));
      return;
    }
    if (n === Number(line.unitWholesalePrice)) return;
    setBusy(true);
    try {
      await api.updatePurchaseOrderLine({ id: poId, lineId: line.id, unitWholesalePrice: n });
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Update failed', 3000);
      setPrice(String(line.unitWholesalePrice));
    } finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.removePurchaseOrderLine({ id: poId, lineId: line.id });
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Remove failed', 3000);
    } finally { setBusy(false); }
  };

  const lineTotal = (Number(price) || 0) * (parseInt(qty, 10) || 0);
  const isDraft = poStatus === 'draft';
  const remaining = Math.max(0, line.quantityOrdered - line.quantityReceived);
  const [receiveQty, setReceiveQty] = useState(String(remaining));

  const doReceive = async () => {
    const n = parseInt(receiveQty, 10);
    if (!Number.isFinite(n) || n <= 0) return;
    setBusy(true);
    try {
      const r = await api.receivePurchaseOrderLine({ id: poId, lineId: line.id, quantityReceived: n });
      if (r?.poFlippedToReceived) {
        showToast?.('Received — PO complete', 2200);
      } else {
        showToast?.(`Received ${n}`, 1500);
      }
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Receive failed', 3000);
    } finally {
      setBusy(false);
    }
  };

  // receivedItemIds is reserved for the Task 15 cancel-receive button.
  void receivedItemIds;

  return (
    <div className="flex items-start gap-3 px-3 py-2.5 border-t border-gray-100">
      <div className="w-14 h-14 bg-gray-100 rounded shrink-0 overflow-hidden flex items-center justify-center text-gray-300">
        {imgUrl ? <img src={imgUrl} alt="" className="w-full h-full object-cover" /> : '—'}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-900 truncate">
          {species?.varietyName || ''} · {species?.epithet || '(unknown)'}
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs flex-wrap">
          <span className="text-gray-500">Ordered</span>
          {isDraft ? (
            <input
              type="number"
              min={1}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              onBlur={saveQty}
              className="w-16 px-2 py-1 text-xs border border-gray-300 rounded"
            />
          ) : (
            <span className="font-semibold text-gray-900">{line.quantityOrdered}</span>
          )}
          <span className="text-gray-500">@ $</span>
          {isDraft ? (
            <input
              type="number"
              step="0.01"
              min={0}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              onBlur={savePrice}
              className="w-20 px-2 py-1 text-xs border border-gray-300 rounded"
            />
          ) : (
            <span className="font-semibold text-gray-900">${Number(line.unitWholesalePrice).toFixed(2)}</span>
          )}
          <span className="text-gray-500">=</span>
          <span className="font-semibold text-gray-900 tabular-nums">${lineTotal.toFixed(2)}</span>
          {!isDraft && (
            <span className="ml-auto flex items-center gap-2">
              <span className="text-gray-500">
                Received <span className="font-semibold text-gray-900">{line.quantityReceived}</span>/{line.quantityOrdered}
                {line.quantityReceived > line.quantityOrdered && (
                  <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-semibold">
                    +{line.quantityReceived - line.quantityOrdered} over
                  </span>
                )}
              </span>
              {poStatus === 'ordered' && remaining > 0 && (
                <>
                  <input
                    type="number"
                    min={1}
                    value={receiveQty}
                    onChange={(e) => setReceiveQty(e.target.value)}
                    className="w-16 px-2 py-1 text-xs border border-gray-300 rounded"
                  />
                  <button
                    type="button"
                    onClick={doReceive}
                    disabled={busy}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded disabled:opacity-60"
                  >
                    {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                    Receive
                  </button>
                </>
              )}
            </span>
          )}
        </div>
      </div>
      {isDraft && (
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          className="shrink-0 p-1.5 text-gray-400 hover:text-red-600 rounded"
          title="Remove line"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
        </button>
      )}
    </div>
  );
}

