import { useState, useMemo } from 'react';
import { Plus, Pencil, Trash2, Check, X, AlertCircle, Search } from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';
import { api } from '../api.js';

// Manage the variety + species catalog. Anyone can add; only admins can
// edit or delete (the API enforces this too).
export function CatalogModal({
  varieties, species, items, isAdmin,
  onVarietiesChange, onSpeciesChange,
  onClose, showToast,
}) {
  const [tab, setTab] = useState('species');

  return (
    <Modal title="Manage Catalog" onClose={onClose} size="xl">
      <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit mb-4">
        <button
          onClick={() => setTab('species')}
          className={`px-4 py-2 text-sm font-medium rounded-md transition ${
            tab === 'species' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600'
          }`}
        >
          Species ({species.length})
        </button>
        <button
          onClick={() => setTab('varieties')}
          className={`px-4 py-2 text-sm font-medium rounded-md transition ${
            tab === 'varieties' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600'
          }`}
        >
          Varieties ({varieties.length})
        </button>
      </div>

      {tab === 'varieties' ? (
        <VarietiesTab
          varieties={varieties}
          species={species}
          isAdmin={isAdmin}
          onChange={onVarietiesChange}
          showToast={showToast}
        />
      ) : (
        <SpeciesTab
          varieties={varieties}
          species={species}
          items={items}
          isAdmin={isAdmin}
          onChange={onSpeciesChange}
          onItemsTouched={() => { /* parent will refresh on next fetch */ }}
          showToast={showToast}
        />
      )}
    </Modal>
  );
}

