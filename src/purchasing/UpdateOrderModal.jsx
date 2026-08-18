import { useEffect, useMemo, useRef, useState } from 'react';
import { Upload, Check, AlertCircle, Loader2, FileSpreadsheet } from 'lucide-react';
import { api } from '../api.js';
import { Modal } from '../ui/Modal.jsx';
import { DEFAULT_ADD_VARIETY } from '../constants.js';
import { readSheetGrid, parseOrderRows, buildMatchContext, matchSheetRow, mergeDuplicateRows, MAX_QTY, MAX_NAME_LEN, MASS_CREATE_WARN } from './sheetParsing.js';

// Re-sync an EXISTING purchase order to a revised supplier list (admin's
// Wholesale tab). Drop the new .xlsx/.csv and the modal previews the diff
// against the order's current lines before anything is written:
//   - species already on the order  → quantity/price update (never below
//     what the packer has already received — clamped with a visible note)
//   - species not on the order      → new line (species auto-created, same
//     rules as the import modal)
//   - lines missing from the sheet  → kept by default; opt in to remove
//     them (lines with received items are always kept)
// Parsing + matching is byte-for-byte the import modal's (sheetParsing.js).

export function UpdateOrderModal({ po, species, varieties, showToast, onClose, onUpdated, onSpeciesChanged }) {
  const [existingLines, setExistingLines] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [fileName, setFileName] = useState('');
  const [baseRows, setBaseRows] = useState(null);
  const [parseErr, setParseErr] = useState('');
  const [noQtyColumn, setNoQtyColumn] = useState(false);
  const [removeMissing, setRemoveMissing] = useState(false);
  const [defaultVarietyId, setDefaultVarietyId] = useState(() => {
    const list = varieties || [];
    const dflt = list.find(v => v.name.trim().toLowerCase() === DEFAULT_ADD_VARIETY);
    return (dflt || list[0])?.id || '';
  });
  const [applying, setApplying] = useState(false);
  const fileRef = useRef(null);
  const busyRef = useRef(false);

  // The diff must be against the order as it is NOW (the card's copy can be
  // stale — a packer may have received since it expanded), so fetch fresh.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { lines } = await api.getPurchaseOrder(po.id);
        if (!cancelled) setExistingLines(lines || []);
      } catch (e) {
        if (!cancelled) setLoadErr(e.message || 'Could not load the order lines.');
      }
    })();
    return () => { cancelled = true; };
  }, [po.id]);

  const matchCtx = useMemo(() => buildMatchContext(species, varieties), [species, varieties]);
  const { varietyById } = matchCtx;
  const speciesById = useMemo(() => new Map((species || []).map(s => [s.id, s])), [species]);
  const lineBySpecies = useMemo(
    () => new Map((existingLines || []).map(l => [l.speciesId, l])),
    [existingLines],
  );

  const handleFile = async (file) => {
    setParseErr('');
    setBaseRows(null);
    setNoQtyColumn(false);
    if (!file) return;
    setFileName(file.name);
    try {
      const { rows: parsed, noQtyColumn: noQty } = parseOrderRows(await readSheetGrid(file));
      setNoQtyColumn(noQty);
      setBaseRows(parsed);
    } catch (e) {
      setParseErr(e.message || 'Could not read that file.');
    }
  };

  // Match + fold duplicates (shared plumbing), then classify each usable
  // row against the order's current lines: add / update / no change.
  const rows = useMemo(() => {
    if (!baseRows) return null;
    const out = mergeDuplicateRows(
      baseRows.map(r => (r.status ? { ...r } : { ...r, ...matchSheetRow(r, matchCtx, defaultVarietyId) })),
    );
    for (const r of out) {
      if (r.status === 'create') { r.change = 'add'; continue; }
      if (r.status !== 'matched') continue;
      const line = lineBySpecies.get(r.speciesId);
      if (!line) { r.change = 'add'; continue; }
      const received = line.quantityReceived || 0;
      const newQty = Math.max(r.qty, received);
      r.clamped = r.qty < received;
      r.oldQty = line.quantityOrdered;
      r.newQty = newQty;
      r.oldPrice = line.unitWholesalePrice != null ? Number(line.unitWholesalePrice) : null;
      const priceChanges = r.price != null && r.oldPrice != null && r.price !== r.oldPrice;
      r.change = newQty !== line.quantityOrdered || priceChanges ? 'update' : 'same';
    }
    return out;
  }, [baseRows, defaultVarietyId, matchCtx, lineBySpecies]);

  const counts = useMemo(() => {
    const c = { add: 0, update: 0, same: 0, create: 0, skipped: 0 };
    for (const r of rows || []) {
      if (r.change === 'add') { c.add += 1; if (r.status === 'create') c.create += 1; }
      else if (r.change === 'update') c.update += 1;
      else if (r.change === 'same') c.same += 1;
      else c.skipped += 1;
    }
    return c;
  }, [rows]);

  // Existing lines the sheet doesn't mention — the "what happens to these"
  // section. Only matched rows can point at existing lines.
  const missingLines = useMemo(() => {
    if (!rows || !existingLines) return [];
    const inSheet = new Set(rows.filter(r => r.status === 'matched').map(r => r.speciesId));
    return existingLines.filter(l => !inSheet.has(l.speciesId));
  }, [rows, existingLines]);

  const usable = (rows || []).filter(r => r.status === 'matched' || r.status === 'create');

  const apply = async () => {
    if (busyRef.current || applying || !usable.length) return;
    const createCount = usable.filter(r => r.status === 'create').length;
    if (createCount > MASS_CREATE_WARN) {
      const sure = window.confirm(
        `This update creates ${createCount} NEW species in the catalog. That many usually means a wrong column was read as the plant name — check the preview. Create them anyway?`,
      );
      if (!sure) return;
    }
    busyRef.current = true;
    setApplying(true);
    let res;
    try {
      res = await api.updatePurchaseOrderLines({
        id: po.id,
        removeMissing,
        lines: usable.map(r => (r.status === 'matched'
          ? {
              speciesId: r.speciesId,
              quantityOrdered: r.qty,
              unitWholesalePrice: r.price ?? undefined,
            }
          : {
              createSpecies: { varietyId: r.varietyId, epithet: r.species, wholesalePrice: r.price ?? undefined },
              quantityOrdered: r.qty,
              unitWholesalePrice: r.price ?? undefined,
            })),
      });
    } catch (e) {
      showToast?.(`Update failed: ${e.message || 'unknown error'} — re-upload the same sheet to converge`, 'error');
      busyRef.current = false;
      setApplying(false);
      return;
    }
    // The write is committed — refresh hiccups after it must never present
    // as a failed update ("re-upload to converge" on a saved order misleads).
    // New species minted server-side need to land in app state before the
    // refreshed lines render, or they'd show as unknown species.
    if (res.createdSpeciesCount) {
      try { await onSpeciesChanged?.(); } catch { /* summary below still reports the save */ }
    }
    const kept = (res.keptMissingSpeciesIds || []).length;
    // App's showToast is (msg, type) — 'error' renders red, anything else
    // is the neutral toast. No duration parameter exists.
    showToast?.(
      `Order updated — ${res.addedCount} added, ${res.updatedCount} changed`
      + (res.removedCount ? `, ${res.removedCount} removed` : '')
      + (res.clampedCount ? ` · ${res.clampedCount} kept at the received count` : '')
      + (removeMissing && kept ? ` · ${kept} kept (has received items)` : '')
      + (res.poFlippedToReceived ? ' · order is now fully received' : ''),
    );
    onUpdated?.();
    onClose();
  };

  const changeChip = (r) => {
    switch (r.change) {
      case 'add':
        return r.status === 'create'
          ? (
            <span className="text-sky-700 bg-sky-50 px-1.5 py-0.5 rounded text-[11px] font-semibold" title={r.viaDefault ? 'Not in the catalog and no variety column — created under the genus chosen below' : 'Created under the variety named on this row'}>
              add · new species → {varietyById.get(r.varietyId)?.name || '?'}
            </span>
          )
          : <span className="text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded text-[11px] font-semibold">add line</span>;
      case 'update':
        return (
          <span className="text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded text-[11px] font-semibold">
            update{r.clamped ? ' · kept at received' : ''}
          </span>
        );
      case 'same':
        return <span className="text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded text-[11px] font-semibold">no change</span>;
      default:
        break;
    }
    switch (r.status) {
      case 'ambiguous': return <span className="text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded text-[11px] font-semibold" title="This name exists in more than one variety (and not the default one) — add a variety column to pick one">ambiguous — skipped</span>;
      case 'duplicate': return (
        <span className="text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded text-[11px] font-semibold" title="Same species appears earlier in the sheet — quantities were combined into that row">
          duplicate — qty merged{r.priceConflict ? ' · price differs, first used' : ''}
        </span>
      );
      case 'bad-qty':   return <span className="text-red-700 bg-red-50 px-1.5 py-0.5 rounded text-[11px] font-semibold" title={`Quantity is 0 or over ${MAX_QTY} — fix the cell and re-upload`}>qty looks wrong — skipped</span>;
      case 'bad-name':  return <span className="text-red-700 bg-red-50 px-1.5 py-0.5 rounded text-[11px] font-semibold" title={`Name is over ${MAX_NAME_LEN} characters — fix the cell and re-upload`}>name too long — skipped</span>;
      case 'unknown-variety': return <span className="text-red-700 bg-red-50 px-1.5 py-0.5 rounded text-[11px] font-semibold" title="This row names a variety that isn't in the catalog — add the variety first, or clear the cell to use the default genus">unknown variety — skipped</span>;
      default:          return <span className="text-red-700 bg-red-50 px-1.5 py-0.5 rounded text-[11px] font-semibold">no match — skipped</span>;
    }
  };

  const qtyCell = (r) => {
    if (r.change === 'update' || r.change === 'same') {
      if (r.newQty !== r.oldQty) {
        return <span><span className="text-gray-400 line-through mr-1">{r.oldQty}</span><span className="font-semibold">{r.newQty}</span></span>;
      }
      return String(r.oldQty);
    }
    return String(r.qty);
  };

  const priceCell = (r) => {
    if (r.change === 'update' || r.change === 'same') {
      if (r.price != null && r.oldPrice != null && r.price !== r.oldPrice) {
        return <span><span className="text-gray-400 line-through mr-1">${r.oldPrice.toFixed(2)}</span><span className="font-semibold">${r.price.toFixed(2)}</span></span>;
      }
      return r.oldPrice != null ? `$${r.oldPrice.toFixed(2)}` : '—';
    }
    if (r.price != null) return `$${r.price.toFixed(2)}`;
    if (r.status === 'matched') {
      const cat = speciesById.get(r.speciesId)?.wholesalePrice;
      return cat != null ? `$${Number(cat).toFixed(2)} (catalog)` : '$0.00 ⚠ no price';
    }
    if (r.status === 'create') return '$0.00 ⚠ no price';
    return '—';
  };

  const rowTint = (r) => {
    if (r.change) return r.change === 'same' ? 'text-gray-400' : '';
    if (r.status === 'duplicate') return 'bg-gray-50 text-gray-400';
    if (r.status === 'ambiguous') return 'bg-amber-50/60';
    return 'bg-red-50/60';
  };

  const missingLabel = (l) => {
    const sp = speciesById.get(l.speciesId);
    const vName = sp ? varietyById.get(sp.varietyId)?.name : '';
    return `${vName ? `${vName} · ` : ''}${sp?.epithet || '(unknown species)'}`;
  };

  return (
    <Modal
      title="Update order from list"
      onClose={applying
        ? () => showToast?.('Update in progress — hang tight')
        : onClose}
      size="lg"
    >
      <div className="space-y-3">
        <div className="text-xs text-gray-500">
          {po.supplier ? `${po.supplier} · ` : ''}{new Date(po.createdAt).toISOString().slice(0, 10)}
          {' · '}<span className="capitalize">{po.status}</span>
          {' — upload the supplier’s revised list; nothing changes until you apply the preview below.'}
        </div>

        {loadErr ? (
          <div className="flex items-center gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
            <AlertCircle className="w-4 h-4 shrink-0" /> {loadErr}
          </div>
        ) : existingLines === null ? (
          <div className="p-6 text-center text-sm text-gray-500">
            <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading current lines…
          </div>
        ) : (
          <>
            <div
              className="border-2 border-dashed border-gray-300 rounded-xl p-4 text-center hover:border-emerald-400 transition cursor-pointer"
              onClick={() => !applying && fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (!applying) handleFile(e.dataTransfer.files?.[0]);
              }}
            >
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(e) => {
                  handleFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
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
                  Drop the revised list here (.xlsx / .csv)
                  <div className="text-xs text-gray-400 mt-1">Columns: species (required) · variety · qty · price</div>
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
                {noQtyColumn && (
                  <div className="flex items-center gap-2 bg-amber-50 text-amber-800 text-xs px-3 py-2 rounded-lg">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    No quantity column found — every row counts as 1 plant. Add a "qty" column if that's wrong.
                  </div>
                )}
                <div className="flex items-center gap-2 text-xs flex-wrap">
                  <span className="font-semibold text-gray-700">{rows.length} rows:</span>
                  {counts.add > 0 && <span className="text-emerald-700">{counts.add} added</span>}
                  {counts.create > 0 && (
                    <span className={counts.create > MASS_CREATE_WARN ? 'text-red-700 font-bold' : 'text-sky-700'}>
                      {counts.create} new species{counts.create > MASS_CREATE_WARN ? ' ⚠' : ''}
                    </span>
                  )}
                  {counts.update > 0 && <span className="text-blue-700">{counts.update} changed</span>}
                  {counts.same > 0 && <span className="text-gray-500">{counts.same} unchanged</span>}
                  {counts.skipped > 0 && <span className="text-red-700">{counts.skipped} skipped</span>}
                </div>
                {counts.create > 0 && (
                  <label className="flex items-center gap-2 text-xs text-gray-700 bg-sky-50 border border-sky-200 rounded-lg px-3 py-2">
                    <span className="font-medium shrink-0">File new species under</span>
                    <select
                      value={defaultVarietyId}
                      onChange={(e) => setDefaultVarietyId(e.target.value)}
                      className="input !py-1.5 text-sm flex-1"
                    >
                      {(varieties || []).map(v => (
                        <option key={v.id} value={v.id}>{v.name} ({v.code})</option>
                      ))}
                    </select>
                    <span className="text-gray-500 shrink-0 hidden sm:inline">rows with their own variety column keep it</span>
                  </label>
                )}
                <div className="border border-gray-200 rounded-xl overflow-hidden">
                  <div className="max-h-56 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 sticky top-0">
                        <tr className="text-left text-gray-500">
                          <th className="px-2.5 py-1.5 font-medium">Species</th>
                          <th className="px-2.5 py-1.5 font-medium text-right">Qty</th>
                          <th className="px-2.5 py-1.5 font-medium text-right">Price</th>
                          <th className="px-2.5 py-1.5 font-medium">Change</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r, i) => (
                          <tr key={i} className={`border-t border-gray-100 ${rowTint(r)}`}>
                            <td className="px-2.5 py-1.5 text-gray-900">{r.species}</td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums">{qtyCell(r)}</td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums">{priceCell(r)}</td>
                            <td className="px-2.5 py-1.5">{changeChip(r)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {missingLines.length > 0 && (
                  <div className="border border-gray-200 rounded-xl p-3 space-y-2">
                    <div className="text-xs font-semibold text-gray-700">
                      {missingLines.length} line{missingLines.length === 1 ? '' : 's'} on the order but not in this list
                    </div>
                    <div className="max-h-28 overflow-y-auto space-y-1">
                      {missingLines.map(l => (
                        <div key={l.id} className="flex items-center gap-2 text-xs">
                          <span className="text-gray-900 truncate">{missingLabel(l)}</span>
                          <span className="text-gray-500 shrink-0">×{l.quantityOrdered}</span>
                          {l.quantityReceived > 0 ? (
                            <span className="ml-auto shrink-0 text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded text-[11px] font-semibold" title="Lines with received items are never removed by an update">
                              {l.quantityReceived} received — kept
                            </span>
                          ) : removeMissing ? (
                            <span className="ml-auto shrink-0 text-red-700 bg-red-50 px-1.5 py-0.5 rounded text-[11px] font-semibold">will be removed</span>
                          ) : (
                            <span className="ml-auto shrink-0 text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded text-[11px] font-semibold">kept</span>
                          )}
                        </div>
                      ))}
                    </div>
                    <label className="flex items-start gap-2 text-sm text-gray-800 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={removeMissing}
                        onChange={(e) => setRemoveMissing(e.target.checked)}
                        className="rounded border-gray-300 mt-0.5"
                      />
                      <span>
                        Remove lines that aren't in the new list
                        <span className="block text-xs text-gray-500">Lines with received items are always kept — cancel the receive first if they really shouldn't exist.</span>
                      </span>
                    </label>
                  </div>
                )}
              </>
            )}

            <div className="flex items-center gap-2 justify-end pt-1">
              {applying && (
                <span className="mr-auto text-xs text-gray-500 flex items-center gap-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Applying…
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
                disabled={applying || !usable.length}
                className="px-4 py-3 text-base font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl flex items-center gap-1.5 disabled:bg-gray-200 disabled:text-gray-500"
              >
                {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                {applying
                  ? 'Applying…'
                  : `Apply — ${counts.add} added · ${counts.update} changed${removeMissing ? ` · ${missingLines.filter(l => !l.quantityReceived).length} removed` : ''}`}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
