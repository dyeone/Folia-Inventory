import { useEffect, useMemo, useRef, useState } from 'react';
import { LogOut, Package, ScanLine, Check, X, ArrowLeft, AlertCircle, Camera, Truck } from 'lucide-react';
import { api } from '../api.js';
import { shortBoxCode, normalizeBoxCode, normalizeSku } from '../labels/boxCode.js';
import { CameraScanner } from './CameraScanner.jsx';

// Full-screen mobile workflow for the 'packer' role. Two screens:
//   1. Scan-box → operator scans/types a box code (B-XXXXXX). On valid
//      match, advance to the items screen.
//   2. Items → list of items still to pack in the scanned box. Operator
//      scans/types each item's SKU; matching items flip to packed
//      (writes packedAt on inventory_items). When every item is packed
//      the packer can hit "Done" to return to scan-box for the next one.
//
// "Scanning" here is text input — works with a hardware barcode
// scanner (it just types the decoded code into the focused field and
// sends Enter). Camera-based scanning is a planned follow-up.

export function PackerView({ onLogout }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [activeBoxId, setActiveBoxId] = useState(null);
  const [toast, setToast] = useState(null);
  // Camera lives at PackerView level so its lifecycle is independent
  // of the BoxScanner ↔ ItemScanner swap. Unmounting the camera at the
  // same instant the screen swaps was causing a blank-screen flash on
  // iOS Safari. Mode is 'box' or 'item' so the same CameraScanner
  // routes its single decode to the right handler.
  const [cameraMode, setCameraMode] = useState(null); // 'box' | 'item' | null

  const refresh = async () => {
    setErr('');
    try {
      const fresh = await api.getItems();
      setItems((fresh || []).filter(i => !i.deletedAt));
    } catch (e) {
      setErr(e.message || 'Failed to load');
    }
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      await refresh();
      setLoading(false);
    })();
  }, []);

  // All currently-open boxes (anything with a still-'sold' item).
  const boxesByCode = useMemo(() => {
    const map = new Map();
    for (const item of items) {
      if (!item.shipmentBoxId) continue;
      if (!['sold', 'shipped', 'delivered'].includes(item.status)) continue;
      let box = map.get(item.shipmentBoxId);
      if (!box) {
        box = {
          id: item.shipmentBoxId,
          code: shortBoxCode(item.shipmentBoxId),
          buyer: item.buyer || '',
          buyerUsername: item.buyerUsername || '',
          buyerAddress: item.buyerAddress || {},
          // All items in one box share a carrier (set during Validate
          // Sales). Take the first non-empty value defensively — falls
          // back to 'usps' so the badge always renders something
          // recognizable.
          carrier: item.shipmentCarrier || 'usps',
          items: [],
        };
        map.set(item.shipmentBoxId, box);
      }
      box.items.push(item);
    }
    // Index by code for fast scan lookup. Drop boxes where every item
    // is already shipped — the packer can't act on them.
    const out = {};
    for (const box of map.values()) {
      if (box.items.some(i => i.status === 'sold')) out[box.code] = box;
    }
    return out;
  }, [items]);

  const showToast = (msg, durationMs = 2200) => {
    setToast(msg);
    setTimeout(() => setToast(null), durationMs);
  };

  const handleScanBox = (raw) => {
    const code = normalizeBoxCode(raw);
    if (!code) return false;
    const match = boxesByCode[code];
    if (!match) {
      showToast(`No open box with code ${code}`, 3500);
      return false;
    }
    goToBox(match.id);
    return true;
  };

  const activeBox = activeBoxId
    ? Object.values(boxesByCode).find(b => b.id === activeBoxId)
    : null;

  // Centralized box-enter / box-leave. The camera no longer auto-
  // opens on box enter — each scan is one-shot, so auto-opening
  // would just close again 350ms later and confuse the operator.
  // They tap the Camera button on the items screen explicitly when
  // ready to scan the next plant.
  const goToBox = (boxId) => {
    setActiveBoxId(boxId);
    setCameraMode(null);
  };

  // Shared item-scan handler used by both the text input in ItemScanner
  // and the camera (when in 'item' mode). Lifted to PackerView so the
  // camera doesn't need to live inside ItemScanner.
  //
  // Optimistic update: flip the local item to packed BEFORE the
  // network round-trip lands, so the UI reflects the change
  // immediately and the operator can scan the next plant without
  // waiting on a full refetch. If the upsert fails we roll back
  // just this item — other in-flight packs aren't disturbed.
  // Optimistic pack-by-id. Flips the local item to packed before the
  // network call lands, rolls back just that item on failure. Used by
  // both the scan handler (after SKU lookup) and the per-row 'Mark
  // packed' button (for unmatched placeholders that have a synthetic
  // SKU and can't be scanned).
  const packById = async (itemId, displayLabel) => {
    const now = new Date().toISOString();
    setItems(prev => prev.map(i =>
      i.id === itemId ? { ...i, packedAt: now } : i
    ));
    if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(30);
    showToast(`Packed ${displayLabel}`, 1500);
    try {
      await api.upsertItems([{ id: itemId, packedAt: now }]);
    } catch (e) {
      setItems(prev => prev.map(i =>
        i.id === itemId ? { ...i, packedAt: null } : i
      ));
      showToast(`Pack failed for ${displayLabel}: ${e.message || 'unknown'}`, 4000);
    }
  };

  // Shared item-scan handler used by both the text input in ItemScanner
  // and the camera (when in 'item' mode). Lifted to PackerView so the
  // camera doesn't need to live inside ItemScanner.
  const handleScanItem = async (rawText) => {
    if (!activeBox) return;
    const sku = normalizeSku(rawText);
    if (!sku) return;
    const candidate = activeBox.items.find(
      i => normalizeSku(i.sku) === sku,
    );
    if (!candidate) {
      showToast(`SKU ${sku} isn't in this box`, 3500);
      return;
    }
    if (candidate.status !== 'sold') {
      showToast(`SKU ${sku} is already ${candidate.status}`, 3500);
      return;
    }
    if (candidate.packedAt) {
      showToast(`SKU ${sku} already packed`, 2500);
      return;
    }
    await packById(candidate.id, sku);
  };

  // Per-row manual pack for unmatched placeholders. They have a
  // synthetic SKU (UNMATCHED-...) that doesn't appear on a real
  // barcode, so scanning can never pack them. The packer taps the
  // 'Mark packed' button on the row directly.
  const handleMarkPacked = async (item) => {
    if (item.packedAt) return;
    if (item.status !== 'sold') return;
    const label = item.name?.trim() || item.sku || 'item';
    await packById(item.id, label.slice(0, 30));
  };

  if (loading) {
    return <FullScreenMessage>Loading boxes…</FullScreenMessage>;
  }
  if (err) {
    return (
      <FullScreenMessage tone="error">
        {err} <button onClick={refresh} className="underline ml-2">retry</button>
      </FullScreenMessage>
    );
  }

  return (
    <div className="fixed inset-0 bg-gray-50 flex flex-col">
      <TopBar
        onLogout={onLogout}
        title={activeBox ? activeBox.code : 'Scan a box'}
        subtitle={activeBox
          ? (activeBox.buyer || `@${activeBox.buyerUsername}` || 'Box')
          : `${Object.keys(boxesByCode).length} open boxes`}
        onBack={activeBox ? () => goToBox(null) : null}
      />
      {activeBox
        ? <ItemScanner
            box={activeBox}
            onScan={handleScanItem}
            onMarkPacked={handleMarkPacked}
            onOpenCamera={() => setCameraMode('item')}
            onDone={() => goToBox(null)}
          />
        : <BoxScanner
            onScan={handleScanBox}
            onOpenCamera={() => setCameraMode('box')}
            hint="Scan or type the B-XXXXXX code on the box label."
          />
      }
      {/* Camera overlay — rendered at PackerView root so its mount /
          unmount lifecycle is decoupled from the box ↔ item screen
          swap. Single instance now; the active mode just decides
          which handler the one-shot decode fires. */}
      {cameraMode && (cameraMode === 'box' || activeBox) && (
        <CameraScanner
          onScan={cameraMode === 'box' ? handleScanBox : handleScanItem}
          onClose={() => setCameraMode(null)}
        />
      )}
      {toast && <Toast text={toast} />}
    </div>
  );
}

