import { useState, useMemo, useRef, useEffect } from 'react';
import {
  X, Layers, Search, DollarSign, Tag, Sprout, ListOrdered, Check,
  ScanLine, Gift,
} from 'lucide-react';
import { PRICE_BUCKETS } from '../constants.js';

export function LineupBuilder({ sale, items, onSave, onClose }) {
  // Per-selected-item state: { lotNumber, kind: 'sale'|'giveaway' }.
  const initialSelected = useMemo(() => {
    const m = {};
    items.filter(i => i.saleId === sale.id).forEach(i => {
      m[i.id] = {
        lotNumber: i.lotNumber || '',
        kind: i.lotKind === 'giveaway' ? 'giveaway' : 'sale',
      };
    });
    return m;
  }, [items, sale.id]);

  const [selected, setSelected] = useState(initialSelected);
  // Active tab determines the kind ('sale' or 'giveaway') for new selections,
  // and filters the eligible pool to hide items selected as the other kind.
  const [activeTab, setActiveTab] = useState('sale');
  const [groupBy, setGroupBy] = useState('price');
  const [typeFilter, setTypeFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState({});

  // Eligible items for the active tab: standard sale eligibility, minus
  // anything already selected as the *other* kind (so the user toggles a
  // single category at a time).
  const eligible = useMemo(() => {
    return items.filter(i => {
      const sel = selected[i.id];
      if (sel && sel.kind !== activeTab) return false;
      if (i.saleId === sale.id) return true;
      if (i.saleId && i.saleId !== sale.id) return false;
      if (!['available', 'listed'].includes(i.status)) return false;
      if (sale.itemTypes === 'tc' && i.type !== 'tc') return false;
      if (sale.itemTypes === 'plant' && i.type !== 'plant') return false;
      return true;
    });
  }, [items, sale.id, sale.itemTypes, selected, activeTab]);

  // Barcode scanner state. The hidden input is auto-focused; USB scanners
  // type the SKU then send Enter, which fires `handleScan`. `scanFlash`
  // briefly highlights the affected row so the user gets visual feedback.
  const scanRef = useRef(null);
  const [scanInput, setScanInput] = useState('');
  const [scanFlash, setScanFlash] = useState({ id: null, kind: null });
  const [scanMessage, setScanMessage] = useState(null);

  useEffect(() => {
    scanRef.current?.focus();
  }, []);

  // Briefly clear the flash highlight after 1.2s.
  useEffect(() => {
    if (!scanFlash.id) return;
    const t = setTimeout(() => setScanFlash({ id: null, kind: null }), 1200);
    return () => clearTimeout(t);
  }, [scanFlash]);

  useEffect(() => {
    if (!scanMessage) return;
    const t = setTimeout(() => setScanMessage(null), 2000);
    return () => clearTimeout(t);
  }, [scanMessage]);

  const handleScan = (raw) => {
    const code = (raw || '').trim();
    if (!code) return;
    const found = items.find(i => i.sku?.toLowerCase() === code.toLowerCase());
    if (!found) {
      setScanMessage({ type: 'error', text: `No SKU "${code}" in inventory` });
      return;
    }
    if (found.saleId && found.saleId !== sale.id) {
      setScanMessage({ type: 'error', text: `${found.sku} is already on another sale` });
      return;
    }
    if (sale.itemTypes === 'tc' && found.type !== 'tc') {
      setScanMessage({ type: 'error', text: `${found.sku} is not a TC; this sale is TC only` });
      return;
    }
    if (sale.itemTypes === 'plant' && found.type !== 'plant') {
      setScanMessage({ type: 'error', text: `${found.sku} is not a plant; this sale is plants only` });
      return;
    }
    setSelected(prev => {
      if (prev[found.id]) {
        // Already selected. If wrong kind for the active tab, switch it.
        if (prev[found.id].kind !== activeTab) {
          return { ...prev, [found.id]: { ...prev[found.id], kind: activeTab } };
        }
        return prev;
      }
      return { ...prev, [found.id]: { lotNumber: '', kind: activeTab } };
    });
    setScanFlash({ id: found.id, kind: 'add' });
    setScanMessage({
      type: 'ok',
      text: `Added ${found.sku} to ${activeTab === 'giveaway' ? 'Giveaways' : 'Sale items'}`,
    });
  };

  const onScanKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleScan(scanInput);
      setScanInput('');
    }
  };

  const toggleItem = (id) => {
    setSelected(prev => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = { lotNumber: '', kind: activeTab };
      return next;
    });
  };

  const toggleGroup = (ids, allSelected) => {
    setSelected(prev => {
      const next = { ...prev };
      if (allSelected) {
        ids.forEach(id => delete next[id]);
      } else {
        ids.forEach(id => { if (!next[id]) next[id] = { lotNumber: '', kind: activeTab }; });
      }
      return next;
    });
  };

  const setLot = (id, lot) => {
    setSelected(prev => ({ ...prev, [id]: { ...prev[id], lotNumber: lot } }));
  };

  // Auto-number assigns sequential lot #s to *sale* items, sorted by price
  // ascending. Giveaways are skipped (they don't take a lot number).
  const autoNumber = () => {
    const saleIds = Object.entries(selected)
      .filter(([, v]) => v.kind !== 'giveaway')
      .map(([id]) => id);
    const sorted = saleIds.sort((a, b) => {
      const ia = eligible.find(i => i.id === a);
      const ib = eligible.find(i => i.id === b);
      const pa = parseFloat(ia?.listingPrice) || 0;
      const pb = parseFloat(ib?.listingPrice) || 0;
      return pa - pb;
    });
    setSelected(prev => {
      const next = { ...prev };
      sorted.forEach((id, idx) => {
        next[id] = { ...next[id], lotNumber: String(idx + 1) };
      });
      return next;
    });
  };

  const clearLots = () => {
    setSelected(prev => {
      const next = {};
      Object.keys(prev).forEach(id => { next[id] = { ...prev[id], lotNumber: '' }; });
      return next;
    });
  };

  const handleSave = () => {
    // Lot # uniqueness only matters for sale items.
    const lotCounts = {};
    Object.values(selected).forEach(s => {
      if (s.kind !== 'giveaway' && s.lotNumber) {
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
      updates.push({
        id,
        saleId: sale.id,
        lotNumber: meta.kind === 'giveaway' ? null : (meta.lotNumber || null),
        lotKind: meta.kind,
      });
    });
    items.filter(i => i.saleId === sale.id && !selected[i.id]).forEach(i => {
      updates.push({ id: i.id, saleId: null, lotNumber: null, lotKind: 'sale' });
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
  const giveawayCount = Object.values(selected).filter(s => s.kind === 'giveaway').length;
  const saleCount = selectedCount - giveawayCount;
  const selectedValue = Object.entries(selected).reduce((sum, [id, meta]) => {
    if (meta.kind === 'giveaway') return sum;
    const item = eligible.find(i => i.id === id);
    return sum + (parseFloat(item?.listingPrice) || 0);
  }, 0);

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-stretch sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-6xl h-full sm:h-[92vh] sm:rounded-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-gray-200 px-4 sm:px-5 py-3 sm:py-4 flex items-center justify-between flex-shrink-0">
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-gray-900 text-base sm:text-lg flex items-center gap-2">
              <Layers className="w-5 h-5 text-emerald-600" />
              Build Lineup · <span className="truncate">{sale.name}</span>
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {sale.date} · {sale.platform || 'Palmstreet'}
              {sale.itemTypes && sale.itemTypes !== 'both' && ` · ${sale.itemTypes.toUpperCase()} only`}
            </p>
          </div>
          <button onClick={onClose} className="p-2 -mr-1 text-gray-500 hover:bg-gray-100 active:bg-gray-200 rounded-lg ml-2">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="border-b border-gray-200 px-4 sm:px-5 pt-3 flex-shrink-0 bg-gray-50">
          <div className="flex gap-1 bg-gray-200/70 p-1 rounded-lg w-fit">
            <button
              onClick={() => setActiveTab('sale')}
              className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md transition ${
                activeTab === 'sale'
                  ? 'bg-white text-emerald-700 shadow-sm'
                  : 'text-gray-600 active:bg-gray-300'
              }`}
            >
              <Layers className="w-4 h-4" /> Sale items
              <span className="text-xs text-gray-500">({saleCount})</span>
            </button>
            <button
              onClick={() => setActiveTab('giveaway')}
              className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md transition ${
                activeTab === 'giveaway'
                  ? 'bg-white text-amber-700 shadow-sm'
                  : 'text-gray-600 active:bg-gray-300'
              }`}
            >
              <Gift className="w-4 h-4" /> Giveaways
              <span className="text-xs text-gray-500">({giveawayCount})</span>
            </button>
          </div>
        </div>

        <div className="border-b border-gray-200 px-4 sm:px-5 py-3 space-y-2.5 flex-shrink-0 bg-gray-50">
          <div className="relative">
            <ScanLine className={`w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 ${
              activeTab === 'giveaway' ? 'text-amber-600' : 'text-emerald-600'
            }`} />
            <input
              ref={scanRef}
              type="text"
              value={scanInput}
              onChange={(e) => setScanInput(e.target.value)}
              onKeyDown={onScanKeyDown}
              placeholder={`Scan to add to ${activeTab === 'giveaway' ? 'Giveaways' : 'Sale items'}`}
              className={`w-full pl-10 pr-3 py-3 text-base border-2 rounded-lg focus:outline-none focus:ring-2 bg-white ${
                activeTab === 'giveaway'
                  ? 'border-amber-300 focus:border-amber-500 focus:ring-amber-200'
                  : 'border-emerald-300 focus:border-emerald-500 focus:ring-emerald-200'
              }`}
            />
            {scanMessage && (
              <div className={`absolute right-2 top-1/2 -translate-y-1/2 text-xs sm:text-sm px-2 py-1 rounded ${
                scanMessage.type === 'error' ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'
              }`}>
                {scanMessage.text}
              </div>
            )}
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="flex-1 relative">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search SKU, name, variety..."
                className="w-full pl-9 pr-3 py-2.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white"
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
                      className={`flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded transition ${
                        groupBy === opt.v ? 'bg-emerald-600 text-white' : 'text-gray-700 active:bg-gray-100'
                      }`}
                    >
                      <Ic className="w-3.5 h-3.5" /> {opt.label}
                    </button>
                  );
                })}
              </div>
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="text-sm px-3 py-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                <option value="all">All types</option>
                <option value="tc">TC only</option>
                <option value="plant">Plant only</option>
              </select>
            </div>
          </div>
          {activeTab === 'sale' && saleCount > 0 && (
            <div className="flex items-center gap-2 pt-1 flex-wrap">
              <button onClick={autoNumber} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border border-gray-300 rounded-lg hover:bg-gray-100 active:bg-gray-200">
                <ListOrdered className="w-3.5 h-3.5" /> Auto-number by price
              </button>
              <button onClick={clearLots} className="text-xs text-gray-600 hover:text-gray-900 px-2 py-1.5">
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
                    <div className="bg-gray-50 px-3 py-2.5 flex items-center justify-between border-b border-gray-200">
                      <button
                        onClick={() => setCollapsed(prev => ({ ...prev, [groupKey]: !prev[groupKey] }))}
                        className="flex items-center gap-2 text-left flex-1 min-w-0 py-1"
                      >
                        <span className={`text-xs transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>▶</span>
                        <span className="font-medium text-sm text-gray-900 truncate">{groupKey}</span>
                        <span className="text-xs text-gray-500 whitespace-nowrap">
                          {groupItems.length} items · ${groupValue.toFixed(0)}
                        </span>
                      </button>
                      <label className="flex items-center gap-2 text-xs sm:text-sm text-gray-700 cursor-pointer ml-2 whitespace-nowrap py-1 px-2">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          ref={(el) => { if (el) el.indeterminate = !allSelected && someSelected; }}
                          onChange={() => toggleGroup(ids, allSelected)}
                          className="w-5 h-5 rounded text-emerald-600 focus:ring-emerald-500"
                        />
                        Select all
                      </label>
                    </div>
                    {!isCollapsed && (
                      <div className="divide-y divide-gray-100">
                        {groupItems.map(item => {
                          const meta = selected[item.id];
                          const isSelected = !!meta;
                          const flashed = scanFlash.id === item.id;
                          return (
                            <label
                              key={item.id}
                              className={`flex items-center gap-3 px-3 py-3 cursor-pointer transition active:bg-gray-100 ${
                                flashed ? (activeTab === 'giveaway' ? 'bg-amber-100' : 'bg-emerald-100') :
                                isSelected ? (activeTab === 'giveaway' ? 'bg-amber-50/70' : 'bg-emerald-50/60')
                                : 'hover:bg-gray-50'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleItem(item.id)}
                                className={`w-5 h-5 rounded focus:ring-2 flex-shrink-0 ${
                                  activeTab === 'giveaway'
                                    ? 'text-amber-600 focus:ring-amber-500'
                                    : 'text-emerald-600 focus:ring-emerald-500'
                                }`}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className={`inline-block w-2 h-2 rounded-full ${
                                    item.type === 'tc' ? 'bg-sky-500' : 'bg-emerald-500'
                                  }`} />
                                  <span className="font-medium text-sm sm:text-base text-gray-900 truncate">{item.name}</span>
                                  {item.variety && (
                                    <span className="text-xs sm:text-sm text-gray-500 truncate">· {item.variety}</span>
                                  )}
                                </div>
                                <div className="text-xs text-gray-500 font-mono mt-0.5">{item.sku}</div>
                              </div>
                              <div className="text-sm sm:text-base font-medium text-gray-900 w-16 text-right flex-shrink-0">
                                {item.listingPrice ? `$${parseFloat(item.listingPrice).toFixed(0)}` : '—'}
                              </div>
                              {isSelected && activeTab === 'sale' && (
                                <input
                                  type="text"
                                  value={meta.lotNumber || ''}
                                  onChange={(e) => setLot(item.id, e.target.value)}
                                  onClick={(e) => e.preventDefault()}
                                  placeholder="Lot #"
                                  inputMode="numeric"
                                  className="w-16 px-2 py-2 text-sm text-center border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 flex-shrink-0"
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

        <div className="border-t border-gray-200 px-4 sm:px-5 py-3 sm:py-4 flex items-center justify-between flex-shrink-0 bg-white">
          <div className="text-sm">
            <span className="font-semibold text-gray-900">{saleCount}</span>
            <span className="text-gray-500"> sale · </span>
            <span className="font-semibold text-amber-700">{giveawayCount}</span>
            <span className="text-gray-500"> give · </span>
            <span className="font-semibold text-emerald-700">${selectedValue.toFixed(0)}</span>
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-100 active:bg-gray-200 rounded-lg">
              Cancel
            </button>
            <button onClick={handleSave} className="px-5 py-2.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white rounded-lg flex items-center gap-1.5">
              <Check className="w-4 h-4" /> Save Lineup
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
