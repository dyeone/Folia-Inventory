import { useMemo, useState } from 'react';
import {
  Upload, ChevronDown, ChevronRight, FileText, AlertCircle,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { parsePalmstreetOrders } from './parsePalmstreetOrders.js';
import { matchInventory } from './matchInventory.js';
import { BoxesList } from './BoxesList.jsx';
import { InventoryPicker } from './InventoryPicker.jsx';

// Sandbox uploader — preview a Palmstreet orders file's matching results
// without applying anything. Useful for spot-checking files before
// running the real apply flow in SalesUploadModal.
export function StandaloneUploader({ inventoryItems }) {
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState('');
  const [boxes, setBoxes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [overrides, setOverrides] = useState({});
  const [pickerFor, setPickerFor] = useState(null);

  const handleFile = async (file) => {
    setErr('');
    setLoading(true);
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      const parsed = parsePalmstreetOrders(rows);
      if (parsed.length === 0) {
        setErr('No shippable items found in this file.');
        setBoxes(null);
      } else {
        setBoxes(parsed);
      }
    } catch (e) {
      setErr(`Could not read file: ${e.message}`);
      setBoxes(null);
    }
    setLoading(false);
  };

  const resolved = useMemo(() => {
    if (!boxes) return null;
    return boxes.map(box => ({
      ...box,
      items: box.items.map(item => {
        const key = `${box.id}::${item.rowKey}`;
        const override = overrides[key];
        let match = null;
        if (override === null) match = null;
        else if (override) {
          const inv = inventoryItems.find(i => i.id === override);
          match = inv ? { item: inv, confidence: 'manual' } : null;
        } else {
          match = matchInventory(item, inventoryItems);
        }
        return { ...item, match, manual: override !== undefined };
      }),
    }));
  }, [boxes, overrides, inventoryItems]);

  return (
    <section className="space-y-2">
      <button
        onClick={() => setOpen(!open)}
        className="text-sm font-medium text-gray-700 hover:text-gray-900 flex items-center gap-1"
      >
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        Standalone upload (not linked to a sale event)
      </button>
      {open && (
        <div className="bg-gray-50 rounded-xl p-4 space-y-3">
          {!boxes ? (
            <>
              <label className="block">
                <div className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center hover:border-emerald-400 hover:bg-white active:bg-emerald-50 cursor-pointer transition">
                  <Upload className="w-7 h-7 text-gray-400 mx-auto mb-2" />
                  <div className="text-sm sm:text-base text-gray-900">
                    {loading ? 'Reading file...' : 'Upload a Palmstreet orders file'}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">Preview only — does not change inventory</div>
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={(e) => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }}
                    className="hidden"
                  />
                </div>
              </label>
              {err && (
                <div className="flex items-start gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {err}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div className="text-sm">
                  <FileText className="w-3 h-3 inline mr-1 text-gray-400" />
                  <span className="font-medium text-gray-900">{fileName}</span>
                  <span className="text-gray-500"> · {resolved.length} boxes</span>
                </div>
                <button
                  onClick={() => { setBoxes(null); setFileName(''); setOverrides({}); }}
                  className="text-xs text-gray-600 hover:text-gray-900"
                >
                  Reset
                </button>
              </div>
              <BoxesList
                boxes={resolved}
                onPick={(boxId, rowKey, title) => setPickerFor({ boxId, rowKey, title })}
                onClearOverride={(boxId, rowKey) => {
                  const key = `${boxId}::${rowKey}`;
                  setOverrides(prev => ({ ...prev, [key]: null }));
                }}
              />
            </>
          )}
          {pickerFor && (
            <InventoryPicker
              title={pickerFor.title}
              inventoryItems={inventoryItems}
              onPick={(invId) => {
                const key = `${pickerFor.boxId}::${pickerFor.rowKey}`;
                setOverrides(prev => ({ ...prev, [key]: invId }));
                setPickerFor(null);
              }}
              onClose={() => setPickerFor(null)}
            />
          )}
        </div>
      )}
    </section>
  );
}
