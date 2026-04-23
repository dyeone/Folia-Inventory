import { useState, useMemo } from 'react';
import { Plus, Check, ChevronDown, X } from 'lucide-react';

// Cascading variety + species picker. Drives a controlled `value` shape:
//   { varietyId, speciesId, varietyName, speciesEpithet }
//
// Both inline "add new" affordances are supported: the user can type a
// new variety name (with code prompt) or a new species epithet, and it'll
// be POSTed to the catalog API immediately so subsequent items can pick it.
export function SpeciesPicker({
  varieties,
  species,
  value,
  onChange,
  onCreateVariety,    // async ({ name, code }) => variety
  onCreateSpecies,    // async ({ varietyId, epithet }) => species
}) {
  const [varietyOpen, setVarietyOpen] = useState(false);
  const [speciesOpen, setSpeciesOpen] = useState(false);
  const [vQuery, setVQuery] = useState('');
  const [sQuery, setSQuery] = useState('');
  const [creatingVariety, setCreatingVariety] = useState(false);
  const [newVarietyName, setNewVarietyName] = useState('');
  const [newVarietyCode, setNewVarietyCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState('');

  const variety = varieties.find(v => v.id === value?.varietyId);
  const speciesList = useMemo(
    () => species.filter(s => s.varietyId === value?.varietyId).sort((a, b) => a.epithet.localeCompare(b.epithet)),
    [species, value?.varietyId]
  );
  const selectedSpecies = species.find(s => s.id === value?.speciesId);

  const filteredVarieties = useMemo(() => {
    const q = vQuery.trim().toLowerCase();
    return q ? varieties.filter(v => v.name.toLowerCase().includes(q)) : varieties;
  }, [varieties, vQuery]);

  const filteredSpecies = useMemo(() => {
    const q = sQuery.trim().toLowerCase();
    return q ? speciesList.filter(s => s.epithet.toLowerCase().includes(q)) : speciesList;
  }, [speciesList, sQuery]);

  const pickVariety = (v) => {
    onChange({ varietyId: v.id, varietyName: v.name, speciesId: null, speciesEpithet: '' });
    setVarietyOpen(false);
    setVQuery('');
  };

  const pickSpecies = (s) => {
    onChange({ ...value, speciesId: s.id, speciesEpithet: s.epithet });
    setSpeciesOpen(false);
    setSQuery('');
  };

  const handleCreateVariety = async () => {
    setErr('');
    if (!newVarietyName.trim()) return setErr('Name required');
    if (!/^[A-Z]{2,6}$/.test(newVarietyCode.trim().toUpperCase())) {
      return setErr('Code must be 2–6 uppercase letters');
    }
    setCreating(true);
    try {
      const v = await onCreateVariety({
        name: newVarietyName.trim(),
        code: newVarietyCode.trim().toUpperCase(),
      });
      pickVariety(v);
      setCreatingVariety(false);
      setNewVarietyName('');
      setNewVarietyCode('');
    } catch (e) {
      setErr(e.message || 'Failed to create variety');
    }
    setCreating(false);
  };

  const handleCreateSpecies = async (epithet) => {
    setErr('');
    if (!value?.varietyId) return setErr('Pick a variety first');
    if (!epithet.trim()) return setErr('Species name required');
    setCreating(true);
    try {
      const s = await onCreateSpecies({
        varietyId: value.varietyId,
        epithet: epithet.trim(),
      });
      pickSpecies(s);
    } catch (e) {
      setErr(e.message || 'Failed to create species');
    }
    setCreating(false);
  };

  return (
    <div className="space-y-3">
      {err && (
        <div className="text-xs text-red-700 bg-red-50 px-2 py-1 rounded">{err}</div>
      )}

      <div>
        <label className="text-sm font-medium text-gray-700 block mb-1.5">Variety *</label>
        <div className="relative">
          <button
            type="button"
            onClick={() => setVarietyOpen(o => !o)}
            className="input flex items-center justify-between text-left"
          >
            <span className={variety ? 'text-gray-900' : 'text-gray-400'}>
              {variety ? `${variety.name} (${variety.code})` : 'Select variety…'}
            </span>
            <ChevronDown className="w-4 h-4 text-gray-400 ml-2" />
          </button>
          {varietyOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setVarietyOpen(false)} />
              <div className="absolute z-20 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-72 overflow-hidden flex flex-col">
                <div className="p-2 border-b border-gray-100">
                  <input
                    autoFocus
                    value={vQuery}
                    onChange={(e) => setVQuery(e.target.value)}
                    placeholder="Search…"
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
                <div className="overflow-y-auto flex-1">
                  {filteredVarieties.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-gray-500">No matches</div>
                  ) : (
                    filteredVarieties.map(v => (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => pickVariety(v)}
                        className="w-full px-3 py-2 text-left text-sm hover:bg-emerald-50 flex items-center justify-between"
                      >
                        <span>{v.name}</span>
                        <span className="text-xs text-gray-500 font-mono">{v.code}</span>
                      </button>
                    ))
                  )}
                </div>
                {!creatingVariety ? (
                  <button
                    type="button"
                    onClick={() => { setCreatingVariety(true); setNewVarietyName(vQuery); }}
                    className="border-t border-gray-100 px-3 py-2 text-sm text-emerald-700 hover:bg-emerald-50 flex items-center gap-1.5 font-medium"
                  >
                    <Plus className="w-4 h-4" /> Add new variety
                  </button>
                ) : (
                  <div className="border-t border-gray-100 p-2 space-y-2 bg-gray-50">
                    <input
                      value={newVarietyName}
                      onChange={(e) => setNewVarietyName(e.target.value)}
                      placeholder="Genus name (e.g. Philodendron)"
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                    <input
                      value={newVarietyCode}
                      onChange={(e) => setNewVarietyCode(e.target.value.toUpperCase())}
                      placeholder="SKU prefix (2–6 letters, e.g. PHI)"
                      maxLength={6}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => { setCreatingVariety(false); setNewVarietyName(''); setNewVarietyCode(''); setErr(''); }}
                        className="flex-1 px-2 py-1.5 text-xs text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-100"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleCreateVariety}
                        disabled={creating}
                        className="flex-1 px-2 py-1.5 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 rounded flex items-center justify-center gap-1"
                      >
                        <Check className="w-3 h-3" /> Add
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div>
        <label className="text-sm font-medium text-gray-700 block mb-1.5">Species / cultivar *</label>
        <div className="relative">
          <button
            type="button"
            disabled={!value?.varietyId}
            onClick={() => setSpeciesOpen(o => !o)}
            className="input flex items-center justify-between text-left disabled:bg-gray-100 disabled:text-gray-400"
          >
            <span className={selectedSpecies ? 'text-gray-900' : 'text-gray-400'}>
              {selectedSpecies?.epithet || (value?.speciesEpithet) || (value?.varietyId ? 'Select species…' : 'Pick a variety first')}
            </span>
            <ChevronDown className="w-4 h-4 text-gray-400 ml-2" />
          </button>
          {speciesOpen && value?.varietyId && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setSpeciesOpen(false)} />
              <div className="absolute z-20 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-80 overflow-hidden flex flex-col">
                <div className="p-2 border-b border-gray-100 flex items-center gap-2">
                  <input
                    autoFocus
                    value={sQuery}
                    onChange={(e) => setSQuery(e.target.value)}
                    placeholder="Search or type a new species name…"
                    className="flex-1 px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && sQuery.trim()) {
                        const exact = filteredSpecies.find(s => s.epithet.toLowerCase() === sQuery.trim().toLowerCase());
                        if (exact) pickSpecies(exact);
                        else handleCreateSpecies(sQuery);
                      }
                    }}
                  />
                  {sQuery && (
                    <button
                      type="button"
                      onClick={() => setSQuery('')}
                      className="p-1 text-gray-400 hover:text-gray-700"
                      aria-label="Clear"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <div className="overflow-y-auto flex-1">
                  {filteredSpecies.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-gray-500">No matches — Enter to add as new</div>
                  ) : (
                    filteredSpecies.map(s => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => pickSpecies(s)}
                        className="w-full px-3 py-2 text-left text-sm hover:bg-emerald-50"
                      >
                        <div className="text-gray-900 truncate">{s.epithet}</div>
                        {s.commonName && <div className="text-xs text-gray-500 truncate">{s.commonName}</div>}
                      </button>
                    ))
                  )}
                </div>
                {sQuery.trim() && !filteredSpecies.some(s => s.epithet.toLowerCase() === sQuery.trim().toLowerCase()) && (
                  <button
                    type="button"
                    onClick={() => handleCreateSpecies(sQuery)}
                    disabled={creating}
                    className="border-t border-gray-100 px-3 py-2 text-sm text-emerald-700 hover:bg-emerald-50 flex items-center gap-1.5 font-medium disabled:opacity-50"
                  >
                    <Plus className="w-4 h-4" /> Add "{sQuery.trim()}" as new species
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
