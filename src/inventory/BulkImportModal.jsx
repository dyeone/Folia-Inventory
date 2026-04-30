import { useState } from 'react';
import { AlertCircle, Check, Upload, FileText, ArrowLeft, ArrowRight, Sparkles } from 'lucide-react';
import * as XLSX from 'xlsx';
import { Modal } from '../ui/Modal.jsx';

// Database fields the user can map their CSV columns onto. Required ones
// must be mapped before they can advance to preview.
const FIELDS = [
  { key: 'category',     label: 'Category',          required: true,  hint: 'Values: tc or plant' },
  { key: 'species',      label: 'Species (genus)',   required: true,  hint: 'Alocasia, Monstera — must already be in catalog' },
  { key: 'variety',      label: 'Variety (cultivar)',required: true,  hint: "e.g. Alocasia cuprea 'Super Pink' — auto-added if new" },
  { key: 'qty',          label: 'Quantity',          required: true },
  { key: 'cost',         label: 'Cost / unit',       required: false, hint: 'Currency symbols and commas are stripped' },
  { key: 'listingPrice', label: 'Listing price',     required: false },
  { key: 'source',       label: 'Source / supplier', required: false },
  { key: 'notes',        label: 'Notes',             required: false },
  { key: 'imageUrl',     label: 'Image URL',         required: false },
];

// Synonyms used only for the auto-suggested initial mapping. The user can
// override any of these in the mapping step.
const SYNONYMS = {
  category:     ['category', 'type'],
  species:      ['species', 'genus'],
  variety:      ['variety', 'cultivar', 'epithet', 'name'],
  qty:          ['qty', 'quantity'],
  cost:         ['totalunitcost', 'unitcost', 'cost', 'grosscost', 'unitpricefob', 'unitprice'],
  listingPrice: ['listingprice', 'price'],
  source:       ['source', 'supplier'],
  notes:        ['notes', 'description'],
  imageUrl:     ['imageurl', 'image'],
};

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function autoSuggest(headers) {
  const out = {};
  for (const [field, syns] of Object.entries(SYNONYMS)) {
    const match = headers.find(h => syns.includes(norm(h)));
    if (match) out[field] = match;
  }
  return out;
}

function normalizeCategory(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (s === 'plant' || s === 'plants') return 'plant';
  if (s === 'tc' || s === 'tissue culture' || s === 'tissueculture') return 'tc';
  return null;
}

// Strip currency symbols and thousands separators so "$1,922.66" → "1922.66".
// Returns null for blank/unparseable input so we don't send "" to numeric DB
// columns, which Postgres rejects with `invalid input syntax for type numeric`.
function cleanMoney(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const cleaned = s.replace(/[$,\s]/g, '');
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return null;
  return n;
}

// Pick a SKU code prefix for a new genus: first 3-6 letters of the name,
// escalating length until it doesn't collide with any code already taken
// (existing catalog codes plus codes already chosen for other new genera in
// this same import).
function suggestCode(name, takenCodes) {
  const clean = String(name).toUpperCase().replace(/[^A-Z]/g, '');
  if (!clean) return 'XXX';
  for (let len = 3; len <= Math.min(6, clean.length); len++) {
    const c = clean.slice(0, len);
    if (!takenCodes.has(c)) return c;
  }
  // Exhausted distinct prefixes — append a digit suffix.
  const base = clean.slice(0, 3);
  for (let i = 2; i < 100; i++) {
    const c = `${base}${i}`;
    if (!takenCodes.has(c)) return c;
  }
  return base;
}

