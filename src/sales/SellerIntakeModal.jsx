import { useState } from 'react';
import { AlertCircle, Plus, Trash2, Loader2, Sprout } from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';
import { nextSkuForSeller } from '../constants.js';

// Intake a seller's plants INTO our inventory for one sale event. Each row
// becomes N inventory items (expanded by quantity), tagged with sellerId +
// commissionPct and pre-attached to the sale (saleId), so they land straight in
// the event's lineup and Palmstreet export. The server assigns the authoritative
// <SELLERCODE>-<VARIETY>-<n> SKU on save — the preview here is approximate.
//
// We deliberately reuse the normal item shape (type:'plant', status:'available')
// rather than the 0032 'consigned' status: that status means WE handed a plant
// out; here a seller handed a plant to US.

function numOrNull(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

let ROW_SEQ = 0;
const newRow = (commissionPct, varietyId = '') => ({
  key: `r${ROW_SEQ++}`,
  varietyId,
  name: '',
  quantity: 1,
  listingPrice: '',
  commissionPct: commissionPct ?? '',
});

export function SellerIntakeModal({ seller, sale, varieties = [], existingItems = [], isBae = false, onIntake, onClose, showToast }) {
  const defPct = seller?.defaultCommissionPct ?? '';
  // BAE sells anthuriums — every row starts on the Anthurium variety (the
  // dropdown stays editable). Folia's mixed catalog keeps the explicit pick.
  const defaultVarietyId = isBae
    ? (varieties.find(v => (v.code || '').toUpperCase() === 'ANT')
        ?? varieties.find(v => /^anthurium/i.test(v.name || '')))?.id ?? ''
    : '';
  const [rows, setRows] = useState([newRow(defPct, defaultVarietyId)]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const patch = (key, p) => setRows(rs => rs.map(r => (r.key === key ? { ...r, ...p } : r)));
  const addRow = () => setRows(rs => [...rs, newRow(defPct, defaultVarietyId)]);
  const removeRow = (key) => setRows(rs => (rs.length > 1 ? rs.filter(r => r.key !== key) : rs));

  const varietyById = new Map(varieties.map(v => [v.id, v]));
  const skuPreview = (row) => {
    const v = varietyById.get(row.varietyId);
    if (!v?.code) return '—';
    return nextSkuForSeller(seller?.code, v.code, existingItems) || '—';
  };

  const totalUnits = rows.reduce((n, r) => n + Math.max(1, parseInt(r.quantity, 10) || 1), 0);

  const submit = async () => {
    setErr('');
    const prepared = [];
    for (const r of rows) {
      const v = varietyById.get(r.varietyId);
      if (!v) return setErr('Pick a variety for every row');
      const name = r.name.trim();
      if (!name) return setErr('Every row needs a plant/species name');
      const qty = Math.max(1, parseInt(r.quantity, 10) || 1);
      const base = {
        type: 'plant',
        variety: v.name,
        name,
        sellerId: seller.id,
        commissionPct: numOrNull(r.commissionPct),
        listingPrice: numOrNull(r.listingPrice),
        saleId: sale.id,
        lotKind: 'sale',
        status: 'available',
        quantity: 1,
        grossCost: 0,
        netCost: 0,
      };
      for (let i = 0; i < qty; i++) prepared.push({ ...base });
    }
    if (prepared.length === 0) return setErr('Nothing to intake');
    setBusy(true);
    try {
      await onIntake(prepared);
      showToast?.(`Added ${prepared.length} plant${prepared.length === 1 ? '' : 's'} for ${seller.name}`);
      onClose();
    } catch (e) {
      setErr(e.message || 'Intake failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Add ${seller?.name || 'seller'}'s plants → ${sale?.name || 'sale'}`} onClose={onClose} size="xl">
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-xs text-gray-500 bg-emerald-50/60 rounded-lg px-3 py-2">
          <Sprout className="w-4 h-4 text-emerald-600 flex-shrink-0" />
          Plants are added to our inventory tagged to <span className="font-medium text-gray-700">{seller?.name}</span>
          {' '}(code <span className="font-mono">{seller?.code}</span>) and staged into this event. Labels &amp; SKUs carry the seller.
        </div>

        {err && (
          <div className="flex items-center gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
            <AlertCircle className="w-4 h-4 flex-shrink-0" /> {err}
          </div>
        )}

        <div className="space-y-2">
          {/* Header (sm+) */}
          <div className="hidden sm:grid grid-cols-[1.4fr_1.4fr_0.6fr_0.8fr_0.7fr_auto] gap-2 px-1 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
            <span>Variety</span><span>Plant / species</span><span>Qty</span><span>Price</span><span>Comm %</span><span />
          </div>
          {rows.map(r => (
            <div key={r.key} className="grid grid-cols-2 sm:grid-cols-[1.4fr_1.4fr_0.6fr_0.8fr_0.7fr_auto] gap-2 items-center">
              <select
                value={r.varietyId}
                onChange={(e) => patch(r.key, { varietyId: e.target.value })}
                className="input"
              >
                <option value="">Variety…</option>
                {varieties.map(v => <option key={v.id} value={v.id}>{v.name} ({v.code})</option>)}
              </select>
              <input
                type="text" value={r.name}
                onChange={(e) => patch(r.key, { name: e.target.value })}
                className="input" placeholder="e.g. warocqueanum"
              />
              <input
                type="number" min="1" value={r.quantity}
                onChange={(e) => patch(r.key, { quantity: e.target.value })}
                className="input" placeholder="1"
              />
              <input
                type="number" step="0.01" value={r.listingPrice}
                onChange={(e) => patch(r.key, { listingPrice: e.target.value })}
                className="input" placeholder="$"
              />
              <input
                type="number" step="1" min="0" max="100" value={r.commissionPct}
                onChange={(e) => patch(r.key, { commissionPct: e.target.value })}
                className="input" placeholder="%"
              />
              <div className="flex items-center gap-2 justify-end col-span-2 sm:col-span-1">
                <span className="text-[11px] font-mono text-gray-400 sm:hidden">≈ {skuPreview(r)}</span>
                <button
                  onClick={() => removeRow(r.key)}
                  disabled={rows.length === 1}
                  className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg disabled:opacity-30"
                  title="Remove row"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <div className="hidden sm:block col-span-full text-[11px] font-mono text-gray-400 -mt-1 pl-1">
                ≈ {skuPreview(r)}
              </div>
            </div>
          ))}
          <button
            onClick={addRow}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 rounded-lg"
          >
            <Plus className="w-4 h-4" /> Add another
          </button>
        </div>

        <div className="flex items-center justify-between gap-2 pt-2 border-t border-gray-100">
          <span className="text-sm text-gray-500">{totalUnits} plant{totalUnits === 1 ? '' : 's'} to add</span>
          <div className="flex gap-2">
            <button onClick={onClose} disabled={busy} className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg">
              Cancel
            </button>
            <button
              onClick={submit} disabled={busy}
              className="flex items-center gap-1.5 px-5 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white rounded-lg disabled:bg-gray-300"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sprout className="w-4 h-4" />} Add to event
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
