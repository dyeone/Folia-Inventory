import { useEffect, useState } from 'react';
import { X, Save, Truck, MapPin, Package, AlertCircle, FlaskConical, KeyRound } from 'lucide-react';
import { api } from '../api.js';

// Palmstreet OMS bearer tokens live for ~1 hour. Show "expires in N min"
// once they're at most this old; show "expired" once past 60 min.
const PALMSTREET_TOKEN_TTL_MIN = 60;

// Edits the id='shipping' row of app_settings. Holds:
//   - shipFrom: the warehouse address that ShipStation prints as "From"
//   - defaults: per-carrier serviceCode + packageCode + weightOz + dims
//   - testMode: when true, every label call passes testLabel:true (no charge)
//
// All admin-gated. Ship-from is required before any label can be bought,
// so the BuyLabelModal links here when fields are missing.

const EMPTY = {
  shipFrom: {
    name: '', company: '', street1: '', street2: '',
    city: '', state: '', zip: '', country: 'US', phone: '',
  },
  carriers: {
    usps: {
      carrierCode: 'stamps_com',
      serviceCode: 'usps_priority_mail',
      packageCode: 'package',
      confirmation: 'delivery',
    },
    ups: {
      carrierCode: 'ups_walleted',
      serviceCode: 'ups_2nd_day_air_saver',
      packageCode: 'package',
      confirmation: 'delivery',
    },
  },
  defaultPackage: { weightOz: 32, length: 12, width: 9, height: 6 },
  testMode: true,
  // Palmstreet OMS bearer token (write-only, server-side). The server
  // strips `token` on GET so we only ever see tokenSetAt here.
  palmstreet: { tokenSetAt: null },
};

