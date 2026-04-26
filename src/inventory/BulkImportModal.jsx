import { useState } from 'react';
import { AlertCircle, Check, Upload, FileText, ArrowLeft } from 'lucide-react';
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

function parseRows(rows) {
  const required = ['sku', 'type', 'name'];
  if (rows.length === 0) {
    return { error: 'The file has no rows.' };
  }
  const firstKeys = Object.keys(rows[0]).map(k => k.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const missing = required.filter(r => !firstKeys.includes(r));
  if (missing.length) {
    return { error: `Missing required columns: ${missing.join(', ')}. Found: ${Object.keys(rows[0]).join(', ')}` };
  }
  const parsed = rows.map(row => ({
    sku: String(pick(row, 'sku')).trim(),
    type: String(pick(row, 'type')).toLowerCase() === 'plant' ? 'plant' : 'tc',
    name: String(pick(row, 'name')).trim(),
    variety: String(pick(row, 'variety')).trim(),
    quantity: parseInt(pick(row, 'quantity', 'qty'), 10) || 1,
    cost: String(pick(row, 'cost', 'grosscost')).trim(),
    listingPrice: String(pick(row, 'listingprice', 'price')).trim(),
    source: String(pick(row, 'source', 'supplier')).trim(),
    notes: String(pick(row, 'notes', 'description')).trim(),
    imageUrl: String(pick(row, 'imageurl', 'image')).trim(),
    status: 'available',
  })).filter(i => i.sku && i.name);
  if (parsed.length === 0) {
    return { error: 'No valid rows found (each row needs a SKU and a name).' };
  }
  return { items: parsed };
}

export function BulkImportModal({ onImport, onClose }) {
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const handleFile = async (file) => {
    setErr('');
    setPreview(null);
    setLoading(true);
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      const result = parseRows(rows);
      if (result.error) setErr(result.error);
      else setPreview(result.items);
    } catch (e) {
      setErr(`Could not read file: ${e.message}`);
    }
    setLoading(false);
  };

  const reset = () => {
    setPreview(null);
    setFileName('');
    setErr('');
  };

  return (
    <Modal title="Bulk Import SKUs" onClose={onClose} size="lg">
      <div className="space-y-3">
        <div className="text-sm text-gray-600 bg-gray-50 rounded-lg p-3">
          Required columns: <span className="font-mono bg-white px-1.5 py-0.5 rounded border">sku</span>{' '}
          <span className="font-mono bg-white px-1.5 py-0.5 rounded border">type</span>{' '}
          <span className="font-mono bg-white px-1.5 py-0.5 rounded border">name</span>.
          Optional: <span className="text-gray-500">variety, quantity, cost, listing price, image url, source, notes</span>.
          Headers are matched case-insensitively.
        </div>

        {!preview ? (
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
              <div className="flex items-start gap-2 bg-red-50 text-red-700 text-sm px-3 py-2 rounded-lg">
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
                <span className="text-gray-500"> · {preview.length} valid rows</span>
              </div>
              <button onClick={reset} className="text-xs text-gray-600 hover:text-gray-900 flex items-center gap-1">
                <ArrowLeft className="w-3 h-3" /> Different file
              </button>
            </div>

            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-900">
              <div className="font-medium mb-1">Ready to import {preview.length} items</div>
              <div className="text-emerald-700 text-xs">
                First row: <span className="font-mono">{preview[0]?.sku}</span> · {preview[0]?.name}
                {preview[0]?.variety ? ` · ${preview[0].variety}` : ''}
              </div>
            </div>

            <div className="border border-gray-200 rounded-lg overflow-hidden max-h-72 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-500 uppercase sticky top-0">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">SKU</th>
                    <th className="px-2 py-1.5 text-left font-medium">Type</th>
                    <th className="px-2 py-1.5 text-left font-medium">Name</th>
                    <th className="px-2 py-1.5 text-left font-medium">Variety</th>
                    <th className="px-2 py-1.5 text-right font-medium">Qty</th>
                    <th className="px-2 py-1.5 text-right font-medium">Cost</th>
                    <th className="px-2 py-1.5 text-right font-medium">Price</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {preview.slice(0, 50).map((r, idx) => (
                    <tr key={idx}>
                      <td className="px-2 py-1.5 font-mono">{r.sku}</td>
                      <td className="px-2 py-1.5">{r.type}</td>
                      <td className="px-2 py-1.5 truncate max-w-[160px]">{r.name}</td>
                      <td className="px-2 py-1.5 text-gray-600 truncate max-w-[120px]">{r.variety || '—'}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.quantity}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.cost || '—'}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.listingPrice || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.length > 50 && (
                <div className="px-3 py-1.5 text-[11px] text-gray-500 bg-gray-50 border-t border-gray-200">
                  …and {preview.length - 50} more rows
                </div>
              )}
            </div>
          </>
        )}

        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-100 active:bg-gray-200 rounded-lg">
            Cancel
          </button>
          {preview && (
            <button
              onClick={() => onImport(preview)}
              className="px-5 py-2.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white rounded-lg flex items-center gap-1.5"
            >
              <Check className="w-4 h-4" /> Import {preview.length}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
