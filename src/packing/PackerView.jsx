import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  LogOut, Package, ScanLine, Check, ArrowLeft, AlertCircle, Camera, Truck,
  Ruler, ChevronRight, Loader2, PackageCheck, Smartphone, X, Search, Clock,
  Printer, Tag,
} from 'lucide-react';
import { api } from '../api.js';
import { AuthContext } from '../AuthContext.js';
import { getRealtimeClient, REALTIME_CONFIGURED } from '../supabaseRealtime.js';
import { shortBoxCode, normalizeBoxCode, normalizeSku } from '../labels/boxCode.js';
import { tracksMatch, looksLikeTracking } from '../labels/tracking.js';
import { boxHoldState, boxIsLocalPickup, isHoldItem } from './holdInfo.js';
import { loadSweepMarks, saveSweepMarks, SWEEP_KEY } from './holdSweep.js';
import { findDupeLots } from './dupeLots.js';
import { resolveBoxCarrier } from './carrier.js';
import { CameraScanner } from './CameraScanner.jsx';
import { PrinterSettingsSheet } from './PrinterSettingsSheet.jsx';
import { getPrintDests, savePrintDest, printBoxLabel, printBoxTag, printItemLabel, getWrapFlow, saveWrapFlow } from './packerPrint.js';
import { ItemNotes } from './ItemNotes.jsx';
import { BoxContentBadges } from './BoxContentBadges.jsx';
import { useIsMobile } from '../ui/useIsMobile.js';

// Full-screen workflow for the 'packer' role, tuned for an iPad at a
// packing table with a USB/Bluetooth barcode scanner.
//
//   Landing → an always-focused scan field (the USB scanner just types the
//     decoded code + Enter into it) plus a tappable grid of every open box.
//     Scan a box label (B-XXXXXX) to open it, or scan an item SKU to jump
//     straight to its box.
//   Box → scan each plant's barcode; matching items flip to packed
//     (writes packedAt). When every item is packed the packer is asked which
//     box size they used; the choice is saved to shipment_boxes.boxSizeId,
//     which the Shipping tab reads back automatically.
//
// The scan field uses inputMode="none" so iPadOS doesn't pop the on-screen
// keyboard while still receiving the hardware scanner's keystrokes, and it
// re-grabs focus aggressively so a stray tap never breaks scanning. The
// camera remains as a secondary, tap-to-open option.

// Merge a fresh /items fetch into the packer's local list WITHOUT regressing
// the forward progress (packed → shipped) the packer just made locally. The
// background sync poll can add/remove boxes and update buyer, address, carrier,
// holds, etc., but a just-packed item must never flicker back to unpacked while
// the server write is still in flight. Progress is monotonic, so once the
// server catches up `fresh` equals local and this is a no-op; a failed write
// already rolled local state back, so nothing is preserved in that case.
function mergeItems(prev, fresh) {
  const prevById = new Map(prev.map(i => [i.id, i]));
  return fresh.map(f => {
    const p = prevById.get(f.id);
    if (!p) return f;
    const keepPacked = !!p.packedAt && !f.packedAt;
    const keepShipped = ['shipped', 'delivered'].includes(p.status)
      && !['shipped', 'delivered'].includes(f.status);
    if (!keepPacked && !keepShipped) return f;
    return {
      ...f,
      packedAt: keepPacked ? p.packedAt : f.packedAt,
      status: keepShipped ? p.status : f.status,
      shippedAt: keepShipped ? (p.shippedAt || f.shippedAt) : f.shippedAt,
    };
  });
}

// Does this shipment actually have a printable label PDF? Carrier rows
// (ShipStation / Shippo) always store one; manual Palmstreet rows only when
// the label was imported. Mirrors the Shipping tab's hasLabel rule — a
// tracking number alone (typed in by hand) is NOT printable.
function shipmentHasLabelPdf(s) {
  return !!s.labelStoragePath || s.carrierCode !== 'palmstreet';
}

// Recipient label for the packer: the shipping full name plus the client's
// Palmstreet @handle when we have both, so the packer can match a box against
// either the label (full name) or the order/chat (username). Falls back to
// whichever single one is known; empty when neither is.
function buyerLabel(box) {
  const name = (box.buyer || '').trim();
  const handle = (box.buyerUsername || '').trim();
  if (name && handle) return `${name} · @${handle}`;
  return name || (handle ? `@${handle}` : '');
}

