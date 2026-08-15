import { useMemo, useRef, useState } from 'react';
import { Upload, Check, AlertCircle, Loader2, FileSpreadsheet } from 'lucide-react';
import { api } from '../api.js';
import { Modal } from '../ui/Modal.jsx';

// Wholesale order upload — hosted by BOTH the admin's Orders pane and the
// packer's ReceivingPane. Drop the supplier's list (.xlsx or .csv) and get
// a purchase order out of it — matched to the catalog, one line per
// species — marked "ordered" so it shows on the receiving screen for
// counting + labeling. `forceSendToReceiving` (the packer context) hides
// the mark-as-ordered choice: an unchecked import would create a draft the
// packer can neither see nor fix (drafts and mark-ordered are admin-only).
//
// Expected columns (headers matched loosely, order doesn't matter):
//   species / name / plant       required — the species or cultivar name
//   variety / genus              optional — narrows the match, and lets a
//                                brand-new species be auto-created under it
//   qty / quantity / count       optional — defaults to 1
//   price / cost / wholesale     optional — per-plant wholesale price;
//                                falls back to the species' saved price
// A headerless sheet is treated as [species, qty, price].

// Note: no '#' or 'amount' as qty aliases — '#' is usually the row-number
// column and 'amount' is usually a dollar total; binding either to qty
// silently orders row-47 or $249 worth of plants.
const HEADER_ALIASES = {
  species: ['species', 'name', 'plant', 'plant name', 'species name', 'cultivar', 'item'],
  variety: ['variety', 'genus'],
  qty: ['qty', 'quantity', 'count', 'units'],
  price: ['price', 'cost', 'wholesale', 'unit price', 'wholesale price', 'unit cost', 'unit wholesale price'],
};

// Sanity rails on supplier-sheet cells. Rows outside them are skipped with
// a visible chip rather than silently coerced — a date serial in the qty
// column must not become a million-unit order.
// MAX_ROWS mirrors IMPORT_LINES_MAX in api/purchase-orders.js.
const MAX_ROWS = 500;
const MAX_QTY = 10000;
const MAX_NAME_LEN = 200;

const norm = (s) => String(s ?? '').trim().toLowerCase();

function detectColumns(headerRow) {
  const cols = {};
  headerRow.forEach((cell, idx) => {
    const h = norm(cell);
    if (!h) return;
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      if (cols[key] === undefined && aliases.includes(h)) cols[key] = idx;
    }
  });
  return cols;
}

