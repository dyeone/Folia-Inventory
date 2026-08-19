import { useEffect, useState } from 'react';
import { Trash2, Loader2, Check } from 'lucide-react';
import { api } from '../api.js';

// One line in an expanded PO. Editing rules:
//   - poStatus = draft    → quantityOrdered + unitWholesalePrice editable; remove allowed
//   - poStatus = ordered  → receive controls for everyone; ADMINS can also
//     edit qty (never below what's received) / price, and remove lines with
//     nothing received — suppliers revise orders after they're placed
//   - poStatus = received → fully read-only

export function PurchaseOrderLineRow({ line, species, varieties = [], receivedItemIds = [], poStatus, poId, poItemType, isAdmin, showToast, onChanged, onSpeciesChanged }) {
  // Local form state — initialized once from props, not reset on prop
  // changes. Preserving mid-typed input across refreshes is a feature.
  // The server strips unitWholesalePrice for non-admin viewers — every
  // price render below must tolerate its absence (no '$NaN', no
  // 'undefined' seeding the input, no spurious 403-ing saves on blur).
  const hasPrice = line.unitWholesalePrice != null;
  const [qty, setQty]     = useState(String(line.quantityOrdered));
  const [price, setPrice] = useState(hasPrice ? String(line.unitWholesalePrice) : '');
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
    // Mirrors the server guard: on an ordered PO the received count is
    // physical reality — the ordered quantity can't drop below it.
    if (poStatus === 'ordered' && n < line.quantityReceived) {
      showToast?.(`${line.quantityReceived} already received — quantity can't go below that`, 'error');
      setQty(String(line.quantityOrdered));
      return;
    }
    if (n === line.quantityOrdered) return;
    setBusy(true);
    try {
      const r = await api.updatePurchaseOrderLine({ id: poId, lineId: line.id, quantityOrdered: n });
      if (r?.poFlippedToReceived) showToast?.('Order is now fully received');
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Update failed', 'error');
      setQty(String(line.quantityOrdered));
    } finally { setBusy(false); }
  };

  const savePrice = async () => {
    if (!hasPrice) return; // cost fields hidden for this viewer — nothing to save
    const n = parseFloat(price);
    if (!Number.isFinite(n) || n < 0) {
      setPrice(String(line.unitWholesalePrice));
      return;
    }
    if (n === Number(line.unitWholesalePrice)) return;
    setBusy(true);
    try {
      const r = await api.updatePurchaseOrderLine({ id: poId, lineId: line.id, unitWholesalePrice: n });
      // Already-received plants from this line get re-costed server-side —
      // say so, or the admin assumes (as before) that minted costs are stuck.
      if (r?.restampedCount) {
        showToast?.(`Price saved — ${r.restampedCount} received plant${r.restampedCount === 1 ? '' : 's'} re-costed`);
      }
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Update failed', 'error');
      setPrice(String(line.unitWholesalePrice));
    } finally { setBusy(false); }
  };

  // Pre-receive knobs (admin): how this line's plants will MINT. Both are
  // locked once anything is received — type mid-count would split one
  // shipment into mixed items, and the SKU prefix only matters for SKUs
  // that don't exist yet (printed labels never change).
  const saveType = async (t) => {
    setBusy(true);
    try {
      await api.updatePurchaseOrderLine({ id: poId, lineId: line.id, itemType: t });
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Type change failed', 'error');
    } finally { setBusy(false); }
  };

  const saveVariety = async (varietyId) => {
    if (!species || !varietyId || varietyId === species.varietyId) return;
    setBusy(true);
    try {
      await api.updateSpecies({ id: species.id, patch: { varietyId } });
      await onSpeciesChanged?.();
      onChanged?.();
      showToast?.('Variety changed — plants received from now on get the new SKU prefix');
    } catch (e) {
      showToast?.(e.message || 'Variety change failed', 'error');
    } finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const r = await api.removePurchaseOrderLine({ id: poId, lineId: line.id });
      if (r?.poFlippedToReceived) showToast?.('Order is now fully received');
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Remove failed', 'error');
    } finally { setBusy(false); }
  };

  const lineTotal = (Number(price) || 0) * (parseInt(qty, 10) || 0);
  const isDraft = poStatus === 'draft';
  // Admins keep editing after the order is placed; staff/packers see the
  // ordered state read-only (the writes are admin actions server-side).
  const canEdit = isDraft || (poStatus === 'ordered' && isAdmin);
  const canRemove = canEdit && (isDraft || line.quantityReceived === 0);
  const remaining = Math.max(0, line.quantityOrdered - line.quantityReceived);
  const [receiveQty, setReceiveQty] = useState(String(remaining));

  const doReceive = async () => {
    const n = parseInt(receiveQty, 10);
    if (!Number.isFinite(n) || n <= 0) return;
    setBusy(true);
    try {
      const r = await api.receivePurchaseOrderLine({ id: poId, lineId: line.id, quantityReceived: n });
      if (r?.poFlippedToReceived) {
        showToast?.('Received — PO complete');
      } else {
        showToast?.(`Received ${n}`);
      }
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Receive failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const cancelReceive = async () => {
    setBusy(true);
    try {
      const r = await api.cancelReceivePurchaseOrderLine({ id: poId, lineId: line.id });
      showToast?.(`Cancelled ${r.deletedCount} unit${r.deletedCount === 1 ? '' : 's'}`);
      onChanged?.();
    } catch (e) {
      showToast?.(e.message || 'Cancel failed', 'error');
    } finally { setBusy(false); }
  };

  return (
    <div className="flex items-start gap-3 px-3 py-2.5 border-t border-gray-100">
      <div className="w-14 h-14 bg-gray-100 rounded shrink-0 overflow-hidden flex items-center justify-center text-gray-300">
        {imgUrl ? <img src={imgUrl} alt="" className="w-full h-full object-cover" /> : '—'}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-900 truncate">
          {[species?.varietyName, species?.epithet || '(unknown)'].filter(Boolean).join(' · ')}
          {(line.itemType ?? poItemType) === 'tc' && (
            <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 font-semibold align-middle">TC</span>
          )}
        </div>
        {isAdmin && canEdit && line.quantityReceived === 0 && (
          <div className="mt-1 flex items-center gap-2 text-xs flex-wrap">
            <label className="flex items-center gap-1 text-gray-500">
              arrives as
              <select
                value={line.itemType || ''}
                onChange={(e) => saveType(e.target.value || null)}
                disabled={busy}
                className="px-1.5 py-1 text-xs border border-gray-300 rounded"
              >
                <option value="">Order default ({poItemType === 'tc' ? 'TC' : 'Plant'})</option>
                <option value="plant">Plant</option>
                <option value="tc">TC</option>
              </select>
            </label>
            <label className="flex items-center gap-1 text-gray-500">
              SKU prefix
              <select
                value={species?.varietyId || ''}
                onChange={(e) => saveVariety(e.target.value)}
                disabled={busy || !species}
                title="Moves this species to another variety — plants received from now on get that variety's SKU prefix. Printed labels and existing SKUs never change."
                className="px-1.5 py-1 text-xs border border-gray-300 rounded max-w-[190px]"
              >
                {!species && <option value="">—</option>}
                {(varieties || []).map(v => (
                  <option key={v.id} value={v.id}>{v.code} — {v.name}</option>
                ))}
              </select>
            </label>
          </div>
        )}
        <div className="mt-1 flex items-center gap-2 text-xs flex-wrap">
          <span className="text-gray-500">Ordered</span>
          {canEdit ? (
            <input
              type="number"
              min={poStatus === 'ordered' ? Math.max(1, line.quantityReceived) : 1}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              onBlur={saveQty}
              className="w-16 px-2 py-1 text-xs border border-gray-300 rounded"
            />
          ) : (
            <span className="font-semibold text-gray-900">{line.quantityOrdered}</span>
          )}
          {hasPrice && (
            <>
              <span className="text-gray-500">@ $</span>
              {canEdit ? (
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
            </>
          )}
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
              {!isDraft && line.quantityReceived > 0 && receivedItemIds.length > 0 && (
                <button
                  type="button"
                  onClick={cancelReceive}
                  disabled={busy}
                  className="text-xs px-2 py-1 border border-gray-300 text-gray-600 rounded hover:bg-gray-50"
                  title="Soft-delete any still-available SKUs from this line and roll back the count"
                >
                  Cancel receive
                </button>
              )}
            </span>
          )}
        </div>
      </div>
      {canRemove && (
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

