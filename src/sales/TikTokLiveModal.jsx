import { useEffect, useMemo, useState } from 'react';
import { PackageOpen, Download, Check, Loader2, AlertCircle, FileSpreadsheet } from 'lucide-react';
import { api } from '../api.js';
import { Modal } from '../ui/Modal.jsx';
import { groupTcForListing, downloadTikTokXlsx, downloadTikTokCsv } from './tiktokExport.js';

// TikTok live setup for a sale: TikTok lives sell TC, and TC arrives by
// the purchase order — so inventory loads in bulk per PO (every TC item
// that order minted and that isn't already in a sale), then the whole
// lineup exports as TikTok Seller Center's own bulk-listing workbook
// (one row per species, quantity = plantlet count) or a CSV twin.

export function TikTokLiveModal({ sale, sales = [], items, speciesById, showToast, onItemsChanged, onClose }) {
  const [pos, setPos] = useState(null);
  const [busyPo, setBusyPo] = useState(null);
  const [poPreview, setPoPreview] = useState(null); // { po, eligible, inThisSale, inOtherSale, nonTc }
  const [pkg, setPkg] = useState({ weightLb: 1, lengthIn: 8, widthIn: 6, heightIn: 4 });
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.listPurchaseOrders('ordered,received')
      .then(fresh => { if (!cancelled) setPos(fresh || []); })
      .catch(e => { if (!cancelled) showToast?.(e.message || 'Could not load purchase orders', 'error'); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saleTc = useMemo(
    () => items.filter(i => i.saleId === sale.id && i.type === 'tc'),
    [items, sale.id],
  );
  const groups = useMemo(() => groupTcForListing(saleTc, speciesById), [saleTc, speciesById]);
  // Cost now backstops the price and the brand image backstops the photo,
  // so these only fire when an item has NEITHER a price NOR a cost.
  const missingPrice = groups.filter(g => g.price == null).length;
  const missingImage = groups.filter(g => !g.imageUrl).length;
  const atCostCount = groups.filter(g => g.priceSource === 'cost').length;

  // Unsold TC parked in a CLOSED sale is reclaimable — closing a live never
  // clears its unsold items' saleId, and without this the leftovers from
  // last week's TikTok live could never be bulk-loaded into the next one.
  const closedSaleIds = useMemo(
    () => new Set((sales || []).filter(s => s.status === 'closed').map(s => s.id)),
    [sales],
  );

  const previewPo = async (po) => {
    if (busyPo) return;
    setBusyPo(po.id);
    setPoPreview(null);
    try {
      const { receivedItems } = await api.getPurchaseOrder(po.id);
      const ids = new Set((receivedItems || []).map(r => r.inventoryItemId));
      const poItems = items.filter(i => ids.has(i.id));
      const sellable = (i) => i.type === 'tc' && ['available', 'acclimated'].includes(i.status);
      const fresh = poItems.filter(i => sellable(i) && !i.saleId);
      const reclaim = poItems.filter(i => sellable(i) && i.saleId && closedSaleIds.has(i.saleId));
      setPoPreview({
        po,
        fresh,
        reclaim,
        eligible: [...fresh, ...reclaim],
        inThisSale: poItems.filter(i => i.saleId === sale.id).length,
        inOtherSale: poItems.filter(i => i.saleId && i.saleId !== sale.id && !closedSaleIds.has(i.saleId)).length,
        nonTc: poItems.filter(i => i.type !== 'tc').length,
      });
    } catch (e) {
      showToast?.(e.message || 'Could not load that order', 'error');
    } finally {
      setBusyPo(null);
    }
  };

  const addEligible = async () => {
    if (!poPreview?.eligible.length || busyPo) return;
    setBusyPo(poPreview.po.id);
    try {
      // Race-safe server-side claim for unassigned items: the saleId-null
      // guard lives in the UPDATE itself, so two admins loading the same
      // PO into different lives can't double-list — the response says
      // what we actually got.
      let got = 0;
      if (poPreview.fresh.length) {
        const { assignedIds } = await api.assignItemsToSale({
          itemIds: poPreview.fresh.map(i => i.id),
          saleId: sale.id,
        });
        got += (assignedIds || []).length;
      }
      // Reclaims come FROM a closed sale, so the null-guard can't apply;
      // stealing from a closed sale is safe (nothing lists from it), and
      // the lot reset matches the staging invariant.
      if (poPreview.reclaim.length) {
        await api.upsertItems(poPreview.reclaim.map(i => ({
          id: i.id, saleId: sale.id, lotKind: 'sale', lotNumber: null,
        })));
        got += poPreview.reclaim.length;
      }
      onItemsChanged?.();
      const lost = poPreview.eligible.length - got;
      showToast?.(
        `Added ${got} TC plant${got === 1 ? '' : 's'} to ${sale.name}`
        + (poPreview.reclaim.length ? ` (${poPreview.reclaim.length} reclaimed from a closed sale)` : '')
        + (lost > 0 ? ` — ${lost} taken by another sale just now` : ''),
      );
      setPoPreview(null);
    } catch (e) {
      showToast?.(e.message || 'Could not add the items', 'error');
    } finally {
      setBusyPo(null);
    }
  };

  const runExport = async (kind) => {
    if (exporting) return;
    if (!groups.length) { showToast?.('No TC plants in this live yet — load a purchase order first'); return; }
    setExporting(true);
    const fn = kind === 'csv' ? downloadTikTokCsv : downloadTikTokXlsx;
    const ok = await fn(sale, groups, pkg, showToast);
    if (ok) showToast?.(`Exported ${groups.length} listing${groups.length === 1 ? '' : 's'} (${saleTc.length} plantlets)`);
    setExporting(false);
  };

  const pkgInput = (key, label) => (
    <label className="block">
      <span className="text-[11px] text-gray-600">{label}</span>
      <input
        type="number"
        min="0"
        step="0.1"
        value={pkg[key]}
        onChange={(e) => setPkg(p => ({ ...p, [key]: parseFloat(e.target.value) || 0 }))}
        className="input mt-0.5 !py-1.5"
      />
    </label>
  );

  return (
    <Modal title={`TikTok live — ${sale.name}`} onClose={onClose} size="lg">
      <div className="space-y-4">
        {/* 1 · Load inventory per PO */}
        <div>
          <div className="text-xs font-semibold text-gray-700 mb-2">1 · Load TC inventory from a purchase order</div>
          {pos === null ? (
            <div className="text-sm text-gray-500 py-4 text-center"><Loader2 className="w-4 h-4 animate-spin inline mr-1.5" />Loading orders…</div>
          ) : pos.length === 0 ? (
            <div className="text-sm text-gray-500 py-2">No purchase orders yet — create one on the Wholesale tab first.</div>
          ) : (
            <div className="space-y-1.5 max-h-44 overflow-y-auto">
              {pos.map(po => (
                <button
                  key={po.id}
                  type="button"
                  onClick={() => previewPo(po)}
                  disabled={!!busyPo}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left text-sm transition ${
                    poPreview?.po.id === po.id ? 'border-emerald-400 bg-emerald-50/60' : 'border-gray-200 hover:border-gray-300'
                  } disabled:opacity-60`}
                >
                  <PackageOpen className="w-4 h-4 text-gray-400 shrink-0" />
                  <span className="flex-1 min-w-0 truncate font-medium text-gray-900">
                    {po.supplier || `Order #${po.id.slice(-6)}`}
                  </span>
                  <span className="text-xs text-gray-500 shrink-0">
                    {po.status} · {po.unitCount} units
                  </span>
                  {busyPo === po.id && <Loader2 className="w-4 h-4 animate-spin text-gray-400 shrink-0" />}
                </button>
              ))}
            </div>
          )}
          {poPreview && (
            <div className="mt-2 bg-gray-50 rounded-lg px-3 py-2.5 text-xs space-y-2">
              <div className="text-gray-700">
                <span className="font-semibold text-emerald-700">{poPreview.eligible.length} TC plants ready to add</span>
                {poPreview.reclaim.length > 0 && ` (${poPreview.reclaim.length} reclaimed from a closed sale)`}
                {poPreview.inThisSale > 0 && ` · ${poPreview.inThisSale} already in this live`}
                {poPreview.inOtherSale > 0 && ` · ${poPreview.inOtherSale} in an active sale (skipped)`}
                {poPreview.nonTc > 0 && ` · ${poPreview.nonTc} non-TC (skipped)`}
              </div>
              <button
                type="button"
                onClick={addEligible}
                disabled={!poPreview.eligible.length || !!busyPo}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold disabled:bg-gray-300"
              >
                <Check className="w-4 h-4" /> Add {poPreview.eligible.length} TC plant{poPreview.eligible.length === 1 ? '' : 's'} to this live
              </button>
            </div>
          )}
        </div>

        {/* Current lineup summary */}
        <div className="border-t border-gray-100 pt-3">
          <div className="text-xs font-semibold text-gray-700 mb-1.5">
            In this live: {saleTc.length} TC plantlet{saleTc.length === 1 ? '' : 's'} · {groups.length} listing{groups.length === 1 ? '' : 's'}
          </div>
          {groups.length > 0 && (
            <div className="max-h-36 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-50 text-xs">
              {groups.map(g => (
                <div key={g.key} className="flex items-center gap-2 px-2.5 py-1.5">
                  <span className="flex-1 min-w-0 truncate text-gray-900">{[g.variety, g.name].filter(Boolean).join(' ')}</span>
                  <span className="text-gray-500 shrink-0">×{g.count}</span>
                  <span className={`shrink-0 tabular-nums ${g.price == null ? 'text-red-600 font-semibold' : 'text-gray-700'}`}>
                    {g.price != null ? `$${g.price.toFixed(2)}` : 'no price'}
                  </span>
                  {g.priceSource === 'cost' && (
                    <span className="shrink-0 text-[10px] px-1 py-0.5 rounded bg-amber-50 text-amber-700 font-semibold" title="No listing price set — exporting at the plantlet's cost as the starting price">
                      at cost
                    </span>
                  )}
                  {!g.imageUrl && <AlertCircle className="w-3.5 h-3.5 text-amber-500 shrink-0" title="No image URL — TikTok requires a main image" />}
                </div>
              ))}
            </div>
          )}
          {(missingPrice > 0 || missingImage > 0 || atCostCount > 0) && (
            <div className="mt-1.5 text-[11px] text-amber-700">
              {missingPrice > 0 && `${missingPrice} listing${missingPrice === 1 ? '' : 's'} missing a price (no listing price AND no cost on the items — set one of them). `}
              {atCostCount > 0 && `${atCostCount} listing${atCostCount === 1 ? '' : 's'} priced at cost — the plantlet's cost is the starting price until you set a listing price. `}
              {missingImage > 0 && `${missingImage} missing an image URL (fill in Seller Center or on the items).`}
            </div>
          )}
        </div>

        {/* 2 · Export */}
        <div className="border-t border-gray-100 pt-3">
          <div className="text-xs font-semibold text-gray-700 mb-2">2 · Export for TikTok Seller Center</div>
          <div className="grid grid-cols-4 gap-2 mb-2.5">
            {pkgInput('weightLb', 'Weight (lb)')}
            {pkgInput('lengthIn', 'Length (in)')}
            {pkgInput('widthIn', 'Width (in)')}
            {pkgInput('heightIn', 'Height (in)')}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => runExport('xlsx')}
              disabled={exporting || !groups.length}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg bg-gray-900 hover:bg-black text-white text-sm font-semibold disabled:bg-gray-300"
            >
              {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />}
              Seller Center file (.xlsx)
            </button>
            <button
              type="button"
              onClick={() => runExport('csv')}
              disabled={exporting || !groups.length}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg border border-gray-300 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40"
            >
              <Download className="w-4 h-4" /> .csv
            </button>
          </div>
          <div className="mt-1.5 text-[11px] text-gray-500">
            The .xlsx is TikTok's own template with your listings filled in — upload it directly in Seller Center → Products → Batch add. One row per species, quantity = plantlet count.
          </div>
        </div>
      </div>
    </Modal>
  );
}
