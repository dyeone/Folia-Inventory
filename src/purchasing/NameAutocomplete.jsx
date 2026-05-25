import { useEffect, useMemo, useRef, useState } from 'react';

// Inline autocomplete dropdown for plant-name fields in the create-plant
// modal. Wraps a single input (epithet OR commonName) and renders a
// floating menu of matching existing plants while the user types.
//
// Matching is case-insensitive substring on epithet OR commonName,
// restricted to the variety the caller scopes via `candidates`. Prefix
// matches on the field the user is typing into rank first; substring
// matches come next; ties break alphabetically by epithet.
//
// Props:
//   value          — current input value (the parent owns the input state)
//   onChange(v)    — input change handler
//   onPick(species)— called with the full species object when a row is picked
//   candidates     — array of { id, epithet, commonName, varietyId, ... } scoped to variety
//   matchField     — 'epithet' | 'commonName' — used for prefix-ranking only
//   inputProps     — additional props spread onto the <input> (className, placeholder, etc.)
//   disabled       — when true, no dropdown shown (e.g. edit mode)

const MIN_CHARS = 2;
const MAX_RESULTS = 5;

export function NameAutocomplete({ value, onChange, onPick, candidates, matchField, inputProps, disabled }) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapperRef = useRef(null);

  const matches = useMemo(() => {
    if (disabled) return [];
    const q = (value || '').trim().toLowerCase();
    if (q.length < MIN_CHARS) return [];
    const list = candidates || [];
    const scored = [];
    for (const s of list) {
      const ep = (s.epithet || '').toLowerCase();
      const cn = (s.commonName || '').toLowerCase();
      const inEp = ep.includes(q);
      const inCn = cn.includes(q);
      if (!inEp && !inCn) continue;
      // Rank: prefix on the matchField field = 0; prefix on the other field = 1;
      // substring-only = 2. Lower is better.
      const primary = matchField === 'epithet' ? ep : cn;
      const secondary = matchField === 'epithet' ? cn : ep;
      let rank;
      if (primary.startsWith(q)) rank = 0;
      else if (secondary.startsWith(q)) rank = 1;
      else rank = 2;
      scored.push({ species: s, rank });
    }
    scored.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return (a.species.epithet || '').localeCompare(b.species.epithet || '');
    });
    return scored.slice(0, MAX_RESULTS).map(x => x.species);
  }, [value, candidates, matchField, disabled]);

  // Keep highlight bounded as the match set shrinks; no effect needed —
  // the keyboard handler reads `safeHighlight` for Enter, and the list
  // renders with `i === safeHighlight`. If the user keeps typing the
  // highlight stays where they put it, clamped to the visible range.
  const safeHighlight = matches.length === 0
    ? 0
    : Math.min(Math.max(highlight, 0), matches.length - 1);

  // Close the dropdown when clicking outside the wrapper.
  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  const visible = open && matches.length > 0;

  const pick = (s) => {
    setOpen(false);
    onPick?.(s);
  };

  const onKeyDown = (e) => {
    if (!visible) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight(h => Math.min(matches.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(h => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(matches[safeHighlight]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      <input
        {...(inputProps || {})}
        value={value}
        onChange={(e) => { onChange?.(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {visible && (
        <div className="absolute left-0 right-0 top-full mt-1 z-10 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
          {matches.map((s, i) => (
            <button
              key={s.id}
              type="button"
              // onMouseDown so the pick fires before the input's blur closes us.
              onMouseDown={(e) => { e.preventDefault(); pick(s); }}
              onMouseEnter={() => setHighlight(i)}
              className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${
                i === safeHighlight ? 'bg-emerald-50' : 'bg-white hover:bg-gray-50'
              }`}
            >
              <span className="font-medium text-gray-900">{s.epithet}</span>
              {s.commonName && (
                <span className="text-gray-500">({s.commonName})</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
