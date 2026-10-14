import { useMemo, useState } from 'react';
import { Upload, AlertCircle, AlertTriangle, Loader2, ListOrdered } from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';
import { readSheetGrid, MAX_ROWS } from '../purchasing/sheetParsing.js';
import { saleWeek, blockStart, blockEnd, isoWeekNum } from './lotBlock.js';
import {
  parseLineupGrid, checkLineupRows, takenLots, varietyForRow, lineupPayloads, LINEUP_ROLES,
} from './lineupImport.js';

// Import a live's lineup from a CSV/XLSX: index + name per row → new plants
// of our own, numbered as the sheet says, staged into this sale. The preview
// shows every row with its number, name, the variety it will file under,
// the price, and anything wrong with it; rows with a problem are left out,
// numbers outside the week's block are allowed after a confirm.

const colLabel = (i) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');
const ROLE_LABEL = { index: 'Index (lineup #)', name: 'Name', price: 'Price', variety: 'Variety' };

export function LineupImportModal({ sale, items = [], sales = [], varieties = [], species = [], isBae = false, onImport, onClose, showToast }) {
  const [fileName, setFileName] = useState('');
  const [grid, setGrid] = useState(null);
  const [forced, setForced] = useState(null);     // operator's column choice
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [printAfter, setPrintAfter] = useState(true);
  const defaultVarietyId = useMemo(() => (isBae
    ? (varieties.find(v => (v.code || '').toUpperCase() === 'ANT') ?? varieties.find(v => /^anthurium/i.test(v.name || '')))?.id ?? ''
    : ''), [isBae, varieties]);
  const [varietyId, setVarietyId] = useState(defaultVarietyId);

  const week = saleWeek(sale);
  const parsed = useMemo(() => (grid ? parseLineupGrid(grid, forced) : null), [grid, forced]);
  const checked = useMemo(() => {
    if (!parsed) return [];
    const { takenInSale, takenThisWeek } = takenLots(items, sales, sale, saleWeek);
    return checkLineupRows(parsed.rows.slice(0, MAX_ROWS), { week, takenInSale, takenThisWeek });
  }, [parsed, items, sales, sale, week]);
  const ready = checked.filter(r => !r.blocking);
  const skipped = checked.length - ready.length;
  const outOfBlock = ready.filter(r => r.problems.some(p => p.code === 'block')).length;
  const noVariety = ready.filter(r => !varietyForRow(r, varieties, varietyId)).length;
  const columnCount = parsed ? Math.max(0, ...(grid || []).map(r => r.length)) : 0;
  const headerCells = parsed?.header || (grid ? grid[0] : []);

  const pick = async (file) => {
    setErr(''); setGrid(null); setForced(null);
    if (!file) return;
    setFileName(file.name);
    try {
      const g = await readSheetGrid(file);
      if (!g.length) { setErr('That file has no rows.'); return; }
      setGrid(g);
    } catch (e) {
      setErr(`Could not read file: ${e.message}`);
    }
  };

  const submit = async () => {
    setErr('');
    if (!ready.length) return setErr('Nothing to add — every row has a problem.');
    if (noVariety) return setErr('Pick a variety for the rows that don’t name one.');
    if (outOfBlock && !window.confirm(`${outOfBlock} number${outOfBlock === 1 ? ' is' : 's are'} outside week ${isoWeekNum(week)}'s lots (${blockStart(week)}–${blockEnd(week)}). Numbers outside that block can duplicate a held plant's label from another week, and packers pick by number. Add anyway?`)) return;
    const payloads = lineupPayloads(checked, { sale, varieties, species, defaultVarietyId: varietyId });
    setBusy(true);
    try {
      await onImport(payloads, { print: printAfter });
      showToast?.(`Added ${payloads.length} plant${payloads.length === 1 ? '' : 's'} to ${sale.name}${skipped ? ` · ${skipped} row${skipped === 1 ? '' : 's'} skipped` : ''}`);
      onClose();
    } catch (e) {
      setErr(e.message || 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Import lineup — ${sale.name}`} onClose={onClose} size="lg">
      <div className="space-y-3">
        <p className="text-xs text-gray-500">
          A CSV or XLSX with one row per plant: its <b>index</b> (lineup number) and <b>name</b>; a <b>price</b> and <b>variety</b> column are optional.
          Each row becomes a new plant of ours with an auto SKU, numbered as the sheet says and staged into this sale.
          Week {isoWeekNum(week)}'s lots are {blockStart(week)}–{blockEnd(week)}.
        </p>
        {err && (
          <div className="flex items-center gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
            <AlertCircle className="w-4 h-4 shrink-0" /> {err}
          </div>
        )}
        <label className="flex items-center gap-2 cursor-pointer">
          <span className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-emerald-50 text-emerald-700 hover:bg-emerald-100"><Upload className="w-4 h-4" /> Choose file</span>
          <span className="text-xs text-gray-500 truncate">{fileName || 'No file chosen'}</span>
          <input type="file" accept=".csv,.txt,.xlsx,.xls" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
        </label>

        {parsed && (
          <>
            {/* Which column is which — detected, or the operator's choice. */}
            <div className="flex flex-wrap gap-2 items-end">
              {LINEUP_ROLES.map(role => (
                <label key={role} className="text-[11px] text-gray-600">
                  <div className="font-medium">{ROLE_LABEL[role]}</div>
                  <select
                    value={parsed.cols[role] ?? -1}
                    onChange={(e) => setForced({ ...parsed.cols, [role]: parseInt(e.target.value, 10) })}
                    className="input py-1 text-xs"
                  >
                    <option value={-1}>—</option>
                    {Array.from({ length: columnCount }, (_, i) => (
                      <option key={i} value={i}>{colLabel(i)}{headerCells?.[i] ? ` · ${String(headerCells[i]).slice(0, 18)}` : ''}</option>
                    ))}
                  </select>
                </label>
              ))}
              <label className="text-[11px] text-gray-600">
                <div className="font-medium">Variety when the sheet has none</div>
                <select value={varietyId} onChange={(e) => setVarietyId(e.target.value)} className="input py-1 text-xs">
                  <option value="">— pick —</option>
                  {varieties.map(v => <option key={v.id} value={v.id}>{v.name}{v.code ? ` (${v.code})` : ''}</option>)}
                </select>
              </label>
              {parsed.headerless && (
                <span className="text-[11px] text-amber-700 inline-flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> No header row — read as index, name, price. Check the columns.</span>
              )}
            </div>

            <div className="text-xs text-gray-700">
              <b>{ready.length}</b> plant{ready.length === 1 ? '' : 's'} ready
              {skipped ? <> · <span className="text-red-700 font-medium">{skipped} row{skipped === 1 ? '' : 's'} with a problem — left out</span></> : ''}
              {outOfBlock ? <> · <span className="text-amber-700 font-medium">{outOfBlock} outside this week's block</span></> : ''}
              {parsed.rows.length > MAX_ROWS ? <> · only the first {MAX_ROWS} rows are read</> : ''}
            </div>

            <div className="border border-gray-200 rounded-lg overflow-auto max-h-[40vh]">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-600 sticky top-0">
                  <tr><th className="px-2 py-1.5 text-right">#</th><th className="px-2 py-1.5 text-left">Name</th><th className="px-2 py-1.5 text-left">Variety</th><th className="px-2 py-1.5 text-right">Price</th><th className="px-2 py-1.5 text-left">Problem</th></tr>
                </thead>
                <tbody>
                  {checked.map((r) => {
                    const v = varietyForRow(r, varieties, varietyId);
                    return (
                      <tr key={r.line} className={`border-t border-gray-100 ${r.blocking ? 'bg-red-50 text-gray-500' : ''}`}>
                        <td className="px-2 py-1 text-right font-mono font-bold tabular-nums">{r.index ?? <span className="text-red-600">{r.indexRaw || '—'}</span>}</td>
                        <td className="px-2 py-1">{r.name || <span className="text-red-600">—</span>}</td>
                        <td className="px-2 py-1">{v ? v.name : <span className="text-red-600">pick one</span>}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{r.price != null ? `$${r.price.toFixed(2)}` : ''}</td>
                        <td className="px-2 py-1">
                          {r.problems.map((p, i) => (
                            <span key={i} className={`inline-block mr-1 ${p.warn ? 'text-amber-700' : 'text-red-700'}`}>{p.text}</span>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between gap-3 pt-1">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={printAfter} onChange={(e) => setPrintAfter(e.target.checked)} className="w-4 h-4 rounded text-emerald-600" />
                Print their labels after adding
              </label>
              <div className="flex items-center gap-2">
                <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancel</button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={busy || !ready.length}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg disabled:opacity-50"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ListOrdered className="w-4 h-4" />} Add {ready.length} plant{ready.length === 1 ? '' : 's'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
