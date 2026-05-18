import { useState, useRef, useEffect } from 'react';
import {
  X, PackageOpen, ChevronRight, Camera, Trash2, ScanLine, Check,
} from 'lucide-react';
import { api } from '../api.js';
import { CameraScanner } from './CameraScanner.jsx';
import { shortBoxCode } from '../labels/boxCode.js';

// Admin-only: open an empty box manually, then scan inventory SKUs to
// drop them into it. Each scan stamps the existing inventory_items row
// with the buyer info + the new shipmentBoxId, flipping the item to
// 'sold'. A box exists in the rest of the system once it has at least
// one item referencing its shipmentBoxId — there's no separate boxes
// table — so closing the modal with zero scans is a no-op (cleanly).
//
// Use cases the admin reaches for this for:
//   - shipping a replacement / gift / sample outside the Palmstreet flow
//   - consolidating an off-platform custom order
//   - fixing a manual mistake without a fake spreadsheet roundtrip

// Generate a fresh shipmentBoxId distinct from upload-generated ones so
// it's obvious in the data that this box was created by hand.
function newManualBoxId() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 7);
  return `manual-${t}-${r}`;
}

const CARRIERS = [
  { value: 'usps', label: 'USPS' },
  { value: 'ups',  label: 'UPS'  },
];

export function NewBoxModal({ inventoryItems, onClose, onRefreshItems, showToast }) {
  // Two-phase modal: 'form' = collect buyer info, 'scan' = scan items
  // into the just-created box. The box id is generated once at the
  // form → scan transition and reused for every scan.
  const [phase, setPhase] = useState('form');
  const [boxId, setBoxId] = useState(null);
  const [scannerOpen, setScannerOpen] = useState(false);

  const [form, setForm] = useState({
    recipientName: '',
    username: '',
    street1: '',
    street2: '',
    city: '',
    state: '',
    zip: '',
    country: 'US',
    shipmentMethod: '',
    carrier: 'usps',
  });
  const [manualSku, setManualSku] = useState('');

  // Items added so far in this session. Each entry is the post-update
  // shape so the list renders without a parent refetch round-trip.
  const [addedItems, setAddedItems] = useState([]);
  const [err, setErr] = useState('');

  const updateField = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  const openBoxForScanning = () => {
    setErr('');
    if (!form.recipientName.trim()) {
      setErr('Recipient name is required.');
      return;
    }
    setBoxId(newManualBoxId());
    setPhase('scan');
  };

  // Lookup an inventory item by SKU and stamp it with the new box
  // metadata. Matches the post-upload apply step's column set so the
  // resulting item is indistinguishable from an upload-created one in
  // every downstream view (Shipping tab, Packer view, labels, etc.).
  const handleScan = async (rawText) => {
    setErr('');
    const sku = String(rawText || '').trim().toUpperCase();
    if (!sku) return;

    const item = inventoryItems.find(i =>
      !i.deletedAt && String(i.sku || '').toUpperCase() === sku
    );
    if (!item) {
      showToast?.(`No inventory item with SKU ${sku}`, 'error');
      return;
    }
    if (addedItems.some(a => a.id === item.id)) {
      showToast?.(`${sku} is already in this box`);
      return;
    }
    if (['sold', 'shipped', 'delivered'].includes(item.status) && item.shipmentBoxId && item.shipmentBoxId !== boxId) {
      showToast?.(`${sku} is already in another box — find it via Scan box`, 'error');
      return;
    }

    const now = new Date().toISOString();
    const buyerAddress = {
      street1: form.street1.trim(),
      street2: form.street2.trim(),
      city: form.city.trim(),
      state: form.state.trim(),
      zip: form.zip.trim(),
      country: form.country.trim(),
      shipmentMethod: form.shipmentMethod.trim(),
    };
    const patch = {
      id: item.id,
      status: 'sold',
      soldAt: now,
      buyer: form.recipientName.trim(),
      buyerUsername: form.username.trim(),
      buyerAddress,
      shipmentBoxId: boxId,
      shipmentCarrier: form.carrier,
    };

    // Optimistic: show the item immediately, roll back on failure.
    const optimistic = { ...item, ...patch };
    setAddedItems(prev => [optimistic, ...prev]);
    if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(20);

    try {
      await api.upsertItems([patch]);
    } catch (e) {
      setAddedItems(prev => prev.filter(a => a.id !== item.id));
      showToast?.(`Failed to add ${sku}: ${e.message || 'unknown'}`, 'error');
    }
  };

  const handleManualSubmit = async (e) => {
    e.preventDefault();
    if (!manualSku.trim()) return;
    await handleScan(manualSku);
    setManualSku('');
  };

  const handleDone = async () => {
    // Refresh items in the parent so the new box appears in the
    // Shipping tab's Ready section right after close. No-op effectively
    // if no scans happened (the box never persisted anything).
    await onRefreshItems?.();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-stretch sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-2xl h-full sm:h-auto sm:max-h-[92vh] sm:rounded-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-gray-200 px-4 sm:px-5 py-3 sm:py-4 flex items-center justify-between flex-shrink-0">
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-gray-900 text-base sm:text-lg flex items-center gap-2">
              <PackageOpen className="w-5 h-5 text-emerald-600" />
              {phase === 'form' ? 'New box' : `Box ${shortBoxCode(boxId)}`}
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {phase === 'form'
                ? 'Enter the buyer info, then scan inventory SKUs to add them.'
                : `${addedItems.length} item${addedItems.length === 1 ? '' : 's'} added · scan more or hit Done.`}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-2 -mr-1 text-gray-500 hover:bg-gray-100 active:bg-gray-200 rounded-lg ml-2">
            <X className="w-5 h-5" />
          </button>
        </div>

        {phase === 'form' && (
          <BuyerForm
            form={form}
            err={err}
            updateField={updateField}
            onSubmit={openBoxForScanning}
            onCancel={onClose}
          />
        )}

        {phase === 'scan' && (
          <ScanPanel
            boxId={boxId}
            form={form}
            addedItems={addedItems}
            manualSku={manualSku}
            setManualSku={setManualSku}
            onManualSubmit={handleManualSubmit}
            onOpenScanner={() => setScannerOpen(true)}
            onDone={handleDone}
          />
        )}
      </div>

      {scannerOpen && (
        <CameraScanner
          onScan={(text) => {
            handleScan(text);
            setScannerOpen(false);
          }}
          onClose={() => setScannerOpen(false)}
        />
      )}
    </div>
  );
}

