import { useState, useMemo, useEffect } from 'react';
import { Search, Download, ArrowRightLeft, Edit2, Trash2, Archive, Printer, X, Target } from 'lucide-react';
import { FilterPill } from '../ui/FilterPill.jsx';
import { VARIETIES as DEFAULT_VARIETIES } from '../constants.js';

// Compute the recommended (ideal) selling price for an item, in priority
// order: explicit idealPrice → per-item rate → variety rate → global rate,
// each multiplied by cost (preferring netCost, falling back to grossCost so
// freshly-imported items still get a meaningful number).
function computeIdealPrice(item, globalRate, varieties = []) {
  const explicit = parseFloat(item.idealPrice);
  if (Number.isFinite(explicit)) return explicit;
  const cost = parseFloat(item.netCost) || parseFloat(item.grossCost ?? item.cost);
  if (!Number.isFinite(cost) || cost <= 0) return NaN;
  const itemRate = parseFloat(item.profitRate);
  if (Number.isFinite(itemRate)) return cost * (1 + itemRate / 100);
  const variety = varieties.find(v => v.name === item.variety);
  const varRate = parseFloat(variety?.profitRate);
  if (Number.isFinite(varRate)) return cost * (1 + varRate / 100);
  const gRate = parseFloat(globalRate);
  if (!Number.isFinite(gRate)) return NaN;
  return cost * (1 + gRate / 100);
}

// Which level supplied the rate for the Ideal $ value, for the small caption
// shown under the number ("global", "variety rate", or none when explicit).
function rateSourceLabel(item, varieties) {
  if (Number.isFinite(parseFloat(item.idealPrice))) return null;
  if (Number.isFinite(parseFloat(item.profitRate))) return null;
  const variety = varieties.find(v => v.name === item.variety);
  if (Number.isFinite(parseFloat(variety?.profitRate))) return 'variety rate';
  return 'global';
}

