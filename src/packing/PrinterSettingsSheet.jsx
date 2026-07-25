import { useEffect, useRef, useState } from 'react';
import { Printer, X, Loader2, Tablet, Monitor, Check, Tag } from 'lucide-react';
import { useBridgePrint } from '../labels/useBridgePrint.js';
import { printTestLabel, printTestTag } from './packerPrint.js';

// Bottom sheet where the packer picks where each label type prints, with a
// test print per type. Three independent destinations:
//   Shipping labels (4×6)  — carrier labels
//   Box tags (2×1)         — B-XXXXXX barcode tags
//   Plant labels (2×1)     — burrito-wrap reprints of a plant's own label
// Each can go to:
//   'ipad'   → the printer plugged into this iPad (USB) or on Wi-Fi
//              (AirPrint). Printing opens the iPadOS print sheet; the actual
//              printer is chosen there the first time and remembered.
//   'bridge' → the shipping desk's printers via the Folia Bridge (the 4×6
//              shipping printer or the 2×1 item-label printer, by type).
// Also hosts the burrito wrap flow toggle. Everything is stored per device
// (localStorage) — see packerPrint.js.
export function PrinterSettingsSheet({ dests, onDestChange, wrapFlow, onWrapFlowChange, onClose, showToast }) {
  const { bridgeOnline } = useBridgePrint();
  const [testing, setTesting] = useState(null); // 'shipping' | 'boxtag' | 'itemlabel' | null
  // Flipped on unmount so a bridge test print stops polling (and skips state
  // updates) once the sheet has closed.
  const unmountedRef = useRef(false);
  useEffect(() => () => { unmountedRef.current = true; }, []);

  const runTest = async (kind) => {
    if (testing) return;
    setTesting(kind);
    try {
      if (kind === 'shipping') await printTestLabel(dests.shipping, showToast, () => unmountedRef.current);
      // Plant labels share the box tags' 2×1 pipeline (same role + media), so
      // the tag test print exercises exactly what a wrap reprint will do.
      else await printTestTag(dests[kind], showToast, () => unmountedRef.current);
    } finally {
      if (!unmountedRef.current) setTesting(null);
    }
  };

  const anyIpad = dests.shipping === 'ipad' || dests.boxtag === 'ipad' || dests.itemlabel === 'ipad';

  return (
    <div
      className="fixed inset-0 z-[80] bg-black/40 flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-md max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl p-5 pb-safe sm:pb-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 mb-4">
          <Printer className="w-6 h-6 text-emerald-700" />
          <h2 className="flex-1 text-lg font-bold text-gray-900">Printers</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-11 h-11 -mr-2 rounded-full flex items-center justify-center text-gray-500 hover:bg-gray-100 active:bg-gray-200"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <DestSection
          icon={Printer}
          title="Shipping labels · 4×6"
          kind="shipping"
          dest={dests.shipping}
          bridgeSubtitle="4×6 label printer at the shipping desk"
          bridgeOnline={bridgeOnline}
          onDestChange={onDestChange}
          onTest={() => runTest('shipping')}
          testing={testing}
          testLabel="Print test label"
        />

        <DestSection
          icon={Tag}
          title="Box tags · 2×1"
          kind="boxtag"
          dest={dests.boxtag}
          bridgeSubtitle="2×1 tag printer at the shipping desk"
          bridgeOnline={bridgeOnline}
          onDestChange={onDestChange}
          onTest={() => runTest('boxtag')}
          testing={testing}
          testLabel="Print test tag"
        />

        <DestSection
          icon={Tag}
          title="Plant labels · 2×1 (burrito wrap)"
          kind="itemlabel"
          dest={dests.itemlabel}
          bridgeSubtitle="2×1 item-label printer at the shipping desk"
          bridgeOnline={bridgeOnline}
          onDestChange={onDestChange}
          onTest={() => runTest('itemlabel')}
          testing={testing}
          testLabel="Print test label (2×1)"
        />

        <div className="mt-5">
          <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-gray-500 mb-2">
            🌯 Burrito wrap flow
          </div>
          <button
            type="button"
            onClick={() => onWrapFlowChange?.(!wrapFlow)}
            aria-pressed={!!wrapFlow}
            className={`w-full text-left rounded-xl border-2 px-3.5 py-3 flex items-center gap-3 transition active:scale-[0.99] ${
              wrapFlow ? 'border-amber-400 bg-amber-50' : 'border-gray-200 bg-white hover:border-gray-300'
            }`}
          >
            <span className="flex-1 min-w-0">
              <span className="text-base font-semibold text-gray-900">
                {wrapFlow ? 'On — two-scan verified pack' : 'Off — single-scan pack'}
              </span>
              <span className="block text-sm text-gray-500 leading-snug">
                Scan a plant → its label prints → wrap it → stick the fresh label on → scan it again to pack. Catches wrong labels before they ship.
              </span>
            </span>
            <span className={`shrink-0 w-12 h-7 rounded-full p-0.5 transition ${wrapFlow ? 'bg-amber-500' : 'bg-gray-300'}`}>
              <span className={`block w-6 h-6 rounded-full bg-white shadow transition-transform ${wrapFlow ? 'translate-x-5' : ''}`} />
            </span>
          </button>
        </div>

        <p className="text-sm text-gray-500 mt-4 leading-snug">
          {anyIpad
            ? '“This iPad” opens the iPad’s print screen — pick your printer there the first time; the iPad remembers it. A USB printer only shows up if it supports AirPrint / IPP.'
            : 'Everything prints at the shipping desk through the Folia Bridge (the Mac app must be running).'}
        </p>
      </div>
    </div>
  );
}

function DestSection({
  icon: sectionIcon, title, kind, dest, bridgeSubtitle, bridgeOnline,
  onDestChange, onTest, testing, testLabel,
}) {
  const SectionIcon = sectionIcon;
  const busy = testing === kind;
  return (
    <div className="mt-4 first:mt-0">
      <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-gray-500 mb-2">
        <SectionIcon className="w-3.5 h-3.5" /> {title}
      </div>
      <div className="space-y-2">
        <DestCard
          active={dest === 'ipad'}
          onSelect={() => onDestChange(kind, 'ipad')}
          icon={Tablet}
          title="This iPad"
          subtitle="Printer plugged into the iPad (USB) or on Wi-Fi (AirPrint)"
        />
        <DestCard
          active={dest === 'bridge'}
          onSelect={() => onDestChange(kind, 'bridge')}
          icon={Monitor}
          title="Shipping desk (Mac)"
          subtitle={bridgeSubtitle}
          status={bridgeOnline === null ? null : bridgeOnline ? 'online' : 'offline'}
        />
      </div>
      <button
        type="button"
        onClick={onTest}
        disabled={!!testing}
        className="mt-2 w-full min-h-11 flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold bg-white border-2 border-emerald-300 text-emerald-700 rounded-xl active:bg-emerald-50 disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
        {testLabel}
      </button>
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
              status === 'online'
                ? 'text-emerald-700 bg-emerald-100'
                // Loud amber when this is the SELECTED destination and it's
                // down (matches the hold-badge warning idiom); quiet gray
                // when it's just the unselected alternative.
                : active ? 'text-amber-900 bg-amber-200 ring-1 ring-amber-400' : 'text-gray-500 bg-gray-100'
            }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${status === 'online' ? 'bg-emerald-500' : active ? 'bg-amber-500' : 'bg-gray-400'}`} />
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
