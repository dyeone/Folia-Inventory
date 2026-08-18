import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { norm } from './sheetParsing.js';

// Manual-match control for one unmatched sheet row (Import / Update-from-
// list modals): the top fuzzy suggestions as one-tap chips, a searchable
// picker over the whole catalog, and the row's default action ("create as
// new species" or "skip") spelled out. Nothing applies without a tap —
// this exists because silent auto-creates turned near-miss names into
// duplicate catalog species.
//
// The parent owns the override value; search text is local (each row's
// picker is its own instance, so state resets naturally on unmount).
//   override: { speciesId } | { skip: true } | null
export function MatchPicker({ row, override, species, varietyById, defaultLabel, onOverride }) {
  const [search, setSearch] = useState('');

  const label = (s) => `${s.epithet}${varietyById.get(s.varietyId) ? ` (${varietyById.get(s.varietyId).name})` : ''}`;

  if (override?.speciesId) {
    const s = (species || []).find(x => x.id === override.speciesId);
    return (
      <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
        <Check className="w-3.5 h-3.5" /> {s ? label(s) : override.speciesId}
        <button type="button" onClick={() => onOverride(null)} className="p-1.5 -m-1 text-gray-400 hover:text-gray-700" aria-label="Undo match">
          <X className="w-3.5 h-3.5" />
        </button>
      </span>
    );
  }
  if (override?.skip) {
    return (
      <span className="inline-flex items-center gap-1 text-gray-400">
        skipped
        <button type="button" onClick={() => onOverride(null)} className="p-1.5 -m-1 hover:text-gray-700" aria-label="Undo skip">
          <X className="w-3.5 h-3.5" />
        </button>
      </span>
    );
  }

  const q = norm(search);
  const options = q
    ? (species || []).filter(s => norm(s.epithet).includes(q) || norm(s.commonName || '').includes(q)).slice(0, 8)
    : [];

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1 flex-wrap">
        {(row.suggestions || []).map(s => (
          <button
            key={s.id}
            type="button"
            onClick={() => onOverride({ speciesId: s.id })}
            className="px-2 py-1 rounded bg-sky-50 text-sky-700 text-xs font-medium hover:bg-sky-100"
          >
            {label(s)}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onOverride({ skip: true })}
          className="px-2 py-1 rounded text-xs text-gray-400 hover:text-gray-700 hover:bg-gray-100"
        >
          skip
        </button>
        {defaultLabel && <span className="text-[10px] text-gray-400">unmatched → {defaultLabel}</span>}
      </div>
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search all species…"
        className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded focus:outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
      />
      {options.length > 0 && (
        <div className="border border-gray-200 rounded divide-y divide-gray-100 max-h-28 overflow-y-auto">
          {options.map(s => (
            <button
              key={s.id}
              type="button"
              onClick={() => { onOverride({ speciesId: s.id }); setSearch(''); }}
              className="w-full text-left px-2 py-1.5 text-xs hover:bg-sky-50"
            >
              {label(s)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