function BuyerForm({ form, err, updateField, onSubmit, onCancel }) {
  // First-field autofocus is intentional: this modal opens from a
  // button click on the Shipping tab, so the operator is already
  // committed to typing.
  const nameRef = useRef(null);
  useEffect(() => { nameRef.current?.focus(); }, []);

  return (
    <>
      <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-4 space-y-3">
        <Field label="Recipient name" required>
          <input
            ref={nameRef}
            type="text"
            value={form.recipientName}
            onChange={(e) => updateField('recipientName', e.target.value)}
            placeholder="e.g. Abby Maldonado"
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          />
        </Field>

        <Field label="Palmstreet @username (optional)">
          <input
            type="text"
            value={form.username}
            onChange={(e) => updateField('username', e.target.value)}
            placeholder="abby_m"
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          />
        </Field>

        <Field label="Carrier">
          <div className="flex gap-2">
            {CARRIERS.map(c => (
              <button
                key={c.value}
                type="button"
                onClick={() => updateField('carrier', c.value)}
                className={`flex-1 px-3 py-2 text-sm font-medium rounded-lg border transition ${
                  form.carrier === c.value
                    ? c.value === 'ups'
                      ? 'bg-amber-100 border-amber-400 text-amber-900'
                      : 'bg-blue-100 border-blue-400 text-blue-900'
                    : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </Field>

        <div className="grid grid-cols-1 gap-3">
          <Field label="Street line 1">
            <input
              type="text"
              value={form.street1}
              onChange={(e) => updateField('street1', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
            />
          </Field>
          <Field label="Street line 2 (optional)">
            <input
              type="text"
              value={form.street2}
              onChange={(e) => updateField('street2', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Field label="City">
            <input
              type="text"
              value={form.city}
              onChange={(e) => updateField('city', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
            />
          </Field>
          <Field label="State">
            <input
              type="text"
              value={form.state}
              onChange={(e) => updateField('state', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
            />
          </Field>
          <Field label="ZIP">
            <input
              type="text"
              value={form.zip}
              onChange={(e) => updateField('zip', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
            />
          </Field>
          <Field label="Country">
            <input
              type="text"
              value={form.country}
              onChange={(e) => updateField('country', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
            />
          </Field>
        </div>

        {err && (
          <div className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded-lg">{err}</div>
        )}
      </div>
      <div className="border-t border-gray-200 px-4 sm:px-5 py-3 flex items-center justify-end gap-2 flex-shrink-0">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 active:bg-gray-200 rounded-lg"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white rounded-lg inline-flex items-center gap-1.5"
        >
          Open box & scan <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </>
  );
}

function ScanPanel({ boxId, form, addedItems, manualSku, setManualSku, onManualSubmit, onOpenScanner, onDone }) {
  return (
    <>
      <div className="px-4 sm:px-5 py-3 bg-gray-50 border-b border-gray-200 flex-shrink-0">
        <div className="flex items-center gap-2 text-sm text-gray-700">
          <span className={`inline-flex items-center px-2 py-0.5 text-xs font-bold tracking-wider rounded ${
            form.carrier === 'ups'
              ? 'bg-amber-100 text-amber-900'
              : 'bg-blue-100 text-blue-900'
          }`}>
            {form.carrier.toUpperCase()}
          </span>
          <span className="font-medium text-gray-900 truncate">{form.recipientName}</span>
          {form.username && <span className="text-gray-500 truncate">@{form.username}</span>}
        </div>
        <div className="text-xs text-gray-500 mt-1 font-mono">{shortBoxCode(boxId)}</div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-3 space-y-1.5">
        {addedItems.length === 0 ? (
          <div className="text-center py-12 text-sm text-gray-400">
            <ScanLine className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            Scan or type a SKU to add the first item.
          </div>
        ) : (
          addedItems.map(item => (
            <div key={item.id} className="flex items-center gap-2 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg">
              <Check className="w-4 h-4 text-emerald-600 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-mono text-emerald-700">{item.sku}</div>
                {(item.name || item.variety) && (
                  <div className="text-xs text-emerald-700 opacity-80 truncate">
                    {[item.name, item.variety].filter(Boolean).join(' · ')}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <form
        onSubmit={onManualSubmit}
        className="border-t border-gray-200 px-4 sm:px-5 py-3 flex-shrink-0 space-y-2 bg-white"
      >
        <button
          type="button"
          onClick={onOpenScanner}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 text-base font-semibold bg-emerald-600 text-white rounded-xl active:bg-emerald-800"
        >
          <Camera className="w-5 h-5" /> Scan item
        </button>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={manualSku}
            onChange={(e) => setManualSku(e.target.value)}
            placeholder="or type SKU"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="flex-1 px-3 py-2 text-sm font-mono uppercase border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
          />
          <button
            type="submit"
            disabled={!manualSku.trim()}
            className="px-3 py-2 text-sm font-medium bg-gray-900 text-white rounded-lg disabled:bg-gray-300"
          >
            Add
          </button>
          <button
            type="button"
            onClick={onDone}
            className="px-4 py-2 text-sm font-medium bg-white border border-emerald-600 text-emerald-700 rounded-lg hover:bg-emerald-50 active:bg-emerald-100"
          >
            Done
          </button>
        </div>
      </form>
    </>
  );
}

function Field({ label, required, children }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-gray-700">
        {label} {required && <span className="text-red-600">*</span>}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