export function InventoryView({ items: filteredItems, allItems, sales, varieties = [], idealRate, onUpdateVarietyRate, searchQuery, setSearchQuery, filterType, setFilterType, filterStatus, setFilterStatus, filterSale, setFilterSale, onEdit, onDelete, onConvert, onAssignSale, onPrintLabel, onBulkPrintLabel, onBulkDelete, onStatusChange, isAdmin }) {
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

  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());
  const toggleGroup = (name) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

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

  // Drop selections that are no longer visible (e.g. filtered out) to avoid
  // acting on rows the user can't see.
  const visibleIds = useMemo(() => new Set(items.map(i => i.id)), [items]);
  const visibleSelected = useMemo(
    () => [...selectedIds].filter(id => visibleIds.has(id)),
    [selectedIds, visibleIds]
  );

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
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
            />
          </div>
          <button onClick={exportCSV} className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50">
            <Download className="w-4 h-4" /> Export CSV
          </button>
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
          return (
            <button
              key={tab.value}
              onClick={() => setVarietyTab(tab.value)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg whitespace-nowrap transition ${
                active
                  ? 'bg-emerald-600 text-white font-medium'
                  : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              {tab.label}
              <span className={`text-xs ${active ? 'text-emerald-100' : 'text-gray-400'}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {varietyTab !== 'all' && onUpdateVarietyRate && (
        <VarietyRateStrip
          variety={varieties.find(v => v.name === varietyTab)}
          itemCount={varietyCounts[varietyTab] ?? 0}
          globalRate={idealRate}
          onUpdate={onUpdateVarietyRate}
        />
      )}

      <div className="flex items-center justify-between gap-2 px-1">
        <div className="text-xs text-gray-500">
          Showing {items.length} of {allItems.length} items
        </div>
        {items.length > 0 && (
          <button onClick={toggleSelectAll} className="text-xs text-gray-600 hover:text-gray-900 whitespace-nowrap">
            {allVisibleSelected ? 'Deselect all' : 'Select all'}
          </button>
        )}
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
          {/* Mobile card list — grouped by name */}
          <div className="sm:hidden space-y-4">
            {groups.map(group => {
              const isCollapsed = collapsedGroups.has(group.name);
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
                    <span className="text-xs text-gray-500 whitespace-nowrap">
                      {group.items.length} {group.items.length === 1 ? 'item' : 'items'}
                    </span>
                  </div>
                  {!isCollapsed && group.items.map(item => {
              const sale = sales.find(s => s.id === item.saleId);
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
                    const variety = varieties.find(v => v.name === item.variety);
                    const varRate = parseFloat(variety?.profitRate);
                    const rate = Number.isFinite(itemRate) ? itemRate
                      : Number.isFinite(varRate) ? varRate
                      : parseFloat(idealRate);
                    const ideal = computeIdealPrice(item, idealRate, varieties);
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
                        item.status === 'sold' ? 'bg-blue-100 text-blue-800' :
                        item.status === 'shipped' ? 'bg-violet-100 text-violet-800' :
                        item.status === 'delivered' ? 'bg-emerald-100 text-emerald-800' :
                        'bg-gray-200 text-gray-600'
                      }`}
                    >
                      <option value="available">Available</option>
                      <option value="listed">Listed</option>
                      <option value="sold">Sold</option>
                      <option value="shipped">Shipped</option>
                      <option value="delivered">Delivered</option>
                      <option value="converted">Converted</option>
                    </select>
                    {sale ? (
                      <span className="text-xs text-gray-500 truncate">
                        {sale.name}{item.lotNumber && ` · Lot #${item.lotNumber}`}
                      </span>
                    ) : (
                      <button onClick={() => onAssignSale(item)} className="text-xs text-emerald-600 hover:text-emerald-700">
                        Assign sale
                      </button>
                    )}
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
                      {(item.status === 'sold' && item.salePrice) || item.listingPrice ? (
                        <span className="text-xs text-gray-700 mr-1">
                          ${parseFloat(item.status === 'sold' && item.salePrice ? item.salePrice : item.listingPrice).toFixed(2)}
                        </span>
                      ) : null}
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

          {/* Desktop table */}
          <div className="hidden sm:block bg-white rounded-xl border border-gray-200 overflow-hidden">
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
                    <th className="px-3 py-2.5">Sale / Lot</th>
                    <th className="px-3 py-2.5 text-right">Cost</th>
                    <th className="px-3 py-2.5 text-right">Ideal $</th>
                    <th className="px-3 py-2.5 text-right">Listed</th>
                    <th className="px-3 py-2.5 text-right">Profit %</th>
                    <th className="px-3 py-2.5"></th>
                  </tr>
                </thead>
                {groups.map(group => {
                  const isCollapsed = collapsedGroups.has(group.name);
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
                        <td colSpan={9} className="px-3 py-2">
                          <button
                            onClick={() => toggleGroup(group.name)}
                            className="flex items-center justify-between w-full text-left"
                          >
                            <div className="flex items-center gap-2">
                              <span className={`text-xs text-gray-500 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>▶</span>
                              <span className="text-sm font-semibold text-gray-900">{group.name}</span>
                            </div>
                            <span className="text-xs text-gray-500">
                              {group.items.length} {group.items.length === 1 ? 'item' : 'items'}
                            </span>
                          </button>
                        </td>
                      </tr>
                      {!isCollapsed && group.items.map(item => {
                    const sale = sales.find(s => s.id === item.saleId);
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
                              item.status === 'sold' ? 'bg-blue-100 text-blue-800' :
                              item.status === 'shipped' ? 'bg-violet-100 text-violet-800' :
                              item.status === 'delivered' ? 'bg-emerald-100 text-emerald-800' :
                              'bg-gray-200 text-gray-600'
                            }`}
                          >
                            <option value="available">Available</option>
                            <option value="listed">Listed</option>
                            <option value="sold">Sold</option>
                            <option value="shipped">Shipped</option>
                            <option value="delivered">Delivered</option>
                            <option value="converted">Converted</option>
                          </select>
                        </td>
                        <td className="px-3 py-2.5 text-xs">
                          {sale ? (
                            <div>
                              <div className="text-gray-900">{sale.name}</div>
                              {item.lotNumber && <div className="text-gray-500">Lot #{item.lotNumber}</div>}
                            </div>
                          ) : (
                            <button onClick={() => onAssignSale(item)} className="text-emerald-600 hover:text-emerald-700">
                              Assign
                            </button>
                          )}
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
                            const ideal = computeIdealPrice(item, idealRate, varieties);
                            if (!Number.isFinite(ideal)) return <span className="text-gray-400">—</span>;
                            const src = rateSourceLabel(item, varieties);
                            return (
                              <>
                                <span className="text-emerald-700 font-medium">${ideal.toFixed(2)}</span>
                                {src && <div className="text-[10px] text-gray-400 leading-tight">{src}</div>}
                              </>
                            );
                          })()}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-gray-900">
                          {item.status === 'sold' && item.salePrice ? `$${parseFloat(item.salePrice).toFixed(2)}` :
                           item.listingPrice ? `$${parseFloat(item.listingPrice).toFixed(2)}` : <span className="text-gray-400">—</span>}
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
        </>
      )}
    </div>
  );
}

