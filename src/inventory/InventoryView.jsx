import { useState, useMemo } from 'react';
import { Search, Download, ArrowRightLeft, Edit2, Trash2, Archive, Printer, X } from 'lucide-react';
import { FilterPill } from '../ui/FilterPill.jsx';
import { VARIETIES } from '../constants.js';

export function InventoryView({ items: filteredItems, allItems, sales, searchQuery, setSearchQuery, filterType, setFilterType, filterStatus, setFilterStatus, filterSale, setFilterSale, onEdit, onDelete, onConvert, onAssignSale, onPrintLabel, onBulkPrintLabel, onBulkDelete, onStatusChange, isAdmin }) {
  // Variety tab further narrows the list. `items` below = the final list
  // shown in the table / cards (after search/type/status/sale + variety tab).
  const [varietyTab, setVarietyTab] = useState('all');
  const items = useMemo(
    () => varietyTab === 'all' ? filteredItems : filteredItems.filter(i => i.variety === varietyTab),
    [filteredItems, varietyTab]
  );
  const varietyCounts = useMemo(() => {
    const counts = { all: filteredItems.length };
    for (const v of VARIETIES) {
      counts[v] = filteredItems.filter(i => i.variety === v).length;
    }
    return counts;
  }, [filteredItems]);

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
    const headers = ['SKU', 'Type', 'Name', 'Variety', 'Quantity', 'Cost', 'Listing Price', 'Sale Price', 'Status', 'Sale Event', 'Lot', 'Source', 'Acquired', 'Notes'];
    const rows = items.map(i => {
      const sale = sales.find(s => s.id === i.saleId);
      return [
        i.sku, i.type, i.name, i.variety || '', i.quantity || 1,
        i.cost || '', i.listingPrice || '', i.salePrice || '',
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
        {[{ value: 'all', label: 'All' }, ...VARIETIES.map(v => ({ value: v, label: v }))].map(tab => {
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
                    <th className="px-3 py-2.5 text-right">Price</th>
                    <th className="px-3 py-2.5 text-right">Profit</th>
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
                        <td colSpan={7} className="px-3 py-2">
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
                        <td className="px-3 py-2.5 text-right text-gray-900">
                          {item.status === 'sold' && item.salePrice ? `${parseFloat(item.salePrice).toFixed(2)}` :
                           item.listingPrice ? `${parseFloat(item.listingPrice).toFixed(2)}` : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          {(() => {
                            const sp = parseFloat(item.salePrice);
                            const cost = parseFloat(item.grossCost ?? item.cost);
                            const isSold = ['sold','shipped','delivered'].includes(item.status);
                            if (!isSold || isNaN(sp) || sp <= 0 || isNaN(cost) || cost <= 0) return <span className="text-xs text-gray-400">—</span>;
                            const rate = ((sp - cost) / cost) * 100;
                            return (
                              <span className={`text-xs font-semibold ${
                                rate >= 200 ? 'text-emerald-600' :
                                rate >= 100 ? 'text-blue-600' :
                                rate >= 0 ? 'text-amber-600' :
                                'text-red-600'
                              }`}>
                                {rate >= 0 ? '+' : ''}{rate.toFixed(0)}%
                              </span>
                            );
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
