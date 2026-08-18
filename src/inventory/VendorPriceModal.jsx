import { useCallback, useMemo, useRef, useState } from 'react';
import { Upload, Check, AlertCircle, Loader2, FileSpreadsheet, ArrowRight, X } from 'lucide-react';
import { api } from '../api.js';
import { Modal } from '../ui/Modal.jsx';
import { norm, readSheetGrid, splitGrid, buildMatchContext, buildSuggestIndex, suggest, MAX_NAME_LEN } from '../purchasing/sheetParsing.js';

// Vendor price-list update: the vendor re-priced, so upload their new list
// and refresh the catalog's WHOLESALE prices. Exact species matches apply
// automatically (with old → new shown per row); everything else gets a
// manual-match row — best fuzzy guesses as one-tap chips plus a full
// searchable species picker — or an explicit skip. Only the catalog's
// species.wholesalePrice moves: costs already recorded on purchased items
// are history and never rewritten. New prices take effect wherever the
// catalog price is read — PO drafting, order imports, and receiving's
// price fallback.

const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);

// Fuzzy matching (buildSuggestIndex/suggest) lives in sheetParsing.js —
// shared with the order modals' manual-match pickers.

export function VendorPriceModal({ species, varieties, showToast, onClose, onSpeciesChanged }) {
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState(null);
  const [parseErr, setParseErr] = useState('');
  const [manual, setManual] = useState({});   // row index → speciesId | '' (skip)
  const [search, setSearch] = useState({});   // row index → picker filter text
  const [applying, setApplying] = useState(false);
  const fileRef = useRef(null);
  const busyRef = useRef(false);

  const speciesById = useMemo(() => new Map((species || []).map(s => [s.id, s])), [species]);
  // Same catalog lookups every sheet flow uses — one home (sheetParsing.js)
  // so the exact-match rules can't drift from the order modals'.
  const { speciesIndex, varietyByName, varietyById } = useMemo(
    () => buildMatchContext(species, varieties),
    [species, varieties],
  );

  const handleFile = async (file) => {
    setParseErr('');
    setRows(null);
    setManual({});
    setSearch({});
    if (!file) return;
    setFileName(file.name);
    try {
      const nonEmpty = await readSheetGrid(file);
      // Headerless price lists: species, price — in that order. splitGrid
      // owns the empty/row-cap guards (shared with the order modals).
      const { cols, dataRows } = splitGrid(nonEmpty, { species: 0, price: 1 });
      if (cols.price === undefined) {
        setParseErr('No price column found — the sheet needs a price / 单价 column.');
        return;
      }
      const suggestIndex = buildSuggestIndex(species);

      const parsed = dataRows
        .map((r, i) => {
          const name = String(r[cols.species] ?? '').trim();
          if (!name) return null;
          const priceRaw = String(r[cols.price] ?? '').replace(/[$¥￥,\s]/g, '');
          const price = priceRaw === '' ? NaN : parseFloat(priceRaw);
          const row = {
            row: i + 1,
            species: name,
            variety: cols.variety !== undefined ? String(r[cols.variety] ?? '').trim() : '',
            price,
          };
          if (!Number.isFinite(price) || price < 0 || price > 100000 || name.length > MAX_NAME_LEN) {
            return { ...row, status: 'bad-row' };
          }
          // Exact match: epithet (case-insensitive), narrowed by the
          // variety column when it names a variety we know.
          const candidates = speciesIndex.get(norm(name)) || [];
          const wantVariety = row.variety ? varietyByName.get(norm(row.variety)) : null;
          const narrowed = wantVariety ? candidates.filter(s => s.varietyId === wantVariety.id) : candidates;
          if (narrowed.length === 1) return { ...row, status: 'matched', speciesId: narrowed[0].id };
          // Ambiguous or unmatched → manual review with suggestions.
          return { ...row, status: 'review', suggestions: suggest(name, suggestIndex) };
        })
        .filter(Boolean);
      if (!parsed.length) { setParseErr('No usable rows found — is there a species/name column?'); return; }

      // Same species listed twice: last price wins, earlier rows are noted.
      const lastByKey = new Map();
      for (const r of parsed) if (r.status === 'matched') lastByKey.set(r.speciesId, r.row);
      for (const r of parsed) {
        if (r.status === 'matched' && lastByKey.get(r.speciesId) !== r.row) r.status = 'superseded';
      }
      setRows(parsed);
    } catch (e) {
      setParseErr(e.message || 'Could not read that file.');
    }
  };

  // A review row's effective pick: the user's manual choice ('' = skip).
  const pickFor = useCallback((i) => (i in manual ? manual[i] : null), [manual]);

  const resolution = useMemo(() => {
    const updates = [];   // { speciesId, price, name }
    let unresolved = 0;
    (rows || []).forEach((r, i) => {
      if (r.status === 'matched') updates.push({ speciesId: r.speciesId, price: r.price, name: r.species });
      else if (r.status === 'review') {
        const pick = pickFor(i);
        if (pick) updates.push({ speciesId: pick, price: r.price, name: r.species });
        else if (pick !== '') unresolved += 1;
      }
    });
    // Manual picks can collide with auto matches or each other — last wins,
    // consistent with the duplicate rule above.
    const byId = new Map();
    for (const u of updates) byId.set(u.speciesId, u);
    return { updates: [...byId.values()], unresolved };
  }, [rows, pickFor]);

  const changed = resolution.updates.filter(u => {
    const cur = speciesById.get(u.speciesId)?.wholesalePrice;
    return cur == null || Number(cur) !== u.price;
  });

  const apply = async () => {
    if (busyRef.current || applying || !changed.length) return;
    busyRef.current = true;
    setApplying(true);
    let updated;
    try {
      updated = await api.bulkSpeciesPrices(changed.map(u => ({ id: u.speciesId, wholesalePrice: u.price })));
    } catch (e) {
      showToast?.(e.message || 'Price update failed — nothing may have been saved', 'error');
      busyRef.current = false;
      setApplying(false);
      return;
    }
    // The write is committed — a refresh hiccup after it must never present
    // as a failed save (an admin would "fix" prices that already saved).
    try { await onSpeciesChanged?.(); } catch { /* toast below still reports the save */ }
    showToast?.(
      `Updated ${updated} wholesale price${updated === 1 ? '' : 's'}`
      + (resolution.unresolved ? ` — ${resolution.unresolved} row${resolution.unresolved === 1 ? '' : 's'} left unmatched` : ''),
    );
    onClose();
  };

  const speciesLabel = (s) => `${s.epithet}${varietyById.get(s.varietyId) ? ` (${varietyById.get(s.varietyId).name})` : ''}`;

  const reviewPicker = (r, i) => {
    const pick = pickFor(i);
    if (pick) {
      const s = speciesById.get(pick);
      return (
        <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
          <Check className="w-3.5 h-3.5" /> {s ? speciesLabel(s) : pick}
          <button type="button" onClick={() => setManual(m => ({ ...m, [i]: null }))} className="p-1.5 -m-1 text-gray-400 hover:text-gray-700" aria-label="Undo match">
            <X className="w-3.5 h-3.5" />
          </button>
        </span>
      );
    }
    if (pick === '') {
      return (
        <span className="inline-flex items-center gap-1 text-gray-400">
          skipped
          <button type="button" onClick={() => setManual(m => ({ ...m, [i]: null }))} className="p-1.5 -m-1 hover:text-gray-700" aria-label="Undo skip">
            <X className="w-3.5 h-3.5" />
          </button>
        </span>
      );
    }
    const q = norm(search[i] || '');
    const options = q
      ? (species || []).filter(s => norm(s.epithet).includes(q) || norm(s.commonName || '').includes(q)).slice(0, 8)
      : [];
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1 flex-wrap">
          {(r.suggestions || []).map(s => (
            <button
              key={s.id}
              type="button"
              onClick={() => setManual(m => ({ ...m, [i]: s.id }))}
              className="px-2 py-1 rounded bg-sky-50 text-sky-700 text-xs font-medium hover:bg-sky-100"
            >
              {speciesLabel(s)}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setManual(m => ({ ...m, [i]: '' }))}
            className="px-2 py-1 rounded text-xs text-gray-400 hover:text-gray-700 hover:bg-gray-100"
          >
            skip
          </button>
        </div>
        <input
          type="text"
          value={search[i] || ''}
          onChange={(e) => setSearch(s => ({ ...s, [i]: e.target.value }))}
          placeholder="Search all species…"
          className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded focus:outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
        />
        {options.length > 0 && (
          <div className="border border-gray-200 rounded divide-y divide-gray-100 max-h-28 overflow-y-auto">
            {options.map(s => (
              <button
                key={s.id}
                type="button"
                onClick={() => { setManual(m => ({ ...m, [i]: s.id })); setSearch(sr => ({ ...sr, [i]: '' })); }}
                className="w-full text-left px-2 py-1.5 text-xs hover:bg-sky-50"
              >
                {speciesLabel(s)} <span className="text-gray-400">· now {money(s.wholesalePrice)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  const statusCell = (r, i) => {
    if (r.status === 'matched') {
      const s = speciesById.get(r.speciesId);
      const old = s?.wholesalePrice;
      const same = old != null && Number(old) === r.price;
      return (
        <span className={`inline-flex items-center gap-1 ${same ? 'text-gray-400' : 'text-emerald-700'}`}>
          <Check className="w-3.5 h-3.5" /> {s ? speciesLabel(s) : ''}
          <span className="tabular-nums">{money(old)}</span>
          <ArrowRight className="w-3 h-3" />
          <span className="tabular-nums font-semibold">{money(r.price)}</span>
          {same && <span>(no change)</span>}
        </span>
      );
    }
    if (r.status === 'superseded') return <span className="text-gray-400">re-listed below — later row wins</span>;
    if (r.status === 'bad-row') return <span className="text-red-600">bad price or name — skipped</span>;
    return reviewPicker(r, i);
  };

  const reviewCount = (rows || []).filter(r => r.status === 'review').length;

  return (
    <Modal
      title="Update vendor prices"
      onClose={applying
        ? () => showToast?.('Price update in progress — hang tight')
        : onClose}
      size="lg"
    >
      <div className="space-y-3">
        <div
          className="border-2 border-dashed border-gray-300 rounded-xl p-4 text-center hover:border-emerald-400 transition cursor-pointer"
          onClick={() => !applying && fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); if (!applying) handleFile(e.dataTransfer.files?.[0]); }}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ''; }}
          />
          {fileName ? (
            <div className="flex items-center justify-center gap-2 text-sm text-gray-800">
              <FileSpreadsheet className="w-5 h-5 text-emerald-600" />
              <span className="font-medium">{fileName}</span>
              <span className="text-gray-400">— tap to change</span>
            </div>
          ) : (
            <div className="text-sm text-gray-600">
              <Upload className="w-6 h-6 mx-auto mb-1 text-gray-400" />
              Drop the vendor's new price list here (.xlsx / .csv)
              <div className="text-xs text-gray-400 mt-1">Columns: species (required) · price (required) · variety</div>
            </div>
          )}
        </div>

        {parseErr && (
          <div className="flex items-center gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
            <AlertCircle className="w-4 h-4 shrink-0" /> {parseErr}
          </div>
        )}

        {rows && (
          <>
            <div className="flex items-center gap-2 text-xs flex-wrap">
              <span className="font-semibold text-gray-700">{rows.length} rows:</span>
              <span className="text-emerald-700">{rows.filter(r => r.status === 'matched').length} matched</span>
              {reviewCount > 0 && <span className="text-amber-700 font-semibold">{reviewCount} need a manual match below</span>}
              <span className="ml-auto font-semibold text-gray-900">
                {changed.length} price{changed.length === 1 ? '' : 's'} will change
              </span>
            </div>
            <div className="border border-gray-200 rounded-xl overflow-hidden">
              <div className="max-h-72 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr className="text-left text-gray-500">
                      <th className="px-2.5 py-1.5 font-medium">Sheet name</th>
                      <th className="px-2.5 py-1.5 font-medium text-right">New price</th>
                      <th className="px-2.5 py-1.5 font-medium w-1/2">Match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className={`border-t border-gray-100 align-top ${
                        r.status === 'review' && pickFor(i) == null ? 'bg-amber-50/60' : ''
                      }`}>
                        <td className="px-2.5 py-1.5 text-gray-900">
                          {r.species}
                          {r.variety ? <span className="text-gray-400"> · {r.variety}</span> : ''}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums font-semibold">{money(r.price)}</td>
                        <td className="px-2.5 py-1.5">{statusCell(r, i)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        <div className="flex items-center gap-2 justify-end pt-1">
          {applying && (
            <span className="mr-auto text-xs text-gray-500 flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Updating {changed.length} prices…
            </span>
          )}
          {!applying && resolution.unresolved > 0 && (
            <span className="mr-auto text-xs text-amber-700">
              {resolution.unresolved} unmatched row{resolution.unresolved === 1 ? '' : 's'} will be left out — match or skip them above.
            </span>
          )}
          <button
            onClick={onClose}
            disabled={applying}
            className="px-4 py-3 text-base font-medium text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={apply}
            disabled={applying || !changed.length}
            className="px-4 py-3 text-base font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl flex items-center gap-1.5 disabled:bg-gray-200 disabled:text-gray-500"
          >
            {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            Update {changed.length} price{changed.length === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
