import { useState } from 'react';
import { AlertCircle, Check } from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';

export function BulkImportModal({ onImport, onClose }) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState('');

  const parseText = () => {
    setErr('');
    try {
      const lines = text.trim().split('\n').filter(l => l.trim());
      if (lines.length < 2) {
        setErr('Need at least a header row and one data row.');
        return;
      }
      const delim = lines[0].includes('\t') ? '\t' : ',';
      const headers = lines[0].split(delim).map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
      const required = ['sku', 'type', 'name'];
      const missing = required.filter(r => !headers.includes(r));
      if (missing.length) {
        setErr(`Missing required columns: ${missing.join(', ')}`);
        return;
      }
      const parsed = lines.slice(1).map(line => {
        const vals = line.split(delim).map(v => v.trim().replace(/^"|"$/g, ''));
        const obj = {};
        headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
        return {
          sku: obj.sku,
          type: obj.type?.toLowerCase() === 'plant' ? 'plant' : 'tc',
          name: obj.name,
          variety: obj.variety || '',
          quantity: parseInt(obj.quantity) || 1,
          cost: obj.cost || '',
          listingPrice: obj['listing price'] || obj.listingprice || obj.price || '',
          source: obj.source || '',
          notes: obj.notes || obj.description || '',
          imageUrl: obj['image url'] || obj.imageurl || obj.image || '',
          status: 'available',
        };
      }).filter(i => i.sku && i.name);
      setPreview(parsed);
    } catch (e) {
      setErr('Could not parse. Check format.');
    }
  };

  return (
    <Modal title="Bulk Import SKUs" onClose={onClose}>
      <div className="space-y-3">
        <div className="text-xs text-gray-600">
          Paste CSV or TSV. Required columns: <span className="font-mono bg-gray-100 px-1">sku</span>, <span className="font-mono bg-gray-100 px-1">type</span>, <span className="font-mono bg-gray-100 px-1">name</span>. Optional: variety, quantity, cost, listing price, image url, source, notes.
        </div>
        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); setPreview(null); }}
          rows="8"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
          placeholder="sku,type,name,variety,quantity,cost,listing price&#10;TC-001,tc,Monstera Albo,Japanese,1,15,45"
        />
        {err && (
          <div className="flex items-center gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
            <AlertCircle className="w-4 h-4" /> {err}
          </div>
        )}
        {preview && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-900">
            <div className="font-medium mb-1">Ready to import {preview.length} items</div>
            <div className="text-emerald-700">First row: {preview[0]?.sku} · {preview[0]?.name}</div>
          </div>
        )}
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
          {!preview ? (
            <button onClick={parseText} className="px-4 py-2 text-sm bg-gray-900 hover:bg-gray-800 text-white rounded-lg">Preview</button>
          ) : (
            <button onClick={() => onImport(preview)} className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg flex items-center gap-1.5">
              <Check className="w-4 h-4" /> Import {preview.length}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
