import { useState, useMemo, useEffect } from 'react';
import {
  Package, AlertCircle, ArrowLeft, PackageOpen, ChevronRight, Upload,
  Truck, Pencil, Check, X, Loader2, Trash2,
} from 'lucide-react';
import { api } from '../api.js';
import { BuyLabelModal } from './BuyLabelModal.jsx';
import { ShipBoxCard } from './ShipBoxCard.jsx';
import { SummaryStat } from './SummaryStat.jsx';

// Re-export the shared building blocks so SalesUploadModal's existing
// imports keep working without a churn-y find-and-replace across files.
export { BoxesList } from './BoxesList.jsx';
export { SummaryStat } from './SummaryStat.jsx';

// ───────────────────────────────────────────────────────────────────────────
// Shipping tab top-level view.
//
// Step 1 of the packing rewrite: list every package (box) that hasn't fully
// shipped yet — label bought or not — grouped by buyer so a single recipient
// who won lots across multiple sales is consolidated into one card.
//
// Tapping a box still drills into the existing per-sale pane (SalePackingPane
// → PackingBoxesPane → ShipBoxCard) so label-buying / mark-shipped flows are
// untouched while we iterate the top view.
// ───────────────────────────────────────────────────────────────────────────

export function PackingView({ inventoryItems, sales, onShipBox, onDeleteAllOpenBoxes, setConfirmDialog }) {
  const [activeSaleId, setActiveSaleId] = useState(null);
  // Sub-tab inside the Shipping page: 'ready' for active boxes,
  // 'shipped' for the archive. Defaults to 'ready' since that's the
  // common operator workflow.
  const [subTab, setSubTab] = useState('ready');

  // Shipments keyed by shipmentBoxId. We need these to know which boxes
  // already have a label / tracking number (→ "Mark shipped") vs. which
  // still need one (→ "Buy label" / "Enter tracking"). Loaded once across
  // all sales since `GET /api/shipments` with no saleId returns the user's
  // full shipments table — see api/shipments.js:53.
  const [shipmentsByBox, setShipmentsByBox] = useState({});
  const [buyingFor, setBuyingFor] = useState(null);
  const [toast, setToast] = useState(null);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const refreshShipments = async () => {
    try {
      const list = await api.getShipments();
      setShipmentsByBox(Object.fromEntries((list || []).map(s => [s.id, s])));
    } catch { /* no-op — rows just won't reflect label state */ }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.getShipments();
        if (cancelled) return;
        setShipmentsByBox(Object.fromEntries((list || []).map(s => [s.id, s])));
      } catch { /* no-op */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // "Ready to ship" = boxes with at least one item still 'sold' (i.e. not
  // every item has been shipped yet). "Shipped" = boxes where every item
  // is in 'shipped' or 'delivered'. Both views use the same buyer
  // grouping for layout consistency.
  const { groups, totalBoxes, totalItems } = useMemo(
    () => groupBoxesByBuyer(inventoryItems, sales, READY_PREDICATE),
    [inventoryItems, sales]
  );
  const shipped = useMemo(
    () => groupBoxesByBuyer(inventoryItems, sales, SHIPPED_PREDICATE),
    [inventoryItems, sales]
  );

  // Sales in 'packing' status that haven't had their orders uploaded yet —
  // they don't have boxes to list (no shipmentBoxId assigned), so they need
  // a separate "awaiting upload" surface to route the operator back to the
  // Sale tab's validate-orders step.
  const awaitingUpload = useMemo(
    () => sales
      .filter(s => s.status === 'packing')
      .filter(s => !inventoryItems.some(i => i.saleId === s.id && i.shipmentBoxId))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)),
    [sales, inventoryItems]
  );

  // Pre-compute the open-box delete summary so the confirm dialog can
  // show what will actually happen ("Revert N items / soft-delete M
  // placeholders") instead of a generic "are you sure?" prompt.
  const deleteSummary = useMemo(() => {
    let matched = 0;
    let unmatched = 0;
    for (const item of inventoryItems) {
      if (item.deletedAt) continue;
      if (item.status !== 'sold') continue;
      if (!item.shipmentBoxId) continue;
      if (item.lotKind === 'unmatched') unmatched++; else matched++;
    }
    return { matched, unmatched, total: matched + unmatched };
  }, [inventoryItems]);

  const activeSale = sales.find(s => s.id === activeSaleId);
  if (activeSale) {
    return (
      <SalePackingPane
        sale={activeSale}
        inventoryItems={inventoryItems}
        onBack={() => setActiveSaleId(null)}
        onShipBox={(itemIds) => onShipBox(activeSale.id, itemIds)}
        setConfirmDialog={setConfirmDialog}
      />
    );
  }

  // Inline action handlers. The fast-path is to keep the operator on the
  // list — drilling into a sale is reserved for label PDFs, voids, and
  // partial-tracking edits.
  const handleMarkShipped = async (box) => {
    const itemIds = box.items.filter(i => i.status === 'sold').map(i => i.id);
    if (itemIds.length === 0) return;
    await onShipBox(box.saleId, itemIds);
    // onShipBox refreshes items at the App level → groups recompute and
    // this box disappears. No need to refresh shipments here.
  };

  const handleSaveTracking = async (box, trackingNumber) => {
    await api.recordPalmstreetTracking(box.id, trackingNumber);
    await refreshShipments();
    showToast('Tracking saved');
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <Package className="w-5 h-5 text-emerald-600" /> Shipping
        </h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Every package with at least one item still to ship, consolidated by buyer
          across sale events.
        </p>
      </div>

      {/* Inner-page sub-tabs. Same chip-tab pattern used elsewhere
          (PackingBoxesPane's carrier filter) so the visual language is
          consistent. Counts live in the tab labels so the operator can
          see the workload split before clicking. */}
      <div className="bg-white rounded-xl border border-gray-200 px-1 py-1 flex gap-0.5 overflow-x-auto">
        {[
          { value: 'ready', label: 'Ready to ship', count: totalBoxes },
          { value: 'shipped', label: 'Shipped', count: shipped.totalBoxes },
        ].map(tab => {
          const active = subTab === tab.value;
          return (
            <button
              key={tab.value}
              onClick={() => setSubTab(tab.value)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg whitespace-nowrap transition ${
                active ? 'bg-emerald-600 text-white font-medium' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              {tab.label}
              <span className={`text-xs ${active ? 'text-emerald-100' : 'text-gray-400'}`}>
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>

      {subTab === 'ready' && (
        <>
          <section className="space-y-2">
            <h3 className="text-sm font-medium text-gray-700">
              Ready to ship
              <span className="text-gray-400 font-normal ml-1">
                · {totalBoxes} {totalBoxes === 1 ? 'box' : 'boxes'} · {groups.length} {groups.length === 1 ? 'buyer' : 'buyers'} · {totalItems} {totalItems === 1 ? 'item' : 'items'}
              </span>
            </h3>
            {groups.length === 0 ? (
              <div className="bg-white border border-gray-200 rounded-xl p-8 text-center">
                <PackageOpen className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                <p className="text-sm text-gray-500">
                  Nothing waiting to ship. When a sale's orders get applied, boxes
                  show up here.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {groups.map(g => (
                  <BuyerGroupCard
                    key={g.key}
                    group={g}
                    sales={sales}
                    shipmentsByBox={shipmentsByBox}
                    onOpenBox={(saleId) => setActiveSaleId(saleId)}
                    onBuyLabel={(box) => setBuyingFor(box)}
                    onSaveTracking={handleSaveTracking}
                    onMarkShipped={handleMarkShipped}
                    showToast={showToast}
                  />
                ))}
              </div>
            )}
          </section>

          {/* Danger zone — wipe every open box in one click. Reverts
              matched items back to 'listed' and soft-deletes unmatched
              placeholders. Used to recover after an upload that went
              wrong (wrong file, bad SKUs, etc.) so the operator can
              clean up and re-apply. */}
          {deleteSummary.total > 0 && onDeleteAllOpenBoxes && (
            <section>
              <button
                type="button"
                onClick={() => {
                  setConfirmDialog?.({
                    title: `Delete all open boxes?`,
                    message: deleteSummary.unmatched > 0
                      ? `Reverts ${deleteSummary.matched} matched item${deleteSummary.matched === 1 ? '' : 's'} back to "listed" and soft-deletes ${deleteSummary.unmatched} unmatched placeholder${deleteSummary.unmatched === 1 ? '' : 's'} (recoverable from Recently Deleted). Already-shipped items aren't touched.`
                      : `Reverts ${deleteSummary.matched} matched item${deleteSummary.matched === 1 ? '' : 's'} back to "listed". Already-shipped items aren't touched.`,
                    confirmLabel: 'Delete all open boxes',
                    danger: true,
                    onConfirm: () => onDeleteAllOpenBoxes(),
                  });
                }}
                className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg border border-red-200 text-red-700 bg-white hover:bg-red-50 active:bg-red-100"
              >
                <Trash2 className="w-4 h-4" />
                Delete all open boxes
                <span className="text-xs text-red-500 font-normal ml-1">
                  · {deleteSummary.matched} revert{deleteSummary.unmatched > 0 ? ` + ${deleteSummary.unmatched} placeholder${deleteSummary.unmatched === 1 ? '' : 's'}` : ''}
                </span>
              </button>
            </section>
          )}

          {awaitingUpload.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-sm font-medium text-gray-700">
                Awaiting upload
                <span className="text-gray-400 font-normal ml-1">
                  · {awaitingUpload.length}
                </span>
              </h3>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {awaitingUpload.map(sale => (
                  <button
                    key={sale.id}
                    onClick={() => setActiveSaleId(sale.id)}
                    className="text-left bg-amber-50 border border-amber-200 rounded-xl p-4 hover:border-amber-400 hover:shadow-sm active:bg-amber-100 transition"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-gray-900 truncate">{sale.name}</div>
                        <div className="text-xs text-gray-500">{sale.date}</div>
                      </div>
                      <Upload className="w-4 h-4 text-amber-600 shrink-0" />
                    </div>
                    <div className="text-xs text-amber-800 mt-2">
                      Run "Validate Sales" in the Sale tab to assemble boxes.
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* Shipped archive — BoxRow detects the all-shipped state and hides
          the per-row action buttons (nothing left to act on), but the
          chevron drill-in still works for label-PDF retrieval. */}
      {subTab === 'shipped' && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-gray-700">
            Shipped
            <span className="text-gray-400 font-normal ml-1">
              · {shipped.totalBoxes} {shipped.totalBoxes === 1 ? 'box' : 'boxes'} · {shipped.groups.length} {shipped.groups.length === 1 ? 'buyer' : 'buyers'} · {shipped.totalItems} {shipped.totalItems === 1 ? 'item' : 'items'}
            </span>
          </h3>
          {shipped.groups.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl p-8 text-center">
              <PackageOpen className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-500">
                No boxes have shipped yet. Once you Mark shipped on a row, it
                moves here.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {shipped.groups.map(g => (
                <BuyerGroupCard
                  key={g.key}
                  group={g}
                  sales={sales}
                  shipmentsByBox={shipmentsByBox}
                  onOpenBox={(saleId) => setActiveSaleId(saleId)}
                  onBuyLabel={(box) => setBuyingFor(box)}
                  onSaveTracking={handleSaveTracking}
                  onMarkShipped={handleMarkShipped}
                  showToast={showToast}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {buyingFor && (
        <BuyLabelModal
          box={buyingFor}
          onClose={() => setBuyingFor(null)}
          onPurchased={() => {
            refreshShipments();
            showToast('Label purchased');
          }}
          showToast={showToast}
        />
      )}

      {toast && (
        <div className="fixed bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-sm px-4 py-2 rounded-lg shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Buyer grouping helpers.
// ───────────────────────────────────────────────────────────────────────────

// "Ready to ship" — at least one item still 'sold' (not every item has
// been shipped yet). Partially-shipped boxes show up here too so the
// operator can finish them.
const READY_PREDICATE = (box) =>
  box.items.some(i => i.status === 'sold');

// "Shipped" — every item in the box is shipped/delivered. Used by the
// archive section so the operator can find historical boxes by buyer.
const SHIPPED_PREDICATE = (box) =>
  box.items.length > 0 &&
  box.items.every(i => ['shipped', 'delivered'].includes(i.status));

function groupBoxesByBuyer(items, sales, predicate) {
  // First, assemble every (live) box from item rows. A box exists once an
  // item has a shipmentBoxId — that's what the post-upload apply step
  // stamps on. We always consider items in 'sold'/'shipped'/'delivered'
  // (anything that's been through Validate Sales). The caller-supplied
  // predicate decides which of the resulting boxes survive to be grouped.
  const boxMap = new Map();
  for (const item of items) {
    if (!item.shipmentBoxId) continue;
    if (item.deletedAt) continue;
    if (!['sold', 'shipped', 'delivered'].includes(item.status)) continue;
    let box = boxMap.get(item.shipmentBoxId);
    if (!box) {
      box = {
        id: item.shipmentBoxId,
        saleId: item.saleId,
        buyer: item.buyer || '',
        buyerUsername: item.buyerUsername || '',
        buyerAddress: item.buyerAddress || {},
        carrier: item.shipmentCarrier || 'usps',
        items: [],
      };
      boxMap.set(item.shipmentBoxId, box);
    }
    box.items.push(item);
  }

  const openBoxes = [...boxMap.values()].filter(predicate);

  // Group by buyer. Prefer username (canonical across Palmstreet sales),
  // fall back to display name. The username is what disambiguates two
  // buyers who happen to share a display name.
  const groupMap = new Map();
  for (const box of openBoxes) {
    const key = (box.buyerUsername || box.buyer || 'unknown').toLowerCase();
    let group = groupMap.get(key);
    if (!group) {
      group = {
        key,
        displayName: box.buyer || box.buyerUsername || 'Unknown buyer',
        username: box.buyerUsername || '',
        addressSnippet: addressOneLine(box.buyerAddress),
        boxes: [],
      };
      groupMap.set(key, group);
    }
    group.boxes.push(box);
  }

  // Within a group, sort boxes by sale recency (newest sale first). Across
  // groups, sort alphabetically by display name — operator can scan to find
  // a specific buyer fast.
  const saleById = new Map(sales.map(s => [s.id, s]));
  for (const group of groupMap.values()) {
    group.boxes.sort((a, b) => {
      const sa = saleById.get(a.saleId);
      const sb = saleById.get(b.saleId);
      return new Date(sb?.createdAt || 0) - new Date(sa?.createdAt || 0);
    });
  }
  const groups = [...groupMap.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName)
  );

  const totalItems = openBoxes.reduce((sum, b) => sum + b.items.length, 0);
  return { groups, totalBoxes: openBoxes.length, totalItems };
}

function addressOneLine(addr) {
  if (!addr || typeof addr !== 'object') return '';
  const parts = [addr.city, addr.state, addr.zip || addr.zipCode].filter(Boolean);
  return parts.join(', ');
}

function BuyerGroupCard({
  group, sales, shipmentsByBox,
  onOpenBox, onBuyLabel, onSaveTracking, onMarkShipped, showToast,
}) {
  const totalItems = group.boxes.reduce((sum, b) => sum + b.items.length, 0);
  const saleCount = new Set(group.boxes.map(b => b.saleId)).size;
  const salesById = useMemo(
    () => new Map(sales.map(s => [s.id, s])),
    [sales],
  );

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-gray-900 truncate">{group.displayName}</div>
          <div className="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
            {group.username && <span>@{group.username}</span>}
            {group.addressSnippet && <span className="truncate">· {group.addressSnippet}</span>}
          </div>
        </div>
        <div className="text-right text-xs text-gray-500 shrink-0 leading-tight">
          <div>
            {group.boxes.length} {group.boxes.length === 1 ? 'box' : 'boxes'}
          </div>
          <div>
            {totalItems} {totalItems === 1 ? 'item' : 'items'}
            {saleCount > 1 && <> · {saleCount} sales</>}
          </div>
        </div>
      </div>
      <div className="space-y-1.5">
        {group.boxes.map(box => (
          <BoxRow
            key={box.id}
            box={box}
            sale={salesById.get(box.saleId)}
            salesById={salesById}
            shipment={shipmentsByBox[box.id]}
            onOpen={() => onOpenBox(box.saleId)}
            onBuyLabel={() => onBuyLabel(box)}
            onSaveTracking={(num) => onSaveTracking(box, num)}
            onMarkShipped={() => onMarkShipped(box)}
            showToast={showToast}
          />
        ))}
      </div>
    </div>
  );
}

// Compute the per-box action state. The shipments row is the source of
// truth for "has label / tracking", but a voided row counts as "no label"
// so the operator can buy/enter again.
function boxActionState(box, shipment) {
  const liveShipment = shipment && !shipment.voidedAt ? shipment : null;
  const hasLabel = !!liveShipment?.labelStoragePath;
  const hasTracking = !!liveShipment?.trackingNumber;
  const carrier = (box.carrier || 'usps').toLowerCase();

  if (hasLabel || hasTracking) return { kind: 'ship', carrier, shipment: liveShipment };
  if (carrier === 'ups') return { kind: 'buy-label', carrier };
  return { kind: 'enter-tracking', carrier };
}

function BoxItemsList({ box, salesById }) {
  // Sort items by SKU for predictable display; fall back to name.
  const sortedItems = useMemo(() => {
    const copy = [...box.items];
    copy.sort((a, b) => {
      const sa = (a.sku || a.name || '').toString();
      const sb = (b.sku || b.name || '').toString();
      return sa.localeCompare(sb);
    });
    return copy;
  }, [box.items]);

  return (
    <div className="border-t border-gray-100 bg-gray-50/40 px-3 py-2 space-y-1.5">
      {sortedItems.map(item => {
        const itemSale = salesById?.get(item.saleId);
        const name = (item.name || '').trim();
        const variety = (item.variety || '').trim();
        const qty = item.quantity || 1;
        // salePrice is set at order-apply time (SalesUploadModal). It's
        // stored as a numeric in dollars to match the existing
        // ShipBoxCard / SalesView display convention.
        const priceRaw = item.salePrice != null ? parseFloat(item.salePrice) : NaN;
        const priceStr = Number.isFinite(priceRaw) && priceRaw > 0
          ? `$${priceRaw.toFixed(2)}`
          : null;
        const isGiveaway = item.lotKind === 'giveaway';
        const isUnmatched = item.lotKind === 'unmatched';
        const shippedAlready = ['shipped', 'delivered'].includes(item.status);

        // Visual treatment: matched lots get an emerald accent, unmatched
        // placeholders get a purple accent so they stand out for the
        // operator (they're a flag — the order line couldn't be linked
        // to real inventory at apply time).
        const rowBg = isUnmatched
          ? 'bg-purple-50 border-l-2 border-purple-300'
          : 'bg-emerald-50 border-l-2 border-emerald-300';

        return (
          <div
            key={item.id}
            className={`text-sm flex items-baseline justify-between gap-3 rounded px-2 py-1.5 ${rowBg} ${shippedAlready ? 'opacity-60' : ''}`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 flex-wrap">
                {item.sku && (
                  <span className="font-mono text-[11px] text-gray-500 shrink-0">{item.sku}</span>
                )}
                {name && (
                  <span className="text-gray-900 font-medium truncate">{name}</span>
                )}
                {name && variety && (
                  <span className="text-gray-300 shrink-0">·</span>
                )}
                {variety && (
                  <span className="text-gray-700 truncate">{variety}</span>
                )}
                {!name && !variety && (
                  <span className="text-gray-400">—</span>
                )}
                <span className="text-xs text-gray-500 shrink-0">×{qty}</span>
                {shippedAlready && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">
                    shipped
                  </span>
                )}
                {isUnmatched && !shippedAlready && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-purple-100 text-purple-800">
                    unmatched
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-gray-500 flex-wrap mt-0.5">
                {isGiveaway ? (
                  <span className="text-amber-700 font-medium">giveaway</span>
                ) : isUnmatched ? (
                  <span className="text-purple-700 font-medium">no inventory link</span>
                ) : (
                  <span>regular</span>
                )}
                {item.orderId && (
                  <>
                    <span className="text-gray-300">·</span>
                    <span className="font-mono">{item.orderId}</span>
                  </>
                )}
                {itemSale?.name && (
                  <>
                    <span className="text-gray-300">·</span>
                    <span className="truncate">{itemSale.name}</span>
                  </>
                )}
              </div>
            </div>
            {priceStr && (
              <span className="text-sm text-gray-700 font-medium shrink-0 tabular-nums">
                {priceStr}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function BoxRow({
  box, sale, shipment, salesById,
  onOpen, onBuyLabel, onSaveTracking, onMarkShipped, showToast,
}) {
  const shipped = box.items.filter(i =>
    ['shipped', 'delivered'].includes(i.status)
  ).length;
  const total = box.items.length;
  const partial = shipped > 0 && shipped < total;
  const allShipped = total > 0 && shipped === total;

  // Every box defaults to expanded — the operator wants the item
  // detail visible without an extra click on both Ready and Shipped.
  // User can still collapse individual rows by clicking the body.
  const [expanded, setExpanded] = useState(true);
  const [editingTracking, setEditingTracking] = useState(false);
  const [trackingDraft, setTrackingDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const carrierKey = (box.carrier || 'usps').toLowerCase();
  const carrierLabel = carrierKey.toUpperCase();
  const carrierClass = carrierKey === 'ups'
    ? 'bg-amber-100 text-amber-800'
    : 'bg-blue-100 text-blue-800';

  // For shipped boxes there's nothing left to act on — hide the
  // primary action button and the inline tracking editor. Chevron
  // drill-in to the per-sale pane is still useful (label PDF download).
  const action = allShipped ? null : boxActionState(box, shipment);

  const handleSaveTracking = async (e) => {
    e?.stopPropagation();
    const num = trackingDraft.trim();
    if (!num) return;
    setBusy(true);
    try {
      await onSaveTracking(num);
      setEditingTracking(false);
      setTrackingDraft('');
    } catch (err) {
      showToast?.(err?.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const handleMarkShipped = async (e) => {
    e?.stopPropagation();
    setBusy(true);
    try {
      await onMarkShipped();
    } catch (err) {
      showToast?.(err?.message || 'Ship failed');
    } finally {
      setBusy(false);
    }
  };

  const stop = (e) => e.stopPropagation();

  return (
    <div className="rounded-lg border border-gray-100 hover:border-emerald-400 transition">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        className="w-full text-left flex items-center justify-between gap-2 px-3 py-2 cursor-pointer hover:bg-emerald-50/30 active:bg-emerald-50"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${carrierClass}`}>
            {carrierLabel}
          </span>
          <span className="text-sm text-gray-900 truncate">{sale?.name || '(unknown sale)'}</span>
          {sale?.date && <span className="text-xs text-gray-400 shrink-0">{sale.date}</span>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-xs ${partial ? 'text-amber-700 font-medium' : allShipped ? 'text-emerald-700' : 'text-gray-600'}`}>
            {allShipped
              ? `${total} shipped`
              : partial
              ? `${shipped}/${total} shipped`
              : `${total} ${total === 1 ? 'item' : 'items'}`}
          </span>
          {/* State-driven secondary actions. Stops propagation so clicking
              doesn't also toggle the row's expanded state. The state-driven
              "Mark shipped" branch is gone — that's now the always-visible
              button below, available even without a label or tracking row. */}
          {action?.kind === 'buy-label' && (
            <button
              onClick={(e) => { stop(e); onBuyLabel(); }}
              className="text-xs font-medium px-2.5 py-1 rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 active:bg-gray-100 flex items-center gap-1"
            >
              <Truck className="w-3 h-3" /> Buy label
            </button>
          )}
          {action?.kind === 'enter-tracking' && !editingTracking && (
            <button
              onClick={(e) => { stop(e); setEditingTracking(true); }}
              className="text-xs font-medium px-2.5 py-1 rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 active:bg-gray-100 flex items-center gap-1"
            >
              <Pencil className="w-3 h-3" /> Enter tracking
            </button>
          )}
          {/* Always-visible Mark shipped on open boxes — operators can ship
              a box without first buying a label / entering tracking when
              they're tracked outside Folia. Hidden only on fully-shipped
              boxes (action===null). */}
          {action && (
            <button
              onClick={handleMarkShipped}
              disabled={busy}
              className="text-xs font-medium px-2.5 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800 disabled:opacity-60 flex items-center gap-1"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              Mark shipped
            </button>
          )}
          {/* Drill-in to the per-sale pane for label PDFs / void / clear
              tracking. Kept distinct from the row toggle so the operator
              can still get to the full ShipBoxCard UI. */}
          <button
            type="button"
            onClick={(e) => { stop(e); onOpen(); }}
            title="Open in sale view"
            className="p-1 -mr-1 text-gray-400 hover:text-emerald-700 hover:bg-emerald-50 rounded"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {expanded && (
        <BoxItemsList box={box} salesById={salesById} />
      )}

      {/* Inline tracking-number entry. Click "Enter tracking" → row expands
          with a small form; Save fires the API and refreshes shipments,
          which transitions this row to "Mark shipped". */}
      {editingTracking && (
        <div
          onClick={stop}
          className="px-3 pb-3 pt-1 flex items-center gap-2 border-t border-gray-100 bg-gray-50/60"
        >
          <input
            type="text"
            autoFocus
            value={trackingDraft}
            onChange={(e) => setTrackingDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveTracking(e);
              if (e.key === 'Escape') { setEditingTracking(false); setTrackingDraft(''); }
            }}
            placeholder="USPS tracking number"
            className="flex-1 text-sm px-2 py-1 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
          />
          <button
            onClick={handleSaveTracking}
            disabled={busy || !trackingDraft.trim()}
            className="text-xs font-medium px-2.5 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60 flex items-center gap-1"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
            Save
          </button>
          <button
            onClick={(e) => { stop(e); setEditingTracking(false); setTrackingDraft(''); }}
            className="text-xs font-medium px-2 py-1 rounded-md text-gray-600 hover:bg-gray-200 flex items-center gap-1"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Per-sale packing pane: shows the upload prompt OR the assembled boxes
// (derived from items once the upload has been applied).
// ───────────────────────────────────────────────────────────────────────────

function SalePackingPane({ sale, inventoryItems, onBack, onShipBox, setConfirmDialog }) {
  const saleItems = useMemo(
    () => inventoryItems.filter(i => i.saleId === sale.id),
    [inventoryItems, sale.id]
  );

  // If any item has a shipmentBoxId, the upload was applied (in the Sales
  // tab, Step 3). Otherwise direct the user back to do it.
  const hasApplied = saleItems.some(i => i.shipmentBoxId);

  if (!hasApplied) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="p-2 -ml-2 text-gray-600 hover:bg-gray-100 active:bg-gray-200 rounded-lg" aria-label="Back">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{sale.name}</h2>
            <p className="text-xs text-gray-500">{saleItems.length} lineup items · {sale.date}</p>
          </div>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-center">
          <AlertCircle className="w-8 h-8 text-amber-500 mx-auto mb-2" />
          <div className="text-sm font-medium text-gray-900">No boxes to pack yet</div>
          <p className="text-xs text-gray-600 mt-1">
            Run "Validate Sales" from the Sale tab (step 3) to mark items
            sold and create the shipping boxes.
          </p>
        </div>
      </div>
    );
  }
  return (
    <PackingBoxesPane
      sale={sale}
      saleItems={saleItems}
      onBack={onBack}
      onShipBox={onShipBox}
      setConfirmDialog={setConfirmDialog}
    />
  );
}


// ───── Boxes phase (after apply) ───────────────────────────────────────────

function PackingBoxesPane({ sale, saleItems, onBack, onShipBox, setConfirmDialog }) {
  // Shipments (= purchased labels) for this sale, keyed by shipmentBoxId.
  // Loaded once on mount and refreshed after a Buy/Void completes.
  const [shipmentsByBox, setShipmentsByBox] = useState({});
  const [buyingFor, setBuyingFor] = useState(null);
  const [actionToast, setActionToast] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const list = await api.getShipments(sale.id);
        setShipmentsByBox(Object.fromEntries((list || []).map(s => [s.id, s])));
      } catch {
        // Silent — shipments simply won't show until refresh.
      }
    })();
  }, [sale.id]);

  const refreshShipments = async () => {
    try {
      const list = await api.getShipments(sale.id);
      setShipmentsByBox(Object.fromEntries((list || []).map(s => [s.id, s])));
    } catch {/* no-op */}
  };

  const showToast = (msg) => {
    setActionToast(msg);
    setTimeout(() => setActionToast(null), 2500);
  };

  // Group sold items by shipmentBoxId. Each group is a "box". The carrier
  // is read off the first item in the box — apply-time stamps the same
  // value on every item in the group.
  const boxes = useMemo(() => {
    const map = new Map();
    for (const item of saleItems) {
      if (!item.shipmentBoxId) continue;
      if (!map.has(item.shipmentBoxId)) {
        map.set(item.shipmentBoxId, {
          id: item.shipmentBoxId,
          recipientName: item.buyer || '(unknown)',
          username: item.buyerUsername || '',
          address: item.buyerAddress || {},
          carrier: item.shipmentCarrier || 'usps',
          items: [],
        });
      }
      map.get(item.shipmentBoxId).items.push(item);
    }
    return [...map.values()].sort((a, b) =>
      (a.recipientName || '').localeCompare(b.recipientName || '')
    );
  }, [saleItems]);

  // Carrier filter: 'all' | 'usps' | 'ups'. Default to 'all' so opening
  // the pane still shows everything, but counts in the tab labels make
  // the split obvious.
  const [carrierFilter, setCarrierFilter] = useState('all');
  const uspsBoxes = useMemo(() => boxes.filter(b => b.carrier === 'usps'), [boxes]);
  const upsBoxes = useMemo(() => boxes.filter(b => b.carrier === 'ups'), [boxes]);
  const visibleBoxes = carrierFilter === 'usps' ? uspsBoxes
    : carrierFilter === 'ups' ? upsBoxes
    : boxes;

  const totalBoxes = boxes.length;
  const shippedBoxes = boxes.filter(b =>
    b.items.every(i => ['shipped', 'delivered'].includes(i.status))
  ).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="p-2 -ml-2 text-gray-600 hover:bg-gray-100 active:bg-gray-200 rounded-lg" aria-label="Back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-gray-900">{sale.name}</h2>
          <p className="text-xs text-gray-500">
            {shippedBoxes}/{totalBoxes} boxes shipped · {sale.date}
          </p>
        </div>
        <span className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded">
          Orders applied
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <SummaryStat label="Total boxes" value={totalBoxes} tone="blue" />
        <SummaryStat
          label="Shipped"
          value={shippedBoxes}
          tone={shippedBoxes === totalBoxes && totalBoxes > 0 ? 'emerald' : 'gray'}
        />
        <SummaryStat label="Outstanding" value={totalBoxes - shippedBoxes} tone="amber" />
      </div>

      {/* Carrier tabs — splits the box list into USPS vs UPS so the user
          can buy labels in batches per carrier. */}
      <div className="bg-white rounded-xl border border-gray-200 px-1 py-1 flex gap-0.5 overflow-x-auto">
        {[
          { value: 'all', label: 'All', count: totalBoxes },
          { value: 'usps', label: 'USPS', count: uspsBoxes.length },
          { value: 'ups', label: 'UPS', count: upsBoxes.length },
        ].map(tab => {
          const active = carrierFilter === tab.value;
          return (
            <button
              key={tab.value}
              onClick={() => setCarrierFilter(tab.value)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg whitespace-nowrap transition ${
                active ? 'bg-emerald-600 text-white font-medium' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              {tab.label}
              <span className={`text-xs ${active ? 'text-emerald-100' : 'text-gray-400'}`}>
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>

      <div className="space-y-3">
        {visibleBoxes.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-xl p-8 text-center text-sm text-gray-500">
            No {carrierFilter === 'all' ? '' : carrierFilter.toUpperCase() + ' '}boxes.
          </div>
        ) : visibleBoxes.map(box => (
          <ShipBoxCard
            key={box.id}
            box={box}
            shipment={shipmentsByBox[box.id]}
            showToast={showToast}
            onShip={() => onShipBox(box.items.map(i => i.id))}
            onBuyLabel={() => setBuyingFor(box)}
            onVoidLabel={() => {
              setConfirmDialog?.({
                title: `Void label for ${box.recipientName}?`,
                message: `ShipStation may decline if it's already been used or scanned.`,
                confirmLabel: 'Void label',
                danger: true,
                onConfirm: async () => {
                  try {
                    await api.voidLabel(box.id);
                    showToast('Label voided');
                    refreshShipments();
                  } catch (e) {
                    showToast(e.message || 'Void failed');
                  }
                },
              });
            }}
            onSaveTracking={async (b, trackingNumber) => {
              await api.recordPalmstreetTracking(b.id, trackingNumber);
              showToast('Tracking saved');
              refreshShipments();
            }}
            onClearTracking={() => {
              setConfirmDialog?.({
                title: `Clear tracking for ${box.recipientName}?`,
                message: 'Removes the manual USPS tracking entry. The Palmstreet label itself is not affected.',
                confirmLabel: 'Clear',
                danger: true,
                onConfirm: async () => {
                  try {
                    await api.clearPalmstreetTracking(box.id);
                    showToast('Tracking cleared');
                    refreshShipments();
                  } catch (e) {
                    showToast(e.message || 'Clear failed');
                  }
                },
              });
            }}
          />
        ))}
      </div>

      {buyingFor && (
        <BuyLabelModal
          box={buyingFor}
          onClose={() => setBuyingFor(null)}
          onPurchased={() => refreshShipments()}
          showToast={showToast}
        />
      )}

      {actionToast && (
        <div className="fixed bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-sm px-4 py-2 rounded-lg shadow-lg z-50">
          {actionToast}
        </div>
      )}
    </div>
  );
}

