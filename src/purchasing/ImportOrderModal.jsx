import { useMemo, useRef, useState } from 'react';
import { Upload, Check, AlertCircle, Loader2, FileSpreadsheet } from 'lucide-react';
import { api } from '../api.js';
import { Modal } from '../ui/Modal.jsx';
import { DEFAULT_ADD_VARIETY } from '../constants.js';
import { readSheetGrid, parseOrderRows, buildMatchContext, matchSheetRow, mergeDuplicateRows, buildSuggestIndex, suggest, MAX_QTY, MAX_NAME_LEN, MASS_CREATE_WARN } from './sheetParsing.js';
import { MatchPicker } from './MatchPicker.jsx';

// Rows the auto-matcher couldn't bind to an existing species — each gets a
// manual-match picker so a near-miss name lands on the right species
// instead of silently becoming a duplicate catalog entry.
const REVIEWABLE = new Set(['create', 'ambiguous', 'unknown-variety', 'unmatched']);

// Wholesale order upload (admin's Orders pane — managing the wholesale
// list is the admin's job; the packer's receiving screen only shows the
// result). Drop the supplier's list (.xlsx or .csv) and get a purchase
// order out of it — matched to the catalog, one line per species —
// optionally marked "ordered" so it shows on the packer's receiving screen
// for counting + labeling.
//
// Expected columns (headers matched loosely, order doesn't matter):
//   species / name / plant       required — the species or cultivar name
//   variety / genus              optional — narrows the match, and lets a
//                                brand-new species be auto-created under it
//   qty / quantity / count       optional — defaults to 1
//   price / cost / wholesale     optional — per-plant wholesale price;
//                                falls back to the species' saved price
// A headerless sheet is treated as [species, qty, price].

// Parsing plumbing (charset-safe CSV decode, header aliases incl. Chinese,
// size rails) is shared with VendorPriceModal — see sheetParsing.js.