function parseRows(rows, mapping, varieties, species) {
  if (rows.length === 0) return { items: [], rowErrors: [], newSpecies: [], newVarieties: [] };

  const get = (row, field) => {
    const col = mapping[field];
    if (!col) return '';
    const v = row[col];
    return v === undefined || v === null ? '' : v;
  };

  const varietyByName = Object.fromEntries(varieties.map(v => [v.name.toLowerCase(), v]));
  const speciesByKey = Object.fromEntries(
    species.map(s => [`${s.varietyId}:${s.epithet.toLowerCase()}`, s])
  );

  const items = [];
  const rowErrors = [];
  const newSpecies = [];
  const newSpeciesSeen = new Set();
  const newVarieties = [];
  const newVarietyByName = new Map(); // lowercased name → { name, code, _placeholderId }
  const takenCodes = new Set(varieties.map(v => v.code).filter(Boolean));

  rows.forEach((row, idx) => {
    const lineNo = idx + 2; // header is row 1
    const category     = normalizeCategory(get(row, 'category'));
    const genusName    = String(get(row, 'species')).trim();
    const cultivarName = String(get(row, 'variety')).trim();
    const qty          = parseInt(get(row, 'qty'), 10);

    if (!category)     { rowErrors.push(`Row ${lineNo}: category must be "tc" or "plant"`); return; }
    if (!genusName)    { rowErrors.push(`Row ${lineNo}: species (genus) required`); return; }
    if (!cultivarName) { rowErrors.push(`Row ${lineNo}: variety (cultivar) required`); return; }
    if (!qty || qty < 1) { rowErrors.push(`Row ${lineNo}: qty must be a positive number`); return; }

    const lowerGenus = genusName.toLowerCase();
    let variety = varietyByName[lowerGenus];
    let placeholderVarietyId = null;

    if (!variety) {
      // Queue a new variety for creation. Use a placeholder id so we can
      // bind species/items to it now and resolve to the real id at import.
      let pending = newVarietyByName.get(lowerGenus);
      if (!pending) {
        const code = suggestCode(genusName, takenCodes);
        takenCodes.add(code);
        pending = {
          name: genusName,
          code,
          _placeholderId: `__new_${lowerGenus}`,
        };
        newVarietyByName.set(lowerGenus, pending);
        newVarieties.push(pending);
      }
      placeholderVarietyId = pending._placeholderId;
    }

    const varietyId = variety?.id || placeholderVarietyId;
    const varietyDisplayName = variety?.name || genusName;

    const sKey = `${varietyId}:${cultivarName.toLowerCase()}`;
    const existing = variety ? speciesByKey[sKey] : null;
    if (!existing && !newSpeciesSeen.has(sKey)) {
      newSpeciesSeen.add(sKey);
      newSpecies.push({
        varietyId,                        // may be a placeholder for new genera
        varietyName: varietyDisplayName,
        epithet: cultivarName,
      });
    }

    const costRaw = cleanMoney(get(row, 'cost'));

    items.push({
      type: category,
      variety: varietyDisplayName,
      name: cultivarName,
      _speciesKey: sKey,
      speciesId: existing?.id || null,
      quantity: qty,
      grossCost:    costRaw,
      cost:         costRaw,
      listingPrice: cleanMoney(get(row, 'listingPrice')),
      source:       String(get(row, 'source')).trim(),
      notes:        String(get(row, 'notes')).trim(),
      imageUrl:     String(get(row, 'imageUrl')).trim(),
      status: 'available',
    });
  });

  return { items, rowErrors, newSpecies, newVarieties };
}

