import { useMemo, useState } from 'react';
import { Search, Plus } from 'lucide-react';
import { api } from '../api.js';
import { CatalogPlantCard } from './CatalogPlantCard.jsx';
import { PlantDetailModal } from './PlantDetailModal.jsx';
import { DraftMiniBar } from './DraftMiniBar.jsx';

const SORTS = [
  { id: 'name',       label: 'Name' },
  { id: 'wholesale',  label: 'Wholesale ↑' },
  { id: 'ideal',      label: 'Ideal ↑' },
  { id: 'margin',     label: 'Margin ↓' },
  { id: 'recent',     label: 'Recently added' },
];

export function CatalogPane({ varieties, species, showToast, onSpeciesChanged, onSwitchToOrders }) {
  const [varietyTab, setVarietyTab] = useState('all');
  const [search, setSearch] = useState('');
  const [sortId, setSortId] = useState('name');
  const [selectedSpeciesId, setSelectedSpeciesId] = useState(null);
  const [addingId, setAddingId] = useState(null);

  const addToDraft = async (plant) => {
    setAddingId(plant.id);
    try {
      const drafts = await api.listPurchaseOrders('draft');
      let po = drafts && drafts[0];
      if (!po) po = await api.createPurchaseOrder({});
      await api.addPurchaseOrderLine({
        id: po.id,
        speciesId: plant.id,
        quantityOrdered: 1,
      });
      showToast?.(`Added ${plant.epithet} to draft`, 1500);
    } catch (e) {
      showToast?.(e.message || 'Add failed', 3000);
    } finally {
      setAddingId(null);
    }
  };

  // Decorate each species row with its variety name (the API only returns varietyId).
  const varietyById = useMemo(() => {
    const m = new Map();
    for (const v of varieties || []) m.set(v.id, v);
    return m;
  }, [varieties]);

  const plants = useMemo(
    () => (species || []).map(s => ({ ...s, varietyName: varietyById.get(s.varietyId)?.name || '' })),
    [species, varietyById],
  );

  const filtered = useMemo(() => {
    let s = plants;
    if (varietyTab !== 'all') s = s.filter(p => p.varietyId === varietyTab);
    if (search) {
      const q = search.toLowerCase();
      s = s.filter(p =>
        (p.epithet || '').toLowerCase().includes(q) ||
        (p.commonName || '').toLowerCase().includes(q) ||
        (p.varietyName || '').toLowerCase().includes(q)
      );
    }
    const copy = [...s];
    switch (sortId) {
      case 'wholesale': copy.sort((a, b) => (a.wholesalePrice ?? Infinity)    - (b.wholesalePrice ?? Infinity));    break;
      case 'ideal':     copy.sort((a, b) => (a.idealSellingPrice ?? Infinity) - (b.idealSellingPrice ?? Infinity)); break;
      case 'margin': {
        const m = (p) => (Number.isFinite(p.wholesalePrice) && p.wholesalePrice > 0 && Number.isFinite(p.idealSellingPrice))
          ? (p.idealSellingPrice - p.wholesalePrice) / p.wholesalePrice
          : -Infinity;
        copy.sort((a, b) => m(b) - m(a));
        break;
      }
      case 'recent':    copy.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')); break;
      case 'name':
      default:          copy.sort((a, b) => a.epithet.localeCompare(b.epithet)); break;
    }
    return copy;
  }, [plants, varietyTab, search, sortId]);

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 p-3 space-y-3">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex-1 relative">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search plant or variety..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
            />
          </div>
          <div className="flex gap-1 bg-gray-100 p-1 rounded-lg overflow-x-auto">
            {SORTS.map(s => (
              <button
                key={s.id}
                onClick={() => setSortId(s.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition ${
                  sortId === s.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 active:bg-gray-200'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setSelectedSpeciesId('NEW')}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg"
          >
            <Plus className="w-4 h-4" /> New plant
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 px-1 py-1 flex gap-0.5 overflow-x-auto">
        {[{ id: 'all', name: 'All' }, ...(varieties || [])].map(v => {
          const active = varietyTab === v.id;
          const count = v.id === 'all' ? plants.length : plants.filter(p => p.varietyId === v.id).length;
          return (
            <button
              key={v.id}
              onClick={() => setVarietyTab(v.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition whitespace-nowrap ${
                active ? 'bg-emerald-600 text-white font-medium' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              {v.name}
              <span className={`text-xs ${active ? 'text-emerald-100' : 'text-gray-400'}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-sm text-gray-500">
          No plants match.
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {filtered.map(plant => (
            <CatalogPlantCard
              key={plant.id}
              plant={plant}
              onOpenDetail={() => setSelectedSpeciesId(plant.id)}
              onAddToDraft={() => addToDraft(plant)}
              adding={addingId === plant.id}
            />
          ))}
        </div>
      )}

      <DraftMiniBar onOpen={() => onSwitchToOrders?.()} />

      {selectedSpeciesId && (
        <PlantDetailModal
          initial={selectedSpeciesId === 'NEW' ? null : plants.find(p => p.id === selectedSpeciesId)}
          varieties={varieties}
          existingSpecies={plants}
          showToast={showToast}
          onClose={() => setSelectedSpeciesId(null)}
          onSaved={() => onSpeciesChanged?.()}
        />
      )}
    </div>
  );
}