export function PackerView({ onLogout }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [activeBoxId, setActiveBoxId] = useState(null);
  const [toast, setToast] = useState(null);
  const [cameraMode, setCameraMode] = useState(null); // 'box' | 'item' | null
  // Box-size catalog (from Shipping Settings) + the per-box selection map
  // (shipmentBoxId → boxSizeId), shared with the Shipping tab via
  // shipment_boxes. Loaded once on mount.
  const [boxSizes, setBoxSizes] = useState([]);
  const [boxSizeByBox, setBoxSizeByBox] = useState({});
  // "Good job" success screen shown after a correct final label scan; holds
  // the finished box for a beat, then auto-returns to the grid.
  const [success, setSuccess] = useState(null);
  // Tracking number per box (shipmentBoxId → trackingNumber), from the
  // shipments recorded when labels were imported. Used to verify the packer
  // attached the right label: scanning the label barcode must match the
  // tracking assigned to the open box.
  const [trackingByBox, setTrackingByBox] = useState({});
  // One-week hold deadline per box (shipmentBoxId → holdUntil ISO), from the
  // shipment_boxes metadata. Drives the held-box background + "on hold" mark.
  const [holdByBox, setHoldByBox] = useState({});
  // Seller note per box (shipmentBoxId → note), so the packer can detect a
  // "local pickup" note and flag the box not-to-ship.
  const [noteByBox, setNoteByBox] = useState({});
  // Label printing at the packing table. Per-device, per-label-type choices
  // ({ shipping, boxtag } → 'ipad' | 'bridge'); the sheet lets the packer
  // switch each and fire a test print per type.
  const [printDests, setPrintDests] = useState(getPrintDests);
  const [printerSheetOpen, setPrinterSheetOpen] = useState(false);
  // Burrito wrap flow (per device): scanning a plant starts a wrap — the app
  // prints that plant's own label, the packer wraps it in paper and applies
  // the fresh label, and scanning THAT label completes the pack. The second
  // scan is the point: it must match the plant that was scanned in, so a
  // wrong label can't ship. Wrap-pending is transient client state keyed by
  // item id (the 8s poll replaces item objects wholesale); the terminal
  // state is plain packedAt, so nothing new is persisted.
  const [wrapFlow, setWrapFlow] = useState(getWrapFlow);
  const [wrap, setWrap] = useState(null); // { itemId, sku, nonce, print: 'sending'|'sent'|'failed' }
  // Bench sweep (holdSweep.js): scan every plant of every held or pickup box
  // off the bench BEFORE regular packing, so plants that aren't shipping
  // this week can't be mixed into this week's boxes. Found-marks persist per
  // device.
  const [sweepOpen, setSweepOpen] = useState(false);
  const [sweepMarks, setSweepMarks] = useState(loadSweepMarks);
  // Write-through on change, and adopt OTHER tabs' writes (storage events
  // never fire in the writing tab) — a second Safari tab must not clobber
  // the first tab's sweep progress with its stale mount snapshot.
  useEffect(() => { saveSweepMarks(sweepMarks); }, [sweepMarks]);
  useEffect(() => {
    const onStorage = (e) => { if (e.key === SWEEP_KEY) setSweepMarks(loadSweepMarks()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  // One busy flag across print jobs ('label' | 'tag' | 'itemlabel' | null):
  // on the iPad path all flows share the in-page print root, so they must
  // never run concurrently (the second purge would eat the first job's
  // pages). Bridge-destined wrap prints skip it — see startWrap.
  const [printing, setPrinting] = useState(null);
  // Manual carrier override per box (shipmentBoxId → 'ups' | 'usps' | null),
  // set at the shipping desk. The packer honors it like the desk does — the
  // printed box tag's carrier header must match the desk's batch print.
  const [carrierOverrideByBox, setCarrierOverrideByBox] = useState({});
  // Which boxes have a printable label PDF (shipmentBoxId → true). Distinct
  // from trackingByBox: a manually recorded tracking number has no PDF.
  const [labelByBox, setLabelByBox] = useState({});

  const [scanValue, setScanValue] = useState('');
  const scanRef = useRef(null);

  // Cross-device handoff. The packer runs this same UI on an iPad (the wide
  // "control" device, which gets the Send-to-phone button) and a phone (which
  // shows the find-list). useIsMobile splits them at the sm breakpoint.
  //
  // Transport: Supabase Realtime broadcast when configured (instant), else a
  // polled app_settings row (~2.5s). Both are namespaced by the packer's user
  // id, so the iPad + phone must be the same login.
  const { currentUser, activeBrand, brands, switchBrand } = useContext(AuthContext);
  const isMobile = useIsMobile();
  const [handoff, setHandoff] = useState(null);     // box snapshot to show on the phone
  const channelRef = useRef(null);                  // live realtime channel (or null)
  // Polling-fallback bookkeeping. lastSentRef seeds on the first poll so a
  // stale handoff from a previous session doesn't pop on load; it's updated
  // when we send (so a device never pops its own send) and when we show one.
  const lastSentRef = useRef(null);
  const handoffReadyRef = useRef(false);

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
      const [, settings, notes, shipments] = await Promise.all([
        refresh(),
        api.getSettings('shipping').catch(() => null),
        api.getBoxNotes().catch(() => ({})),
        api.getShipments().catch(() => []),
      ]);
      setBoxSizes(Array.isArray(settings?.data?.boxSizes) ? settings.data.boxSizes : []);
      setBoxSizeByBox(
        Object.fromEntries(
          Object.entries(notes || {}).map(([id, v]) => [id, v?.boxSizeId || null]),
        ),
      );
      setHoldByBox(
        Object.fromEntries(
          Object.entries(notes || {}).map(([id, v]) => [id, v?.holdUntil || null]),
        ),
      );
      setNoteByBox(
        Object.fromEntries(
          Object.entries(notes || {}).map(([id, v]) => [id, v?.note || '']),
        ),
      );
      setCarrierOverrideByBox(
        Object.fromEntries(
          Object.entries(notes || {}).map(([id, v]) => [id, v?.carrierOverride || null]),
        ),
      );
      setTrackingByBox(
        Object.fromEntries(
          (shipments || [])
            .filter(s => s.trackingNumber && !s.voidedAt)
            .map(s => [s.id, s.trackingNumber]),
        ),
      );
      setLabelByBox(
        Object.fromEntries(
          (shipments || [])
            .filter(s => !s.voidedAt && shipmentHasLabelPdf(s))
            .map(s => [s.id, true]),
        ),
      );
      setLoading(false);
    })();
  }, []);

  // Background sync with the shipping desk. The mount load above is one-shot;
  // without this, a box edited on the website — item added/removed, ship-to
  // changed, a new box, an imported label, an applied hold, a box-size pick —
  // never reaches the packer until they reload. Mirrors the admin Shipping
  // tab: poll every 8s, skip while the tab is hidden, and refetch immediately
  // when it returns to the foreground. Items merge forward-progress-safe so an
  // in-flight optimistic pack never flickers back.
  useEffect(() => {
    let cancelled = false;
    // Guard against overlapping polls: a slow request resolving late would
    // overwrite fresher state (e.g. tracking/label flags flickering off, which
    // now unmounts the Print button mid-tap).
    let inFlight = false;
    const sync = async () => {
      if (cancelled || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const [fresh, shipments, notes] = await Promise.all([
          api.getItems(),
          api.getShipments().catch(() => []),
          api.getBoxNotes().catch(() => ({})),
        ]);
        if (cancelled) return;
        setItems(prev => mergeItems(prev, (fresh || []).filter(i => !i.deletedAt)));
        setTrackingByBox(
          Object.fromEntries(
            (shipments || [])
              .filter(s => s.trackingNumber && !s.voidedAt)
              .map(s => [s.id, s.trackingNumber]),
          ),
        );
        setLabelByBox(
          Object.fromEntries(
            (shipments || [])
              .filter(s => !s.voidedAt && shipmentHasLabelPdf(s))
              .map(s => [s.id, true]),
          ),
        );
        setHoldByBox(
          Object.fromEntries(Object.entries(notes || {}).map(([id, v]) => [id, v?.holdUntil || null])),
        );
        setNoteByBox(
          Object.fromEntries(Object.entries(notes || {}).map(([id, v]) => [id, v?.note || ''])),
        );
        setCarrierOverrideByBox(
          Object.fromEntries(Object.entries(notes || {}).map(([id, v]) => [id, v?.carrierOverride || null])),
        );
        setBoxSizeByBox(
          Object.fromEntries(Object.entries(notes || {}).map(([id, v]) => [id, v?.boxSizeId || null])),
        );
      } catch { /* keep last good state — a single failed poll is fine */ }
      finally { inFlight = false; }
    };
    const id = setInterval(sync, 8000);
    const onVisible = () => { if (document.visibilityState === 'visible') sync(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Open boxes, keyed by short code for scan lookup. A box is "open" while it
  // still has at least one 'sold' item; fully-shipped boxes drop out.
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
          stampedCarrier: item.shipmentCarrier || 'usps',
          carrier: item.shipmentCarrier || 'usps',
          items: [],
        };
        map.set(item.shipmentBoxId, box);
      }
      box.items.push(item);
    }
    const out = {};
    for (const box of map.values()) {
      // Effective carrier, same rule as the Shipping tab: manual per-box
      // override first, else content default (anthurium → UPS), else the
      // stamped carrier. Must match the desk exactly — the packer PRINTS
      // this on box tags now, not just displays it.
      box.carrier = resolveBoxCarrier(box.items, carrierOverrideByBox[box.id], box.stampedCarrier);
      if (box.items.some(i => i.status === 'sold')) out[box.code] = box;
    }
    return out;
  }, [items, carrierOverrideByBox]);

  const openBoxes = useMemo(
    () => Object.values(boxesByCode).sort((a, b) => {
      // Boxes with work left float above fully-packed ones.
      const ap = a.items.filter(i => i.status === 'sold' && !i.packedAt).length;
      const bp = b.items.filter(i => i.status === 'sold' && !i.packedAt).length;
      if ((ap === 0) !== (bp === 0)) return ap === 0 ? 1 : -1;
      return (a.buyer || '').localeCompare(b.buyer || '');
    }),
    [boxesByCode],
  );

  // Lineup numbers carried by 2+ unpacked items across the open boxes (last
  // week's hold labels beside this week's, block spills, manual dupes). Every
  // pack path checks this set before trusting a bare # — the label's wk tag
  // is what disambiguates.
  const dupeLots = useMemo(() => findDupeLots(Object.values(boxesByCode)), [boxesByCode]);

  // The sweep's scope: boxes whose plants must come OFF the bench before
  // packing — still-holding boxes ('ready' ones ship this week and are packed
  // normally) and local-pickup boxes (never ship; the buyer collects, so
  // pickup plants leave the bench regardless of hold state). Operator
  // "1-week hold" placeholder lines aren't physical plants and are excluded.
  const sweepBoxes = useMemo(() => openBoxes.flatMap(box => {
    const hold = boxHoldState(box.items, holdByBox[box.id]);
    const pickup = boxIsLocalPickup(noteByBox[box.id], box.items);
    if (hold.state !== 'holding' && !pickup) return [];
    const plants = box.items.filter(i => i.status === 'sold' && !i.packedAt && !isHoldItem(i.name));
    return plants.length ? [{ box, plants, hold, pickup }] : [];
  }), [openBoxes, holdByBox, noteByBox]);
  const sweepTotal = sweepBoxes.reduce((s, h) => s + h.plants.length, 0);
  const sweepFound = sweepBoxes.reduce((s, h) => s + h.plants.filter(p => sweepMarks[p.id]).length, 0);

  const toastTimerRef = useRef(null);
  const showToast = (msg, durationMs = 2200) => {
    // Clear the previous timer so a short-lived toast (e.g. "Packed X",
    // 1.5s) can't cut off a long instructional one shown right after.
    clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => setToast(null), durationMs);
  };

  const activeBox = activeBoxId
    ? Object.values(boxesByCode).find(b => b.id === activeBoxId)
    : null;

  // The wrap is honored only while its plant is still an unpacked sold item
  // of the ACTIVE box — derived, not synchronized, so switching boxes or a
  // desk-side pack neutralizes it without an effect. Returning to the box
  // with the plant still unpacked resumes the wrap.
  const activeWrap = useMemo(() => {
    if (!wrap || !activeBox) return null;
    const it = activeBox.items.find(i => i.id === wrap.itemId);
    return it && it.status === 'sold' && !it.packedAt ? wrap : null;
  }, [wrap, activeBox]);

  // Start wrapping: remember the plant and fire its label print. The nonce
  // ties the async print result to THIS wrap — a cancel + rescan of the same
  // plant mints a new wrap, and the old print's late result must not stamp
  // it. Takes the shared print mutex: on the iPad path two concurrent jobs
  // purge each other's in-page print root.
  const startWrap = async (candidate, sku) => {
    const nonce = `${Date.now()}-${Math.random()}`;
    if (navigator.vibrate) navigator.vibrate(30);
    // The mutex protects the iPad's in-page print root; bridge jobs queue
    // server-side and don't need it — holding it across the bridge poll
    // (up to 35s on a wedged bridge) would dead-disable the next wrap's
    // Reprint button.
    const needMutex = printDests.itemlabel === 'ipad';
    if (needMutex && printing) {
      setWrap({ itemId: candidate.id, sku, nonce, print: 'failed' });
      showToast('Printer is busy — tap Reprint on the wrap card in a moment.', 3500);
      return;
    }
    setWrap({ itemId: candidate.id, sku, nonce, print: 'sending' });
    if (needMutex) setPrinting('itemlabel');
    try {
      const ok = await printItemLabel(candidate, printDests.itemlabel, showToast);
      setWrap(w => (w && w.nonce === nonce ? { ...w, print: ok ? 'sent' : 'failed' } : w));
    } finally {
      if (needMutex) setPrinting(null);
    }
  };

  // Re-pull tracking numbers + holds. Both are set at the shipping desk while
  // the packer's app is already open, so refresh on each box open to pick up a
  // label or a hold applied since mount.
  const refreshBoxMeta = async () => {
    try {
      const [shipments, notes] = await Promise.all([
        api.getShipments(),
        api.getBoxNotes().catch(() => ({})),
      ]);
      setTrackingByBox(
        Object.fromEntries(
          (shipments || [])
            .filter(s => s.trackingNumber && !s.voidedAt)
            .map(s => [s.id, s.trackingNumber]),
        ),
      );
      setLabelByBox(
        Object.fromEntries(
          (shipments || [])
            .filter(s => !s.voidedAt && shipmentHasLabelPdf(s))
            .map(s => [s.id, true]),
        ),
      );
      setHoldByBox(
        Object.fromEntries(
          Object.entries(notes || {}).map(([id, v]) => [id, v?.holdUntil || null]),
        ),
      );
      setNoteByBox(
        Object.fromEntries(
          Object.entries(notes || {}).map(([id, v]) => [id, v?.note || '']),
        ),
      );
      setCarrierOverrideByBox(
        Object.fromEntries(
          Object.entries(notes || {}).map(([id, v]) => [id, v?.carrierOverride || null]),
        ),
      );
    } catch { /* keep whatever we have */ }
  };

  const goToBox = (boxId) => {
    setActiveBoxId(boxId);
    setCameraMode(null);
    if (boxId) refreshBoxMeta();
  };

  // Print the open box's shipping label on the packer's chosen printer.
  const printActiveLabel = async () => {
    if (!activeBox || printing) return;
    setPrinting('label');
    try {
      await printBoxLabel(activeBox.id, printDests.shipping, showToast);
    } finally {
      setPrinting(null);
    }
  };

  // Print the open box's 2×1 box tag (B-XXXXXX barcode) — e.g. when a box
  // was built without one or the tag got damaged mid-pack.
  const printActiveTag = async () => {
    if (!activeBox || printing) return;
    setPrinting('tag');
    try {
      await printBoxTag(activeBox, printDests.boxtag, showToast);
    } finally {
      setPrinting(null);
    }
  };

  // ── Scan field focus management ──────────────────────────────────────────
  // Keep the scan input focused whenever the camera overlay is closed, so the
  // USB scanner's keystrokes always land in it. A ref mirrors the overlay
  // state so a click that opens the camera doesn't yank focus back.
  // The printer sheet counts as an overlay too: while it's open the scan
  // field must not steal focus back from it, and stray hardware-scanner
  // input must not drive the (covered) packing flow behind it.
  const overlayOpen = !!cameraMode || printerSheetOpen;
  const overlayRef = useRef(overlayOpen);
  useEffect(() => { overlayRef.current = overlayOpen; }, [overlayOpen]);
  useEffect(() => {
    if (overlayOpen) return undefined;
    const t = setTimeout(() => scanRef.current?.focus({ preventScroll: true }), 60);
    return () => clearTimeout(t);
  }, [activeBoxId, overlayOpen, loading]);
  useEffect(() => {
    const refocus = (e) => {
      if (overlayRef.current) return;
      // Leave focus alone when the tap lands in a real field.
      if (e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      setTimeout(() => {
        if (overlayRef.current) return;
        scanRef.current?.focus({ preventScroll: true });
      }, 0);
    };
    document.addEventListener('click', refocus);
    return () => document.removeEventListener('click', refocus);
  }, []);

  // Optimistic pack-by-id: flip the local item to packed before the network
  // call lands; roll back just that item on failure. Returns whether the pack
  // stuck — the burrito wrap flow restores its wrap on failure so a retry
  // scan doesn't print a duplicate label.
  const packById = async (itemId, displayLabel) => {
    const now = new Date().toISOString();
    setItems(prev => prev.map(i => (i.id === itemId ? { ...i, packedAt: now } : i)));
    if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(30);
    showToast(`Packed ${displayLabel}`, 1500);
    try {
      await api.upsertItems([{ id: itemId, packedAt: now }]);
      return true;
    } catch (e) {
      setItems(prev => prev.map(i => (i.id === itemId ? { ...i, packedAt: null } : i)));
      showToast(`Pack failed for ${displayLabel}: ${e.message || 'unknown'}`, 4000);
      return false;
    }
  };

  // Mark the whole box shipped (optimistic, with rollback) — the verified
  // label scan is the box leaving the building. Mirrors the Shipping desk:
  // every non-terminal item → status 'shipped' (+ packedAt for tidiness), and
  // the sale closes once all its non-giveaway lots are shipped. Returns true
  // on success so the caller can run the celebration only when it stuck.
  const shipBox = async (box) => {
    const now = new Date().toISOString();
    const targets = box.items.filter(i => !['shipped', 'delivered'].includes(i.status));
    if (targets.length === 0) return true;
    const prevById = new Map(targets.map(i => [i.id, { status: i.status, shippedAt: i.shippedAt, packedAt: i.packedAt }]));
    const idSet = new Set(targets.map(i => i.id));
    setItems(prev => prev.map(i => (idSet.has(i.id)
      ? { ...i, status: 'shipped', shippedAt: now, packedAt: i.packedAt || now }
      : i)));
    try {
      await api.upsertItems(targets.map(i => ({ id: i.id, status: 'shipped', shippedAt: now, packedAt: i.packedAt || now })));
      // Close the sale if every non-giveaway lot for it is now shipped.
      const saleId = box.items[0]?.saleId || null;
      if (saleId) {
        const lots = items
          .map(i => (idSet.has(i.id) ? { ...i, status: 'shipped' } : i))
          .filter(i => i.saleId === saleId && !i.deletedAt && i.lotKind !== 'giveaway');
        const allShipped = lots.length > 0 && lots.every(i => ['shipped', 'delivered'].includes(i.status));
        if (allShipped) await api.upsertSales([{ id: saleId, status: 'closed', closedAt: now }]).catch(() => {});
      }
      return true;
    } catch (e) {
      setItems(prev => prev.map(i => (prevById.has(i.id) ? { ...i, ...prevById.get(i.id) } : i)));
      showToast(`Ship failed: ${e.message || 'unknown'}`, 4000);
      return false;
    }
  };

  // Final step: the packer scans the shipping label's barcode to confirm the
  // right label went on the right box. A matching scan marks the box SHIPPED
  // (the box is going out) and celebrates; a mismatch names the box the label
  // really belongs to. A box still on its one-week hold can't be shipped yet.
  const handleScanLabel = async (rawText) => {
    if (!activeBox) return;
    // A wrap in progress means an unverified plant: shipping the box now
    // would backfill its packedAt and skip the exact wrong-label check the
    // wrap exists for. (Mid-wrap the box is never all-packed, so a label
    // scan is never the legitimate finishing move.)
    if (activeWrap) {
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
      showToast('⚠ Finish the wrap first — scan the fresh label on the burrito (or Cancel the wrap).', 5000);
      return;
    }
    const assigned = trackingByBox[activeBox.id];
    if (!assigned) {
      showToast('No label assigned to this box yet — import it on the shipping desk first', 4500);
      return;
    }
    if (tracksMatch(rawText, assigned)) {
      // Respect a one-week hold — don't ship a box that's still holding.
      const hs = boxHoldState(activeBox.items, holdByBox[activeBox.id]);
      if (hs.state === 'holding') {
        if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
        showToast(`⚠ On hold — do not ship yet${hs.daysLeft ? ` · ${hs.daysLeft} day${hs.daysLeft === 1 ? '' : 's'} left` : ''}`, 5000);
        return;
      }
      // A pickup box never ships, matching label or not — the buyer collects.
      if (boxIsLocalPickup(noteByBox[activeBox.id], activeBox.items)) {
        if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
        showToast('⚠ LOCAL PICKUP — this box must not ship. The buyer collects it.', 5000);
        return;
      }
      if (navigator.vibrate) navigator.vibrate([40, 50, 90]);
      const ok = await shipBox(activeBox);
      if (!ok) return; // ship failed — toast shown, stay on the box
      // Shipped — celebrate, then jump back to the grid.
      setSuccess({
        code: activeBox.code,
        who: buyerLabel(activeBox),
      });
      setTimeout(() => { setSuccess(null); goToBox(null); }, 2600);
      return;
    }
    // Wrong label — find which open box it really belongs to.
    const other = Object.values(boxesByCode).find(
      b => b.id !== activeBox.id && trackingByBox[b.id] && tracksMatch(rawText, trackingByBox[b.id]),
    );
    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
    if (other) {
      showToast(`⚠ Wrong label! This is for box ${other.code}${other.buyer ? ` · ${other.buyer}` : ''}`, 6000);
    } else {
      showToast('⚠ This label isn’t assigned to any open box', 5000);
    }
  };

  // Landing scan: a box label (B-XXXXXX) opens the box; an item SKU resolves
  // which open box carries it and opens that box.
  const handleScanBox = (raw) => {
    const upper = String(raw || '').trim().toUpperCase().replace(/_/g, '-');
    if (!upper) return;
    if (upper.startsWith('B-')) {
      const code = normalizeBoxCode(raw);
      const match = boxesByCode[code];
      if (!match) { showToast(`No open box with code ${code}`, 3500); return; }
      goToBox(match.id);
      return;
    }
    const sku = normalizeSku(raw);
    for (const box of Object.values(boxesByCode)) {
      if (box.items.some(i => normalizeSku(i.sku) === sku)) {
        showToast(`${sku} → box ${box.code}`, 2500);
        goToBox(box.id);
        return;
      }
    }
    showToast(`Nothing matches ${raw}`, 3500);
  };

  // In-box scan: flip the matching item to packed. If the scanned plant
  // belongs to a DIFFERENT open box, jump to that box instead of erroring —
  // so scanning any plant always takes the packer to its box. EXCEPT when
  // the active box still needs the same lineup number: that's the wrong-grab
  // signature (last week's #N pulled instead of this week's), and the silent
  // jump is exactly what converted wrong grabs into wrong shipments.
  const handleScanItem = async (rawText) => {
    if (!activeBox) return;
    const sku = normalizeSku(rawText);
    if (!sku) return;
    // Mid-wrap, every scan is the verification scan: the fresh label on the
    // burrito either matches the plant being wrapped, or something is wrong.
    // Nothing else (box jumps, starting another wrap) is allowed until the
    // packer finishes or cancels — a mismatch here is exactly the
    // wrong-label-on-the-burrito mistake this flow exists to catch.
    if (activeWrap) {
      const wrapItem = activeBox.items.find(i => i.id === activeWrap.itemId);
      if (sku === activeWrap.sku) {
        const saved = activeWrap;
        setWrap(null);
        // Restore the wrap if the pack didn't stick — otherwise the retry
        // scan would start a fresh wrap and print a duplicate label.
        const ok = await packById(wrapItem.id, `${sku} — 🌯 done`);
        if (!ok) setWrap(saved);
        return;
      }
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
      const lot = wrapItem?.lotNumber ? `#${wrapItem.lotNumber} · ` : '';
      showToast(`⚠ Wrong label — you're wrapping ${lot}${activeWrap.sku}, but this label reads ${sku}. Fix the label, or Cancel on the wrap card.`, 6000);
      return;
    }
    const candidate = activeBox.items.find(i => normalizeSku(i.sku) === sku);
    if (!candidate) {
      const other = Object.values(boxesByCode).find(
        b => b.id !== activeBox.id && b.items.some(i => normalizeSku(i.sku) === sku),
      );
      if (other) {
        const scanned = other.items.find(i => normalizeSku(i.sku) === sku);
        const lot = parseInt(scanned?.lotNumber, 10);
        const needed = Number.isFinite(lot)
          ? activeBox.items.find(i => i.status === 'sold' && !i.packedAt && parseInt(i.lotNumber, 10) === lot)
          : null;
        if (needed) {
          if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
          // Synthetic UNMATCHED-/DBL- SKUs exist on no label (LabelSheet
          // suppresses them) — pointing the packer at one is a dead end.
          const neededSku = needed.sku && !/^(UNMATCHED|DBL)-/i.test(needed.sku)
            ? `SKU ${needed.sku}` : 'no barcode — an unmatched item';
          showToast(`⚠ Wrong plant — that's #${lot} for box ${other.code}. This box needs #${lot} (${neededSku}). Put it back and check the wk tag on the label.`, 7000);
          return;
        }
        showToast(`${sku} → box ${other.code}`, 2500);
        goToBox(other.id);
        return;
      }
      showToast(`SKU ${sku} isn't in any open box`, 3500);
      return;
    }
    if (candidate.status !== 'sold') { showToast(`SKU ${sku} is already ${candidate.status}`, 3500); return; }
    if (candidate.packedAt) { showToast(`SKU ${sku} already packed`, 2500); return; }
    if (wrapFlow) { await startWrap(candidate, sku); return; }
    await packById(candidate.id, sku);
  };

  // Per-row manual pack for unmatched placeholders (synthetic SKU, no barcode).
  // No barcode means no scan verification, so a collided lineup number must
  // be acknowledged before packing on the bare #.
  const handleMarkPacked = async (item) => {
    if (item.packedAt || item.status !== 'sold') return;
    const lot = parseInt(item.lotNumber, 10);
    if (dupeLots.has(lot) && !window.confirm(
      `#${lot} is also on another unpacked plant. Check the wk tag on the label — pack this one anyway?`,
    )) return;
    const label = item.name?.trim() || item.sku || 'item';
    await packById(item.id, label.slice(0, 30));
  };

  // Manual burrito-label print, per plant. The wrap flow auto-prints on
  // scan, but unmatched placeholders have no barcode to start a wrap,
  // reprints happen, and a station with the wrap flow off still wraps
  // burritos. Same mutex rule as startWrap: only the iPad path needs it.
  const handlePrintPlantLabel = async (item) => {
    const needMutex = printDests.itemlabel === 'ipad';
    if (needMutex && printing) { showToast('Printer is busy — try again in a moment', 2500); return; }
    showToast(`Printing label${item.lotNumber ? ` #${item.lotNumber}` : ''}…`, 1800);
    if (needMutex) setPrinting('itemlabel');
    try {
      await printItemLabel(item, printDests.itemlabel, showToast);
    } finally {
      if (needMutex) setPrinting(null);
    }
  };

  // Sweep scan: a FIND-scan, not a pack-scan — it only ticks a held or
  // pickup plant off the checklist. A plant that isn't in the sweep is the
  // packer's cue to leave it on the bench for this week's packing. Guards
  // live HERE (not in submitScan) so the camera path gets them too.
  const handleScanSweep = (rawText) => {
    const raw = String(rawText || '').trim();
    // The two most common non-plant barcodes in the room deserve honest
    // answers, not "unknown SKU". A box tag exits to that box (landing
    // muscle memory) — unless the box is IN the sweep, whose pane just said
    // nothing in it gets packed today.
    if (/^B[-_]/i.test(raw)) {
      const code = normalizeBoxCode(raw);
      if (sweepBoxes.some(sb => sb.box.code === code)) {
        showToast(`Box ${code} is in this sweep — scan its plants (or tap Boxes to leave)`, 3500);
        return;
      }
      // Resolve BEFORE exiting: a stale tag (yesterday's shipped box, one
      // from the trash) must not eject the packer from a half-done sweep.
      const match = boxesByCode[code];
      if (!match) { showToast(`No open box with code ${code}`, 3500); return; }
      setSweepOpen(false);
      goToBox(match.id);
      return;
    }
    if (looksLikeTracking(raw)) {
      showToast('That’s a shipping label — scan plant barcodes during the sweep', 3500);
      return;
    }
    const sku = normalizeSku(raw);
    if (!sku) return;
    // Prefer an UNMARKED match: double-sold duplicates can put the same SKU
    // in two swept boxes, and the second physical plant must still be
    // scannable to found — "already found" only when every match is marked.
    let already = false;
    for (const { box, plants, pickup } of sweepBoxes) {
      const hit = plants.find(i => normalizeSku(i.sku) === sku && !sweepMarks[i.id]);
      if (!hit) {
        already = already || plants.some(i => normalizeSku(i.sku) === sku);
        continue;
      }
      setSweepMarks(m => ({ ...m, [hit.id]: Date.now() }));
      if (sweepFound + 1 === sweepTotal) {
        if (navigator.vibrate) navigator.vibrate([60, 40, 60, 40, 140]);
        showToast(`All ${sweepTotal} plants found 🎉 — bench is clear for this week's packing`, 5000);
      } else {
        if (navigator.vibrate) navigator.vibrate(30);
        const take = hit.quantity > 1 ? ` — take all ${hit.quantity}` : '';
        showToast(`Found ${hit.lotNumber ? `#${hit.lotNumber} · ` : ''}${sku}${take} → ${pickup ? 'pickup' : 'hold'} shelf (box ${box.code})`, 2600);
      }
      return;
    }
    if (already) { showToast(`${sku} already found ✓`, 2000); return; }
    const elsewhere = Object.values(boxesByCode).find(b => b.items.some(i => normalizeSku(i.sku) === sku));
    if (elsewhere) { showToast(`${sku} isn't in the sweep — leave it on the bench (box ${elsewhere.code})`, 3500); return; }
    showToast(`SKU ${sku} isn't in any open box`, 3500);
  };

  // Manual found-toggle, only for swept plants with no scannable barcode
  // (synthetic UNMATCHED-/DBL- SKUs) — everything else must be scanned.
  // Fires the same completion signal as the scan path: the last unfound item
  // is often a barcode-less placeholder, exactly what this toggle is for.
  const handleToggleFound = (item) => {
    const marking = !sweepMarks[item.id];
    setSweepMarks(m => {
      const next = { ...m };
      if (next[item.id]) delete next[item.id];
      else next[item.id] = Date.now();
      return next;
    });
    if (marking && sweepFound + 1 === sweepTotal) {
      if (navigator.vibrate) navigator.vibrate([60, 40, 60, 40, 140]);
      showToast(`All ${sweepTotal} plants found 🎉 — bench is clear for this week's packing`, 5000);
    }
  };

  const submitScan = () => {
    const v = scanValue.trim();
    setScanValue('');
    if (v) {
      if (activeBox) {
        // A shipping-label barcode (long numeric / 1Z…) verifies the label;
        // anything else is treated as a plant SKU to pack.
        if (looksLikeTracking(v)) handleScanLabel(v);
        else handleScanItem(v);
      } else if (sweepOpen) {
        handleScanSweep(v);
      } else {
        handleScanBox(v);
      }
    }
    setTimeout(() => scanRef.current?.focus({ preventScroll: true }), 0);
  };

  // Realtime transport (preferred). Subscribe to a per-packer broadcast
  // channel; a 'box' event from the other device pops the find-list. self is
  // false so the sender never receives its own broadcast.
  useEffect(() => {
    if (!REALTIME_CONFIGURED || !currentUser?.id) return undefined;
    let active = true;
    let bound = null; // { client, channel }
    getRealtimeClient().then(client => {
      if (!active || !client) return;
      const channel = client.channel(`packer-handoff-${currentUser.id}`, {
        config: { broadcast: { self: false } },
      });
      channel.on('broadcast', { event: 'box' }, ({ payload }) => {
        if (payload?.box) setHandoff(payload.box);
      });
      channel.subscribe();
      bound = { client, channel };
      channelRef.current = channel;
    });
    return () => {
      active = false;
      channelRef.current = null;
      if (bound) bound.client.removeChannel(bound.channel);
    };
  }, [currentUser?.id]);

  // Polling fallback — only when realtime isn't configured. The first result
  // seeds the baseline (no pop); afterwards a changed sentAt pops the overlay.
  // The sender suppresses its own send via lastSentRef.
  useEffect(() => {
    if (REALTIME_CONFIGURED) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const h = await api.getPhoneHandoff();
        if (cancelled) return;
        const sentAt = h?.sentAt || null;
        if (!handoffReadyRef.current) {
          lastSentRef.current = sentAt;
          handoffReadyRef.current = true;
          return;
        }
        if (sentAt && sentAt !== lastSentRef.current) {
          lastSentRef.current = sentAt;
          if (h?.box) setHandoff(h.box);
        }
      } catch { /* ignore transient poll errors */ }
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Send the open box's items to the packer's phone — via realtime broadcast
  // when connected, otherwise the durable app_settings row the phone polls.
  const sendToPhone = async (box) => {
    const snapshot = {
      id: box.id,
      code: box.code,
      buyer: box.buyer,
      buyerUsername: box.buyerUsername,
      carrier: box.carrier,
      items: box.items.map(i => ({
        id: i.id, sku: i.sku, name: i.name, variety: i.variety,
        quantity: i.quantity, lotNumber: i.lotNumber, notes: i.notes,
        packedAt: i.packedAt, status: i.status,
      })),
    };
    if (REALTIME_CONFIGURED) {
      const channel = channelRef.current;
      if (!channel) { showToast('Phone link still connecting — try again', 3000); return; }
      try {
        const status = await channel.send({ type: 'broadcast', event: 'box', payload: { box: snapshot } });
        showToast(
          status === 'ok' ? 'Sent to your phone 📱' : 'Sent — make sure your phone is on the packing screen',
          status === 'ok' ? 1800 : 3500,
        );
      } catch (e) {
        showToast(`Send failed: ${e.message || 'unknown'}`, 4000);
      }
      return;
    }
    try {
      const r = await api.sendBoxToPhone(snapshot);
      if (r?.sentAt) lastSentRef.current = r.sentAt;
      showToast('Sent to your phone 📱', 1800);
    } catch (e) {
      showToast(`Send failed: ${e.message || 'unknown'}`, 4000);
    }
  };

  if (loading) return <FullScreenMessage><Loader2 className="w-5 h-5 animate-spin inline mr-2" />Loading boxes…</FullScreenMessage>;
  if (err) {
    return (
      <FullScreenMessage tone="error">
        {err} <button onClick={refresh} className="underline ml-2">retry</button>
      </FullScreenMessage>
    );
  }

  const totalOpen = openBoxes.length;
  const fullyPacked = openBoxes.filter(b => b.items.filter(i => i.status === 'sold').every(i => i.packedAt)).length;

  // Hold state of the box currently open — drives a distinct (amber) page
  // background + an easy-to-read banner so the packer can't miss a held box.
  // A box is on hold if it has a "1-week hold" item (the operator's manual
  // flag) OR an active holdUntil timestamp; only the timestamp has a countdown.
  // Item-based holds count a week from the hold item's purchase date; the
  // manual button hold uses its timestamp. boxHoldState unifies both.
  const activeHoldState = activeBox ? boxHoldState(activeBox.items, holdByBox[activeBox.id]) : { state: 'none' };
  const activeOnHold = activeHoldState.state === 'holding';
  const activeHoldReady = activeHoldState.state === 'ready';
  const activeHoldDays = activeHoldState.state === 'holding' ? activeHoldState.daysLeft : null;
  // Local pickup (seller note / item says "pickup") — a separate "do not ship"
  // flag with its own (violet) colour. Hold takes precedence for the page tint.
  const activeIsPickup = activeBox ? boxIsLocalPickup(noteByBox[activeBox.id], activeBox.items) : false;
  const pageTone = activeOnHold ? 'hold' : activeIsPickup ? 'pickup' : null;

  return (
    <div className={`fixed inset-0 flex flex-col ${pageTone === 'hold' ? 'bg-amber-100' : pageTone === 'pickup' ? 'bg-violet-100' : 'bg-gray-50'}`}>
      <TopBar
        onLogout={onLogout}
        tone={pageTone}
        title={activeBox ? activeBox.code : 'Packing'}
        subtitle={activeBox
          ? (buyerLabel(activeBox) || 'Box')
          : `${totalOpen} open · ${fullyPacked} packed`}
        onBack={activeBox ? () => goToBox(null) : null}
        onPrinterSettings={() => setPrinterSheetOpen(true)}
      />

      {/* Brand chooser — only on the landing screen (no box open) and only when
          the packer's account spans more than one 3babes brand. Picking a brand
          swaps which brand's boxes appear (BAE and Folia ship separately). */}
      {!activeBox && brands && brands.length > 1 && (
        <BrandStrip brands={brands} activeBrand={activeBrand} onSwitch={switchBrand} />
      )}

      {/* Easy-to-read flag banners under the bar — both can show (a box can be
          held AND local-pickup). Amber "ON HOLD"; violet "LOCAL PICKUP". */}
      {activeBox && activeIsPickup && (
        <div className="flex-shrink-0 bg-violet-500 text-white px-4 py-3 flex items-center justify-center gap-2 text-center">
          <Package className="w-6 h-6 flex-shrink-0" />
          <span className="text-lg font-extrabold tracking-wide">LOCAL PICKUP — do not ship, customer collects</span>
        </div>
      )}
      {activeBox && activeOnHold && (
        <div className="flex-shrink-0 bg-amber-400 text-amber-950 px-4 py-3 flex items-center justify-center gap-2 text-center">
          <Clock className="w-6 h-6 flex-shrink-0" />
          <span className="text-lg font-extrabold tracking-wide">
            ON HOLD — do not ship yet{activeHoldDays ? ` · ${activeHoldDays} day${activeHoldDays === 1 ? '' : 's'} left` : ''}
          </span>
        </div>
      )}
      {activeBox && activeHoldReady && (
        <div className="flex-shrink-0 bg-emerald-500 text-white px-4 py-2.5 flex items-center justify-center gap-2 text-center">
          <Check className="w-5 h-5 flex-shrink-0" />
          <span className="text-base font-bold">Hold complete — OK to ship</span>
        </div>
      )}

      {/* Always-on scan strip — the USB scanner types here. */}
      <ScanField
        inputRef={scanRef}
        value={scanValue}
        onChange={setScanValue}
        onSubmit={submitScan}
        placeholder={activeBox
          ? (trackingByBox[activeBox.id] ? 'Scan a plant or the shipping label…' : 'Scan a plant barcode…')
          : sweepOpen ? 'Scan a plant for the sweep…' : 'Scan a box or plant…'}
        onCamera={() => setCameraMode(activeBox ? 'item' : sweepOpen ? 'sweep' : 'box')}
      />

      {activeBox
        ? <BoxPane
            box={activeBox}
            assignedTracking={trackingByBox[activeBox.id] || null}
            dupeLots={dupeLots}
            wrap={activeWrap}
            onWrapCancel={() => setWrap(null)}
            onWrapReprint={() => {
              const it = activeBox.items.find(i => i.id === activeWrap?.itemId);
              if (it) startWrap(it, activeWrap.sku);
            }}
            onMarkPacked={handleMarkPacked}
            onPrintPlantLabel={handlePrintPlantLabel}
            onCamera={() => setCameraMode('item')}
            onScanLabel={() => setCameraMode('label')}
            onSendToPhone={isMobile ? null : () => sendToPhone(activeBox)}
            onPrintLabel={labelByBox[activeBox.id] ? printActiveLabel : null}
            onPrintTag={printActiveTag}
            printing={printing}
            onDone={() => goToBox(null)}
          />
        : sweepOpen
        ? <SweepPane
            sweepBoxes={sweepBoxes}
            marks={sweepMarks}
            found={sweepFound}
            total={sweepTotal}
            dupeLots={dupeLots}
            onToggleFound={handleToggleFound}
            onReset={() => {
              if (window.confirm('Restart the sweep? All found checkmarks clear.')) setSweepMarks({});
            }}
            onCamera={() => setCameraMode('sweep')}
            onClose={() => setSweepOpen(false)}
          />
        : <>
            {/* Held + pickup plants come off the bench FIRST — stock that
                isn't shipping this week mixed into this week's packing is
                how wrong plants ship. */}
            {sweepBoxes.length > 0 && (
              <div className="flex-shrink-0 px-3 sm:px-5 pt-3">
                <button
                  type="button"
                  onClick={() => setSweepOpen(true)}
                  className={`max-w-5xl mx-auto w-full text-left rounded-2xl border-2 px-4 py-3 flex items-center gap-3 transition active:scale-[0.99] ${
                    sweepFound === sweepTotal
                      ? 'border-emerald-300 bg-emerald-50'
                      : 'border-amber-400 bg-amber-100 hover:border-amber-500'
                  }`}
                >
                  {sweepFound === sweepTotal
                    ? <Check className="w-6 h-6 text-emerald-600 shrink-0" />
                    : <Clock className="w-6 h-6 text-amber-700 shrink-0" />}
                  <span className="flex-1 min-w-0">
                    <span className={`block text-base font-bold ${sweepFound === sweepTotal ? 'text-emerald-800' : 'text-amber-900'}`}>
                      {sweepFound === sweepTotal
                        ? 'All held & pickup plants off the bench ✓'
                        : 'Step 1 — pull held & pickup plants off the bench'}
                    </span>
                    <span className={`block text-sm ${sweepFound === sweepTotal ? 'text-emerald-700' : 'text-amber-800'}`}>
                      {sweepFound}/{sweepTotal} found · {sweepBoxes.length} {sweepBoxes.length === 1 ? 'box isn’t' : 'boxes aren’t'} shipping this week
                    </span>
                  </span>
                </button>
              </div>
            )}
            <LandingGrid
              boxes={openBoxes}
              boxSizes={boxSizes}
              boxSizeByBox={boxSizeByBox}
              trackingByBox={trackingByBox}
              holdByBox={holdByBox}
              noteByBox={noteByBox}
              onOpen={goToBox}
            />
          </>
      }

      {cameraMode && (cameraMode === 'box' || cameraMode === 'sweep' || activeBox) && (
        <CameraScanner
          onScan={
            cameraMode === 'box' ? handleScanBox
              : cameraMode === 'sweep' ? handleScanSweep
              : cameraMode === 'label' ? handleScanLabel
                : handleScanItem
          }
          onClose={() => setCameraMode(null)}
        />
      )}
      {printerSheetOpen && (
        <PrinterSettingsSheet
          dests={printDests}
          onDestChange={(kind, d) => { savePrintDest(kind, d); setPrintDests(p => ({ ...p, [kind]: d })); }}
          wrapFlow={wrapFlow}
          onWrapFlowChange={(on) => { saveWrapFlow(on); setWrapFlow(on); }}
          onClose={() => setPrinterSheetOpen(false)}
          showToast={showToast}
        />
      )}
      {handoff && <PhoneHandoffOverlay box={handoff} onClose={() => setHandoff(null)} />}
      {success && <GoodJobOverlay info={success} />}
      {toast && <Toast text={toast} />}
    </div>
  );
}

function TopBar({ onLogout, title, subtitle, onBack, tone, onPrinterSettings }) {
  const isCodeTitle = /^B-/.test(title || '');
  // Flagged box → coloured bar so the whole top of the screen reads the state:
  // amber = on hold, violet = local pickup, else the normal emerald.
  const barBg = tone === 'hold' ? 'bg-amber-600' : tone === 'pickup' ? 'bg-violet-600' : 'bg-emerald-700';
  const btnHover = tone === 'hold'
    ? 'hover:bg-amber-700 active:bg-amber-800'
    : tone === 'pickup'
    ? 'hover:bg-violet-700 active:bg-violet-800'
    : 'hover:bg-emerald-800 active:bg-emerald-900';
  const subTone = tone === 'hold' ? 'text-amber-100' : tone === 'pickup' ? 'text-violet-100' : 'text-emerald-100';
  return (
    <div className={`${barBg} text-white pt-safe flex-shrink-0`}>
      <div className="h-16 px-3 sm:px-5 flex items-center gap-3">
        {onBack ? (
          <button
            onClick={onBack}
            aria-label="Back"
            className={`w-12 h-12 -ml-2 rounded-full flex items-center justify-center ${btnHover}`}
          >
            <ArrowLeft className="w-6 h-6" />
          </button>
        ) : (
          <div className="w-12 h-12 -ml-2 rounded-full flex items-center justify-center">
            <Package className="w-6 h-6" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className={`font-semibold text-lg leading-tight truncate ${isCodeTitle ? 'font-mono tracking-wide' : ''}`}>
            {title}
          </div>
          {subtitle && <div className={`text-sm ${subTone} leading-tight truncate mt-0.5`}>{subtitle}</div>}
        </div>
        {onPrinterSettings && (
          <button
            onClick={onPrinterSettings}
            aria-label="Printer settings"
            className={`w-12 h-12 rounded-full flex items-center justify-center ${btnHover}`}
          >
            <Printer className="w-6 h-6" />
          </button>
        )}
        <button
          onClick={onLogout}
          aria-label="Log out"
          className={`w-12 h-12 -mr-2 rounded-full flex items-center justify-center ${btnHover}`}
        >
          <LogOut className="w-6 h-6" />
        </button>
      </div>
    </div>
  );
}

// Big, touch-first brand chooser for the packing table. Switching remounts the
// app (App is keyed by activeBrand), so PackerView refetches the chosen brand's
// boxes and lands back on the grid. Active brand uses its accent colour (Folia
// green / BAE red) so it's obvious which brand's boxes are on screen.
function BrandStrip({ brands, activeBrand, onSwitch }) {
  return (
    <div className="flex-shrink-0 bg-white border-b border-gray-200 px-3 sm:px-5 py-2.5">
      <div className="max-w-5xl mx-auto flex items-center gap-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-400 flex-shrink-0">
          Brand
        </span>
        <div className="flex-1 flex gap-2">
          {brands.map((b) => {
            const active = b.id === activeBrand;
            return (
              <button
                key={b.id}
                type="button"
                onClick={() => { if (!active) onSwitch(b.id); }}
                aria-pressed={active}
                className={`flex-1 h-11 rounded-xl border-2 text-sm font-semibold inline-flex items-center justify-center gap-2 transition active:scale-[0.99] ${
                  active ? 'text-white shadow-sm' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                }`}
                style={active ? { background: b.accent, borderColor: b.accent } : undefined}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ background: active ? '#fff' : b.accent }}
                />
                {b.name}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// The always-focused scan input. inputMode="none" keeps iPadOS from popping
// the on-screen keyboard while the hardware scanner still types into it.
function ScanField({ inputRef, value, onChange, onSubmit, placeholder, onCamera }) {
  return (
    <div className="flex-shrink-0 bg-white border-b border-gray-200 px-3 sm:px-5 py-3">
      <div className="flex items-center gap-2 max-w-5xl mx-auto">
        <form
          onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
          className="flex-1 flex items-center gap-2 px-3 h-14 rounded-xl border-2 border-emerald-300 bg-emerald-50/40 focus-within:border-emerald-500 focus-within:bg-white"
        >
          <ScanLine className="w-6 h-6 text-emerald-600 flex-shrink-0" />
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSubmit(); } }}
            inputMode="none"
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label="Scan barcode"
            placeholder={placeholder}
            className="flex-1 min-w-0 bg-transparent outline-none text-lg font-mono text-gray-900 placeholder:font-sans placeholder:text-gray-400"
          />
          <span className="hidden sm:flex items-center gap-1.5 text-xs text-emerald-700 flex-shrink-0">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" /> Ready
          </span>
        </form>
        <button
          type="button"
          onClick={onCamera}
          aria-label="Scan with camera"
          className="flex-shrink-0 w-14 h-14 rounded-xl border-2 border-gray-200 bg-white text-gray-600 flex items-center justify-center hover:bg-gray-50 active:bg-gray-100"
          title="Scan with the camera instead"
        >
          <Camera className="w-6 h-6" />
        </button>
      </div>
    </div>
  );
}

// Landing — a responsive grid of every open box. Tap a card to open it (or
// just scan). Cards show packing progress + the chosen box size so the
// packer can see what's left at a glance across the iPad.
// One sweep checklist row, shared by the lot-ordered and by-box views. The
// box code chip renders only in the flat view, where rows from many boxes
// interleave.
function SweepPlantRow({ item, pickup, boxCode, isFound, isDupe, onToggleFound }) {
  // Synthetic placeholder SKUs have no barcode to scan.
  const noBarcode = !item.sku || /^(UNMATCHED|DBL)-/i.test(item.sku);
  return (
    <div
      className={`px-3 py-2.5 rounded-xl border-2 flex items-center gap-2.5 ${
        isFound ? 'bg-emerald-50 border-emerald-200' : `bg-white ${pickup ? 'border-violet-200' : 'border-amber-200'}`
      }`}
    >
      {isFound
        ? <Check className="w-5 h-5 text-emerald-600 shrink-0" />
        : <div className={`w-5 h-5 rounded-full border-2 shrink-0 ${pickup ? 'border-violet-300' : 'border-amber-300'}`} />}
      {item.lotNumber && (
        <span
          className={`shrink-0 min-w-[2.5rem] px-1.5 py-0.5 rounded-lg text-lg font-extrabold text-center tabular-nums ${
            isFound ? 'bg-gray-200 text-gray-400' : 'bg-blue-600 text-white'
          } ${isDupe && !isFound ? 'ring-2 ring-red-500' : ''}`}
          title="Lineup number — find the plant labelled with this #"
        >
          {item.lotNumber}
        </span>
      )}
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-mono ${isFound ? 'text-gray-400' : 'text-gray-800 font-semibold'}`}>
          {noBarcode ? '(no barcode)' : item.sku}
        </div>
        {(item.name || item.variety) && (
          <div className={`text-xs break-words ${isFound ? 'text-gray-400 line-through' : 'text-gray-500'}`}>
            {[(item.name || '').trim(), (item.variety || '').trim()].filter(Boolean).join(' · ')}
          </div>
        )}
      </div>
      {boxCode && (
        <span className={`shrink-0 text-[11px] font-mono font-bold px-1.5 py-0.5 rounded ${
          pickup ? 'bg-violet-100 text-violet-800' : 'bg-amber-100 text-amber-900'
        }`}
        >
          {boxCode}
        </span>
      )}
      {item.quantity > 1 && (
        <span className={`text-sm font-bold shrink-0 ${isFound ? 'text-gray-400' : 'text-amber-800'}`}>
          ×{item.quantity}
        </span>
      )}
      {noBarcode && (
        <button
          type="button"
          onClick={() => onToggleFound(item)}
          aria-pressed={isFound}
          aria-label={`Mark ${(item.name || 'item').trim()} ${isFound ? 'not found' : 'found'}`}
          className={`shrink-0 text-sm font-semibold px-3 py-2 rounded-lg ${
            isFound
              ? 'bg-gray-200 text-gray-600 active:bg-gray-300'
              : 'bg-purple-600 text-white active:bg-purple-800'
          }`}
          title="No scannable barcode — mark found manually"
        >
          {isFound ? 'Undo' : 'Found'}
        </button>
      )}
    </div>
  );
}

// Bench sweep checklist: every unpacked plant of every box that ISN'T
// shipping this week — still-holding boxes and local-pickup boxes — scanned
// off as the packer pulls them from the bench. Two views: a flat list in
// lot-number order (the locate view — benches are walked by lineup number)
// and grouped by box. Scanning is the verification — a manual Found toggle
// exists only for placeholder items with no scannable barcode.
function SweepPane({ sweepBoxes, marks, found, total, dupeLots, onToggleFound, onReset, onCamera, onClose }) {
  const allFound = total > 0 && found === total;
  const [byBox, setByBox] = useState(false);
  // Flat locate view: every swept plant in lot-number order; un-numbered
  // rows sink to the bottom.
  const flatPlants = sweepBoxes
    .flatMap(({ box, plants, pickup }) => plants.map(item => ({ item, box, pickup })))
    .sort((a, b) => (parseInt(a.item.lotNumber, 10) || 999999) - (parseInt(b.item.lotNumber, 10) || 999999));
  // Pickup boxes never ship — their date line must not say so. A pickup box
  // that's ALSO on hold shows when the buyer can collect.
  const holdLabel = (hold, pickup) => {
    const when = hold?.state === 'holding' && hold.until
      ? hold.until.toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' })
      : null;
    if (pickup) return when ? `pickup after ${when}` : 'pickup — do not ship';
    return when ? `ships ${when}` : 'on hold';
  };
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-shrink-0 px-4 sm:px-5 py-3 border-b border-amber-200 bg-amber-50">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center gap-2 flex-wrap">
            <Clock className="w-5 h-5 text-amber-700 shrink-0" />
            <h2 className="flex-1 text-base font-bold text-amber-900">Held & pickup plants — pull these off the bench first</h2>
            <div className="text-base">
              <span className="font-bold text-gray-900">{found}/{total}</span>
              <span className="text-gray-500 ml-1">found</span>
            </div>
          </div>
          <div
            className="mt-2 w-full bg-amber-200 rounded-full h-2.5 overflow-hidden"
            role="progressbar" aria-valuenow={found} aria-valuemin={0} aria-valuemax={total}
          >
            <div className="h-full bg-amber-500 transition-all" style={{ width: total ? `${(found / total) * 100}%` : 0 }} />
          </div>
          <p className="text-xs text-amber-800 mt-1.5">
            Scan each plant's barcode as you pull it: held plants go to the hold shelf, pickup plants to the pickup shelf. Nothing here gets packed today.
          </p>
          <div className="mt-2 flex gap-1.5">
            <button
              type="button"
              aria-pressed={!byBox}
              onClick={() => setByBox(false)}
              className={`text-xs font-semibold px-2.5 py-1.5 rounded-lg border-2 ${
                !byBox ? 'border-amber-500 bg-amber-500 text-white' : 'border-amber-300 bg-white text-amber-800'
              }`}
            >
              By lot #
            </button>
            <button
              type="button"
              aria-pressed={byBox}
              onClick={() => setByBox(true)}
              className={`text-xs font-semibold px-2.5 py-1.5 rounded-lg border-2 ${
                byBox ? 'border-amber-500 bg-amber-500 text-white' : 'border-amber-300 bg-white text-amber-800'
              }`}
            >
              By box
            </button>
          </div>
        </div>
      </div>

      {allFound && (
        <div className="flex-shrink-0 bg-emerald-500 text-white px-4 py-2.5 flex items-center justify-center gap-2 text-center">
          <Check className="w-5 h-5 shrink-0" />
          <span className="text-base font-bold">All held & pickup plants found — the bench is clear for this week's packing</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 sm:px-5 py-4">
        <div className="max-w-5xl mx-auto space-y-4">
          {sweepBoxes.length === 0 && (
            <div className="text-center text-sm text-gray-500 py-12">
              <PackageCheck className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              No held or pickup plants right now — you&apos;re clear to pack.
            </div>
          )}
          {!byBox && sweepBoxes.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {flatPlants.map(({ item, box, pickup }) => (
                <SweepPlantRow
                  key={item.id}
                  item={item}
                  pickup={pickup}
                  boxCode={box.code}
                  isFound={!!marks[item.id]}
                  isDupe={!!dupeLots && dupeLots.has(parseInt(item.lotNumber, 10))}
                  onToggleFound={onToggleFound}
                />
              ))}
            </div>
          )}
          {byBox && sweepBoxes.map(({ box, plants, hold, pickup }) => {
            const boxFound = plants.filter(p => marks[p.id]).length;
            return (
              <div
                key={box.id}
                className={`rounded-2xl border-2 overflow-hidden ${
                  pickup ? 'border-violet-300 bg-violet-50' : 'border-amber-300 bg-amber-50'
                }`}
              >
                <div className={`px-3.5 py-2.5 flex items-center gap-2 flex-wrap ${pickup ? 'bg-violet-100' : 'bg-amber-100'}`}>
                  <span className={`font-mono font-bold ${pickup ? 'text-violet-950' : 'text-amber-950'}`}>{box.code}</span>
                  {box.buyer && <span className={`text-sm truncate ${pickup ? 'text-violet-900' : 'text-amber-900'}`}>{box.buyer}</span>}
                  {pickup && (
                    <span className="text-[11px] font-bold uppercase tracking-wide text-violet-800 bg-violet-200 px-1.5 py-0.5 rounded">
                      Pickup
                    </span>
                  )}
                  <span className={`text-xs font-semibold ml-auto ${pickup ? 'text-violet-800' : 'text-amber-800'}`}>
                    {holdLabel(hold, pickup)} · {boxFound}/{plants.length}
                  </span>
                </div>
                <div className="p-2.5 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {plants.map(item => (
                    <SweepPlantRow
                      key={item.id}
                      item={item}
                      pickup={pickup}
                      isFound={!!marks[item.id]}
                      isDupe={!!dupeLots && dupeLots.has(parseInt(item.lotNumber, 10))}
                      onToggleFound={onToggleFound}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          {found > 0 && (
            <button
              type="button"
              onClick={onReset}
              className="w-full text-sm font-semibold text-gray-500 py-2 rounded-lg hover:bg-gray-100 active:bg-gray-200"
            >
              Reset the sweep
            </button>
          )}
          <div className="h-6 pb-safe" />
        </div>
      </div>

      <div className="flex-shrink-0 border-t border-gray-200 bg-white p-3 pb-safe">
        <div className="max-w-5xl mx-auto flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center gap-2 px-4 py-3 text-base font-semibold bg-gray-100 text-gray-800 rounded-xl active:bg-gray-200"
          >
            <ArrowLeft className="w-5 h-5" /> Boxes
          </button>
          <button
            type="button"
            onClick={onCamera}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3 text-base font-semibold bg-blue-600 text-white rounded-xl active:bg-blue-800"
          >
            <Camera className="w-5 h-5" /> Scan a plant
          </button>
        </div>
      </div>
    </div>
  );
}

function LandingGrid({ boxes, boxSizes, boxSizeByBox, trackingByBox, holdByBox, noteByBox, onOpen }) {
  if (boxes.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center pb-safe">
        <PackageCheck className="w-16 h-16 text-emerald-300 mb-3" />
        <h2 className="text-lg font-semibold text-gray-900">All caught up</h2>
        <p className="text-sm text-gray-500 mt-1 max-w-xs">No open boxes to pack right now. Scan a box label if one was just created.</p>
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto px-3 sm:px-5 py-4">
      <div className="max-w-5xl mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {boxes.map(box => (
          <BoxCard
            key={box.id}
            box={box}
            sizeName={boxSizes.find(s => s.id === boxSizeByBox[box.id])?.name || null}
            hasLabel={!!trackingByBox?.[box.id]}
            holdState={boxHoldState(box.items, holdByBox?.[box.id])}
            isPickup={boxIsLocalPickup(noteByBox?.[box.id], box.items)}
            onOpen={() => onOpen(box.id)}
          />
        ))}
      </div>
      <div className="h-6 pb-safe" />
    </div>
  );
}

function BoxCard({ box, sizeName, hasLabel, holdState, isPickup, onOpen }) {
  const sold = box.items.filter(i => i.status === 'sold');
  const packed = sold.filter(i => i.packedAt).length;
  const total = sold.length;
  const allPacked = total > 0 && packed === total;
  const pct = total > 0 ? (packed / total) * 100 : 0;
  const onHold = holdState?.state === 'holding';
  const holdReady = holdState?.state === 'ready';
  const holdDays = holdState?.state === 'holding' ? holdState.daysLeft : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`text-left rounded-2xl border-2 p-4 transition active:scale-[0.99] ${
        onHold
          ? 'border-amber-400 bg-amber-100 hover:border-amber-500'
          : isPickup
          ? 'border-violet-400 bg-violet-100 hover:border-violet-500'
          : allPacked
          ? 'border-emerald-300 bg-emerald-50/60 hover:border-emerald-400'
          : 'border-gray-200 bg-white hover:border-emerald-400 hover:shadow-sm'
      }`}
    >
      <div className="flex items-center gap-2">
        <CarrierBadge carrier={box.carrier} size="sm" />
        <span className="font-mono font-semibold text-gray-900 tracking-wide">{box.code}</span>
        {allPacked && <Check className="w-5 h-5 text-emerald-600 ml-auto" />}
        {!allPacked && <ChevronRight className="w-5 h-5 text-gray-300 ml-auto" />}
      </div>
      <div className="mt-2">
        <div className="text-sm font-medium text-gray-900 truncate">
          {box.buyer || (box.buyerUsername ? `@${box.buyerUsername}` : 'Box')}
        </div>
        {box.buyer && box.buyerUsername && (
          <div className="text-xs text-gray-500 truncate">@{box.buyerUsername}</div>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div className="flex-1 bg-gray-200 rounded-full h-2 overflow-hidden">
          <div className={`h-full ${allPacked ? 'bg-emerald-500' : 'bg-emerald-400'}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="text-xs font-medium text-gray-600 tabular-nums">{packed}/{total}</span>
      </div>
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <BoxContentBadges box={box} />
        {onHold && (
          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-900 bg-amber-200 ring-1 ring-amber-400 px-1.5 py-0.5 rounded" title="On hold — do not ship yet">
            <Clock className="w-3 h-3" /> On hold{holdDays ? ` · ${holdDays}d` : ''}
          </span>
        )}
        {holdReady && (
          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-white bg-emerald-600 px-1.5 py-0.5 rounded" title="Hold complete — ready to ship">
            <Check className="w-3 h-3" /> Hold done
          </span>
        )}
        {isPickup && (
          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-violet-900 bg-violet-200 ring-1 ring-violet-400 px-1.5 py-0.5 rounded" title="Local pickup — do not ship">
            <Package className="w-3 h-3" /> Pickup
          </span>
        )}
        {sizeName && (
          <span className="inline-flex items-center gap-1 text-[11px] text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">
            <Ruler className="w-3 h-3" /> {sizeName}
          </span>
        )}
        {hasLabel && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded" title="Shipping label imported — scan it to confirm">
            <ScanLine className="w-3 h-3" /> Label
          </span>
        )}
      </div>
    </button>
  );
}

// Active-box pane: progress header, item grid, and — once everything is
// packed — the final "scan the shipping label" step.
// Big, scannable "Ship to" block — recipient name + address so the packer
// can match it against the physical shipping label before attaching it.
function ShipTo({ box }) {
  const a = box.buyerAddress || {};
  const name = box.buyer || (box.buyerUsername ? `@${box.buyerUsername}` : 'Unknown recipient');
  const line1 = [a.street1, a.street2].filter(Boolean).join(', ');
  const cityLine = [[a.city, a.state].filter(Boolean).join(', '), a.zip].filter(Boolean).join(' ').trim();
  return (
    <div className="mb-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Ship to</div>
      <div className="text-xl sm:text-2xl font-bold text-gray-900 leading-tight break-words">{name}</div>
      {box.buyer && box.buyerUsername && (
        <div className="text-sm text-gray-500 leading-tight">@{box.buyerUsername}</div>
      )}
      {(line1 || cityLine) && (
        <div className="text-base text-gray-700 leading-snug mt-1">
          {line1 && <div>{line1}</div>}
          {cityLine && <div>{cityLine}</div>}
        </div>
      )}
    </div>
  );
}

function BoxPane({ box, assignedTracking, dupeLots, wrap, onWrapCancel, onWrapReprint, onMarkPacked, onPrintPlantLabel, onCamera, onScanLabel, onSendToPhone, onPrintLabel, onPrintTag, printing, onDone }) {
  const unpacked = box.items.filter(i => i.status === 'sold' && !i.packedAt);
  const packed = box.items.filter(i => i.status === 'sold' && !!i.packedAt);
  const total = unpacked.length + packed.length;
  const allPacked = total > 0 && unpacked.length === 0;
  const pct = total > 0 ? (packed.length / total) * 100 : 0;
  const wrapItem = wrap ? box.items.find(i => i.id === wrap.itemId) : null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Progress header */}
      <div className="flex-shrink-0 px-4 sm:px-5 py-3 border-b border-gray-200 bg-white">
        <div className="max-w-5xl mx-auto">
          {/* Ship-to — big name + address so the packer can match the
              physical shipping label before attaching it. */}
          <ShipTo box={box} />
          <div className="flex items-center gap-2 flex-wrap">
            <CarrierBadge carrier={box.carrier} />
            <BoxContentBadges box={box} size="lg" />
            <div className="ml-auto text-base">
              <span className="font-bold text-gray-900">{packed.length}/{total}</span>
              <span className="text-gray-500 ml-1">packed</span>
            </div>
          </div>
          <div className="mt-2 w-full bg-gray-200 rounded-full h-2.5 overflow-hidden">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>

      {/* Active burrito wrap — pinned above the item grid so the packer
          always sees which plant the printed label belongs to. */}
      {wrap && (
        <div className="flex-shrink-0 px-3 sm:px-5 pt-3">
          <div className="max-w-5xl mx-auto rounded-xl border-2 border-amber-400 bg-amber-50 px-3.5 py-3 flex items-center gap-3">
            <span className="text-2xl shrink-0" aria-hidden>🌯</span>
            {wrapItem?.lotNumber && (
              <span className="shrink-0 min-w-[2.5rem] px-1.5 py-0.5 rounded-lg text-xl font-extrabold text-center tabular-nums bg-amber-500 text-white">
                {wrapItem.lotNumber}
              </span>
            )}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold text-amber-900 truncate">
                Wrapping {wrap.sku}{wrapItem?.name ? ` · ${wrapItem.name}` : ''}
              </div>
              <div className="text-xs text-amber-800">
                {wrap.print === 'sending' ? 'Printing the label…'
                  : wrap.print === 'failed' ? 'Label didn’t print — tap Reprint.'
                    : 'Stick the fresh label on the burrito, then scan it to finish.'}
              </div>
            </div>
            <button
              type="button"
              onClick={onWrapReprint}
              disabled={wrap.print === 'sending' || !!printing}
              className="shrink-0 text-sm font-semibold px-3 py-2 rounded-lg bg-white border-2 border-amber-400 text-amber-800 active:bg-amber-100 disabled:opacity-50 flex items-center gap-1"
            >
              <Printer className="w-4 h-4" /> Reprint
            </button>
            <button
              type="button"
              onClick={onWrapCancel}
              className="shrink-0 text-sm font-semibold px-3 py-2 rounded-lg text-amber-800 active:bg-amber-100"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-3 sm:px-5 py-4">
        <div className="max-w-5xl mx-auto">
          {allPacked ? (
            <FinalStep
              assignedTracking={assignedTracking}
              onScanLabel={onScanLabel}
              onPrintLabel={onPrintLabel}
              onPrintTag={onPrintTag}
              printing={printing}
              onDone={onDone}
            />
          ) : (
            <>
              {total === 0 ? (
                <div className="text-center text-sm text-gray-500 py-12">
                  <Package className="w-8 h-8 text-gray-300 mx-auto mb-2" /> No items in this box.
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {unpacked.map(item => <ItemCard key={item.id} item={item} onMarkPacked={onMarkPacked} onPrintPlantLabel={onPrintPlantLabel} dupeLots={dupeLots} wrapping={wrap?.itemId === item.id} />)}
                  {packed.map(item => <ItemCard key={item.id} item={item} />)}
                </div>
              )}
            </>
          )}
          <div className="h-6 pb-safe" />
        </div>
      </div>

      {/* Footer — only while packing: push-to-phone + camera. Once every item
          is packed, the body shows the final label-scan step. */}
      {!allPacked && (
        <div className="flex-shrink-0 border-t border-gray-200 bg-white p-3 pb-safe">
          <div className="max-w-5xl mx-auto flex gap-3 flex-wrap">
            {/* iPad-only: push this box's item list to the packer's phone so
                they can walk the racks and find items hands-free. */}
            {onSendToPhone && (
              <button
                type="button"
                onClick={onSendToPhone}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-3.5 text-base font-semibold bg-blue-600 text-white rounded-xl active:bg-blue-800"
              >
                <Smartphone className="w-5 h-5" /> Send to phone
              </button>
            )}
            {/* Reprint this box's 2×1 tag (B-XXXXXX barcode) at the table.
                Both print buttons disable while EITHER job runs — the iPad
                path's print root must never host two jobs at once. */}
            {onPrintTag && (
              <button
                type="button"
                onClick={onPrintTag}
                disabled={!!printing}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-3.5 text-base font-semibold bg-white border-2 border-gray-200 text-gray-700 rounded-xl active:bg-gray-50 disabled:opacity-60"
              >
                {printing === 'tag' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Tag className="w-5 h-5" />} Print tag
              </button>
            )}
            {/* Print this box's shipping label at the packing table — only
                offered once the label exists (imported at the shipping desk). */}
            {onPrintLabel && (
              <button
                type="button"
                onClick={onPrintLabel}
                disabled={!!printing}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-3.5 text-base font-semibold bg-white border-2 border-gray-200 text-gray-700 rounded-xl active:bg-gray-50 disabled:opacity-60"
              >
                {printing === 'label' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Printer className="w-5 h-5" />} Print label
              </button>
            )}
            <button
              type="button"
              onClick={onCamera}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-3.5 text-base font-semibold bg-white border-2 border-gray-200 text-gray-700 rounded-xl active:bg-gray-50"
            >
              <Camera className="w-5 h-5" /> Scan a plant
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Shown once every item is packed: the final step is scanning the shipping
// label. A correct scan triggers the "Good job" screen (see handleScanLabel).
function FinalStep({ assignedTracking, onScanLabel, onPrintLabel, onPrintTag, printing, onDone }) {
  return (
    <div className="text-center max-w-md mx-auto pt-2">
      <div className="flex items-center justify-center gap-2.5 mb-1.5">
        <PackageCheck className="w-9 h-9 text-emerald-600" />
        <h2 className="text-2xl font-bold text-gray-900">All items packed!</h2>
      </div>
      {assignedTracking ? (
        <>
          <p className="text-lg text-gray-600 mb-6">
            {onPrintLabel
              ? "Last step — print the shipping label, stick it on, then scan it to confirm it's the right one."
              : "Last step — scan the shipping label to confirm it's the right one."}
          </p>
          {onPrintLabel && (
            <button
              type="button"
              onClick={onPrintLabel}
              disabled={!!printing}
              className="w-full flex items-center justify-center gap-2 px-4 py-4 mb-3 text-lg font-semibold bg-white border-2 border-emerald-300 text-emerald-700 rounded-xl active:bg-emerald-50 disabled:opacity-60"
            >
              {printing === 'label' ? <Loader2 className="w-6 h-6 animate-spin" /> : <Printer className="w-6 h-6" />} Print shipping label
            </button>
          )}
          <button
            type="button"
            onClick={onScanLabel}
            className="w-full flex items-center justify-center gap-2 px-4 py-5 text-lg font-semibold bg-emerald-600 text-white rounded-xl active:bg-emerald-800"
          >
            <ScanLine className="w-6 h-6" /> Scan shipping label
          </button>
          <p className="text-sm text-gray-400 mt-3">Or scan it with the handheld scanner.</p>
        </>
      ) : (
        <>
          <div className="flex items-start gap-2 text-base text-gray-600 bg-amber-50 border border-amber-200 rounded-xl p-4 mb-5 text-left">
            <AlertCircle className="w-6 h-6 text-amber-600 flex-shrink-0 mt-0.5" />
            <span>No shipping label has been imported for this box yet. Ask the shipping desk to import it, then scan it here.</span>
          </div>
          <button
            type="button"
            onClick={onDone}
            className="w-full flex items-center justify-center gap-2 px-4 py-4 text-lg font-semibold bg-white border-2 border-gray-200 text-gray-700 rounded-xl active:bg-gray-50"
          >
            Done — next box <ChevronRight className="w-6 h-6" />
          </button>
        </>
      )}
      {/* Reprint the 2×1 box tag — useful when the tag was never printed or
          got damaged during packing. Available with or without a label. */}
      {onPrintTag && (
        <button
          type="button"
          onClick={onPrintTag}
          disabled={!!printing}
          className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-3 text-base font-semibold bg-white border-2 border-gray-200 text-gray-700 rounded-xl active:bg-gray-50 disabled:opacity-60"
        >
          {printing === 'tag' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Tag className="w-5 h-5" />} Print box tag
        </button>
      )}
    </div>
  );
}

// Full-screen "Good job" celebration after a correct final label scan. The
// caller auto-returns to the grid a beat later, so this is display-only.
function GoodJobOverlay({ info }) {
  return (
    <div className="fixed inset-0 z-[70] bg-emerald-600 text-white flex flex-col items-center justify-center px-6 text-center pt-safe pb-safe">
      <div className="folia-goodjob">
        <PackageCheck className="w-24 h-24 mx-auto mb-4" strokeWidth={1.5} />
      </div>
      <h1 className="text-4xl font-extrabold">Good job! 🎉</h1>
      <p className="text-lg text-emerald-100 mt-2">
        <span className="font-mono tracking-wide">{info.code}</span>
        {info.who ? ` · ${info.who}` : ''} — shipped!
      </p>
      <p className="text-sm text-emerald-200/80 mt-6">Returning to boxes…</p>
      <style>{`
        @keyframes folia-goodjob-pop {
          0%   { opacity: 0; transform: scale(0.6); }
          50%  { transform: scale(1.08); }
          100% { opacity: 1; transform: scale(1); }
        }
        .folia-goodjob { animation: folia-goodjob-pop 0.4s ease-out; }
      `}</style>
    </div>
  );
}

function CarrierBadge({ carrier, size = 'md' }) {
  const c = String(carrier || 'usps').toUpperCase();
  const isUps = c === 'UPS';
  const cls = isUps
    ? 'bg-amber-100 text-amber-900 ring-1 ring-amber-300'
    : 'bg-blue-100 text-blue-900 ring-1 ring-blue-300';
  const sz = size === 'sm'
    ? 'px-2 py-0.5 text-xs gap-1'
    : size === 'lg'
    ? 'px-3 py-1.5 text-base gap-1.5'
    : 'px-2.5 py-1 text-sm gap-1.5';
  const ic = size === 'lg' ? 'w-5 h-5' : size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4';
  return (
    <span className={`inline-flex items-center rounded-md font-bold tracking-wider ${cls} ${sz}`}>
      <Truck className={ic} /> {c}
    </span>
  );
}

function ItemCard({ item, onMarkPacked, onPrintPlantLabel, dupeLots, wrapping }) {
  const isPacked = !!item.packedAt;
  const isUnmatched = item.lotKind === 'unmatched';
  const name = (item.name || '').trim();
  const variety = (item.variety || '').trim();
  const showManualPack = isUnmatched && !isPacked && !!onMarkPacked;
  // Same lineup number open on another unpacked item — the bare # can't be
  // trusted, only the label's wk tag can.
  const isDupe = !isPacked && !!dupeLots && dupeLots.has(parseInt(item.lotNumber, 10));

  const family = isUnmatched
    ? { bg: isPacked ? 'bg-purple-100' : 'bg-purple-50', border: 'border-purple-200', accent: 'text-purple-700', icon: 'text-purple-600', ring: 'border-purple-300' }
    : { bg: isPacked ? 'bg-emerald-100' : 'bg-emerald-50', border: 'border-emerald-200', accent: 'text-emerald-700', icon: 'text-emerald-600', ring: 'border-emerald-300' };

  return (
    <div className={`px-3 py-3 rounded-xl border-2 ${family.bg} ${wrapping ? 'border-amber-400 ring-2 ring-amber-300' : family.border}`}>
      <div className="flex items-center gap-2.5">
        {isPacked
          ? <Check className={`w-6 h-6 ${family.icon} shrink-0`} />
          : <div className={`w-6 h-6 rounded-full border-2 ${family.ring} shrink-0`} />}
        {item.lotNumber && (
          <span
            className={`shrink-0 min-w-[2.5rem] px-1.5 py-0.5 rounded-lg text-xl font-extrabold text-center tabular-nums ${
              isPacked ? 'bg-gray-200 text-gray-400' : 'bg-blue-600 text-white'
            } ${isDupe ? 'ring-2 ring-red-500' : ''}`}
            title="Lineup number — find the plant labelled with this #"
          >
            {item.lotNumber}
          </span>
        )}
        <div className="flex-1 min-w-0">
          <div className={`text-base font-mono ${family.accent} ${isPacked ? '' : 'font-semibold'}`}>
            {item.sku || '(no SKU)'}
          </div>
          {(name || variety) && (
            <div className={`text-sm break-words ${family.accent} ${isPacked ? 'line-through opacity-70' : 'opacity-80'}`}>
              {[name, variety].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
        {item.quantity > 1 && <span className={`text-sm font-medium ${family.accent} shrink-0`}>×{item.quantity}</span>}
        {onPrintPlantLabel && !isPacked && (
          <button
            type="button"
            onClick={() => onPrintPlantLabel(item)}
            className={`shrink-0 w-10 h-10 rounded-lg border-2 bg-white flex items-center justify-center ${family.ring} ${family.accent} active:bg-gray-100`}
            title="Print this plant's burrito label"
            aria-label={`Print label for ${(item.name || item.sku || 'item').trim()}`}
          >
            <Printer className="w-4 h-4" />
          </button>
        )}
        {showManualPack && (
          <button
            type="button"
            onClick={() => onMarkPacked(item)}
            className="shrink-0 text-sm font-semibold px-3 py-2 rounded-lg bg-purple-600 text-white hover:bg-purple-700 active:bg-purple-800 flex items-center gap-1"
            title="No scannable barcode — mark packed manually"
          >
            <Check className="w-4 h-4" /> Pack
          </button>
        )}
      </div>
      {isDupe && (
        <div className="mt-1.5 flex items-center gap-1 text-xs font-semibold text-red-700">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          Same # on another unpacked plant — check the wk tag on the label.
        </div>
      )}
      <ItemNotes raw={item.notes} />
    </div>
  );
}

// Full-screen find-list shown on the packer's phone when the iPad sends a
// box over. Items are sorted by variety/name (the order they're shelved) and
// filterable, so the packer can walk the racks and pull each one.
function PhoneHandoffOverlay({ box, onClose }) {
  const [q, setQ] = useState('');
  const items = (box.items || []).slice().sort((a, b) =>
    `${a.variety || ''} ${a.name || ''}`.toLowerCase()
      .localeCompare(`${b.variety || ''} ${b.name || ''}`.toLowerCase()),
  );
  const ql = q.trim().toLowerCase();
  const filtered = ql
    ? items.filter(i =>
        [i.sku, i.name, i.variety, i.lotNumber].filter(Boolean).join(' ').toLowerCase().includes(ql))
    : items;
  const total = items.length;

  return (
    <div className="fixed inset-0 z-[60] bg-white flex flex-col pt-safe">
      <div className="flex-shrink-0 bg-blue-600 text-white px-4 py-3 flex items-center gap-3">
        <Smartphone className="w-6 h-6 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-lg leading-tight truncate">
            Find {total} item{total === 1 ? '' : 's'}
          </div>
          <div className="text-sm text-blue-100 leading-tight truncate">
            <span className="font-mono tracking-wide">{box.code}</span>
            {buyerLabel(box) ? ` · ${buyerLabel(box)}` : ''}
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="w-12 h-12 -mr-2 rounded-full flex items-center justify-center hover:bg-blue-700 active:bg-blue-800"
        >
          <X className="w-6 h-6" />
        </button>
      </div>

      <div className="flex-shrink-0 px-3 py-2 border-b border-gray-200 bg-gray-50">
        <div className="flex items-center gap-2 px-3 h-11 rounded-xl border border-gray-300 bg-white">
          <Search className="w-5 h-5 text-gray-400 flex-shrink-0" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by SKU, name, variety…"
            className="flex-1 min-w-0 bg-transparent outline-none text-base text-gray-900 placeholder:text-gray-400"
          />
          {q && (
            <button onClick={() => setQ('')} aria-label="Clear filter" className="text-gray-400 p-1">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="space-y-2">
          {filtered.length === 0 ? (
            <div className="text-center text-sm text-gray-500 py-12">No items match “{q}”.</div>
          ) : filtered.map((it, idx) => {
            const packed = !!it.packedAt;
            return (
              <div
                key={it.id || it.sku || idx}
                className={`px-3 py-3 rounded-xl border-2 ${packed ? 'bg-gray-50 border-gray-200' : 'bg-white border-blue-200'}`}
              >
                <div className="flex items-center gap-2.5">
                  {packed
                    ? <Check className="w-6 h-6 text-emerald-600 shrink-0" />
                    : <div className="w-6 h-6 rounded-full border-2 border-blue-300 shrink-0" />}
                  {it.lotNumber && (
                    <span
                      className={`shrink-0 min-w-[2.25rem] px-1.5 py-0.5 rounded-lg text-lg font-extrabold text-center tabular-nums ${
                        packed ? 'bg-gray-100 text-gray-400' : 'bg-blue-600 text-white'
                      }`}
                      title="Lineup number — find the plant labelled with this #"
                    >
                      {it.lotNumber}
                    </span>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className={`text-base font-mono ${packed ? 'text-gray-400 line-through' : 'text-blue-800 font-semibold'}`}>
                      {it.sku || '(no SKU)'}
                    </div>
                    {(it.name || it.variety) && (
                      <div className={`text-sm break-words ${packed ? 'text-gray-400' : 'text-gray-700'}`}>
                        {[it.name, it.variety].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </div>
                  {it.quantity > 1 && <span className="text-sm font-medium text-gray-600 shrink-0">×{it.quantity}</span>}
                </div>
                <ItemNotes raw={it.notes} />
              </div>
            );
          })}
        </div>
        <div className="h-6 pb-safe" />
      </div>

      <div className="flex-shrink-0 border-t border-gray-200 bg-white p-3 pb-safe">
        <button
          onClick={onClose}
          className="w-full flex items-center justify-center gap-2 px-4 py-3.5 text-base font-semibold bg-emerald-600 text-white rounded-xl active:bg-emerald-800"
        >
          <Check className="w-5 h-5" /> Done
        </button>
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
    // z-[90]: above the printer sheet (z-[80]) so print feedback stays visible.
    <div className="fixed bottom-[calc(2rem+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 bg-gray-900 text-white text-sm px-4 py-2.5 rounded-xl shadow-lg z-[90] max-w-[90%] text-center">
      {text}
    </div>
  );
}
