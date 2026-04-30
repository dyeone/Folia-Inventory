import { useState } from 'react';
import { AlertCircle, Check, Upload, FileText, ArrowLeft, Sparkles } from 'lucide-react';
import * as XLSX from 'xlsx';
import { Modal } from '../ui/Modal.jsx';

// Resolve a row's value across the various header spellings the user might
// have used (case- and punctuation-insensitive). Returns '' if not found.
function pick(row, ...candidates) {
  for (const cand of candidates) {
    for (const key of Object.keys(row)) {
      if (key.toLowerCase().replace(/[^a-z0-9]/g, '') === cand) {
        const v = row[key];
        if (v !== undefined && v !== null && v !== '') return v;
      }
    }
  }
  return '';
}

function normalizeCategory(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (s === 'plant' || s === 'plants') return 'plant';
  if (s === 'tc' || s === 'tissue culture' || s === 'tissueculture') return 'tc';
  return null;
}

const COL_SYNONYMS = {
  category: ['category', 'type'],
  variety:  ['variety', 'genus'],
  species:  ['species', 'name', 'epithet'],
  qty:      ['qty', 'quantity'],
};

function parseRows(rows, varieties, species) {
  if (rows.length === 0) return { error: 'The file has no rows.' };

  const firstKeys = Object.keys(rows[0]).map(k => k.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const missing = Object.keys(COL_SYNONYMS).filter(req =>
    !COL_SYNONYMS[req].some(syn => firstKeys.includes(syn.replace(/[^a-z0-9]/g, '')))
  );
  if (missing.length) {
    return {
      error: `Missing required columns: ${missing.join(', ')}. Found: ${Object.keys(rows[0]).join(', ')}`,
    };
  }

  const varietyByName = Object.fromEntries(varieties.map(v => [v.name.toLowerCase(), v]));
  const speciesByKey = Object.fromEntries(
    species.map(s => [`${s.varietyId}:${s.epithet.toLowerCase()}`, s])
  );

  const items = [];
  const rowErrors = [];
  const newSpecies = [];
  const newSpeciesSeen = new Set();

  rows.forEach((row, idx) => {
    const lineNo = idx + 2; // header is row 1
    const category    = normalizeCategory(pick(row, 'category', 'type'));
    const varietyName = String(pick(row, 'variety', 'genus')).trim();
    const speciesName = String(pick(row, 'species', 'name', 'epithet')).trim();
    const qty         = parseInt(pick(row, 'qty', 'quantity'), 10);

    if (!category)    { rowErrors.push(`Row ${lineNo}: category must be "tc" or "plant"`); return; }
    if (!varietyName) { rowErrors.push(`Row ${lineNo}: variety required`); return; }
    if (!speciesName) { rowErrors.push(`Row ${lineNo}: species required`); return; }
    if (!qty || qty < 1) { rowErrors.push(`Row ${lineNo}: qty must be a positive number`); return; }

    const variety = varietyByName[varietyName.toLowerCase()];
    if (!variety) {
      rowErrors.push(`Row ${lineNo}: variety "${varietyName}" not in catalog — add it first`);
      return;
    }

    const sKey = `${variety.id}:${speciesName.toLowerCase()}`;
    const existing = speciesByKey[sKey];
    if (!existing && !newSpeciesSeen.has(sKey)) {
      newSpeciesSeen.add(sKey);
      newSpecies.push({ varietyId: variety.id, varietyName: variety.name, epithet: speciesName });
    }

    items.push({
      type: category,
      variety: variety.name,
      name: speciesName,
      _speciesKey: sKey,
      speciesId: existing?.id || null,
      quantity: qty,
      grossCost:    String(pick(row, 'cost', 'grosscost')).trim(),
      cost:         String(pick(row, 'cost', 'grosscost')).trim(),
      listingPrice: String(pick(row, 'listingprice', 'price')).trim(),
      source:       String(pick(row, 'source', 'supplier')).trim(),
      notes:        String(pick(row, 'notes', 'description')).trim(),
      imageUrl:     String(pick(row, 'imageurl', 'image')).trim(),
      status: 'available',
    });
  });

  return { items, rowErrors, newSpecies };
}

export function BulkImportModal({ varieties = [], species = [], onCreateSpecies, onImport, onClose }) {
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState(null); // { items, rowErrors, newSpecies }
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);

  const handleFile = async (file) => {
    setErr('');
    setParsed(null);
    setLoading(true);
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      const result = parseRows(rows, varieties, species);
      if (result.error) setErr(result.error);
      else setParsed(result);
    } catch (e) {
      setErr(`Could not read file: ${e.message}`);
    }
    setLoading(false);
  };

  const reset = () => {
    setParsed(null);
    setFileName('');
    setErr('');
  };

  const handleImport = async () => {
    if (!parsed || parsed.items.length === 0) return;
    setImporting(true);
    setErr('');
    try {
      // Create any missing species first, then resolve speciesId for items.
      const newIdByKey = {};
      for (const ns of parsed.newSpecies) {
        const created = await onCreateSpecies({ varietyId: ns.varietyId, epithet: ns.epithet });
        newIdByKey[`${ns.varietyId}:${ns.epithet.toLowerCase()}`] = created.id;
      }
      const finalItems = parsed.items.map(({ _speciesKey, ...rest }) => ({
        ...rest,
        speciesId: rest.speciesId || newIdByKey[_speciesKey] || null,
      }));
      await onImport(finalItems);
    } catch (e) {
      setErr(e.message || 'Import failed');
    }
    setImporting(false);
  };

  const validCount = parsed?.items.length || 0;
  const errCount = parsed?.rowErrors.length || 0;
  const newSpeciesCount = parsed?.newSpecies.length || 0;

  return (
    <Modal title="Bulk Import SKUs" onClose={onClose} size="lg">
      <div className="space-y-3">
        <div className="text-sm text-gray-600 bg-gray-50 rounded-lg p-3">
          <div className="mb-1">
            Required columns:{' '}
            <span className="font-mono bg-white px-1.5 py-0.5 rounded border">category</span>{' '}
            <span className="font-mono bg-white px-1.5 py-0.5 rounded border">variety</span>{' '}
            <span className="font-mono bg-white px-1.5 py-0.5 rounded border">species</span>{' '}
            <span className="font-mono bg-white px-1.5 py-0.5 rounded border">qty</span>
          </div>
          <div className="text-gray-500 text-xs">
            <span className="text-emerald-700 font-medium">SKUs are generated automatically.</span>{' '}
            Optional: cost, listing price, source, notes, image url. Anything missing can be filled in later.
          </div>
        </div>

        {!parsed ? (
          <>
            <label className="block">
              <div className="border-2 border-dashed border-gray-300 rounded-xl p-10 sm:p-12 text-center hover:border-emerald-400 hover:bg-emerald-50/50 active:bg-emerald-50 cursor-pointer transition">
                <Upload className="w-9 h-9 text-gray-400 mx-auto mb-2" />
                <div className="text-base font-medium text-gray-900">
                  {loading ? 'Reading file…' : 'Upload CSV or XLSX'}
                </div>
                <div className="text-sm text-gray-500 mt-1">.csv, .xlsx or .xls</div>
                <input
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  onChange={(e) => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }}
                  className="hidden"
                />
              </div>
            </label>
            {err && (
              <div className="flex items-start gap-2 bg-red-50 text-red-700 text-sm px-3 py-2 rounded-lg whitespace-pre-line">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {err}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <div className="text-sm">
                <FileText className="w-4 h-4 inline mr-1 text-gray-400" />
                <span className="font-medium text-gray-900">{fileName}</span>
                <span className="text-gray-500"> · {validCount} valid · {errCount} skipped</span>
              </div>
              <button onClick={reset} className="text-xs text-gray-600 hover:text-gray-900 flex items-center gap-1">
                <ArrowLeft className="w-3 h-3" /> Different file
              </button>
            </div>

            {validCount > 0 && (
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-900">
                <div className="font-medium mb-0.5">Ready to import {validCount} item{validCount === 1 ? '' : 's'}</div>
                <div className="text-emerald-700 text-xs">
                  SKUs will be assigned automatically on save.
                </div>
              </div>
            )}

            {newSpeciesCount > 0 && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-900">
                <div className="font-medium mb-1 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" /> {newSpeciesCount} new species will be added to the catalog
                </div>
                <ul className="text-blue-800 text-xs space-y-0.5 max-h-24 overflow-y-auto">
                  {parsed.newSpecies.slice(0, 10).map((ns, i) => (
                    <li key={i}>· {ns.varietyName} <span className="italic">{ns.epithet}</span></li>
                  ))}
                  {newSpeciesCount > 10 && <li>…and {newSpeciesCount - 10} more</li>}
                </ul>
              </div>
            )}

            {errCount > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900">
                <div className="font-medium mb-1 flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5" /> {errCount} row{errCount === 1 ? '' : 's'} skipped
                </div>
                <ul className="text-amber-800 text-xs space-y-0.5 max-h-32 overflow-y-auto">
                  {parsed.rowErrors.slice(0, 10).map((m, i) => <li key={i}>· {m}</li>)}
                  {errCount > 10 && <li>…and {errCount - 10} more</li>}
                </ul>
              </div>
            )}

            {validCount > 0 && (
              <div className="border border-gray-200 rounded-lg overflow-hidden max-h-72 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-gray-500 uppercase sticky top-0">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-medium">Category</th>
                      <th className="px-2 py-1.5 text-left font-medium">Variety</th>
                      <th className="px-2 py-1.5 text-left font-medium">Species</th>
                      <th className="px-2 py-1.5 text-right font-medium">Qty</th>
                      <th className="px-2 py-1.5 text-right font-medium">Cost</th>
                      <th className="px-2 py-1.5 text-right font-medium">Price</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {parsed.items.slice(0, 50).map((r, idx) => (
                      <tr key={idx}>
                        <td className="px-2 py-1.5 uppercase text-gray-700">{r.type}</td>
                        <td className="px-2 py-1.5">{r.variety}</td>
                        <td className="px-2 py-1.5 italic">{r.name}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{r.quantity}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{r.cost || '—'}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{r.listingPrice || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {parsed.items.length > 50 && (
                  <div className="px-3 py-1.5 text-[11px] text-gray-500 bg-gray-50 border-t border-gray-200">
                    …and {parsed.items.length - 50} more rows
                  </div>
                )}
              </div>
            )}

            {err && (
              <div className="flex items-start gap-2 bg-red-50 text-red-700 text-sm px-3 py-2 rounded-lg">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {err}
              </div>
            )}
          </>
        )}

        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-100 active:bg-gray-200 rounded-lg">
            Cancel
          </button>
          {parsed && validCount > 0 && (
            <button
              onClick={handleImport}
              disabled={importing}
              className="px-5 py-2.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 disabled:bg-gray-300 text-white rounded-lg flex items-center gap-1.5"
            >
              <Check className="w-4 h-4" /> {importing ? 'Importing…' : `Import ${validCount}`}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
