import { useEffect, useState } from 'react';
import { X, Truck, MapPin, Package, AlertCircle, Check, FlaskConical, ShoppingCart } from 'lucide-react';
import { api } from '../api.js';
import { ShipDateField } from './ShipDateField.jsx';
import { shipDateProblem } from './shipDate.js';

// Confirmation modal for buying a single shipping label. Pre-fills weight
// and dims from the saved settings; the user can override before
// confirming. The actual ShipStation call happens server-side via
// /api/shipstation/buy-label, which also persists the shipment row.
//
// "Test mode" (per Settings) is shown prominently — when on, the label
// returned is a placeholder and ShipStation does not charge.

export function BuyLabelModal({ box, onClose, onPurchased, showToast }) {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [buying, setBuying] = useState(false);
  const [err, setErr] = useState('');

  // Per-purchase overrides (don't persist to settings)
  const [weightOz, setWeightOz] = useState('');
  const [length, setLength] = useState('');
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [serviceCode, setServiceCode] = useState('');
  // Deliberately empty: the operator must pick the ship date before buying.
  const [shipDate, setShipDate] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const row = await api.getSettings('shipping');
        const s = row?.data || {};
        setSettings(s);
        const pkg = s.defaultPackage || {};
        setWeightOz(String(pkg.weightOz ?? 16));
        setLength(String(pkg.length ?? 12));
        setWidth(String(pkg.width ?? 9));
        setHeight(String(pkg.height ?? 6));
        setServiceCode(s.carriers?.[box.carrier]?.serviceCode || '');
      } catch (e) {
        setErr(e.message || 'Failed to load settings');
      }
      setLoading(false);
    })();
  }, [box.carrier]);

  const shipFromOk = settings?.shipFrom &&
    ['name','street1','city','state','zip','country'].every(k => (settings.shipFrom[k] || '').trim());

  const handleBuy = async () => {
    // Click-time re-check (the modal can sit open across midnight) — and say
    // so, rather than a silent no-op on a button that still looks enabled.
    const dateProblem = shipDateProblem(shipDate);
    if (dateProblem) { setErr(`Ship date: ${dateProblem}`); return; }
    setErr('');
    setBuying(true);
    try {
      const shipment = await api.buyLabel({
        shipmentBoxId: box.id,
        weightOz: parseFloat(weightOz) || undefined,
        dims: { length: parseFloat(length), width: parseFloat(width), height: parseFloat(height) },
        serviceCode: serviceCode || undefined,
        shipDate,
      });
      showToast?.(`Label purchased${shipment.isTestLabel ? ' (test)' : ''} · ${shipment.trackingNumber || 'no tracking'}`);
      onPurchased?.(shipment);
      onClose();
    } catch (e) {
      setErr(e.message || 'Purchase failed');
    }
    setBuying(false);
  };

  const a = box.address || {};
  const addressLine = [
    a.street1, a.street2,
    [a.city, a.state, a.zip].filter(Boolean).join(', '),
    a.country && a.country !== 'US' ? a.country : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-stretch sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-lg h-full sm:h-auto sm:rounded-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-gray-200 px-4 sm:px-5 py-3 sm:py-4 flex items-center justify-between flex-shrink-0">
          <h3 className="font-semibold text-gray-900 text-base sm:text-lg flex items-center gap-2">
            <ShoppingCart className="w-5 h-5 text-emerald-600" /> Buy {box.carrier?.toUpperCase()} Label
          </h3>
          <button onClick={onClose} className="p-2 -mr-1 text-gray-500 hover:bg-gray-100 rounded-lg" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-4 space-y-4">
          {loading ? (
            <div className="text-sm text-gray-500 text-center py-12">Loading…</div>
          ) : !shipFromOk ? (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-gray-700">
                <div className="font-medium text-gray-900">Ship-from address missing</div>
                <p className="text-xs mt-1">Open <strong>Shipping Settings</strong> in the user menu and fill in the From address before buying labels.</p>
              </div>
            </div>
          ) : (
            <>
              {settings.testMode !== false && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2 text-xs">
                  <FlaskConical className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div className="text-amber-900">
                    <strong>Test mode</strong> — ShipStation returns a placeholder label and does <em>not</em> charge. Toggle off in Shipping Settings to buy real labels.
                  </div>
                </div>
              )}

              {/* Recipient summary */}
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-3">
                <div className="font-medium text-gray-900">{box.recipientName}</div>
                {box.username && <div className="text-xs text-gray-500">@{box.username}</div>}
                <div className="text-xs text-gray-600 mt-1 flex items-start gap-1">
                  <MapPin className="w-3 h-3 mt-0.5 flex-shrink-0" /> {addressLine || '(no address)'}
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {box.items.length} {box.items.length === 1 ? 'item' : 'items'}
                </div>
              </div>

              {/* Required first step: the date the carrier gets for this
                  label — pick it before the buy button arms. */}
              <div className="border border-gray-200 rounded-xl px-3 py-2 bg-gray-50">
                <ShipDateField value={shipDate} onChange={setShipDate} disabled={buying} />
              </div>

              {/* Service code (overridable) */}
              <Field label="Service code" value={serviceCode} onChange={setServiceCode}
                hint={`Default for ${box.carrier?.toUpperCase()}: ${settings.carriers?.[box.carrier]?.serviceCode || '—'}`} />

              {/* Weight */}
              <Field label="Weight (oz)" type="number" value={weightOz} onChange={setWeightOz} />

              {/* Dims */}
              <div className="grid grid-cols-3 gap-2">
                <Field label="Length (in)" type="number" value={length} onChange={setLength} />
                <Field label="Width (in)" type="number" value={width} onChange={setWidth} />
                <Field label="Height (in)" type="number" value={height} onChange={setHeight} />
              </div>

              {err && (
                <div className="flex items-start gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {err}
                </div>
              )}
            </>
          )}
        </div>

        <div className="border-t border-gray-200 px-4 sm:px-5 py-3 flex justify-end gap-2 flex-shrink-0 bg-white">
          <button onClick={onClose} className="px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
          <button
            onClick={handleBuy}
            disabled={buying || loading || !shipFromOk || !!shipDateProblem(shipDate)}
            title={shipDateProblem(shipDate) ? `Ship date: ${shipDateProblem(shipDate)}` : undefined}
            className={`px-5 py-2.5 text-sm font-medium text-white rounded-lg flex items-center gap-1.5 disabled:bg-gray-300 ${
              settings?.testMode === false ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-amber-600 hover:bg-amber-700'
            }`}
          >
            <Check className="w-4 h-4" /> {buying ? 'Buying…' : settings?.testMode === false ? 'Buy real label' : 'Buy test label'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, hint, type = 'text' }) {
  return (
    <label className="block">
      <div className="text-xs font-medium text-gray-700 mb-1">{label}</div>
      <input
        type={type}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
      />
      {hint && <div className="text-[11px] text-gray-500 mt-0.5">{hint}</div>}
    </label>
  );
}