export function BulkImportModal({ varieties = [], species = [], onCreateVariety, onCreateSpecies, onImport, onClose }) {
  const [step, setStep] = useState('upload'); // upload | mapping | preview
  const [fileName, setFileName] = useState('');
  const [csvHeaders, setCsvHeaders] = useState([]);
  const [csvRows, setCsvRows] = useState([]);
  const [mapping, setMapping] = useState({});
  const [parsed, setParsed] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);

  const handleFile = async (file) => {
    setErr('');
    setLoading(true);
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      if (rows.length === 0) {
        setErr('The file has no rows.');
        setLoading(false);
        return;
      }
      const headers = Object.keys(rows[0]);
      setCsvHeaders(headers);
      setCsvRows(rows);
      setMapping(autoSuggest(headers));
      setStep('mapping');
    } catch (e) {
      setErr(`Could not read file: ${e.message}`);
    }
    setLoading(false);
  };

  const handleConfirmMapping = () => {
    const missing = FIELDS.filter(f => f.required && !mapping[f.key]).map(f => f.label);
    if (missing.length) {
      setErr(`Map these required fields first: ${missing.join(', ')}`);
      return;
    }
    setErr('');
    setParsed(parseRows(csvRows, mapping, varieties, species));
    setStep('preview');
  };

  const reset = () => {
    setStep('upload');
    setFileName('');
    setCsvHeaders([]);
    setCsvRows([]);
    setMapping({});
    setParsed(null);
    setErr('');
  };

  const handleImport = async () => {
    if (!parsed || parsed.items.length === 0) return;
    setImporting(true);
    setErr('');
    try {
      // 1. Create new varieties first; remember placeholder → real id.
      const realVarietyId = {};
      for (const nv of parsed.newVarieties) {
        const created = await onCreateVariety({ name: nv.name, code: nv.code });
        realVarietyId[nv._placeholderId] = created.id;
      }

      // 2. Create new species under their (now real) variety ids. Re-key by
      // the same `${varietyId}:${epithet}` lookup the items use.
      const newSpeciesIdByKey = {};
      for (const ns of parsed.newSpecies) {
        const resolvedVarietyId = realVarietyId[ns.varietyId] || ns.varietyId;
        const created = await onCreateSpecies({ varietyId: resolvedVarietyId, epithet: ns.epithet });
        // Items reference the original (possibly-placeholder) varietyId in
        // their _speciesKey, so we re-key the same way to match them.
        newSpeciesIdByKey[`${ns.varietyId}:${ns.epithet.toLowerCase()}`] = created.id;
      }

      const finalItems = parsed.items.map(({ _speciesKey, ...rest }) => ({
        ...rest,
        speciesId: rest.speciesId || newSpeciesIdByKey[_speciesKey] || null,
      }));
      await onImport(finalItems);
    } catch (e) {
      setErr(e.message || 'Import failed');
    }
    setImporting(false);
  };

  return (
    <Modal title="Bulk Import SKUs" onClose={onClose} size="lg">
      <div className="space-y-3">
        {step === 'upload' && (
          <UploadStep loading={loading} onFile={handleFile} err={err} />
        )}
        {step === 'mapping' && (
          <MappingStep
            fileName={fileName}
            headers={csvHeaders}
            rows={csvRows}
            mapping={mapping}
            onMappingChange={setMapping}
            onBack={reset}
            onContinue={handleConfirmMapping}
            err={err}
          />
        )}
        {step === 'preview' && parsed && (
          <PreviewStep
            fileName={fileName}
            parsed={parsed}
            importing={importing}
            err={err}
            onBack={() => { setStep('mapping'); setErr(''); }}
            onImport={handleImport}
          />
        )}

        {/* Footer: Cancel is always present; primary action varies by step */}
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-100 active:bg-gray-200 rounded-lg">
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

function UploadStep(props) {
  const { loading, onFile, err } = props;
  return (
    <>
      <div className="text-sm text-gray-600 bg-gray-50 rounded-lg p-3">
        Upload your spreadsheet — you'll map columns to database fields on the next step.
        <span className="text-emerald-700 font-medium"> SKUs are generated automatically.</span>
      </div>
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
            onChange={(e) => { if (e.target.files?.[0]) onFile(e.target.files[0]); }}
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
  );
}

function MappingStep(props) {
  const { fileName, headers, rows, mapping, onMappingChange, onBack, onContinue, err } = props;

  // Track which CSV columns have already been mapped to avoid double-mapping
  // the same column to two fields (still allowed, but flag it visually).
  const usedCounts = {};
  for (const v of Object.values(mapping)) if (v) usedCounts[v] = (usedCounts[v] || 0) + 1;

  const setField = (field, header) => {
    onMappingChange({ ...mapping, [field]: header || '' });
  };

  return (
    <>
      <div className="flex items-center justify-between text-sm">
        <div>
          <FileText className="w-4 h-4 inline mr-1 text-gray-400" />
          <span className="font-medium text-gray-900">{fileName}</span>
          <span className="text-gray-500"> · {rows.length} rows · {headers.length} columns</span>
        </div>
        <button onClick={onBack} className="text-xs text-gray-600 hover:text-gray-900 flex items-center gap-1">
          <ArrowLeft className="w-3 h-3" /> Different file
        </button>
      </div>

      <div className="border border-gray-200 rounded-lg overflow-hidden">
        <div className="bg-gray-50 px-3 py-1.5 text-[11px] font-medium text-gray-600 uppercase tracking-wide border-b border-gray-200">
          First 3 rows of your file
        </div>
        <div className="overflow-x-auto max-h-32">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                {headers.map(h => (
                  <th key={h} className="px-2 py-1.5 text-left font-medium text-gray-700 whitespace-nowrap border-r border-gray-100 last:border-r-0">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.slice(0, 3).map((r, i) => (
                <tr key={i}>
                  {headers.map(h => (
                    <td key={h} className="px-2 py-1.5 text-gray-700 whitespace-nowrap max-w-[160px] truncate border-r border-gray-100 last:border-r-0">
                      {String(r[h] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-2.5 text-xs text-emerald-900">
        <Sparkles className="w-3.5 h-3.5 inline mr-1" />
        Pre-filled with best guesses based on your column names — adjust any that look wrong.
      </div>

      <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
        {FIELDS.map(f => {
          const value = mapping[f.key] || '';
          const sample = value && rows[0] ? String(rows[0][value] ?? '') : '';
          const used = value && usedCounts[value] > 1;
          return (
            <div key={f.key} className="grid grid-cols-12 gap-3 items-center px-3 py-2.5">
              <div className="col-span-5">
                <div className="text-sm font-medium text-gray-900 flex items-center gap-1">
                  {f.label}
                  {f.required && <span className="text-red-500">*</span>}
                </div>
                {f.hint && <div className="text-[11px] text-gray-500 mt-0.5">{f.hint}</div>}
              </div>
              <div className="col-span-7">
                <select
                  value={value}
                  onChange={(e) => setField(f.key, e.target.value)}
                  className={`w-full px-2.5 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 ${
                    f.required && !value ? 'border-amber-300 bg-amber-50' : 'border-gray-300'
                  }`}
                >
                  <option value="">— Skip —</option>
                  {headers.map(h => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
                {sample && (
                  <div className="text-[11px] text-gray-500 mt-1 truncate">
                    sample: <span className="font-mono">{sample}</span>
                    {used && <span className="text-amber-600 ml-2">· also used by another field</span>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {err && (
        <div className="flex items-start gap-2 bg-red-50 text-red-700 text-sm px-3 py-2 rounded-lg whitespace-pre-line">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {err}
        </div>
      )}

      <div className="flex gap-2 justify-end">
        <button
          onClick={onContinue}
          className="px-5 py-2.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white rounded-lg flex items-center gap-1.5"
        >
          Preview <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </>
  );
}

function PreviewStep(props) {
  const { fileName, parsed, importing, err, onBack, onImport } = props;
  const validCount = parsed.items.length;
  const errCount = parsed.rowErrors.length;
  const newSpeciesCount = parsed.newSpecies.length;
  const newVarietyCount = parsed.newVarieties?.length || 0;

  return (
    <>
      <div className="flex items-center justify-between text-sm">
        <div>
          <FileText className="w-4 h-4 inline mr-1 text-gray-400" />
          <span className="font-medium text-gray-900">{fileName}</span>
          <span className="text-gray-500"> · {validCount} valid · {errCount} skipped</span>
        </div>
        <button onClick={onBack} className="text-xs text-gray-600 hover:text-gray-900 flex items-center gap-1">
          <ArrowLeft className="w-3 h-3" /> Edit mapping
        </button>
      </div>

      {validCount > 0 && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-900">
          <div className="font-medium mb-0.5">Ready to import {validCount} item{validCount === 1 ? '' : 's'}</div>
          <div className="text-emerald-700 text-xs">SKUs will be assigned automatically on save.</div>
        </div>
      )}

      {newVarietyCount > 0 && (
        <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 text-sm text-purple-900">
          <div className="font-medium mb-1 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5" /> {newVarietyCount} new {newVarietyCount === 1 ? 'genus' : 'genera'} will be added to the catalog
          </div>
          <ul className="text-purple-800 text-xs space-y-0.5 max-h-24 overflow-y-auto">
            {parsed.newVarieties.slice(0, 10).map((nv, i) => (
              <li key={i}>· {nv.name} <span className="text-purple-500 font-mono">({nv.code})</span></li>
            ))}
            {newVarietyCount > 10 && <li>…and {newVarietyCount - 10} more</li>}
          </ul>
          <div className="text-purple-700 text-[11px] mt-1.5">
            SKU prefixes auto-derived from the name. You can rename them later from the catalog screen.
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
                <th className="px-2 py-1.5 text-left font-medium">Species</th>
                <th className="px-2 py-1.5 text-left font-medium">Variety</th>
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

      {validCount > 0 && (
        <div className="flex gap-2 justify-end">
          <button
            onClick={onImport}
            disabled={importing}
            className="px-5 py-2.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 disabled:bg-gray-300 text-white rounded-lg flex items-center gap-1.5"
          >
            <Check className="w-4 h-4" /> {importing ? 'Importing…' : `Import ${validCount}`}
          </button>
        </div>
      )}
    </>
  );
}
