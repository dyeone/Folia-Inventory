import { useState } from 'react';
import { Printer, X, Loader2, Tablet, Monitor, Check } from 'lucide-react';
import { useBridgePrint } from '../labels/useBridgePrint.js';
import { printTestLabel } from './packerPrint.js';

// Bottom sheet where the packer picks where shipping labels print and fires a
// test label. Two destinations:
//   'ipad'   → the printer plugged into this iPad (USB) or on Wi-Fi (AirPrint).
//              Printing opens the iPadOS print sheet; the actual printer is
//              chosen there the first time and remembered by iPadOS.
//   'bridge' → the shipping desk's 4×6 label printer via the Folia Bridge.
// The choice is stored per device (localStorage) — see packerPrint.js.
export function PrinterSettingsSheet({ dest, onDestChange, onClose, showToast }) {
  const { bridgeOnline } = useBridgePrint();
  const [testing, setTesting] = useState(false);

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    try { await printTestLabel(dest, showToast); }
    finally { setTesting(false); }
  };

  return (
    <div
      className="fixed inset-0 z-[80] bg-black/40 flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-5 pb-safe sm:pb-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 mb-4">
          <Printer className="w-6 h-6 text-emerald-700" />
          <h2 className="flex-1 text-lg font-bold text-gray-900">Label printer</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-11 h-11 -mr-2 rounded-full flex items-center justify-center text-gray-500 hover:bg-gray-100 active:bg-gray-200"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="space-y-2.5">
          <DestCard
            active={dest === 'ipad'}
            onSelect={() => onDestChange('ipad')}
            icon={Tablet}
            title="This iPad"
            subtitle="Printer plugged into the iPad (USB) or on Wi-Fi (AirPrint)"
          />
          <DestCard
            active={dest === 'bridge'}
            onSelect={() => onDestChange('bridge')}
            icon={Monitor}
            title="Shipping desk (Mac)"
            subtitle="4×6 label printer at the shipping desk"
            status={bridgeOnline === null ? null : bridgeOnline ? 'online' : 'offline'}
          />
        </div>

        <p className="text-sm text-gray-500 mt-3 leading-snug">
          {dest === 'ipad'
            ? 'Printing opens the iPad’s print screen — pick your printer there the first time; the iPad remembers it. A USB printer only shows up if it supports AirPrint / IPP.'
            : 'Labels print on the shipping desk’s label printer through the Folia Bridge (the Mac app must be running).'}
        </p>

        <button
          type="button"
          onClick={runTest}
          disabled={testing}
          className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-3.5 text-base font-semibold bg-emerald-600 text-white rounded-xl active:bg-emerald-800 disabled:opacity-60"
        >
          {testing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Printer className="w-5 h-5" />}
          Print test label
        </button>
      </div>
    </div>
  );
}

function DestCard({ active, onSelect, icon, title, subtitle, status }) {
  const Icon = icon;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={`w-full text-left rounded-xl border-2 px-3.5 py-3 flex items-center gap-3 transition active:scale-[0.99] ${
        active ? 'border-emerald-500 bg-emerald-50' : 'border-gray-200 bg-white hover:border-gray-300'
      }`}
    >
      <Icon className={`w-6 h-6 flex-shrink-0 ${active ? 'text-emerald-700' : 'text-gray-400'}`} />
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2">
          <span className="text-base font-semibold text-gray-900">{title}</span>
          {status && (
            <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded ${
              status === 'online' ? 'text-emerald-700 bg-emerald-100' : 'text-gray-500 bg-gray-100'
            }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${status === 'online' ? 'bg-emerald-500' : 'bg-gray-400'}`} />
              {status === 'online' ? 'Online' : 'Offline'}
            </span>
          )}
        </span>
        <span className="block text-sm text-gray-500 leading-snug">{subtitle}</span>
      </span>
      {active && <Check className="w-5 h-5 text-emerald-600 flex-shrink-0" />}
    </button>
  );
}