function TopBar({ onLogout, title, subtitle, onBack }) {
  // Box codes look right in mono ("B-3K8F2A"); regular titles like
  // "Scan a box" don't. Pick the font per-title instead of forcing one.
  const isCodeTitle = /^B-/.test(title || '');
  return (
    <div className="bg-emerald-700 text-white pt-safe">
      <div className="h-14 px-3 flex items-center gap-3">
        {/* Left slot: back button when in a box, app icon otherwise.
            Same 40×40 visual footprint so the layout doesn't shift
            between screens. */}
        {onBack ? (
          <button
            onClick={onBack}
            aria-label="Back"
            className="w-10 h-10 -ml-2 rounded-full flex items-center justify-center hover:bg-emerald-800 active:bg-emerald-900"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
        ) : (
          <div className="w-10 h-10 -ml-2 rounded-full flex items-center justify-center">
            <Package className="w-5 h-5" />
          </div>
        )}

        <div className="flex-1 min-w-0">
          <div className={`font-semibold text-base leading-tight truncate ${isCodeTitle ? 'font-mono tracking-wide' : ''}`}>
            {title}
          </div>
          {subtitle && (
            <div className="text-xs text-emerald-100 leading-tight truncate mt-0.5">
              {subtitle}
            </div>
          )}
        </div>

        <button
          onClick={onLogout}
          aria-label="Log out"
          className="w-10 h-10 -mr-2 rounded-full flex items-center justify-center hover:bg-emerald-800 active:bg-emerald-900"
        >
          <LogOut className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}

// Scan-box screen — big input that the operator types/scans into.
//
// Intentionally NOT autofocused on mount. Auto-focus on a freshly-
// mounted input causes iOS Safari to pop the on-screen keyboard up
// every time the operator returns from item view, which is annoying
// (most operators come back to use the camera button, not to type).
// Tap the input explicitly if you want to type.
function BoxScanner({ onScan, onOpenCamera, hint }) {
  const [value, setValue] = useState('');
  const inputRef = useRef(null);

  const submit = (e) => {
    e?.preventDefault();
    const v = value.trim();
    if (!v) return;
    const ok = onScan(v);
    setValue('');
    // Re-focus AFTER an explicit submit only — the operator's
    // already typing, so keeping focus is what they expect.
    setTimeout(() => inputRef.current?.focus(), 0);
    return ok;
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 pb-safe">
      <ScanLine className="w-16 h-16 text-emerald-600 mb-4" />
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Scan box label</h2>
      <p className="text-sm text-gray-500 text-center mb-6 max-w-xs">{hint}</p>
      <form onSubmit={submit} className="w-full max-w-sm">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="B-XXXXXX"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="w-full px-4 py-4 text-lg font-mono uppercase border-2 border-gray-300 rounded-xl focus:outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/20 text-center"
        />
        <button
          type="submit"
          className="w-full mt-3 px-4 py-3 text-base font-semibold bg-emerald-600 text-white rounded-xl active:bg-emerald-800"
        >
          Open box
        </button>
        <button
          type="button"
          onClick={onOpenCamera}
          className="w-full mt-2 px-4 py-3 text-base font-medium bg-white border-2 border-emerald-600 text-emerald-700 rounded-xl active:bg-emerald-50 flex items-center justify-center gap-2"
        >
          <Camera className="w-5 h-5" /> Use camera
        </button>
      </form>
    </div>
  );
}

// Items screen — list of unpacked items in the active box + an item
// scanner that flips matching items to packed. Scan logic lives in
// PackerView so the camera (also at PackerView level) can share it.
function ItemScanner({ box, onScan, onMarkPacked, onOpenCamera, onDone }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, [box.id]);

  // Two buckets so the unpacked items rise to the top — the operator
  // sees what's left before everything that's already packed.
  const unpackedItems = box.items.filter(
    i => i.status === 'sold' && !i.packedAt,
  );
  const packedItems = box.items.filter(
    i => i.status === 'sold' && !!i.packedAt,
  );
  const totalSold = unpackedItems.length + packedItems.length;
  const allPacked = totalSold > 0 && unpackedItems.length === 0;

  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true);
    try {
      await onScan(value);
    } finally {
      setBusy(false);
      setValue('');
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 bg-white">
        <div className="flex items-center gap-3 text-sm">
          <CarrierBadge carrier={box.carrier} />
          <div className="text-gray-700 ml-auto">
            <span className="font-semibold text-gray-900">{packedItems.length}/{totalSold}</span>
            <span className="text-gray-500 ml-1">packed</span>
          </div>
          {allPacked && (
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
              All done — close the box
            </span>
          )}
        </div>
        <div className="mt-2 w-full bg-gray-200 rounded-full h-2 overflow-hidden">
          <div
            className="h-full bg-emerald-500 transition-all"
            style={{ width: totalSold > 0 ? `${(packedItems.length / totalSold) * 100}%` : '0%' }}
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5">
        {unpackedItems.length === 0 && packedItems.length === 0 && (
          <div className="text-center text-sm text-gray-500 py-12">
            <Package className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            No items in this box.
          </div>
        )}
        {unpackedItems.map(item => (
          <ItemRow key={item.id} item={item} onMarkPacked={onMarkPacked} />
        ))}
        {packedItems.length > 0 && unpackedItems.length > 0 && (
          <div className="pt-3 pb-1 text-[10px] uppercase tracking-wider text-gray-400 font-semibold">
            Packed
          </div>
        )}
        {packedItems.map(item => <ItemRow key={item.id} item={item} />)}
      </div>
      <form onSubmit={submit} className="border-t border-gray-200 bg-white p-3 pb-safe space-y-2">
        {/* Primary action: scan the next plant. Big, full-width,
            tinted emerald so it's the obvious thing to tap when
            the operator has the camera in one hand and a plant in
            the other. Hidden once every item in the box is packed
            — the Done button takes over. */}
        {!allPacked && (
          <button
            type="button"
            onClick={onOpenCamera}
            className="w-full flex items-center justify-center gap-2 px-4 py-4 text-base font-semibold bg-emerald-600 text-white rounded-xl active:bg-emerald-800 shadow-sm"
          >
            <Camera className="w-6 h-6" /> Scan plant
          </button>
        )}
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="or type SKU"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            disabled={busy || allPacked}
            className="flex-1 px-4 py-3 text-base font-mono uppercase border-2 border-gray-300 rounded-xl focus:outline-none focus:border-emerald-500 disabled:bg-gray-100"
          />
          {allPacked ? (
            <button
              type="button"
              onClick={onDone}
              className="px-6 py-3 text-base font-semibold bg-emerald-600 text-white rounded-xl active:bg-emerald-800"
            >
              Done
            </button>
          ) : (
            <button
              type="submit"
              disabled={busy || !value.trim()}
              className="px-4 py-3 text-base font-semibold bg-emerald-600 text-white rounded-xl active:bg-emerald-800 disabled:bg-gray-300"
            >
              <Check className="w-5 h-5" />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

// Carrier banner at the top of the items screen. The packer needs to
// know which postage / handoff bin to use BEFORE they finish packing,
// so the badge is sized to read across a worktable: bold uppercase
// label, carrier-flavored color (UPS=amber, USPS=blue), truck glyph.
function CarrierBadge({ carrier }) {
  const c = String(carrier || 'usps').toUpperCase();
  const isUps = c === 'UPS';
  const cls = isUps
    ? 'bg-amber-100 text-amber-900 ring-1 ring-amber-300'
    : 'bg-blue-100 text-blue-900 ring-1 ring-blue-300';
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-base font-bold tracking-wider ${cls}`}>
      <Truck className="w-5 h-5" /> {c}
    </span>
  );
}

function ItemRow({ item, onMarkPacked }) {
  const isPacked = !!item.packedAt;
  const isUnmatched = item.lotKind === 'unmatched';
  const name = (item.name || '').trim();
  const variety = (item.variety || '').trim();
  // Unmatched placeholders have a synthetic SKU (UNMATCHED-...) that
  // can't be scanned off a barcode label. Show a manual 'Mark packed'
  // button on the row so the packer can flip its status without a scan.
  const showManualPack = isUnmatched && !isPacked && !!onMarkPacked;

  // Color family by match status, mirroring the Shipping tab so the
  // packer sees the same emerald/purple convention the admin sees:
  //   matched real inventory  → emerald
  //   unmatched placeholder   → purple (something to double-check)
  //
  // Bg intensifies (50 → 100) when the item flips to packed, so the
  // packed/unpacked split stays visible even though color is now
  // carrying match status too. Check icon + strikethrough still
  // signal packed.
  const family = isUnmatched
    ? {
        bg: isPacked ? 'bg-purple-100' : 'bg-purple-50',
        border: 'border-purple-200',
        accent: 'text-purple-700',
        icon: 'text-purple-600',
        ring: 'border-purple-300',
      }
    : {
        bg: isPacked ? 'bg-emerald-100' : 'bg-emerald-50',
        border: 'border-emerald-200',
        accent: 'text-emerald-700',
        icon: 'text-emerald-600',
        ring: 'border-emerald-300',
      };

  return (
    <div className={`px-3 py-2 rounded-lg border ${family.bg} ${family.border}`}>
      <div className="flex items-center gap-2">
        {isPacked
          ? <Check className={`w-5 h-5 ${family.icon} shrink-0`} />
          : <div className={`w-5 h-5 rounded-full border-2 ${family.ring} shrink-0`} />}
        <div className="flex-1 min-w-0">
          <div className={`text-sm font-mono ${family.accent} ${isPacked ? '' : 'font-medium'}`}>
            {item.sku || '(no SKU)'}
          </div>
          {(name || variety) && (
            <div className={`text-xs truncate ${family.accent} ${isPacked ? 'line-through opacity-70' : 'opacity-80'}`}>
              {[name, variety].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
        {item.quantity > 1 && (
          <span className={`text-xs ${family.accent} shrink-0`}>×{item.quantity}</span>
        )}
        {showManualPack && (
          <button
            type="button"
            onClick={() => onMarkPacked(item)}
            className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-md bg-purple-600 text-white hover:bg-purple-700 active:bg-purple-800 flex items-center gap-1"
            title="No scannable barcode — mark packed manually"
          >
            <Check className="w-3.5 h-3.5" /> Pack
          </button>
        )}
      </div>
    </div>
  );
}

function FullScreenMessage({ children, tone }) {
  const bg = tone === 'error' ? 'bg-red-50 text-red-800' : 'bg-gray-50 text-gray-700';
  return (
    <div className={`fixed inset-0 flex items-center justify-center px-6 ${bg}`}>
      <div className="text-center">
        {tone === 'error' && <AlertCircle className="w-8 h-8 mx-auto mb-2 text-red-600" />}
        <div className="text-sm">{children}</div>
      </div>
    </div>
  );
}

function Toast({ text }) {
  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-sm px-4 py-2 rounded-lg shadow-lg z-50 max-w-[90%] text-center">
      {text}
    </div>
  );
}
