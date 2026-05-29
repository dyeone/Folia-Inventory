import { useState, useMemo } from 'react';
import { Search, Download, ArrowRightLeft, Edit2, Trash2, Archive, Printer, X, Plus, Sprout } from 'lucide-react';
import { FilterPill } from '../ui/FilterPill.jsx';
import { useIsMobile } from '../ui/useIsMobile.js';
import { VARIETIES as DEFAULT_VARIETIES } from '../constants.js';
import { buildLookups, speciesForItem, computeIdealPrice, rateSourceLabel, displayPrice } from './pricing.js';
import { CultivarRateInput } from './CultivarRateInput.jsx';
import { AcclimationModal } from './AcclimationModal.jsx';

// e.g. "May 8, 3:45 PM" (same year) or "May 8, 2024" (prior year).
function fmtAddedAt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const datePart = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  if (!sameYear) return datePart;
  const timePart = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${datePart}, ${timePart}`;
}

export function InventoryView({ items: filteredItems, allItems, sales, varieties = [], species = [], idealRate, acclimatedRate, onUpdateSpeciesRate, onDeleteVariety, onAddToSpecies, onExportPalmstreet, onManageVarieties, searchQuery, setSearchQuery, filterType, setFilterType, filterStatus, setFilterStatus, filterSale, setFilterSale, onEdit, onDelete, onConvert, onPrintLabel, onBulkPrintLabel, onBulkDelete, onStatusChange, isAdmin }) {
  const isMobile = useIsMobile();
  // O(1) lookups for speciesForItem / computeIdealPrice — built once per
  // varieties/species change instead of linear-scanning per item per render.
  const lookups = useMemo(() => buildLookups(varieties, species), [varieties, species]);
  // Variety tabs come from the live catalog when available, falling back to
  // the legacy constant list while it's still loading.
  const varietyNames = useMemo(
    () => varieties.length > 0 ? varieties.map(v => v.name) : DEFAULT_VARIETIES,
    [varieties]
  );
  const [varietyTab, setVarietyTab] = useState('all');
  const items = useMemo(
    () => varietyTab === 'all' ? filteredItems : filteredItems.filter(i => i.variety === varietyTab),
    [filteredItems, varietyTab]
  );
  const varietyCounts = useMemo(() => {
    const counts = { all: filteredItems.length };
    for (const v of varietyNames) {
      counts[v] = filteredItems.filter(i => i.variety === v).length;
    }
    return counts;
  }, [filteredItems, varietyNames]);

  // Group items by name (alphabetical). Within each group items keep their
  // existing order (newest first, sorted in the parent).
  const groups = useMemo(() => {
    const map = new Map();
    for (const item of items) {
      const key = (item.name || '').trim() || '(unnamed)';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, list]) => ({ name, items: list }));
  }, [items]);

  // Track expanded groups (additive) instead of collapsed (additive) so
  // the default state is "everything collapsed" — only group headers paint
  // on first render. Critical for the 1945-item case on mobile, where
  // expanding everything was costing seconds of layout work.
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const isGroupExpanded = (name) => expandedGroups.has(name);
  const toggleGroup = (name) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  const expandAll = () => setExpandedGroups(new Set(groups.map(g => g.name)));
  const collapseAll = () => setExpandedGroups(new Set());

  // Toggle selection of every item in a group. If all are already selected,
  // clears them; otherwise adds them all to the selection.
  const toggleGroupSelection = (groupItems) => {
    const ids = groupItems.map(i => i.id);
    const allSelected = ids.length > 0 && ids.every(id => selectedIds.has(id));
    setSelectedIds(prev => {
      const next = new Set(prev);
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  // Selection is local to this view; cleared whenever filters change or after an action.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [showAcclimation, setShowAcclimation] = useState(false);

  // Drop selections that are no longer visible (e.g. filtered out) to avoid
  // acting on rows the user can't see.
  const visibleIds = useMemo(() => new Set(items.map(i => i.id)), [items]);
  const visibleSelected = [...selectedIds].filter(id => visibleIds.has(id));

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const allVisibleSelected = items.length > 0 && items.every(i => selectedIds.has(i.id));
    setSelectedIds(allVisibleSelected ? new Set() : new Set(items.map(i => i.id)));
  };

  const clearSelection = () => setSelectedIds(new Set());

  const handleBulkPrint = () => {
    const selected = items.filter(i => selectedIds.has(i.id));
    if (selected.length === 0) return;
    onBulkPrintLabel(selected);
    clearSelection();
  };

  const handleBulkDelete = () => {
    if (visibleSelected.length === 0) return;
    onBulkDelete(visibleSelected, () => clearSelection());
  };

  const allVisibleSelected = items.length > 0 && items.every(i => selectedIds.has(i.id));
  const exportCSV = () => {
    const headers = ['SKU', 'Type', 'Name', 'Variety', 'Quantity', 'Gross Cost', 'Net Cost', 'Profit Rate %', 'Ideal Price', 'Listing Price', 'Sale Price', 'Status', 'Sale Event', 'Lot', 'Source', 'Acquired', 'Notes'];
    const rows = items.map(i => {
      const sale = sales.find(s => s.id === i.saleId);
      return [
        i.sku, i.type, i.name, i.variety || '', i.quantity || 1,
        i.grossCost ?? i.cost ?? '', i.netCost ?? '', i.profitRate ?? '', i.idealPrice ?? '',
        i.listingPrice || '', i.salePrice || '',
        i.status, sale?.name || '', i.lotNumber || '',
        i.source || '', i.acquiredAt || '', (i.notes || '').replace(/"/g, '""')
      ].map(v => `"${v}"`).join(',');
    });
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inventory-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 p-3 space-y-3">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex-1 relative">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search SKU, name, variety..."
              className="w-full pl-9 pr-9 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <button
            onClick={() => setShowAcclimation(true)}
            title="Scan TC SKUs in bulk to mark them Acclimated"
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-fuchsia-700 border border-fuchsia-300 bg-fuchsia-50 rounded-lg hover:bg-fuchsia-100"
          >
            <Sprout className="w-4 h-4" /> Acclimation Mode
          </button>
          <button onClick={exportCSV} className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50">
            <Download className="w-4 h-4" /> Export CSV
          </button>
          {onExportPalmstreet && (
            <button
              onClick={onExportPalmstreet}
              title="Export all available, unassigned items in Palmstreet's CSV template"
              className="flex items-center gap-1.5 px-3 py-2 text-sm text-emerald-700 border border-emerald-300 bg-emerald-50 rounded-lg hover:bg-emerald-100"
            >
              <Download className="w-4 h-4" /> Export to Palmstreet
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <FilterPill label="Type" value={filterType} onChange={setFilterType} options={[
            { value: 'all', label: 'All types' },
            { value: 'tc', label: 'TC only' },
            { value: 'plant', label: 'Plant only' },
          ]} />
          <FilterPill label="Status" value={filterStatus} onChange={setFilterStatus} options={[
            { value: 'all', label: 'All statuses' },
            { value: 'available', label: 'Available' },
            { value: 'listed', label: 'Listed' },
            { value: 'acclimated', label: 'Acclimated' },
            { value: 'sold', label: 'Sold' },
            { value: 'shipped', label: 'Shipped' },
            { value: 'delivered', label: 'Delivered' },
            { value: 'converted', label: 'Converted' },
          ]} />
          <FilterPill label="Sale" value={filterSale} onChange={setFilterSale} options={[
            { value: 'all', label: 'All sales' },
            { value: 'none', label: 'Unassigned' },
            ...sales.map(s => ({ value: s.id, label: s.name })),
          ]} />
        </div>
      </div>

      {/* Variety tabs */}
      <div className="bg-white rounded-xl border border-gray-200 px-1 py-1 flex gap-0.5 overflow-x-auto">
        {[{ value: 'all', label: 'All' }, ...varietyNames.map(v => ({ value: v, label: v }))].map(tab => {
          const active = varietyTab === tab.value;
          const count = varietyCounts[tab.value] ?? 0;
          // Empty + admin = show an inline delete affordance. Skip "All".
          const variety = tab.value === 'all' ? null : varieties.find(v => v.name === tab.value);
          const canDelete = isAdmin && tab.value !== 'all' && count === 0 && onDeleteVariety && variety;
          return (
            <div
              key={tab.value}
              className={`flex items-center gap-1 rounded-lg overflow-hidden whitespace-nowrap ${
                active ? 'bg-emerald-600' : 'hover:bg-gray-100'
              }`}
            >
              <button
                onClick={() => setVarietyTab(tab.value)}
                className={`flex items-center gap-1.5 pl-3 pr-2 py-1.5 text-sm transition ${
                  active ? 'text-white font-medium' : 'text-gray-700'
                }`}
              >
                {tab.label}
                <span className={`text-xs ${active ? 'text-emerald-100' : 'text-gray-400'}`}>
                  {count}
                </span>
              </button>
              {canDelete && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    // Confirmation is handled in the parent (App.jsx) via the
                    // shared ConfirmDialog — keeps the UI consistent with the
                    // rest of the destructive actions.
                    onDeleteVariety(variety);
                  }}
                  title="Delete empty variety"
                  aria-label={`Delete ${variety.name}`}
                  className={`pl-1 pr-2 py-1.5 ${
                    active ? 'text-emerald-100 hover:text-white' : 'text-gray-400 hover:text-red-600'
                  }`}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          );
        })}
        {onManageVarieties && (
          <button
            onClick={onManageVarieties}
            title="Add, rename or delete varieties"
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg whitespace-nowrap"
          >
            <Edit2 className="w-3.5 h-3.5" /> Edit
          </button>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 px-1">
        <div className="text-xs text-gray-500">
          Showing {items.length} of {allItems.length} items
        </div>
        <div className="flex items-center gap-3">
          {groups.length > 0 && (
            <button
              onClick={expandedGroups.size === groups.length ? collapseAll : expandAll}
              className="text-xs text-gray-600 hover:text-gray-900 whitespace-nowrap"
            >
              {expandedGroups.size === groups.length ? 'Collapse all' : 'Expand all'}
            </button>
          )}
          {items.length > 0 && (
            <button onClick={toggleSelectAll} className="text-xs text-gray-600 hover:text-gray-900 whitespace-nowrap">
              {allVisibleSelected ? 'Deselect all' : 'Select all'}
            </button>
          )}
        </div>
      </div>

      {visibleSelected.length > 0 && (
        <div className="sticky top-28 z-20 bg-emerald-600 text-white rounded-xl px-3 py-2 flex items-center justify-between shadow-md">
          <div className="text-sm font-medium">
            {visibleSelected.length} selected
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleBulkPrint}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-white/15 hover:bg-white/25 rounded-lg transition"
            >
              <Printer className="w-4 h-4" /> <span className="hidden sm:inline">Print labels</span>
            </button>
            {isAdmin && (
              <button
                onClick={handleBulkDelete}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-white/15 hover:bg-red-500 rounded-lg transition"
              >
                <Trash2 className="w-4 h-4" /> <span className="hidden sm:inline">Delete</span>
              </button>
            )}
            <button
              onClick={clearSelection}
              title="Clear selection"
              className="p-1.5 hover:bg-white/15 rounded-lg transition"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
          <Archive className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 text-sm">No items match your filters.</p>
        </div>
      ) : (
        <>
          {/* Mobile card list — grouped by name. Only mounted on phone-width
              viewports so the desktop <table> below doesn't double the DOM. */}
          {isMobile && (
          <div className="space-y-4">
            {groups.map(group => {
              const isCollapsed = !isGroupExpanded(group.name);
              const groupIds = group.items.map(i => i.id);
              const allInGroupSelected = groupIds.length > 0 && groupIds.every(id => selectedIds.has(id));
              const someInGroupSelected = groupIds.some(id => selectedIds.has(id));
              return (
                <div key={group.name} className="space-y-2">
                  <div
                    onClick={() => toggleGroup(group.name)}
                    className="w-full flex items-center justify-between gap-2 text-left px-2 py-1.5 bg-gray-50 rounded-lg hover:bg-gray-100 cursor-pointer"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <input
                        type="checkbox"
                        checked={allInGroupSelected}
                        ref={(el) => { if (el) el.indeterminate = !allInGroupSelected && someInGroupSelected; }}
                        onChange={() => toggleGroupSelection(group.items)}
                        onClick={(e) => e.stopPropagation()}
                        className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer flex-shrink-0"
                      />
                      <span className={`text-xs text-gray-500 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>▶</span>
                      <span className="font-medium text-gray-900 text-sm truncate">{group.name}</span>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {onUpdateSpeciesRate && (
                        <CultivarRateInput
                          species={speciesForItem(group.items[0], lookups)}
                          globalRate={idealRate}
                          onUpdate={onUpdateSpeciesRate}
                        />
                      )}
                      {onAddToSpecies && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onAddToSpecies(speciesForItem(group.items[0], lookups), group.items[0]);
                          }}
                          title={`Add another ${group.name}`}
                          className="p-1 text-emerald-600 hover:bg-emerald-50 rounded transition"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      )}
                      <span className="text-xs text-gray-500 whitespace-nowrap tabular-nums w-16 text-right">
                        {group.items.length} {group.items.length === 1 ? 'item' : 'items'}
                      </span>
                    </div>
                  </div>
                  {!isCollapsed && group.items.map(item => {
              const sp = parseFloat(item.salePrice);
              const cost = parseFloat(item.grossCost ?? item.cost);
              const isSold = ['sold','shipped','delivered'].includes(item.status);
              const profitRate = isSold && !isNaN(sp) && sp > 0 && !isNaN(cost) && cost > 0
                ? ((sp - cost) / cost) * 100 : null;
              const checked = selectedIds.has(item.id);
              return (
                <div key={item.id} className={`bg-white rounded-xl border p-3 transition ${
                  checked ? 'border-emerald-400 ring-1 ring-emerald-400' : 'border-gray-200'
                }`}>
                  <div className="flex items-start justify-between gap-2">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSelect(item.id)}
                      className="mt-1 w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 flex-shrink-0 cursor-pointer"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-gray-900 truncate">{item.name}</div>
                      <div className="text-xs text-gray-500 flex items-center gap-1.5 mt-0.5">
                        <span className="font-mono">{item.sku}</span>
                        {item.variety && <span>· {item.variety}</span>}
                      </div>
                      {item.createdAt && (
                        <div className="text-[11px] text-gray-400 mt-0.5">
                          Added {fmtAddedAt(item.createdAt)}
                        </div>
                      )}
                      {item.soldAt && ['sold','shipped','delivered'].includes(item.status) && (
                        <div className="text-[11px] text-blue-600 mt-0.5">
                          Sold {fmtAddedAt(item.soldAt)}
                        </div>
                      )}
                    </div>
                    <span className={`flex-shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      item.type === 'tc' ? 'bg-sky-100 text-sky-700' : 'bg-emerald-100 text-emerald-700'
                    }`}>
                      {item.type === 'tc' ? 'TC' : 'Plant'}
                    </span>
                  </div>
                  {(() => {
                    const gross = parseFloat(item.grossCost ?? item.cost);
                    const net = parseFloat(item.netCost);
                    const itemRate = parseFloat(item.profitRate);
                    const sp = speciesForItem(item, lookups);
                    const spRate = parseFloat(sp?.profitRate);
                    const rate = Number.isFinite(itemRate) ? itemRate
                      : Number.isFinite(spRate) ? spRate
                      : parseFloat(idealRate);
                    const ideal = computeIdealPrice(item, idealRate, lookups);
                    const anyFinancial = !isNaN(gross) || !isNaN(net) || !isNaN(rate) || !isNaN(ideal);
                    if (!anyFinancial) return null;
                    return (
                      <div className="grid grid-cols-4 gap-1 mt-2 text-[11px] tabular-nums">
                        <div className="bg-gray-50 rounded px-1.5 py-1">
                          <div className="text-gray-500">Gross</div>
                          <div className="font-medium text-gray-900">{!isNaN(gross) ? `$${gross.toFixed(2)}` : '—'}</div>
                        </div>
                        <div className="bg-gray-50 rounded px-1.5 py-1">
                          <div className="text-gray-500">Net</div>
                          <div className="font-medium text-gray-900">{!isNaN(net) ? `$${net.toFixed(2)}` : '—'}</div>
                        </div>
                        <div className="bg-gray-50 rounded px-1.5 py-1">
                          <div className="text-gray-500">Rate</div>
                          <div className="font-medium text-gray-900">{!isNaN(rate) ? `${rate.toFixed(0)}%` : '—'}</div>
                        </div>
                        <div className="bg-emerald-50 rounded px-1.5 py-1">
                          <div className="text-emerald-700">Ideal</div>
                          <div className="font-medium text-emerald-800">{!isNaN(ideal) ? `$${ideal.toFixed(2)}` : '—'}</div>
                        </div>
                      </div>
                    );
                  })()}
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <select
                      value={item.status}
                      onChange={(e) => onStatusChange(item.id, e.target.value)}
                      className={`text-xs font-medium rounded px-2 py-1 border-0 focus:ring-2 focus:ring-emerald-500 ${
                        item.status === 'available' ? 'bg-gray-100 text-gray-700' :
                        item.status === 'listed' ? 'bg-amber-100 text-amber-800' :
                        item.status === 'acclimated' ? 'bg-fuchsia-100 text-fuchsia-800' :
                        item.status === 'sold' ? 'bg-blue-100 text-blue-800' :
                        item.status === 'shipped' ? 'bg-violet-100 text-violet-800' :
                        item.status === 'delivered' ? 'bg-emerald-100 text-emerald-800' :
                        'bg-gray-200 text-gray-600'
                      }`}
                    >
                      <option value="available">Available</option>
                      <option value="listed">Listed</option>
                      {item.type === 'tc' && <option value="acclimated">Acclimated</option>}
                      <option value="sold">Sold</option>
                      <option value="shipped">Shipped</option>
                      <option value="delivered">Delivered</option>
                      <option value="converted">Converted</option>
                    </select>
                    <div className="ml-auto flex items-center gap-1">
                      {profitRate !== null && (
                        <span className={`text-xs font-semibold mr-1 ${
                          profitRate >= 200 ? 'text-emerald-600' :
                          profitRate >= 100 ? 'text-blue-600' :
                          profitRate >= 0 ? 'text-amber-600' : 'text-red-600'
                        }`}>
                          {profitRate >= 0 ? '+' : ''}{profitRate.toFixed(0)}%
                        </span>
                      )}
                      {(() => {
                        const price = displayPrice(item);
                        return price !== null ? (
                          <span className="text-xs text-gray-700 mr-1">
                            ${price.toFixed(2)}
                          </span>
                        ) : null;
                      })()}
                      {item.type === 'tc' && item.status !== 'converted' && (
                        <button onClick={() => onConvert(item)} title="Convert to plant" className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded">
                          <ArrowRightLeft className="w-4 h-4" />
                        </button>
                      )}
                      <button onClick={() => onPrintLabel(item)} title="Print label" className="p-1.5 text-gray-500 hover:bg-gray-100 rounded">
                        <Printer className="w-4 h-4" />
                      </button>
                      <button onClick={() => onEdit(item)} className="p-1.5 text-gray-500 hover:bg-gray-100 rounded">
                        <Edit2 className="w-4 h-4" />
                      </button>
                      {isAdmin && (
                        <button onClick={() => onDelete(item.id)} className="p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600 rounded">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
                  })}
                </div>
              );
            })}
          </div>
          )}

          {/* Desktop table — only mounted at sm+ breakpoints. */}
          {!isMobile && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr className="text-left text-xs font-medium text-gray-600 uppercase tracking-wide">
                    <th className="px-3 py-2.5 w-10">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        ref={(el) => { if (el) el.indeterminate = !allVisibleSelected && visibleSelected.length > 0; }}
                        onChange={toggleSelectAll}
                        className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                      />
                    </th>
                    <th className="px-3 py-2.5">SKU / Name</th>
                    <th className="px-3 py-2.5">Type</th>
                    <th className="px-3 py-2.5">Status</th>
                    <th className="px-3 py-2.5 text-right">Cost</th>
                    <th className="px-3 py-2.5 text-right">Ideal $</th>
                    <th className="px-3 py-2.5 text-right">Listed</th>
                    <th className="px-3 py-2.5 text-right">Profit %</th>
                    <th className="px-3 py-2.5"></th>
                  </tr>
                </thead>
                {groups.map(group => {
                  const isCollapsed = !isGroupExpanded(group.name);
                  const groupIds = group.items.map(i => i.id);
                  const allInGroupSelected = groupIds.length > 0 && groupIds.every(id => selectedIds.has(id));
                  const someInGroupSelected = groupIds.some(id => selectedIds.has(id));
                  return (
                    <tbody key={group.name} className="divide-y divide-gray-100">
                      <tr className="bg-gray-50 border-y border-gray-200">
                        <td className="px-3 py-2 w-10">
                          <input
                            type="checkbox"
                            checked={allInGroupSelected}
                            ref={(el) => { if (el) el.indeterminate = !allInGroupSelected && someInGroupSelected; }}
                            onChange={() => toggleGroupSelection(group.items)}
                            className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                          />
                        </td>
                        <td colSpan={8} className="px-3 py-2">
                          <div className="flex items-center justify-between gap-3">
                            <button
                              onClick={() => toggleGroup(group.name)}
                              className="flex items-center gap-2 flex-1 min-w-0 text-left"
                            >
                              <span className={`text-xs text-gray-500 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>▶</span>
                              <span className="text-sm font-semibold text-gray-900 truncate">{group.name}</span>
                            </button>
                            <div className="flex items-center gap-3 flex-shrink-0">
                              {onUpdateSpeciesRate && (
                                <CultivarRateInput
                                  species={speciesForItem(group.items[0], lookups)}
                                  globalRate={idealRate}
                                  onUpdate={onUpdateSpeciesRate}
                                />
                              )}
                              {onAddToSpecies && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onAddToSpecies(speciesForItem(group.items[0], lookups), group.items[0]);
                                  }}
                                  title={`Add another ${group.name}`}
                                  className="p-1 text-emerald-600 hover:bg-emerald-50 rounded transition"
                                >
                                  <Plus className="w-4 h-4" />
                                </button>
                              )}
                              <span className="text-xs text-gray-500 tabular-nums w-16 text-right">
                                {group.items.length} {group.items.length === 1 ? 'item' : 'items'}
                              </span>
                            </div>
                          </div>
                        </td>
                      </tr>
                      {!isCollapsed && group.items.map(item => {
                    const checked = selectedIds.has(item.id);
                    return (
                      <tr key={item.id} className={`hover:bg-gray-50 ${checked ? 'bg-emerald-50/50' : ''}`}>
                        <td className="px-3 py-2.5">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleSelect(item.id)}
                            className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                          />
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="font-medium text-gray-900">{item.name}</div>
                          <div className="text-xs text-gray-500 flex items-center gap-1.5">
                            <span className="font-mono">{item.sku}</span>
                            {item.variety && <span>· {item.variety}</span>}
                          </div>
                          {item.createdAt && (
                            <div className="text-[11px] text-gray-400 mt-0.5">
                              Added {fmtAddedAt(item.createdAt)}
                            </div>
                          )}
                          {item.soldAt && ['sold','shipped','delivered'].includes(item.status) && (
                            <div className="text-[11px] text-blue-600 mt-0.5">
                              Sold {fmtAddedAt(item.soldAt)}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                            item.type === 'tc' ? 'bg-sky-100 text-sky-700' : 'bg-emerald-100 text-emerald-700'
                          }`}>
                            {item.type === 'tc' ? 'TC' : 'Plant'}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <select
                            value={item.status}
                            onChange={(e) => onStatusChange(item.id, e.target.value)}
                            className={`text-xs font-medium rounded px-2 py-1 border-0 focus:ring-2 focus:ring-emerald-500 ${
                              item.status === 'available' ? 'bg-gray-100 text-gray-700' :
                              item.status === 'listed' ? 'bg-amber-100 text-amber-800' :
                              item.status === 'acclimated' ? 'bg-fuchsia-100 text-fuchsia-800' :
                              item.status === 'sold' ? 'bg-blue-100 text-blue-800' :
                              item.status === 'shipped' ? 'bg-violet-100 text-violet-800' :
                              item.status === 'delivered' ? 'bg-emerald-100 text-emerald-800' :
                              'bg-gray-200 text-gray-600'
                            }`}
                          >
                            <option value="available">Available</option>
                            <option value="listed">Listed</option>
                            {item.type === 'tc' && <option value="acclimated">Acclimated</option>}
                            <option value="sold">Sold</option>
                            <option value="shipped">Shipped</option>
                            <option value="delivered">Delivered</option>
                            <option value="converted">Converted</option>
                          </select>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {(() => {
                            const gross = parseFloat(item.grossCost ?? item.cost);
                            const net = parseFloat(item.netCost);
                            if (isNaN(gross) && isNaN(net)) return <span className="text-gray-400">—</span>;
                            return (
                              <>
                                <div className="text-gray-900">{!isNaN(gross) ? `$${gross.toFixed(2)}` : '—'}</div>
                                {!isNaN(net) && <div className="text-[11px] text-gray-500">net ${net.toFixed(2)}</div>}
                              </>
                            );
                          })()}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {(() => {
                            const ideal = computeIdealPrice(item, idealRate, lookups);
                            if (!Number.isFinite(ideal)) return <span className="text-gray-400">—</span>;
                            const src = rateSourceLabel(item, lookups);
                            return (
                              <>
                                <span className="text-emerald-700 font-medium">${ideal.toFixed(2)}</span>
                                {src && <div className="text-[10px] text-gray-400 leading-tight">{src}</div>}
                              </>
                            );
                          })()}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-gray-900">
                          {(() => {
                            const price = displayPrice(item);
                            return price !== null ? `$${price.toFixed(2)}` : <span className="text-gray-400">—</span>;
                          })()}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          {(() => {
                            const sp = parseFloat(item.salePrice);
                            const gross = parseFloat(item.grossCost ?? item.cost);
                            const isSold = ['sold','shipped','delivered'].includes(item.status);
                            // Realized rate when sold; configured target rate otherwise.
                            if (isSold && !isNaN(sp) && sp > 0 && !isNaN(gross) && gross > 0) {
                              const rate = ((sp - gross) / gross) * 100;
                              return (
                                <span className={`text-xs font-semibold ${
                                  rate >= 200 ? 'text-emerald-600' :
                                  rate >= 100 ? 'text-blue-600' :
                                  rate >= 0 ? 'text-amber-600' : 'text-red-600'
                                }`}>
                                  {rate >= 0 ? '+' : ''}{rate.toFixed(0)}%
                                </span>
                              );
                            }
                            const target = parseFloat(item.profitRate);
                            if (!isNaN(target)) {
                              return <span className="text-xs text-gray-500">{target.toFixed(0)}% target</span>;
                            }
                            return <span className="text-xs text-gray-400">—</span>;
                          })()}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-1 justify-end">
                            {item.type === 'tc' && item.status !== 'converted' && (
                              <button onClick={() => onConvert(item)} title="Convert to plant" className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded">
                                <ArrowRightLeft className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button onClick={() => onPrintLabel(item)} title="Print label" className="p-1.5 text-gray-500 hover:bg-gray-100 rounded">
                              <Printer className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => onEdit(item)} className="p-1.5 text-gray-500 hover:bg-gray-100 rounded">
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            {isAdmin && (
                              <button onClick={() => onDelete(item.id)} className="p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600 rounded" title="Delete (admin only)">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                      })}
                    </tbody>
                  );
                })}
              </table>
            </div>
          </div>
          )}
        </>
      )}

      {showAcclimation && (
        <AcclimationModal
          items={allItems}
          acclimatedRate={acclimatedRate}
          onStatusChange={onStatusChange}
          onClose={() => setShowAcclimation(false)}
        />
      )}
    </div>
  );
}

