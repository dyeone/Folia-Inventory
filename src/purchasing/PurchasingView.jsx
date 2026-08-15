import { CatalogPane } from './CatalogPane.jsx';

// The Purchase tab is the CATALOG side of buying: browse species, set
// wholesale prices, and add plants to a draft PO. The orders themselves —
// importing a supplier's list, marking ordered, watching the packer's
// receiving progress — live on the dedicated Wholesale tab (OrdersPane,
// promoted out of a sub-tab here so handling an order is one tap from
// anywhere). The catalog's DraftMiniBar jumps there via onOpenOrders.
export function PurchasingView({
  varieties, species, showToast, onOpenOrders, onSpeciesChanged,
}) {
  return (
    <div className="space-y-4 pb-32">
      <CatalogPane
        varieties={varieties}
        species={species}
        showToast={showToast}
        onSpeciesChanged={onSpeciesChanged}
        onSwitchToOrders={() => onOpenOrders?.()}
      />
    </div>
  );
}