export function ImportOrderModal({ species, varieties, showToast, onClose, onCreated }) {
  const [fileName, setFileName] = useState('');
  const [baseRows, setBaseRows] = useState(null); // parsed rows, pre-matching
  const [parseErr, setParseErr] = useState('');
  // Where new species land when the sheet has no (or an unknown-to-us)
  // variety column. Defaults to the shop's main genus — same constant the
  // Add form uses — so a plain list of names imports without ceremony.
  const [defaultVarietyId, setDefaultVarietyId] = useState(() => {
    const list = varieties || [];
    const dflt = list.find(v => v.name.trim().toLowerCase() === DEFAULT_ADD_VARIETY);
    return (dflt || list[0])?.id || '';
  });
  const [supplier, setSupplier] = useState('');
  const [shippingFee, setShippingFee] = useState('');
  const [notes, setNotes] = useState('');
  const [sendToReceiving, setSendToReceiving] = useState(true);
  // How this order's items get minted at receive time (migration 0038).
  // Only non-default choices are sent, so an un-migrated database keeps
  // working until someone actually picks TC / acclimated / a note.
  const [itemType, setItemType] = useState('plant');
  const [itemStatus, setItemStatus] = useState('available');
  const [itemNotes, setItemNotes] = useState('');
  const [importing, setImporting] = useState(false);
  const fileRef = useRef(null);
  // Synchronous double-tap guard (state alone loses to fast iPad taps) and
  // the idempotency id: one per parsed sheet, used as the PO id server-side,
  // so a retry after a lost success response can't mint a duplicate order.
  const busyRef = useRef(false);
  const importIdRef = useRef(null);

  // Catalog lookups + row matching + duplicate folding live in
  // sheetParsing.js, shared with UpdateOrderModal — a supplier sheet must
  // parse and match identically whichever door it comes in.
  const matchCtx = useMemo(() => buildMatchContext(species, varieties), [species, varieties]);
  const { varietyById } = matchCtx;

  const [noQtyColumn, setNoQtyColumn] = useState(false);
  const [overrides, setOverrides] = useState({}); // baseRow index → {speciesId}|{skip:true}

  const handleFile = async (file) => {
    setParseErr('');
    setBaseRows(null);
    setNoQtyColumn(false);
    setOverrides({});
    importIdRef.current = `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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

  const speciesById = useMemo(() => new Map((species || []).map(s => [s.id, s])), [species]);
  const suggestIndex = useMemo(() => buildSuggestIndex(species), [species]);

  // Matching + manual overrides + duplicate-merge, derived so changing the
  // "file under" genus re-matches live. Rows are cloned first — the merge
  // mutates quantities.
  const rows = useMemo(() => {
    if (!baseRows) return null;
    const mapped = baseRows.map((r, i) => {
      let row = r.status ? { ...r } : { ...r, ...matchSheetRow(r, matchCtx, defaultVarietyId) };
      const ov = overrides[i];
      // A manual pick beats whatever the auto-matcher decided —
      // UNCONDITIONALLY: a later genus change can flip an ambiguous row to
      // auto-matched, and the user's explicit bind must not lose to that.
      if (ov?.speciesId) {
        const sp = speciesById.get(ov.speciesId);
        row = { ...row, status: 'matched', speciesId: ov.speciesId, varietyId: sp?.varietyId, manual: true, viaDefault: false, reviewable: true };
      } else if (ov?.skip) {
        row = { ...row, status: 'skipped-manual', reviewable: true };
      } else if (REVIEWABLE.has(row.status)) {
        row.suggestions = suggest(row.species, suggestIndex);
        row.reviewable = true;
      }
      row.idx = i;
      return row;
    });
    const out = mergeDuplicateRows(mapped);
    // A row folded into an earlier duplicate is no longer independently
    // matchable — its picker and review count would be pure noise.
    for (const r of out) {
      if (r.status === 'duplicate') { delete r.suggestions; r.reviewable = false; }
    }
    return out;
  }, [baseRows, defaultVarietyId, matchCtx, overrides, suggestIndex, speciesById]);

  const counts = useMemo(() => {
    const c = {
      matched: 0, create: 0, ambiguous: 0, unmatched: 0, duplicate: 0,
      'bad-qty': 0, 'bad-name': 0, 'unknown-variety': 0, 'skipped-manual': 0,
      units: 0, review: 0,
    };
    for (const r of rows || []) {
      c[r.status] += 1;
      if (r.suggestions) c.review += 1;
      if (r.status === 'matched' || r.status === 'create') c.units += r.qty;
    }
    return c;
  }, [rows]);

  // Catalog wholesale price per species — the preview must show the REAL
  // price a priceless row will import at ($0 when the catalog has none),
  // not a vague "catalog" that may not exist.
  const catalogPriceById = useMemo(
    () => new Map((species || []).map(s => [s.id, s.wholesalePrice ?? null])),
    [species],
  );

  const importable = (rows || []).filter(r => r.status === 'matched' || r.status === 'create');

  const runImport = async () => {
    if (busyRef.current || importing || !importable.length) return;
    // Mass-create guard: hundreds of new species in one import usually
    // means a wrong column was read as the plant name — the per-row chips
    // are easy to skim past at that volume, so make it a deliberate step.
    const createCount = importable.filter(r => r.status === 'create').length;
    if (createCount > MASS_CREATE_WARN) {
      const sure = window.confirm(
        `This import creates ${createCount} NEW species in the catalog. That many usually means a wrong column was read as the plant name — check the preview's "new species" chips. Create them anyway?`,
      );
      if (!sure) return;
    }
    busyRef.current = true;
    setImporting(true);
    const markOrdered = sendToReceiving;
    try {
      // One request: the import-order action creates species + PO + every
      // line in batch statements server-side (and never leaves a line-less
      // order behind), so there's no sequential per-row loop to resume.
      const res = await api.importPurchaseOrder({
        importId: importIdRef.current || undefined,
        supplier: supplier.trim(),
        shippingFee: parseFloat(shippingFee) || 0,
        notes: notes.trim() || undefined,
        itemType: itemType !== 'plant' ? itemType : undefined,
        itemStatus: itemStatus !== 'available' ? itemStatus : undefined,
        itemNotes: itemNotes.trim() || undefined,
        markOrdered,
        lines: importable.map(r => (r.status === 'matched'
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

      const skipped = (rows || []).length - importable.length;
      // App's showToast is (msg, type) — 'error' renders red, anything else
      // is the neutral toast. No duration parameter exists.
      if (res.alreadyImported) {
        showToast?.('This sheet was already imported — nothing was duplicated.');
      } else if (res.markOrderedFailed) {
        // The order EXISTS as a draft; retrying would duplicate it.
        showToast?.('Order created as a DRAFT — send it to receiving from the Orders list (do not re-upload).', 'error');
      } else {
        showToast?.(
          `Order created — ${res.lineCount} species, ${res.unitCount} plants`
          + (res.createdSpeciesCount ? `, ${res.createdSpeciesCount} new species` : '')
          + (skipped ? ` (${skipped} row${skipped === 1 ? '' : 's'} skipped)` : '')
          + (markOrdered ? '. It’s live on the receiving screen.' : '.'),
        );
      }
      onCreated?.();
      onClose();
    } catch (e) {
      showToast?.(`Import failed: ${e.message || 'unknown error'} — fix and try again`, 'error');
      busyRef.current = false;
      setImporting(false);
    }
  };

  const statusChip = (r) => {
    switch (r.status) {
      case 'matched':   return <span className="text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded text-[11px] font-semibold">matched</span>;
      case 'create': {
        const vName = varietyById.get(r.varietyId)?.name || '?';
        return (
          <span className="text-sky-700 bg-sky-50 px-1.5 py-0.5 rounded text-[11px] font-semibold" title={r.viaDefault ? 'Not in the catalog and no variety column — created under the genus chosen below' : 'Created under the variety named on this row'}>
            new species → {vName}
          </span>
        );
      }
      case 'skipped-manual': return <span className="text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded text-[11px] font-semibold">skipped</span>;
      case 'ambiguous': return <span className="text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded text-[11px] font-semibold" title="This name exists in more than one variety (and not the default one) — match it below or add a variety column">ambiguous</span>;
      case 'duplicate': return (
        <span className="text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded text-[11px] font-semibold" title="Same species appears earlier in the sheet — quantities were combined into that row">
          duplicate — qty merged{r.priceConflict ? ' · price differs, first used' : ''}
        </span>
      );
      case 'bad-qty':   return <span className="text-red-700 bg-red-50 px-1.5 py-0.5 rounded text-[11px] font-semibold" title={`Quantity is 0 or over ${MAX_QTY} — fix the cell and re-upload`}>qty looks wrong — skipped</span>;
      case 'bad-name':  return <span className="text-red-700 bg-red-50 px-1.5 py-0.5 rounded text-[11px] font-semibold" title={`Name is over ${MAX_NAME_LEN} characters — fix the cell and re-upload`}>name too long — skipped</span>;
      case 'unknown-variety': return <span className="text-red-700 bg-red-50 px-1.5 py-0.5 rounded text-[11px] font-semibold" title="This row names a variety that isn't in the catalog — match it below, add the variety, or clear the cell to use the default genus">unknown variety</span>;
      default:          return <span className="text-red-700 bg-red-50 px-1.5 py-0.5 rounded text-[11px] font-semibold">no match</span>;
    }
  };

  const priceCell = (r) => {
    if (r.price != null) return `$${r.price.toFixed(2)}`;
    if (r.status === 'matched') {
      const cat = catalogPriceById.get(r.speciesId);
      return cat != null ? `$${Number(cat).toFixed(2)} (catalog)` : '$0.00 ⚠ no price';
    }
    if (r.status === 'create') return '$0.00 ⚠ no price';
    return '—';
  };

  const rowTint = (r) => {
    if (r.status === 'matched' || r.status === 'create') return '';
    if (r.status === 'duplicate' || r.status === 'skipped-manual') return 'bg-gray-50 text-gray-400';
    if (r.status === 'ambiguous') return 'bg-amber-50/60';
    return 'bg-red-50/60';
  };

  return (
    <Modal
      title="Import wholesale order"
      onClose={importing
        ? () => showToast?.('Import in progress — hang tight, closing now would leave a half-built order')
        : onClose}
      size="lg"
    >
      <div className="space-y-3">
        {/* File picker — real drop target, not just a click zone. */}
        <div
          className="border-2 border-dashed border-gray-300 rounded-xl p-4 text-center hover:border-emerald-400 transition cursor-pointer"
          onClick={() => !importing && fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (!importing) handleFile(e.dataTransfer.files?.[0]);
          }}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => {
              handleFile(e.target.files?.[0]);
              // Reset so re-picking the SAME file (after fixing it on disk)
              // still fires a change event.
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
              Drop the supplier's list here (.xlsx / .csv)
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
            {/* Match summary + preview */}
            {noQtyColumn && (
              <div className="flex items-center gap-2 bg-amber-50 text-amber-800 text-xs px-3 py-2 rounded-lg">
                <AlertCircle className="w-4 h-4 shrink-0" />
                No quantity column found — every row counts as 1 plant. Add a "qty" column if that's wrong.
              </div>
            )}
            <div className="flex items-center gap-2 text-xs flex-wrap">
              <span className="font-semibold text-gray-700">{rows.length} rows:</span>
              {counts.matched > 0 && <span className="text-emerald-700">{counts.matched} matched</span>}
              {counts.create > 0 && (
                <span className={counts.create > MASS_CREATE_WARN ? 'text-red-700 font-bold' : 'text-sky-700'}>
                  {counts.create} new species{counts.create > MASS_CREATE_WARN ? ' ⚠' : ''}
                </span>
              )}
              {counts.duplicate > 0 && <span className="text-gray-500">{counts.duplicate} merged</span>}
              {counts.ambiguous > 0 && <span className="text-amber-700">{counts.ambiguous} ambiguous</span>}
              {counts.unmatched > 0 && <span className="text-red-700">{counts.unmatched} unmatched</span>}
              {counts['unknown-variety'] > 0 && <span className="text-red-700">{counts['unknown-variety']} unknown variety</span>}
              {counts['bad-qty'] > 0 && <span className="text-red-700">{counts['bad-qty']} bad qty</span>}
              {counts['bad-name'] > 0 && <span className="text-red-700">{counts['bad-name']} bad name</span>}
              {counts['skipped-manual'] > 0 && <span className="text-gray-500">{counts['skipped-manual']} skipped</span>}
              {counts.review > 0 && <span className="text-amber-700 font-semibold">{counts.review} need a manual match below</span>}
              <span className="ml-auto font-semibold text-gray-900">{counts.units} plants to order</span>
            </div>
            {counts.review > 0 && (
              <div className="flex items-center gap-2 bg-amber-50 text-amber-800 text-xs px-3 py-2 rounded-lg">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {counts.review} row{counts.review === 1 ? " didn't" : "s didn't"} match the catalog — tap a suggestion or search to bind each one to an existing species. Left alone, a "new species" row is created under the genus below; other unmatched rows are skipped.
              </div>
            )}
            {counts.create > 0 && (
              <label className="flex items-center gap-2 text-xs text-gray-700 bg-sky-50 border border-sky-200 rounded-lg px-3 py-2">
                <span className="font-medium shrink-0">File new species under</span>
                <select
                  value={defaultVarietyId}
                  onChange={(e) => {
                    setDefaultVarietyId(e.target.value);
                    // A different genus is a different import: mint a fresh
                    // idempotency id so a retry can't replay the previous
                    // genus's order as "already imported".
                    importIdRef.current = `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
                  }}
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
                      <th className="px-2.5 py-1.5 font-medium">Variety</th>
                      <th className="px-2.5 py-1.5 font-medium text-right">Qty</th>
                      <th className="px-2.5 py-1.5 font-medium text-right">Price</th>
                      <th className="px-2.5 py-1.5 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className={`border-t border-gray-100 align-top ${rowTint(r)}`}>
                        <td className="px-2.5 py-1.5 text-gray-900">{r.species}</td>
                        <td className="px-2.5 py-1.5 text-gray-500">
                          {r.variety || (r.speciesId ? varietyById.get(r.varietyId)?.name : '') || '—'}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">{r.qty}</td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">{priceCell(r)}</td>
                        <td className="px-2.5 py-1.5">
                          {statusChip(r)}
                          {r.reviewable && (
                            <div className="mt-1">
                              <MatchPicker
                                row={r}
                                override={overrides[r.idx] || null}
                                species={species}
                                varietyById={varietyById}
                                defaultLabel={r.status === 'create' ? 'new species' : 'skipped'}
                                onOverride={(ov) => {
                                  // A different match set is a different import —
                                  // same re-mint rule as the genus select, so a
                                  // retry after fixing matches can't be swallowed
                                  // as "already imported".
                                  importIdRef.current = `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
                                  setOverrides(o => ({ ...o, [r.idx]: ov }));
                                }}
                              />
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Item settings — stamped on every item this order mints. */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-gray-50 rounded-lg p-3">
              <label className="block">
                <span className="text-xs font-medium text-gray-700">Items arrive as</span>
                <select
                  value={itemType}
                  onChange={(e) => {
                    setItemType(e.target.value);
                    if (e.target.value !== 'tc') setItemStatus('available');
                  }}
                  className="input mt-1"
                >
                  <option value="plant">Plant</option>
                  <option value="tc">TC (Tissue Culture)</option>
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-700">Initial status</span>
                <select
                  value={itemStatus}
                  onChange={(e) => setItemStatus(e.target.value)}
                  className="input mt-1"
                  disabled={itemType !== 'tc'}
                  title={itemType !== 'tc' ? 'Acclimated only applies to TC' : undefined}
                >
                  <option value="available">Available</option>
                  {itemType === 'tc' && <option value="acclimated">Acclimated</option>}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-700">Item note (on every plant)</span>
                <input type="text" value={itemNotes} onChange={(e) => setItemNotes(e.target.value)} className="input mt-1" placeholder="optional" />
              </label>
            </div>

            {/* Order header fields */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="block">
                <span className="text-xs font-medium text-gray-700">Supplier</span>
                <input type="text" value={supplier} onChange={(e) => setSupplier(e.target.value)} className="input mt-1" placeholder="e.g. TC Farm" />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-700">Shipping fee ($)</span>
                <input type="number" step="0.01" min="0" value={shippingFee} onChange={(e) => setShippingFee(e.target.value)} className="input mt-1" placeholder="0.00" />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-gray-700">Notes</span>
                <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} className="input mt-1" placeholder="optional" />
              </label>
            </div>
            <label className="flex items-start gap-2 text-sm text-gray-800 cursor-pointer">
              <input
                type="checkbox"
                checked={sendToReceiving}
                onChange={(e) => setSendToReceiving(e.target.checked)}
                className="rounded border-gray-300 mt-0.5"
              />
              <span>
                Mark as <strong>ordered</strong> and send to the packer's receiving screen
                <span className="block text-xs text-gray-500">Unchecked, it stays a draft you can edit in the Orders list first. The shipping fee is split across every plant's cost at receive time.</span>
              </span>
            </label>
          </>
        )}

        <div className="flex items-center gap-2 justify-end pt-1">
          {importing && (
            <span className="mr-auto text-xs text-gray-500 flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Importing {importable.length} species…
            </span>
          )}
          <button
            onClick={onClose}
            disabled={importing}
            className="px-4 py-3 text-base font-medium text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={runImport}
            disabled={importing || !importable.length}
            className="px-4 py-3 text-base font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl flex items-center gap-1.5 disabled:bg-gray-200 disabled:text-gray-500"
          >
            {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            {importing
              ? 'Importing…'
              : `Create order — ${importable.length} species / ${counts.units} plants`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