export function ImportOrderModal({ species, varieties, showToast, onClose, onCreated, forceSendToReceiving = false }) {
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState(null);      // parsed + matched rows
  const [parseErr, setParseErr] = useState('');
  const [supplier, setSupplier] = useState('');
  const [shippingFee, setShippingFee] = useState('');
  const [notes, setNotes] = useState('');
  const [sendToReceiving, setSendToReceiving] = useState(true);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef(null);
  // Synchronous double-tap guard (state alone loses to fast iPad taps) and
  // the idempotency id: one per parsed sheet, used as the PO id server-side,
  // so a retry after a lost success response can't mint a duplicate order.
  const busyRef = useRef(false);
  const importIdRef = useRef(null);

  const speciesIndex = useMemo(() => {
    // epithet (lowercased) → [species…]; a name can exist in several
    // varieties, so the variety column (when present) disambiguates.
    const m = new Map();
    for (const s of species || []) {
      const k = norm(s.epithet);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(s);
    }
    return m;
  }, [species]);

  const varietyByName = useMemo(
    () => new Map((varieties || []).map(v => [norm(v.name), v])),
    [varieties],
  );
  const varietyById = useMemo(
    () => new Map((varieties || []).map(v => [v.id, v])),
    [varieties],
  );

  const matchRow = (r) => {
    const candidates = speciesIndex.get(norm(r.species)) || [];
    const wantVariety = r.variety ? varietyByName.get(norm(r.variety)) : null;
    const narrowed = wantVariety
      ? candidates.filter(s => s.varietyId === wantVariety.id)
      : candidates;
    if (narrowed.length === 1) return { status: 'matched', speciesId: narrowed[0].id, varietyId: narrowed[0].varietyId };
    if (narrowed.length > 1) return { status: 'ambiguous' };
    // No match. If the sheet names a variety we know, the species can be
    // created under it during import.
    if (wantVariety) return { status: 'create', varietyId: wantVariety.id };
    return { status: 'unmatched' };
  };

  const [noQtyColumn, setNoQtyColumn] = useState(false);

  const handleFile = async (file) => {
    setParseErr('');
    setRows(null);
    setNoQtyColumn(false);
    importIdRef.current = `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    if (!file) return;
    setFileName(file.name);
    try {
      // Lazy: xlsx is ~140KB gzip and the repo deliberately keeps it out of
      // eagerly-loaded chunks — load it only when a file is actually chosen.
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      const nonEmpty = grid.filter(r => r.some(c => norm(c) !== ''));
      if (!nonEmpty.length) { setParseErr('The file looks empty.'); return; }
      if (nonEmpty.length > MAX_ROWS + 1) {
        setParseErr(`That's ${nonEmpty.length} rows — the import caps at ${MAX_ROWS}. Split the sheet.`);
        return;
      }

      let cols = detectColumns(nonEmpty[0]);
      let dataRows;
      if (cols.species !== undefined) {
        dataRows = nonEmpty.slice(1);
      } else {
        // Headerless: species, qty, price — in that order.
        cols = { species: 0, qty: 1, price: 2 };
        dataRows = nonEmpty;
      }
      // A sheet with headers but no recognizable qty column silently
      // defaults every row to 1 plant — make that loud, not silent.
      setNoQtyColumn(cols.qty === undefined);

      const parsed = dataRows
        .map((r, i) => {
          const speciesName = String(r[cols.species] ?? '').trim();
          if (!speciesName) return null;
          // Commas stripped like the price column — "1,000" must not
          // parseInt to 1. An explicit 0 (out-of-stock marker) or an
          // absurd value is skipped visibly, never coerced.
          const qtyRaw = cols.qty !== undefined ? String(r[cols.qty] ?? '').replace(/[,\s]/g, '') : '';
          const qty = cols.qty === undefined || qtyRaw === '' ? 1 : parseInt(qtyRaw, 10);
          const priceRaw = cols.price !== undefined ? String(r[cols.price] ?? '').replace(/[$,\s]/g, '') : '';
          const price = priceRaw === '' ? null : parseFloat(priceRaw);
          const row = {
            row: i + 1,
            species: speciesName,
            variety: cols.variety !== undefined ? String(r[cols.variety] ?? '').trim() : '',
            qty: Number.isFinite(qty) ? qty : 0,
            price: Number.isFinite(price) && price >= 0 ? price : null,
          };
          if (row.qty < 1 || row.qty > MAX_QTY) return { ...row, status: 'bad-qty' };
          if (speciesName.length > MAX_NAME_LEN) return { ...row, status: 'unmatched' };
          return { ...row, ...matchRow(row) };
        })
        .filter(Boolean);

      // Merge duplicate species rows — the import-order action aggregates
      // them server-side anyway (summing quantity, keeping the FIRST price),
      // so surface that here. Later duplicates fold their qty into the first
      // row and show a chip (with a price-conflict note when it matters).
      // A merged total past MAX_QTY skips the whole species: the server
      // enforces the same cap on the aggregate and would reject the import.
      const firstByKey = new Map();
      for (const r of parsed) {
        if (r.status !== 'matched' && r.status !== 'create') continue;
        const key = r.status === 'matched' ? `m:${r.speciesId}` : `c:${r.varietyId}:${norm(r.species)}`;
        const first = firstByKey.get(key);
        if (!first) { firstByKey.set(key, r); continue; }
        first.qty += r.qty;
        r.status = 'duplicate';
        r.priceConflict = r.price != null && first.price != null && r.price !== first.price;
        if (first.price == null && r.price != null) first.price = r.price;
      }
      for (const first of firstByKey.values()) {
        if (first.qty > MAX_QTY) first.status = 'bad-qty';
      }

      if (!parsed.length) { setParseErr('No usable rows found — is there a species/name column?'); return; }
      setRows(parsed);
    } catch (e) {
      setParseErr(e.message || 'Could not read that file.');
    }
  };

  const counts = useMemo(() => {
    const c = { matched: 0, create: 0, ambiguous: 0, unmatched: 0, duplicate: 0, 'bad-qty': 0, units: 0 };
    for (const r of rows || []) {
      c[r.status] += 1;
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
    busyRef.current = true;
    setImporting(true);
    const markOrdered = forceSendToReceiving || sendToReceiving;
    try {
      // One request: the import-order action creates species + PO + every
      // line in batch statements server-side (and never leaves a line-less
      // order behind), so there's no sequential per-row loop to resume.
      const res = await api.importPurchaseOrder({
        importId: importIdRef.current || undefined,
        supplier: supplier.trim(),
        shippingFee: parseFloat(shippingFee) || 0,
        notes: notes.trim() || undefined,
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
      if (res.alreadyImported) {
        showToast?.('This sheet was already imported — nothing was duplicated.', 4000);
      } else if (res.markOrderedFailed) {
        // The order EXISTS as a draft; retrying would duplicate it. An admin
        // has to flip it from the Purchase tab's Orders list.
        showToast?.('Order created as a DRAFT — it needs an admin to send it to receiving (do not re-upload).', 7000);
      } else {
        showToast?.(
          `Order created — ${res.lineCount} species, ${res.unitCount} plants`
          + (res.createdSpeciesCount ? `, ${res.createdSpeciesCount} new species` : '')
          + (skipped ? ` (${skipped} row${skipped === 1 ? '' : 's'} skipped)` : '')
          + (markOrdered ? '. It’s live on the receiving screen.' : '.'),
          5000,
        );
      }
      onCreated?.();
      onClose();
    } catch (e) {
      showToast?.(`Import failed: ${e.message || 'unknown error'} — fix and try again`, 5000);
      busyRef.current = false;
      setImporting(false);
    }
  };

  const statusChip = (r) => {
    switch (r.status) {
      case 'matched':   return <span className="text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded text-[11px] font-semibold">matched</span>;
      case 'create':    return <span className="text-sky-700 bg-sky-50 px-1.5 py-0.5 rounded text-[11px] font-semibold">new species</span>;
      case 'ambiguous': return <span className="text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded text-[11px] font-semibold" title="This name exists in more than one variety — add a variety column to pick one">ambiguous — skipped</span>;
      case 'duplicate': return (
        <span className="text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded text-[11px] font-semibold" title="Same species appears earlier in the sheet — quantities were combined into that row">
          duplicate — qty merged{r.priceConflict ? ' · price differs, first used' : ''}
        </span>
      );
      case 'bad-qty':   return <span className="text-red-700 bg-red-50 px-1.5 py-0.5 rounded text-[11px] font-semibold" title={`Quantity is 0 or over ${MAX_QTY} — fix the cell and re-upload`}>qty looks wrong — skipped</span>;
      default:          return <span className="text-red-700 bg-red-50 px-1.5 py-0.5 rounded text-[11px] font-semibold" title="Not in the catalog (or the name is too long), and no known variety to create it under">no match — skipped</span>;
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
    if (r.status === 'duplicate') return 'bg-gray-50 text-gray-400';
    if (r.status === 'ambiguous') return 'bg-amber-50/60';
    return 'bg-red-50/60';
  };

  return (
    <Modal
      title="Import wholesale order"
      onClose={importing
        ? () => showToast?.('Import in progress — hang tight, closing now would leave a half-built order', 2500)
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
              {counts.create > 0 && <span className="text-sky-700">{counts.create} new species</span>}
              {counts.duplicate > 0 && <span className="text-gray-500">{counts.duplicate} merged</span>}
              {counts.ambiguous > 0 && <span className="text-amber-700">{counts.ambiguous} ambiguous</span>}
              {counts.unmatched > 0 && <span className="text-red-700">{counts.unmatched} unmatched</span>}
              {counts['bad-qty'] > 0 && <span className="text-red-700">{counts['bad-qty']} bad qty</span>}
              <span className="ml-auto font-semibold text-gray-900">{counts.units} plants to order</span>
            </div>
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
                      <tr key={i} className={`border-t border-gray-100 ${rowTint(r)}`}>
                        <td className="px-2.5 py-1.5 text-gray-900">{r.species}</td>
                        <td className="px-2.5 py-1.5 text-gray-500">
                          {r.variety || (r.speciesId ? varietyById.get(r.varietyId)?.name : '') || '—'}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">{r.qty}</td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">{priceCell(r)}</td>
                        <td className="px-2.5 py-1.5">{statusChip(r)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
            {forceSendToReceiving ? (
              // Packer context: no draft escape hatch — an unchecked import
              // would be invisible on this screen and only an admin could
              // rescue it from Drafts.
              <div className="text-xs text-gray-500">
                The order goes straight to this receiving screen. The shipping fee is split across every plant's cost at receive time.
              </div>
            ) : (
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
            )}
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
