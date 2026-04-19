import { useState, useMemo } from 'react';
import { X, Layers, Search, DollarSign, Tag, Sprout, ListOrdered, Check } from 'lucide-react';
import { PRICE_BUCKETS } from '../constants.js';

export function LineupBuilder({ sale, items, onSave, onClose }) {
  const eligible = useMemo(() => {
    return items.filter(i => {
      if (i.saleId === sale.id) return true;
      if (i.saleId && i.saleId !== sale.id) return false;
      return ['available', 'listed'].includes(i.status);
    });
  }, [items, sale.id]);

  const initialSelected = useMemo(() => {
    const m = {};
    items.filter(i => i.saleId === sale.id).forEach(i => {
      m[i.id] = { lotNumber: i.lotNumber || '' };
    });
    return m;
  }, [items, sale.id]);

  const [selected, setSelected] = useState(initialSelected);
  const [groupBy, setGroupBy] = useState('price');
  const [typeFilter, setTypeFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState({});

  const toggleItem = (id) => {
    setSelected(prev => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = { lotNumber: '' };
      return next;
    });
  };

  const toggleGroup = (ids, allSelected) => {
    setSelected(prev => {
      const next = { ...prev };
      if (allSelected) {
        ids.forEach(id => delete next[id]);
      } else {
        ids.forEach(id => { if (!next[id]) next[id] = { lotNumber: '' }; });
      }
      return next;
    });
  };

  const setLot = (id, lot) => {
    setSelected(prev => ({ ...prev, [id]: { ...prev[id], lotNumber: lot } }));
  };

  const autoNumber = () => {
    const sortedIds = Object.keys(selected).sort((a, b) => {
      const ia = eligible.find(i => i.id === a);
      const ib = eligible.find(i => i.id === b);
      const pa = parseFloat(ia?.listingPrice) || 0;
      const pb = parseFloat(ib?.listingPrice) || 0;
      return pa - pb;
    });
    const next = { ...selected };
    sortedIds.forEach((id, idx) => {
      next[id] = { ...next[id], lotNumber: String(idx + 1) };
    });
    setSelected(next);
  };

  const clearLots = () => {
    const next = {};
    Object.keys(selected).forEach(id => { next[id] = { lotNumber: '' }; });
    setSelected(next);
  };

  const handleSave = () => {
    const lotCounts = {};
    Object.values(selected).forEach(s => {
      if (s.lotNumber) {
        lotCounts[s.lotNumber] = (lotCounts[s.lotNumber] || 0) + 1;
      }
    });
    const dupes = Object.entries(lotCounts).filter(([, c]) => c > 1).map(([n]) => n);
    if (dupes.length) {
      alert(`Duplicate lot numbers: ${dupes.join(', ')}`);
      return;
    }

    const updates = [];
    Object.entries(selected).forEach(([id, meta]) => {
      updates.push({ id, saleId: sale.id, lotNumber: meta.lotNumber || null });
    });
    items.filter(i => i.saleId === sale.id && !selected[i.id]).forEach(i => {
      updates.push({ id: i.id, saleId: null, lotNumber: null });
    });
    onSave(updates);
  };

  const filtered = useMemo(() => {
    return eligible.filter(i => {
      if (typeFilter !== 'all' && i.type !== typeFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          i.sku?.toLowerCase().includes(q) ||
          i.name?.toLowerCase().includes(q) ||
          i.variety?.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [eligible, typeFilter, search]);

  const grouped = useMemo(() => {
    const groups = {};
    const order = [];

    if (groupBy === 'price') {
      PRICE_BUCKETS.forEach(b => { groups[b.label] = []; order.push(b.label); });
      filtered.forEach(item => {
        const price = parseFloat(item.listingPrice);
        if (!price || isNaN(price)) {
          groups['No price set'].push(item);
          return;
        }
        const bucket = PRICE_BUCKETS.find(b => b.min !== null && price >= b.min && price < b.max);
        if (bucket) groups[bucket.label].push(item);
      });
    } else if (groupBy === 'variety') {
      filtered.forEach(item => {
        const key = item.variety?.trim() || item.name?.trim() || 'Unlabeled';
        if (!groups[key]) { groups[key] = []; order.push(key); }
        groups[key].push(item);
      });
      order.sort();
    } else if (groupBy === 'type') {
      groups['TC'] = [];
      groups['Plant'] = [];
      order.push('TC', 'Plant');
      filtered.forEach(item => {
        if (item.type === 'tc') groups['TC'].push(item);
        else groups['Plant'].push(item);
      });
    }

    return { groups, order: order.filter(k => groups[k]?.length > 0) };
  }, [filtered, groupBy]);

  const selectedCount = Object.keys(selected).length;
  const selectedValue = Object.keys(selected).reduce((sum, id) => {
    const item = eligible.find(i => i.id === id);
    return sum + (parseFloat(item?.listingPrice) || 0);
  }, 0);

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-stretch sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-5xl h-full sm:h-[90vh] sm:rounded-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-gray-200 px-4 py-3 flex items-center justify-between flex-shrink-0">
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-gray-900 flex items-center gap-2">
              <Layers className="w-4 h-4 text-emerald-600" />
              Build Lineup · <span className="truncate">{sale.name}</span>
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">{sale.date} · {sale.platform || 'Palmstreet'}</p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-500 hover:bg-gray-100 rounded ml-2">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="border-b border-gray-200 px-4 py-3 space-y-2 flex-shrink-0 bg-gray-50">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="flex-1 relative">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search SKU, name, variety..."
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white"
              />
            </div>
            <div className="flex gap-2">
              <div className="flex items-center bg-white border border-gray-300 rounded-lg p-0.5">
                {[
                  { v: 'price', label: 'Price', icon: DollarSign },
                  { v: 'variety', label: 'Variety', icon: Tag },
                  { v: 'type', label: 'Type', icon: Sprout },
                ].map(opt => {
                  const Ic = opt.icon;
                  return (
                    <button
                      key={opt.v}
                      onClick={() => setGroupBy(opt.v)}
                      className={`flex items-center gap-1 px-2 py-1 text-xs font-medium rounded transition ${
                        groupBy === opt.v ? 'bg-emerald-600 text-white' : 'text-gray-700 hover:bg-gray-100'
                      }`}
                    >
                      <Ic className="w-3 h-3" /> {opt.label}
                    </button>
                  );
                })}
              </div>
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="text-sm px-2 py-1.5 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                <option value="all">All types</option>
                <option value="tc">TC only</option>
                <option value="plant">Plant only</option>
              </select>
            </div>
          </div>
          {selectedCount > 0 && (
            <div className="flex items-center gap-2 pt-1">
              <button onClick={autoNumber} className="flex items-center gap-1 px-2 py-1 text-xs bg-white border border-gray-300 rounded-lg hover:bg-gray-100">
                <ListOrdered className="w-3 h-3" /> Auto-number by price
              </button>
              <button onClick={clearLots} className="text-xs text-gray-600 hover:text-gray-900 px-2 py-1">
                Clear lot numbers
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {grouped.order.length === 0 ? (
            <div className="text-center py-12 text-sm text-gray-500">
              No items match. Try changing filters or add more inventory.
            </div>
          ) : (
            <div className="space-y-4">
              {grouped.order.map(groupKey => {
                const groupItems = grouped.groups[groupKey];
                const ids = groupItems.map(i => i.id);
                const allSelected = ids.every(id => selected[id]);
                const someSelected = ids.some(id => selected[id]);
                const isCollapsed = collapsed[groupKey];
                const groupValue = groupItems.reduce((s, i) => s + (parseFloat(i.listingPrice) || 0), 0);

                return (
                  <div key={groupKey} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                    <div className="bg-gray-50 px-3 py-2 flex items-center justify-between border-b border-gray-200">
                      <button
                        onClick={() => setCollapsed(prev => ({ ...prev, [groupKey]: !prev[groupKey] }))}
                        className="flex items-center gap-2 text-left flex-1 min-w-0"
                      >
                        <span className={`text-xs transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>▶</span>
                        <span className="font-medium text-sm text-gray-900 truncate">{groupKey}</span>
                        <span className="text-xs text-gray-500 whitespace-nowrap">
                          {groupItems.length} items · ${groupValue.toFixed(0)}
                        </span>
                      </button>
                      <label className="flex items-center gap-1.5 text-xs text-gray-700 cursor-pointer ml-2 whitespace-nowrap">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          ref={(el) => { if (el) el.indeterminate = !allSelected && someSelected; }}
                          onChange={() => toggleGroup(ids, allSelected)}
                          className="w-3.5 h-3.5 rounded text-emerald-600 focus:ring-emerald-500"
                        />
                        Select all
                      </label>
                    </div>
                    {!isCollapsed && (
                      <div className="divide-y divide-gray-100">
                        {groupItems.map(item => {
                          const isSelected = !!selected[item.id];
                          const lotValue = selected[item.id]?.lotNumber || '';
                          return (
                            <label
                              key={item.id}
                              className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 transition ${
                                isSelected ? 'bg-emerald-50/50' : ''
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleItem(item.id)}
                                className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 flex-shrink-0"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                                    item.type === 'tc' ? 'bg-sky-500' : 'bg-emerald-500'
                                  }`} />
                                  <span className="font-medium text-sm text-gray-900 truncate">{item.name}</span>
                                  {item.variety && (
                                    <span className="text-xs text-gray-500 truncate">· {item.variety}</span>
                                  )}
                                </div>
                                <div className="text-xs text-gray-500 font-mono">{item.sku}</div>
                              </div>
                              <div className="text-sm font-medium text-gray-900 w-16 text-right flex-shrink-0">
                                {item.listingPrice ? `$${parseFloat(item.listingPrice).toFixed(0)}` : '—'}
                              </div>
                              {isSelected && (
                                <input
                                  type="text"
                                  value={lotValue}
                                  onChange={(e) => setLot(item.id, e.target.value)}
                                  onClick={(e) => e.preventDefault()}
                                  placeholder="Lot #"
                                  className="w-16 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-emerald-500 flex-shrink-0"
                                />
                              )}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="border-t border-gray-200 px-4 py-3 flex items-center justify-between flex-shrink-0 bg-white">
          <div className="text-sm">
            <span className="font-semibold text-gray-900">{selectedCount}</span>
            <span className="text-gray-500"> lots selected · </span>
            <span className="font-semibold text-emerald-700">${selectedValue.toFixed(0)}</span>
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
            <button onClick={handleSave} className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg flex items-center gap-1.5">
              <Check className="w-4 h-4" /> Save Lineup
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