function VarietyRateStrip({ variety, itemCount, globalRate, onUpdate }) {
  const [val, setVal] = useState(variety?.profitRate != null ? String(variety.profitRate) : '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    // Resync when the user switches to a different variety tab.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVal(variety?.profitRate != null ? String(variety.profitRate) : '');
    setErr('');
  }, [variety?.id, variety?.profitRate]);

  if (!variety) return null;

  const commit = async (next) => {
    setErr('');
    setSaving(true);
    try {
      await onUpdate(variety.id, next);
    } catch (e) {
      setErr(e.message || 'Save failed');
    }
    setSaving(false);
  };

  const handleBlur = () => {
    const trimmed = val.trim();
    if (trimmed === '' && variety.profitRate == null) return;
    if (trimmed === '') return commit(null);
    const num = parseFloat(trimmed);
    if (!Number.isFinite(num)) {
      setErr('Must be a number');
      return;
    }
    if (num === variety.profitRate) return;
    commit(num);
  };

  const effectiveRate = Number.isFinite(parseFloat(val))
    ? parseFloat(val)
    : (variety.profitRate ?? globalRate);
  const usingGlobal = variety.profitRate == null && val.trim() === '';

  return (
    <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex-shrink-0 w-9 h-9 bg-white text-emerald-700 rounded-lg flex items-center justify-center">
        <Target className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-emerald-900">
          {variety.name} profit rate
        </div>
        <div className="text-xs text-emerald-700/80">
          Applies to {itemCount} item{itemCount === 1 ? '' : 's'} in this variety that don't have their own rate set.
          {usingGlobal && ` Currently using the global ${globalRate ?? '—'}%.`}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            inputMode="decimal"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            placeholder={String(globalRate ?? '')}
            disabled={saving}
            className="w-20 px-2.5 py-1.5 border border-emerald-300 rounded-lg text-sm text-right tabular-nums bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-50"
            min="0"
            step="10"
          />
          <span className="text-sm text-emerald-800">%</span>
        </div>
        {!usingGlobal && Number.isFinite(effectiveRate) && (
          <span className="text-xs text-emerald-700 whitespace-nowrap hidden sm:inline">
            $10 → ${(10 * (1 + effectiveRate / 100)).toFixed(2)}
          </span>
        )}
      </div>
      {err && (
        <div className="text-xs text-red-700 sm:ml-3">{err}</div>
      )}
    </div>
  );
}
