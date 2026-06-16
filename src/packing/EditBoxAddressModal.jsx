import { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, MapPin, Loader2, Check } from 'lucide-react';
import { shortBoxCode } from '../labels/boxCode.js';

// Edit the recipient name + shipping address for an open box. The address
// lives denormalized on every item in the box (buyer + buyerAddress), so
// saving writes the new values to all of them. The box's identity key
// (shipmentBoxId) is left untouched, so its label / tracking / notes stay
// linked — only the address used for the slip + future labels changes.
export function EditBoxAddressModal({ box, onClose, onSave, showToast }) {
  const a = box.buyerAddress || {};
  const [name, setName] = useState(box.buyer || '');
  const [street1, setStreet1] = useState(a.street1 || '');
  const [street2, setStreet2] = useState(a.street2 || '');
  const [city, setCity] = useState(a.city || '');
  const [state, setState] = useState(a.state || '');
  const [zip, setZip] = useState(a.zip || '');
  const [country, setCountry] = useState(a.country || '');
  const [phone, setPhone] = useState(a.phone || '');
  const [busy, setBusy] = useState(false);

  const itemCount = box.items?.length || 0;

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Preserve any extra fields already on the address (shipmentMethod, etc.).
      const buyerAddress = {
        ...a,
        street1: street1.trim(),
        street2: street2.trim(),
        city: city.trim(),
        state: state.trim().toUpperCase(),
        zip: zip.trim(),
        country: country.trim(),
        phone: phone.trim(),
      };
      await onSave({ buyer: name.trim(), buyerAddress });
      onClose();
    } catch (e) {
      showToast?.(e?.message || 'Could not save address');
      setBusy(false);
    }
  };

  const field = (label, value, setter, props = {}) => (
    <label className="block">
      <span className="block text-xs font-medium text-gray-600 mb-1">{label}</span>
      <input
        value={value}
        onChange={(e) => setter(e.target.value)}
        spellCheck={false}
        className="w-full text-sm px-2.5 py-1.5 border border-gray-300 rounded-lg focus:outline-none focus:border-emerald-500"
        {...props}
      />
    </label>
  );

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-3 sm:p-6">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[92vh] flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-200">
          <MapPin className="w-5 h-5 text-emerald-600" />
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-gray-900 leading-tight">Edit address</h2>
            <div className="text-xs text-gray-500 font-mono">{shortBoxCode(box.id)}</div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-auto p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {field('Recipient name', name, setName, { placeholder: 'Full name' })}
          {field('Street line 1', street1, setStreet1, { placeholder: '123 Main St' })}
          {field('Street line 2', street2, setStreet2, { placeholder: 'Apt / Unit (optional)' })}
          <div className="grid grid-cols-6 gap-2">
            <div className="col-span-3">{field('City', city, setCity)}</div>
            <div className="col-span-1">{field('State', state, setState, { maxLength: 2, className: 'w-full text-sm px-2.5 py-1.5 border border-gray-300 rounded-lg focus:outline-none focus:border-emerald-500 uppercase' })}</div>
            <div className="col-span-2">{field('ZIP', zip, setZip)}</div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {field('Country', country, setCountry, { placeholder: 'US' })}
            {field('Phone', phone, setPhone, { placeholder: 'optional' })}
          </div>
          <p className="text-xs text-gray-500 pt-1">
            Updates the address on {itemCount} item{itemCount === 1 ? '' : 's'} in this box. The tracking number and label stay attached.
          </p>
        </div>

        <div className="px-5 py-3.5 border-t border-gray-200 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            disabled={busy}
            className="text-sm font-medium text-gray-600 hover:text-gray-900 px-3 py-2 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="inline-flex items-center gap-1.5 text-sm font-semibold px-4 py-2.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800 disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            Save address
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