function VarietiesTab({ varieties, species, isAdmin, onChange, showToast }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [editing, setEditing] = useState(null); // id
  const [editName, setEditName] = useState('');
  const [editCode, setEditCode] = useState('');
  const [busy, setBusy] = useState(false);

  const speciesCountByVariety = useMemo(() => {
    const counts = {};
    for (const s of species) counts[s.varietyId] = (counts[s.varietyId] || 0) + 1;
    return counts;
  }, [species]);

  const create = async () => {
    setBusy(true);
    try {
      const v = await api.createVariety({ name: name.trim(), code: code.trim().toUpperCase() });
      onChange([...varieties, v].sort((a, b) => a.name.localeCompare(b.name)));
      setName(''); setCode(''); setCreating(false);
      showToast?.('Variety added');
    } catch (e) {
      showToast?.(e.message || 'Failed', 'error');
    }
    setBusy(false);
  };

  const startEdit = (v) => {
    setEditing(v.id);
    setEditName(v.name);
    setEditCode(v.code);
  };

  const saveEdit = async (id) => {
    setBusy(true);
    try {
      await api.updateVariety({ id, patch: { name: editName.trim(), code: editCode.trim().toUpperCase() } });
      onChange(varieties.map(v => v.id === id ? { ...v, name: editName.trim(), code: editCode.trim().toUpperCase() } : v));
      setEditing(null);
      showToast?.('Variety updated');
    } catch (e) {
      showToast?.(e.message || 'Failed', 'error');
    }
    setBusy(false);
  };

  const remove = async (v) => {
    if (!confirm(`Delete variety "${v.name}"? This requires no species in it.`)) return;
    setBusy(true);
    try {
      await api.deleteVariety(v.id);
      onChange(varieties.filter(x => x.id !== v.id));
      showToast?.('Variety deleted');
    } catch (e) {
      showToast?.(e.message || 'Failed', 'error');
    }
    setBusy(false);
  };

  return (
    <div className="space-y-3">
      <div className="text-xs text-gray-600 bg-gray-50 rounded p-2">
        Varieties are top-level genus groups. The code is used as the SKU
        prefix (e.g. <span className="font-mono">ALO-12</span>).
      </div>

      {!creating ? (
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg"
        >
          <Plus className="w-4 h-4" /> Add variety
        </button>
      ) : (
        <div className="border border-emerald-200 bg-emerald-50/40 rounded-lg p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Genus (e.g. Philodendron)"
              className="input"
            />
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="Prefix (e.g. PHI)"
              maxLength={6}
              className="input font-mono"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => { setCreating(false); setName(''); setCode(''); }} className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded">Cancel</button>
            <button
              onClick={create}
              disabled={busy || !name.trim() || !/^[A-Z]{2,6}$/.test(code.trim())}
              className="px-3 py-1.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white rounded"
            >
              Add
            </button>
          </div>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-96 overflow-y-auto">
        {varieties.length === 0 ? (
          <div className="px-4 py-6 text-sm text-gray-500 text-center">No varieties yet.</div>
        ) : (
          varieties.map(v => (
            <div key={v.id} className="px-3 py-2.5">
              {editing === v.id ? (
                <div className="flex items-center gap-2">
                  <input value={editName} onChange={(e) => setEditName(e.target.value)} className="input flex-1" />
                  <input value={editCode} onChange={(e) => setEditCode(e.target.value.toUpperCase())} className="input w-24 font-mono" maxLength={6} />
                  <button onClick={() => saveEdit(v.id)} disabled={busy} className="p-2 text-emerald-700 hover:bg-emerald-50 rounded">
                    <Check className="w-4 h-4" />
                  </button>
                  <button onClick={() => setEditing(null)} className="p-2 text-gray-500 hover:bg-gray-100 rounded">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="font-medium text-gray-900">{v.name}</div>
                    <div className="text-xs text-gray-500">
                      <span className="font-mono">{v.code}</span> · {speciesCountByVariety[v.id] || 0} species
                    </div>
                  </div>
                  {isAdmin && (
                    <>
                      <button onClick={() => startEdit(v)} className="p-2 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded" aria-label="Edit">
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button onClick={() => remove(v)} className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" aria-label="Delete">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
      {!isAdmin && (
        <div className="text-xs text-gray-500 flex items-start gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          Editing or deleting varieties requires admin access.
        </div>
      )}
    </div>
  );
}

function SpeciesTab({ varieties, species, items, isAdmin, onChange, showToast }) {
  const [filterVarietyId, setFilterVarietyId] = useState('all');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [newVarietyId, setNewVarietyId] = useState('');
  const [newEpithet, setNewEpithet] = useState('');
  const [newCommon, setNewCommon] = useState('');
  const [editing, setEditing] = useState(null);
  const [editEpithet, setEditEpithet] = useState('');
  const [editCommon, setEditCommon] = useState('');
  const [busy, setBusy] = useState(false);

  const itemCountBySpecies = useMemo(() => {
    const counts = {};
    for (const i of items) {
      if (i.speciesId) counts[i.speciesId] = (counts[i.speciesId] || 0) + 1;
    }
    return counts;
  }, [items]);
  const varietyById = useMemo(
    () => Object.fromEntries(varieties.map(v => [v.id, v])),
    [varieties]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return species.filter(s => {
      if (filterVarietyId !== 'all' && s.varietyId !== filterVarietyId) return false;
      if (q && !s.epithet.toLowerCase().includes(q) && !(s.commonName || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [species, filterVarietyId, search]);

  const create = async () => {
    setBusy(true);
    try {
      const s = await api.createSpecies({
        varietyId: newVarietyId,
        epithet: newEpithet.trim(),
        commonName: newCommon.trim() || null,
      });
      onChange([...species, s].sort((a, b) => a.epithet.localeCompare(b.epithet)));
      setCreating(false); setNewEpithet(''); setNewCommon(''); setNewVarietyId('');
      showToast?.('Species added');
    } catch (e) {
      showToast?.(e.message || 'Failed', 'error');
    }
    setBusy(false);
  };

  const startEdit = (s) => {
    setEditing(s.id);
    setEditEpithet(s.epithet);
    setEditCommon(s.commonName || '');
  };

  const saveEdit = async (id) => {
    setBusy(true);
    try {
      await api.updateSpecies({
        id,
        patch: { epithet: editEpithet.trim(), commonName: editCommon.trim() || null },
      });
      onChange(species.map(s => s.id === id ? { ...s, epithet: editEpithet.trim(), commonName: editCommon.trim() || null } : s));
      setEditing(null);
      showToast?.('Species updated');
    } catch (e) {
      showToast?.(e.message || 'Failed', 'error');
    }
    setBusy(false);
  };

  const remove = async (s) => {
    if (!confirm(`Delete species "${s.epithet}"? Items linked to it must be removed/reassigned first.`)) return;
    setBusy(true);
    try {
      await api.deleteSpecies(s.id);
      onChange(species.filter(x => x.id !== s.id));
      showToast?.('Species deleted');
    } catch (e) {
      showToast?.(e.message || 'Failed', 'error');
    }
    setBusy(false);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          value={filterVarietyId}
          onChange={(e) => setFilterVarietyId(e.target.value)}
          className="input sm:w-48"
        >
          <option value="all">All varieties</option>
          {varieties.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <div className="flex-1 relative">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search species…"
            className="input pl-9"
          />
        </div>
      </div>

      {!creating ? (
        <button
          onClick={() => { setCreating(true); setNewVarietyId(filterVarietyId !== 'all' ? filterVarietyId : ''); }}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg"
        >
          <Plus className="w-4 h-4" /> Add species
        </button>
      ) : (
        <div className="border border-emerald-200 bg-emerald-50/40 rounded-lg p-3 space-y-2">
          <select
            value={newVarietyId}
            onChange={(e) => setNewVarietyId(e.target.value)}
            className="input"
          >
            <option value="">Pick variety…</option>
            {varieties.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          <input
            autoFocus
            value={newEpithet}
            onChange={(e) => setNewEpithet(e.target.value)}
            placeholder="Species name (e.g. sinuata 'Aurea Variegated')"
            className="input"
          />
          <input
            value={newCommon}
            onChange={(e) => setNewCommon(e.target.value)}
            placeholder="Common name (optional)"
            className="input"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => { setCreating(false); setNewEpithet(''); setNewCommon(''); }} className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded">Cancel</button>
            <button
              onClick={create}
              disabled={busy || !newVarietyId || !newEpithet.trim()}
              className="px-3 py-1.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white rounded"
            >
              Add
            </button>
          </div>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-[50vh] overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-4 py-6 text-sm text-gray-500 text-center">No species match.</div>
        ) : (
          filtered.map(s => (
            <div key={s.id} className="px-3 py-2.5">
              {editing === s.id ? (
                <div className="space-y-2">
                  <input value={editEpithet} onChange={(e) => setEditEpithet(e.target.value)} className="input" />
                  <input value={editCommon} onChange={(e) => setEditCommon(e.target.value)} className="input" placeholder="Common name (optional)" />
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setEditing(null)} className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded">Cancel</button>
                    <button onClick={() => saveEdit(s.id)} disabled={busy} className="px-3 py-1.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white rounded">Save</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-gray-900 truncate">{s.epithet}</div>
                    <div className="text-xs text-gray-500 truncate">
                      {varietyById[s.varietyId]?.name || '?'} · {itemCountBySpecies[s.id] || 0} items
                      {s.commonName && ` · ${s.commonName}`}
                    </div>
                  </div>
                  {isAdmin && (
                    <>
                      <button onClick={() => startEdit(s)} className="p-2 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded" aria-label="Edit">
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button onClick={() => remove(s)} className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" aria-label="Delete">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
      {!isAdmin && (
        <div className="text-xs text-gray-500 flex items-start gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          Editing or deleting species requires admin access.
        </div>
      )}
    </div>
  );
}
