import { useState, useMemo, useEffect } from 'react';
import {
  Package, AlertCircle, ArrowLeft, PackageOpen,
} from 'lucide-react';
import { api } from '../api.js';
import { BuyLabelModal } from './BuyLabelModal.jsx';
import { ShipBoxCard } from './ShipBoxCard.jsx';
import { SummaryStat } from './SummaryStat.jsx';
import { StandaloneUploader } from './StandaloneUploader.jsx';

// Re-export the shared building blocks so SalesUploadModal's existing
// imports keep working without a churn-y find-and-replace across files.
export { BoxesList } from './BoxesList.jsx';
export { InventoryPicker } from './InventoryPicker.jsx';
export { SummaryStat } from './SummaryStat.jsx';

export function PackingView({ inventoryItems, sales, onShipBox, setConfirmDialog }) {
  const [activeSaleId, setActiveSaleId] = useState(null);

  const pendingSales = useMemo(
    () => sales.filter(s => s.status === 'packing'),
    [sales]
  );

  const activeSale = pendingSales.find(s => s.id === activeSaleId)
    || sales.find(s => s.id === activeSaleId);

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

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <Package className="w-5 h-5 text-emerald-600" /> Packing
        </h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Sale events sent to packing show up here, with their boxes ready to ship.
        </p>
      </div>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-gray-700">
          Pending sale events ({pendingSales.length})
        </h3>
        {pendingSales.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-xl p-8 text-center">
            <PackageOpen className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-500">
              No sale events pending. Click "Send to Packing" on a sale event to start packing.
            </p>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {pendingSales.map(sale => (
              <SalePendingCard
                key={sale.id}
                sale={sale}
                inventoryItems={inventoryItems}
                onOpen={() => setActiveSaleId(sale.id)}
              />
            ))}
          </div>
        )}
      </section>

      <StandaloneUploader inventoryItems={inventoryItems} />
    </div>
  );
}

function SalePendingCard({ sale, inventoryItems, onOpen }) {
  const saleLots = inventoryItems.filter(i => i.saleId === sale.id && i.lotKind !== 'giveaway');
  const giveaways = inventoryItems.filter(i => i.saleId === sale.id && i.lotKind === 'giveaway');
  const sold = saleLots.filter(i => ['sold', 'shipped', 'delivered'].includes(i.status));
  const shipped = saleLots.filter(i => ['shipped', 'delivered'].includes(i.status));
  const hasUpload = saleLots.some(i => i.shipmentBoxId);

  return (
    <button
      onClick={onOpen}
      className="text-left bg-white border border-gray-200 rounded-xl p-4 hover:border-emerald-400 hover:shadow-sm active:bg-gray-50 transition"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-gray-900 truncate">{sale.name}</div>
          <div className="text-xs text-gray-500">{sale.date}</div>
        </div>
        <span className={`text-xs px-2 py-1 rounded-full whitespace-nowrap font-medium ${
          hasUpload ? 'bg-blue-100 text-blue-800' : 'bg-amber-100 text-amber-800'
        }`}>
          {hasUpload ? `${shipped.length}/${saleLots.length} shipped` : 'Awaiting upload'}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <Mini label="Lots" value={saleLots.length} />
        <Mini label="Giveaways" value={giveaways.length} />
        <Mini label="Sold" value={sold.length} />
      </div>
    </button>
  );
}

function Mini({ label, value }) {
  return (
    <div className="bg-gray-50 rounded p-2">
      <div className="text-gray-500">{label}</div>
      <div className="font-semibold text-gray-900">{value}</div>
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
            Upload the Palmstreet sales report from the Sales Events tab (step 3)
            to mark items sold and create the shipping boxes.
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

