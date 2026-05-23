import { useState } from 'react';
import { ShoppingCart, Package } from 'lucide-react';
import { CatalogPane } from './CatalogPane.jsx';
import { OrdersPane } from './OrdersPane.jsx';

// Two-sub-tab shell: Catalog | Orders. State of which sub-tab is open
// lives here so switching back to the Purchase tab from another top-level
// tab restores the last sub-tab the operator used. State of the "current
// draft PO" is server-derived (most-recent draft) — DraftMiniBar polls
// for it inside CatalogPane.

export function PurchasingView({
  varieties, species, currentUser,
  showToast, setConfirmDialog,
  onSpeciesChanged, onItemsChanged,
}) {
  const [sub, setSub] = useState('catalog');
  return (
    <div className="space-y-4 pb-32">
      <div className="bg-white rounded-xl border border-gray-200 px-1 py-1 flex gap-0.5">
        {[
          { id: 'catalog', label: 'Catalog', icon: ShoppingCart },
          { id: 'orders',  label: 'Orders',  icon: Package },
        ].map(t => {
          const active = sub === t.id;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setSub(t.id)}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg transition ${
                active ? 'bg-emerald-600 text-white font-medium' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              <Icon className="w-4 h-4" /> {t.label}
            </button>
          );
        })}
      </div>

      {sub === 'catalog' && (
        <CatalogPane
          varieties={varieties}
          species={species}
          currentUser={currentUser}
          showToast={showToast}
          onSpeciesChanged={onSpeciesChanged}
          onSwitchToOrders={() => setSub('orders')}
        />
      )}
      {sub === 'orders' && (
        <OrdersPane
          varieties={varieties}
          species={species}
          currentUser={currentUser}
          showToast={showToast}
          setConfirmDialog={setConfirmDialog}
          onItemsChanged={onItemsChanged}
        />
      )}
    </div>
  );
}