export function ShippingSettingsModal({ onClose }) {
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  // Held separately from `data` so an empty string means "user cleared
  // the field" (sent to server as "" → clear) vs. "user didn't touch
  // it" (undefined → server preserves existing).
  const [palmstreetTokenInput, setPalmstreetTokenInput] = useState(undefined);

  useEffect(() => {
    (async () => {
      try {
        const row = await api.getSettings('shipping');
        setData({ ...EMPTY, ...(row?.data || {}),
          shipFrom: { ...EMPTY.shipFrom, ...(row?.data?.shipFrom || {}) },
          carriers: {
            usps: { ...EMPTY.carriers.usps, ...(row?.data?.carriers?.usps || {}) },
            ups: { ...EMPTY.carriers.ups, ...(row?.data?.carriers?.ups || {}) },
          },
          defaultPackage: { ...EMPTY.defaultPackage, ...(row?.data?.defaultPackage || {}) },
          palmstreet: { ...EMPTY.palmstreet, ...(row?.data?.palmstreet || {}) },
        });
      } catch (e) {
        setErr(e.message || 'Failed to load settings');
      }
      setLoading(false);
    })();
  }, []);

  const setShipFrom = (patch) => setData(d => ({ ...d, shipFrom: { ...d.shipFrom, ...patch } }));
  const setCarrier = (carrier, patch) =>
    setData(d => ({ ...d, carriers: { ...d.carriers, [carrier]: { ...d.carriers[carrier], ...patch } } }));
  const setPkg = (patch) => setData(d => ({ ...d, defaultPackage: { ...d.defaultPackage, ...patch } }));

  const validShipFrom = ['name', 'street1', 'city', 'state', 'zip', 'country']
    .every(k => data.shipFrom?.[k]?.trim());

  const handleSave = async () => {
    setErr('');
    setSaving(true);
    try {
      // Only attach `palmstreet.token` to the PUT body when the operator
      // actually edited it. The server preserves the existing token when
      // the field is absent, and clears it when set to "".
      const payload = { ...data };
      if (palmstreetTokenInput !== undefined) {
        payload.palmstreet = { ...data.palmstreet, token: palmstreetTokenInput };
      }
      await api.putSettings('shipping', payload);
      onClose();
    } catch (e) {
      setErr(e.message || 'Save failed');
    }
    setSaving(false);
  };

  const palmstreetTokenStatus = describePalmstreetToken(data.palmstreet?.tokenSetAt);

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-stretch sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-3xl h-full sm:h-[92vh] sm:rounded-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-gray-200 px-4 sm:px-5 py-3 sm:py-4 flex items-center justify-between flex-shrink-0">
          <h3 className="font-semibold text-gray-900 text-base sm:text-lg flex items-center gap-2">
            <Truck className="w-5 h-5 text-emerald-600" /> Shipping Settings
          </h3>
          <button onClick={onClose} className="p-2 -mr-1 text-gray-500 hover:bg-gray-100 rounded-lg" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-4 space-y-6">
          {loading ? (
            <div className="text-sm text-gray-500 text-center py-12">Loading…</div>
          ) : (
            <>
              {/* Test mode toggle — surfaces at the top so it's obvious */}
              <div className={`rounded-xl border p-3 flex items-start gap-3 ${
                data.testMode ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'
              }`}>
                <FlaskConical className={`w-5 h-5 mt-0.5 ${data.testMode ? 'text-amber-600' : 'text-emerald-600'}`} />
                <div className="flex-1">
                  <div className="font-medium text-sm text-gray-900">
                    {data.testMode ? 'Test mode is ON' : 'LIVE mode — labels will be charged'}
                  </div>
                  <div className="text-xs text-gray-600 mt-0.5">
                    {data.testMode
                      ? 'ShipStation returns a placeholder label and your account is not charged.'
                      : 'Every "Buy label" purchase deducts from your ShipStation balance.'}
                  </div>
                </div>
                <label className="inline-flex items-center cursor-pointer flex-shrink-0">
                  <input
                    type="checkbox"
                    checked={data.testMode}
                    onChange={(e) => setData(d => ({ ...d, testMode: e.target.checked }))}
                    className="sr-only peer"
                  />
                  <div className="w-10 h-5 bg-gray-300 peer-checked:bg-amber-500 rounded-full relative transition">
                    <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition ${data.testMode ? 'translate-x-5' : ''}`} />
                  </div>
                </label>
              </div>

              <Section icon={MapPin} title="Ship-from address" subtitle="Printed as the From on every label">
                <div className="grid sm:grid-cols-2 gap-3">
                  <Field label="Name" value={data.shipFrom.name} onChange={(v) => setShipFrom({ name: v })} required />
                  <Field label="Company" value={data.shipFrom.company} onChange={(v) => setShipFrom({ company: v })} />
                  <Field label="Street 1" value={data.shipFrom.street1} onChange={(v) => setShipFrom({ street1: v })} required className="sm:col-span-2" />
                  <Field label="Street 2" value={data.shipFrom.street2} onChange={(v) => setShipFrom({ street2: v })} className="sm:col-span-2" />
                  <Field label="City" value={data.shipFrom.city} onChange={(v) => setShipFrom({ city: v })} required />
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="State" value={data.shipFrom.state} onChange={(v) => setShipFrom({ state: v.toUpperCase() })} required maxLength={2} />
                    <Field label="ZIP" value={data.shipFrom.zip} onChange={(v) => setShipFrom({ zip: v })} required />
                  </div>
                  <Field label="Country" value={data.shipFrom.country} onChange={(v) => setShipFrom({ country: v.toUpperCase() })} required maxLength={2} />
                  <Field label="Phone" value={data.shipFrom.phone} onChange={(v) => setShipFrom({ phone: v })} placeholder="Required by some carriers" />
                </div>
                {!validShipFrom && (
                  <div className="flex items-start gap-2 mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    Required fields missing — labels can't be purchased until this is filled in.
                  </div>
                )}
              </Section>

              <Section icon={Package} title="Default package" subtitle="Pre-fills the weight + dimensions on every label; override per-box.">
                <div className="grid grid-cols-4 gap-3">
                  <Field label="Weight (oz)" type="number" value={data.defaultPackage.weightOz} onChange={(v) => setPkg({ weightOz: parseFloat(v) || 0 })} />
                  <Field label="Length (in)" type="number" value={data.defaultPackage.length} onChange={(v) => setPkg({ length: parseFloat(v) || 0 })} />
                  <Field label="Width (in)" type="number" value={data.defaultPackage.width} onChange={(v) => setPkg({ width: parseFloat(v) || 0 })} />
                  <Field label="Height (in)" type="number" value={data.defaultPackage.height} onChange={(v) => setPkg({ height: parseFloat(v) || 0 })} />
                </div>
              </Section>

              <Section icon={Truck} title="USPS defaults">
                <div className="grid sm:grid-cols-2 gap-3">
                  <Field label="Carrier code" value={data.carriers.usps.carrierCode} onChange={(v) => setCarrier('usps', { carrierCode: v })} />
                  <Field label="Service code" value={data.carriers.usps.serviceCode} onChange={(v) => setCarrier('usps', { serviceCode: v })} />
                  <Field label="Package code" value={data.carriers.usps.packageCode} onChange={(v) => setCarrier('usps', { packageCode: v })} />
                  <Field label="Confirmation" value={data.carriers.usps.confirmation} onChange={(v) => setCarrier('usps', { confirmation: v })} />
                </div>
              </Section>

              <Section icon={Truck} title="UPS defaults">
                <div className="grid sm:grid-cols-2 gap-3">
                  <Field label="Carrier code" value={data.carriers.ups.carrierCode} onChange={(v) => setCarrier('ups', { carrierCode: v })} />
                  <Field label="Service code" value={data.carriers.ups.serviceCode} onChange={(v) => setCarrier('ups', { serviceCode: v })} />
                  <Field label="Package code" value={data.carriers.ups.packageCode} onChange={(v) => setCarrier('ups', { packageCode: v })} />
                  <Field label="Confirmation" value={data.carriers.ups.confirmation} onChange={(v) => setCarrier('ups', { confirmation: v })} />
                </div>
              </Section>

              <Section
                icon={KeyRound}
                title="Palmstreet OMS token"
                subtitle={
                  <>
                    Pasted bearer token used to push tracking back to Palmstreet
                    after Mark shipped. Tokens last ~1 hour — refresh the
                    Palmstreet ops page to get a new one.
                  </>
                }
              >
                <div className={`rounded-xl border p-3 mb-3 flex items-start gap-3 ${
                  palmstreetTokenStatus.tone === 'ok' ? 'bg-emerald-50 border-emerald-200'
                  : palmstreetTokenStatus.tone === 'warn' ? 'bg-amber-50 border-amber-200'
                  : palmstreetTokenStatus.tone === 'expired' ? 'bg-red-50 border-red-200'
                  : 'bg-gray-50 border-gray-200'
                }`}>
                  <AlertCircle className={`w-5 h-5 mt-0.5 ${
                    palmstreetTokenStatus.tone === 'ok' ? 'text-emerald-600'
                    : palmstreetTokenStatus.tone === 'warn' ? 'text-amber-600'
                    : palmstreetTokenStatus.tone === 'expired' ? 'text-red-600'
                    : 'text-gray-500'
                  }`} />
                  <div className="text-xs text-gray-700">{palmstreetTokenStatus.text}</div>
                </div>
                <label className="block">
                  <div className="text-xs font-medium text-gray-700 mb-1">
                    New token (paste here to replace)
                  </div>
                  <textarea
                    value={palmstreetTokenInput ?? ''}
                    onChange={(e) => setPalmstreetTokenInput(e.target.value)}
                    placeholder="eyJhbGciOi... (leave blank to keep current; clear & save to remove)"
                    rows={3}
                    spellCheck={false}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </label>
                {palmstreetTokenInput !== undefined && (
                  <button
                    type="button"
                    onClick={() => setPalmstreetTokenInput(undefined)}
                    className="mt-2 text-xs text-gray-500 hover:text-gray-700 underline"
                  >
                    Discard change
                  </button>
                )}
              </Section>

              {err && (
                <div className="flex items-start gap-2 bg-red-50 text-red-700 text-sm px-3 py-2 rounded-lg">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {err}
                </div>
              )}
            </>
          )}
        </div>

        <div className="border-t border-gray-200 px-4 sm:px-5 py-3 flex justify-end gap-2 flex-shrink-0 bg-white">
          <button onClick={onClose} className="px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving || loading}
            className="px-5 py-2.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 text-white rounded-lg flex items-center gap-1.5"
          >
            <Save className="w-4 h-4" /> {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function describePalmstreetToken(tokenSetAt) {
  if (!tokenSetAt) {
    return {
      tone: 'none',
      text: 'No token set. Tracking won\'t push to Palmstreet until you paste one.',
    };
  }
  const setAt = new Date(tokenSetAt);
  if (Number.isNaN(setAt.getTime())) {
    return { tone: 'none', text: 'Token set, but timestamp unreadable.' };
  }
  const ageMin = Math.floor((Date.now() - setAt.getTime()) / 60_000);
  const remaining = PALMSTREET_TOKEN_TTL_MIN - ageMin;
  if (remaining <= 0) {
    return {
      tone: 'expired',
      text: `Token likely expired (set ${ageMin} min ago). Refresh the Palmstreet ops page and paste a new one.`,
    };
  }
  if (remaining <= 10) {
    return {
      tone: 'warn',
      text: `Token expires in ~${remaining} min. Refresh soon to avoid mid-session failures.`,
    };
  }
  return {
    tone: 'ok',
    text: `Token set ${ageMin} min ago — expires in ~${remaining} min.`,
  };
}

function Section({ icon: Icon, title, subtitle, children }) {
  return (
    <section className="space-y-2">
      <div>
        <h4 className="font-medium text-gray-900 flex items-center gap-2 text-sm">
          {Icon && <Icon className="w-4 h-4 text-gray-500" />} {title}
        </h4>
        {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({ label, value, onChange, type = 'text', required, placeholder, maxLength, className = '' }) {
  return (
    <label className={`block ${className}`}>
      <div className="text-xs font-medium text-gray-700 mb-1">
        {label} {required && <span className="text-red-500">*</span>}
      </div>
      <input
        type={type}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
      />
    </label>
  );
}
