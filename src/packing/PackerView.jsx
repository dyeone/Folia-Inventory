import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  LogOut, Package, ScanLine, Check, ArrowLeft, AlertCircle, Camera, Truck,
  Ruler, ChevronRight, Loader2, PackageCheck, Smartphone, X, Search, Clock,
} from 'lucide-react';
import { api } from '../api.js';
import { AuthContext } from '../AuthContext.js';
import { getRealtimeClient, REALTIME_CONFIGURED } from '../supabaseRealtime.js';
import { shortBoxCode, normalizeBoxCode, normalizeSku } from '../labels/boxCode.js';
import { tracksMatch, looksLikeTracking } from '../labels/tracking.js';
import { boxHoldState, boxIsLocalPickup } from './holdInfo.js';
import { derivedBoxCarrier } from './carrier.js';
import { CameraScanner } from './CameraScanner.jsx';
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

  const [scanValue, setScanValue] = useState('');
  const scanRef = useRef(null);

  // Cross-device handoff. The packer runs this same UI on an iPad (the wide
  // "control" device, which gets the Send-to-phone button) and a phone (which
  // shows the find-list). useIsMobile splits them at the sm breakpoint.
  //
  // Transport: Supabase Realtime broadcast when configured (instant), else a
  // polled app_settings row (~2.5s). Both are namespaced by the packer's user
  // id, so the iPad + phone must be the same login.
  const { currentUser } = useContext(AuthContext);
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
      setTrackingByBox(
        Object.fromEntries(
          (shipments || [])
            .filter(s => s.trackingNumber && !s.voidedAt)
            .map(s => [s.id, s.trackingNumber]),
        ),
      );
      setLoading(false);
    })();
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
      // Carrier follows the content rule (anthurium → UPS) so the packer's
      // badge matches the office. A manual per-box override is set/honored in
      // the main Shipping tab; the packer view shows the content default.
      box.carrier = derivedBoxCarrier(box.items, box.stampedCarrier);
      if (box.items.some(i => i.status === 'sold')) out[box.code] = box;
    }
    return out;
  }, [items]);

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

  const showToast = (msg, durationMs = 2200) => {
    setToast(msg);
    setTimeout(() => setToast(null), durationMs);
  };

  const activeBox = activeBoxId
    ? Object.values(boxesByCode).find(b => b.id === activeBoxId)
    : null;

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
    } catch { /* keep whatever we have */ }
  };

  const goToBox = (boxId) => {
    setActiveBoxId(boxId);
    setCameraMode(null);
    if (boxId) refreshBoxMeta();
  };

  // ── Scan field focus management ──────────────────────────────────────────
  // Keep the scan input focused whenever the camera overlay is closed, so the
  // USB scanner's keystrokes always land in it. A ref mirrors the overlay
  // state so a click that opens the camera doesn't yank focus back.
  const overlayOpen = !!cameraMode;
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
  // call lands; roll back just that item on failure.
  const packById = async (itemId, displayLabel) => {
    const now = new Date().toISOString();
    setItems(prev => prev.map(i => (i.id === itemId ? { ...i, packedAt: now } : i)));
    if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(30);
    showToast(`Packed ${displayLabel}`, 1500);
    try {
      await api.upsertItems([{ id: itemId, packedAt: now }]);
    } catch (e) {
      setItems(prev => prev.map(i => (i.id === itemId ? { ...i, packedAt: null } : i)));
      showToast(`Pack failed for ${displayLabel}: ${e.message || 'unknown'}`, 4000);
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
      if (navigator.vibrate) navigator.vibrate([40, 50, 90]);
      const ok = await shipBox(activeBox);
      if (!ok) return; // ship failed — toast shown, stay on the box
      // Shipped — celebrate, then jump back to the grid.
      setSuccess({
        code: activeBox.code,
        who: activeBox.buyer || (activeBox.buyerUsername ? `@${activeBox.buyerUsername}` : ''),
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
  // so scanning any plant always takes the packer to its box.
  const handleScanItem = async (rawText) => {
    if (!activeBox) return;
    const sku = normalizeSku(rawText);
    if (!sku) return;
    const candidate = activeBox.items.find(i => normalizeSku(i.sku) === sku);
    if (!candidate) {
      const other = Object.values(boxesByCode).find(
        b => b.id !== activeBox.id && b.items.some(i => normalizeSku(i.sku) === sku),
      );
      if (other) { showToast(`${sku} → box ${other.code}`, 2500); goToBox(other.id); return; }
      showToast(`SKU ${sku} isn't in any open box`, 3500);
      return;
    }
    if (candidate.status !== 'sold') { showToast(`SKU ${sku} is already ${candidate.status}`, 3500); return; }
    if (candidate.packedAt) { showToast(`SKU ${sku} already packed`, 2500); return; }
    await packById(candidate.id, sku);
  };

  // Per-row manual pack for unmatched placeholders (synthetic SKU, no barcode).
  const handleMarkPacked = async (item) => {
    if (item.packedAt || item.status !== 'sold') return;
    const label = item.name?.trim() || item.sku || 'item';
    await packById(item.id, label.slice(0, 30));
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
          ? (activeBox.buyer || (activeBox.buyerUsername ? `@${activeBox.buyerUsername}` : 'Box'))
          : `${totalOpen} open · ${fullyPacked} packed`}
        onBack={activeBox ? () => goToBox(null) : null}
      />

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
          : 'Scan a box or plant…'}
        onCamera={() => setCameraMode(activeBox ? 'item' : 'box')}
      />

      {activeBox
        ? <BoxPane
            box={activeBox}
            assignedTracking={trackingByBox[activeBox.id] || null}
            onMarkPacked={handleMarkPacked}
            onCamera={() => setCameraMode('item')}
            onScanLabel={() => setCameraMode('label')}
            onSendToPhone={isMobile ? null : () => sendToPhone(activeBox)}
            onDone={() => goToBox(null)}
          />
        : <LandingGrid
            boxes={openBoxes}
            boxSizes={boxSizes}
            boxSizeByBox={boxSizeByBox}
            trackingByBox={trackingByBox}
            holdByBox={holdByBox}
            noteByBox={noteByBox}
            onOpen={goToBox}
          />
      }

      {cameraMode && (cameraMode === 'box' || activeBox) && (
        <CameraScanner
          onScan={
            cameraMode === 'box' ? handleScanBox
              : cameraMode === 'label' ? handleScanLabel
                : handleScanItem
          }
          onClose={() => setCameraMode(null)}
        />
      )}
      {handoff && <PhoneHandoffOverlay box={handoff} onClose={() => setHandoff(null)} />}
      {success && <GoodJobOverlay info={success} />}
      {toast && <Toast text={toast} />}
    </div>
  );
}

function TopBar({ onLogout, title, subtitle, onBack, tone }) {
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
      <div className="mt-2 text-sm font-medium text-gray-900 truncate">
        {box.buyer || (box.buyerUsername ? `@${box.buyerUsername}` : 'Box')}
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

function BoxPane({ box, assignedTracking, onMarkPacked, onCamera, onScanLabel, onSendToPhone, onDone }) {
  const unpacked = box.items.filter(i => i.status === 'sold' && !i.packedAt);
  const packed = box.items.filter(i => i.status === 'sold' && !!i.packedAt);
  const total = unpacked.length + packed.length;
  const allPacked = total > 0 && unpacked.length === 0;
  const pct = total > 0 ? (packed.length / total) * 100 : 0;

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

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-3 sm:px-5 py-4">
        <div className="max-w-5xl mx-auto">
          {allPacked ? (
            <FinalStep assignedTracking={assignedTracking} onScanLabel={onScanLabel} onDone={onDone} />
          ) : (
            <>
              {total === 0 ? (
                <div className="text-center text-sm text-gray-500 py-12">
                  <Package className="w-8 h-8 text-gray-300 mx-auto mb-2" /> No items in this box.
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {unpacked.map(item => <ItemCard key={item.id} item={item} onMarkPacked={onMarkPacked} />)}
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
          <div className="max-w-5xl mx-auto flex gap-3">
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
function FinalStep({ assignedTracking, onScanLabel, onDone }) {
  return (
    <div className="text-center max-w-md mx-auto pt-2">
      <div className="flex items-center justify-center gap-2.5 mb-1.5">
        <PackageCheck className="w-9 h-9 text-emerald-600" />
        <h2 className="text-2xl font-bold text-gray-900">All items packed!</h2>
      </div>
      {assignedTracking ? (
        <>
          <p className="text-lg text-gray-600 mb-6">Last step — scan the shipping label to confirm it's the right one.</p>
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

function ItemCard({ item, onMarkPacked }) {
  const isPacked = !!item.packedAt;
  const isUnmatched = item.lotKind === 'unmatched';
  const name = (item.name || '').trim();
  const variety = (item.variety || '').trim();
  const showManualPack = isUnmatched && !isPacked && !!onMarkPacked;

  const family = isUnmatched
    ? { bg: isPacked ? 'bg-purple-100' : 'bg-purple-50', border: 'border-purple-200', accent: 'text-purple-700', icon: 'text-purple-600', ring: 'border-purple-300' }
    : { bg: isPacked ? 'bg-emerald-100' : 'bg-emerald-50', border: 'border-emerald-200', accent: 'text-emerald-700', icon: 'text-emerald-600', ring: 'border-emerald-300' };

  return (
    <div className={`px-3 py-3 rounded-xl border-2 ${family.bg} ${family.border}`}>
      <div className="flex items-center gap-2.5">
        {isPacked
          ? <Check className={`w-6 h-6 ${family.icon} shrink-0`} />
          : <div className={`w-6 h-6 rounded-full border-2 ${family.ring} shrink-0`} />}
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
            {box.buyer ? ` · ${box.buyer}` : box.buyerUsername ? ` · @${box.buyerUsername}` : ''}
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
                  <div className="flex-1 min-w-0">
                    <div className={`text-base font-mono ${packed ? 'text-gray-400 line-through' : 'text-blue-800 font-semibold'}`}>
                      {it.sku || '(no SKU)'}
                    </div>
                    {(it.name || it.variety) && (
                      <div className={`text-sm break-words ${packed ? 'text-gray-400' : 'text-gray-700'}`}>
                        {[it.name, it.variety].filter(Boolean).join(' · ')}
                      </div>
                    )}
                    {it.lotNumber && <div className="text-xs text-gray-400 font-mono">Lot #{it.lotNumber}</div>}
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
    <div className="fixed bottom-[calc(2rem+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 bg-gray-900 text-white text-sm px-4 py-2.5 rounded-xl shadow-lg z-50 max-w-[90%] text-center">
      {text}
    </div>
  );
}
