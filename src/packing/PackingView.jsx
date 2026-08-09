import { useState, useMemo, useEffect, useRef } from 'react';
import {
  Package, AlertCircle, ArrowLeft, PackageOpen, ChevronRight, Upload,
  Truck, Pencil, Check, X, Loader2, Trash2, Printer, ScanLine, Plus,
  Receipt, Search, Copy, RotateCcw, CheckCircle2, Tag, MapPin, Clock,
  ShoppingCart, Combine,
} from 'lucide-react';
import { api } from '../api.js';
import { ItemNotes } from './ItemNotes.jsx';
import { BoxContentBadges } from './BoxContentBadges.jsx';
import { BuyLabelModal } from './BuyLabelModal.jsx';
import { BulkBuyLabelsModal } from './BulkBuyLabelsModal.jsx';
import { CombineBoxesModal } from './CombineBoxesModal.jsx';
import { HeatCheckPanel } from './HeatCheckPanel.jsx';
import { ShipBoxCard } from './ShipBoxCard.jsx';
import { PrintListButton } from './PrintListButton.jsx';
import { BoxNotePanel, InsulationStrip, InsulationChip } from './BoxNotePanel.jsx';
import { BoxPackagingPanel } from './BoxPackagingPanel.jsx';
import { ShippingMarginNote } from './ShippingMarginNote.jsx';
import { openLabelPdf, copyText, printShippingLabels } from './labelPdf.js';
import { SummaryStat } from './SummaryStat.jsx';
import { shippingRollup, fmt$2 } from '../financial/financialHelpers.js';
import { CameraScanner } from './CameraScanner.jsx';
import { NewBoxModal } from './NewBoxModal.jsx';
import { EditBoxItemsModal } from './EditBoxItemsModal.jsx';
import { EditBoxAddressModal } from './EditBoxAddressModal.jsx';
import { ImportLabelsModal } from './ImportLabelsModal.jsx';
import { ShippingSlipSheet } from '../labels/ShippingSlipSheet.jsx';
import { shortBoxCode, normalizeBoxCode, normalizeSku } from '../labels/boxCode.js';
import { tracksMatch, looksLikeTracking } from '../labels/tracking.js';
import { boxHoldState, boxHasHoldItem, boxIsLocalPickup, isLocalPickupText, weekHoldUntil } from './holdInfo.js';
import { findDupeLots } from './dupeLots.js';
import { resolveBoxCarrier, derivedBoxCarrier, isAnthuriumItem, hasPaidNextDay, boxUpsServiceKey, isNextDayService } from './carrier.js';
import { useIsMobile } from '../ui/useIsMobile.js';

// Re-export the shared building blocks so SalesUploadModal's existing
// imports keep working without a churn-y find-and-replace across files.
export { BoxesList } from './BoxesList.jsx';
export { SummaryStat } from './SummaryStat.jsx';

// Short timestamp for box / item events. Recent dates collapse to
// "today HH:MM" / "yesterday HH:MM"; older ones show "May 18 HH:MM"
// (or include the year if it's not the current one). The HH:MM is
// rendered in the user's locale (12h on most Mac/iOS, 24h on most
// Linux), which keeps timestamps consistent with the rest of the OS.
function fmtShortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.floor((startOf(now) - startOf(d)) / 86400000);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (dayDiff === 0) return `today ${time}`;
  if (dayDiff === 1) return `yesterday ${time}`;
  const opts = d.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' };
  return `${d.toLocaleDateString(undefined, opts)} ${time}`;
}

// ───────────────────────────────────────────────────────────────────────────
// Shipping tab top-level view.
//
// Step 1 of the packing rewrite: list every package (box) that hasn't fully
// shipped yet — label bought or not — grouped by buyer so a single recipient
// who won lots across multiple sales is consolidated into one card.
//
// Tapping a box still drills into the existing per-sale pane (SalePackingPane
// → PackingBoxesPane → ShipBoxCard) so label-buying / mark-shipped flows are
// untouched while we iterate the top view.
// ───────────────────────────────────────────────────────────────────────────

export function PackingView({
  inventoryItems, sales,
  onShipBox, onUnshipBox, onDeleteAllOpenBoxes, onDeleteBox, onDeleteBoxes, onPrintBoxLabels, onPrintItemLabels, onTogglePacked,
  setConfirmDialog,
  isAdmin, onRefreshItems, settingsVersion = 0,
}) {
  // Admin-only modal for creating a box by hand (no Palmstreet upload
  // involved). Sits next to the existing Print box labels button. The
  // modal manages its own two-phase flow (form → scan) and stamps each
  // scanned inventory item with the new shipmentBoxId.
  const [newBoxOpen, setNewBoxOpen] = useState(false);

  // Import Shipping Labels modal. The operator uploads the label PDFs they
  // downloaded from Palmstreet/Shippo; we decode each tracking barcode, OCR
  // the recipient, auto-match it to an open box, and (on confirm) store the
  // tracking number + label PDF on each box.
  const [importOpen, setImportOpen] = useState(false);

  // Admin-only modal for editing items in an existing open box: scan
  // to add, trash icon per row to remove. State holds the box being
  // edited; mirrors how Validate Sales / BuyLabel modals work.
  const [editingBox, setEditingBox] = useState(null);

  // Edit-address modal for an open box. Holds the box whose recipient name +
  // shipping address are being corrected; saving writes to every item in it.
  const [editingAddressBox, setEditingAddressBox] = useState(null);

  // Per-box shipping-slip preview. Not admin-gated — anyone packing
  // can print the customer-facing manifest.
  const [slipBox, setSlipBox] = useState(null);

  // Desktop: prefer a text-input dialog over the camera for the Scan box
  // / Scan item buttons. Laptops rarely have a good rear camera, and the
  // typical desktop workflow uses a USB barcode scanner that emits the
  // decoded SKU as keystrokes into the focused input. On mobile we keep
  // the camera flow — phones are why CameraScanner exists.
  const isMobile = useIsMobile();

  // Live search box (desktop-only). Matches against box code, buyer,
  // @username, and any item SKU/name/variety inside the box. Combines
  // with scannedBoxId so a scan can still narrow further from a typed
  // query. Empty string = no filter.
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef(null);

  // Note: we intentionally do NOT refocus the scan strip when the window or
  // tab regains focus. Auto-grabbing focus on every wake-up stole focus (and
  // scrolled the page to the strip) when the operator alt-tabbed back, which
  // was disruptive. A USB scanner still works after one click on the strip,
  // and it's still autofocused once when the tab first opens (below).

  // Header controls for the Ready section. readySort drives the order
  // boxes are listed; readyCarrierFilter narrows by carrier so the
  // operator can batch UPS-only or USPS-only work.
  const [readySort, setReadySort] = useState('created-desc');
  const [readyCarrierFilter, setReadyCarrierFilter] = useState('all'); // 'all' | 'usps' | 'ups'
  // Narrow the list to boxes that contain a given kind of item, so the
  // operator can batch-pack one product line at a time: 'tc' = boxes with
  // any tissue-culture item, 'anthurium' = boxes with any Anthurium plant.
  const [contentFilter, setContentFilter] = useState('all'); // 'all' | 'tc' | 'anthurium'

  // Multi-select for batch label printing. Selected box ids are
  // accumulated as the operator clicks the per-row checkboxes; the
  // "Print box labels" button uses this set if non-empty, else falls
  // back to "print every open box".
  const [selectedBoxIds, setSelectedBoxIds] = useState(() => new Set());
  const toggleBoxSelected = (id) => setSelectedBoxIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const clearSelection = () => setSelectedBoxIds(new Set());
  // Batch "Print shipping labels" in-flight flag (fetch + merge + print).
  const [printingLabels, setPrintingLabels] = useState(false);

  // A box's carrier label is printable once it has a stored PDF: a bought
  // ShipStation/Shippo label (carrierCode != 'palmstreet'), or an imported
  // Palmstreet label (labelStoragePath set). Voided rows don't count. Mirrors
  // BoxRow's canPrintLabel so the batch button agrees with the per-row one.
  const boxHasPrintableLabel = (boxId) => {
    const s = shipmentsByBox[boxId];
    return !!s && !s.voidedAt && (!!s.labelStoragePath || s.carrierCode !== 'palmstreet');
  };

  // Always-on scan strip (desktop only). A persistent autofocused text
  // input at the top of the tab so a USB barcode scanner can fire
  // back-to-back scans without the operator ever clicking. Each scan's
  // CR routes through submitScan, which auto-classifies B-XXXXXX as a
  // box code and everything else as an item SKU.
  const scanInputRef = useRef(null);
  const [scanInput, setScanInput] = useState('');
  const [scanFeedback, setScanFeedback] = useState(null); // { kind, text } for the green flash
  useEffect(() => {
    if (isMobile) return;
    // Autofocus on first mount of the tab. We don't fight the user for
    // focus afterward — only re-focus right after a successful scan.
    scanInputRef.current?.focus();
  }, [isMobile]);
  const submitScan = (raw) => {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return;
    const upper = trimmed.toUpperCase().replace(/_/g, '-');
    if (/^B-/.test(upper)) {
      handleScannedBoxCode(trimmed);
      setScanFeedback({ kind: 'box', text: upper });
    } else if (looksLikeTracking(trimmed)) {
      // A shipping-label barcode (long numeric / 1Z…) — verify it against the
      // box it's assigned to rather than treating it as an item SKU.
      handleScannedTracking(trimmed);
    } else {
      handleScannedItemSku(trimmed);
      setScanFeedback({ kind: 'item', text: upper });
    }
    setScanInput('');
    // Clear the flash after a moment, then re-grab focus for the next
    // scan. setTimeout(0) ensures the focus lands after React commits
    // the input clear.
    setTimeout(() => scanInputRef.current?.focus(), 0);
    setTimeout(() => setScanFeedback(null), 1200);
  };
  const [activeSaleId, setActiveSaleId] = useState(null);
  // Sub-tab inside the Shipping page: 'ready' for active boxes,
  // 'shipped' for the archive. Defaults to 'ready' since that's the
  // common operator workflow.
  const [subTab, setSubTab] = useState('ready');
  // Period scope for the Shipped tab's shipping-cost summary only (not the
  // list): 'week' = boxes marked shipped in the current Mon–Sun local week,
  // 'all' = every shipped box. Defaults to this week so the figure is a
  // meaningful weekly spend/loss rather than an ever-growing all-time total.
  const [shippedCostPeriod, setShippedCostPeriod] = useState('week');
  // Scanner state. scannerMode picks which lookup path the next decode
  // runs through: 'box' resolves a B-XXXXXX code to a box, 'item' looks
  // up which open/shipped box contains a given item SKU. Either way,
  // a successful match sets scannedBoxId which then filters the list
  // to that one box.
  const [scannerMode, setScannerMode] = useState(null); // 'box' | 'item' | null
  const [scannedBoxId, setScannedBoxId] = useState(null);

  // Shipments keyed by shipmentBoxId. We need these to know which boxes
  // already have a label / tracking number (→ "Mark shipped") vs. which
  // still need one (→ "Buy label" / "Enter tracking"). Loaded once across
  // all sales since `GET /api/shipments` with no saleId returns the user's
  // full shipments table — see api/shipments.js:53.
  const [shipmentsByBox, setShipmentsByBox] = useState({});
  const [boxNotesByBox, setBoxNotesByBox] = useState({});
  // Box-size presets (from Shipping Settings) the operator picks from per
  // box when rate-shopping. Read-only here; edited in ShippingSettingsModal.
  const [boxSizes, setBoxSizes] = useState([]);
  const [buyingFor, setBuyingFor] = useState(null);
  const [bulkBuyOpen, setBulkBuyOpen] = useState(false);
  const [combineOpen, setCombineOpen] = useState(false);
  const [toast, setToast] = useState(null);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  // Keep the always-on scan strip focused whenever it's actually on screen:
  // desktop, the list view (not drilled into a box), and no modal open. A USB
  // barcode scanner only feeds the input that holds focus, so we re-grab it
  // after the operator clicks around or comes back from a box/modal. A ref
  // mirrors the overlay state so a click that opens a modal doesn't yank
  // focus back to the (now-hidden) scan box. preventScroll keeps the page
  // from jumping to the top when refocusing after a click further down.
  const overlayOpen = !!(buyingFor || bulkBuyOpen || combineOpen || importOpen || editingBox || editingAddressBox || slipBox || newBoxOpen || scannerMode || activeSaleId);
  const overlayOpenRef = useRef(overlayOpen);
  useEffect(() => { overlayOpenRef.current = overlayOpen; }, [overlayOpen]);
  useEffect(() => {
    if (isMobile || overlayOpen) return;
    scanInputRef.current?.focus({ preventScroll: true });
  }, [isMobile, overlayOpen, subTab]);
  useEffect(() => {
    if (isMobile) return undefined;
    const refocus = (e) => {
      if (overlayOpenRef.current) return;
      // Leave focus alone when the click lands in a real field so the operator
      // can still type in search, tracking, note, etc.
      if (e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      setTimeout(() => {
        if (overlayOpenRef.current) return;
        scanInputRef.current?.focus({ preventScroll: true });
      }, 0);
    };
    document.addEventListener('click', refocus);
    return () => document.removeEventListener('click', refocus);
  }, [isMobile]);

  const refreshShipments = async () => {
    try {
      const [list, notes] = await Promise.all([
        api.getShipments(),
        api.getBoxNotes(),
      ]);
      setShipmentsByBox(Object.fromEntries((list || []).map(s => [s.id, s])));
      setBoxNotesByBox(notes || {});
    } catch { /* no-op — rows just won't reflect label state */ }
  };

  // Cancel a bought label from the box list: confirm, then void (ShipStation)
  // / refund (Shippo) via api.voidLabel. On success the shipment row is
  // marked voided, so the box's quote panel + Buy actions return.
  const onCancelLabel = (box) => {
    // Palmstreet/manual USPS rows have no carrier purchase to undo — disabling
    // just clears the row so the box can switch carriers and buy a new label.
    const manual = shipmentsByBox?.[box.id]?.carrierCode === 'palmstreet';
    const who = box.buyer || box.recipientName || 'this box';
    setConfirmDialog?.({
      title: manual ? `Disable the USPS label for ${who}?` : `Cancel the label for ${who}?`,
      message: manual
        ? 'Removes the Palmstreet USPS tracking so you can switch the carrier and buy a new label. No refund — the USPS label was generated in Palmstreet, not bought here.'
        : 'Voids the ShipStation label (or refunds the Shippo purchase) and re-enables rate quoting. A carrier may decline if the label was already used or scanned.',
      confirmLabel: manual ? 'Disable label' : 'Cancel label',
      danger: true,
      onConfirm: async () => {
        try {
          await api.voidLabel(box.id);
          showToast(manual ? 'USPS label disabled' : 'Label canceled');
          refreshShipments();
        } catch (e) {
          showToast(e.message || (manual ? 'Disable failed' : 'Cancel failed'));
        }
      },
    });
  };

  const onSaveBoxNote = async (shipmentBoxId, note) => {
    const saved = await api.setBoxNote({ shipmentBoxId, note });
    // Merge — setBoxNote only returns note fields, so keep any packaging
    // (boxSizeId / weightOz / serviceKey) already in the cache.
    setBoxNotesByBox(prev => ({
      ...prev,
      [shipmentBoxId]: {
        ...(prev[shipmentBoxId] || {}),
        note: saved.note,
        updatedAt: saved.updatedAt,
        updatedBy: saved.updatedBy,
      },
    }));
  };

  // Mark / unmark a box as local pickup. Zero new storage: the flag IS a
  // canonical "Local pickup" segment in the box note — exactly what
  // boxIsLocalPickup (violet tint here, packer banner, bulk-buy exclusion)
  // already keys on, so every consumer works unchanged. Unmarking strips
  // only our canonical segment; free-text that still says "pickup" is the
  // operator's words, so we surface it instead of editing their prose.
  const onTogglePickup = async (shipmentBoxId, makePickup) => {
    try {
      // Fresh read before the read-modify-write: this cache has no poll, and
      // rebuilding from a stale note would silently discard an edit another
      // operator made since page load (setBoxNote overwrites the whole note).
      let current = boxNotesByBox?.[shipmentBoxId]?.note || '';
      try {
        const fresh = await api.getBoxNotes();
        if (fresh) {
          setBoxNotesByBox(fresh);
          current = fresh[shipmentBoxId]?.note || '';
        }
      } catch { /* transient — fall back to the cached note */ }
      current = current.trim();
      let next = current;
      if (makePickup) {
        if (!isLocalPickupText(current)) next = current ? `${current} · Local pickup` : 'Local pickup';
      } else {
        next = current
          .split(' · ')
          .filter(p => p.trim().toLowerCase() !== 'local pickup')
          .join(' · ');
      }
      if (next !== current) await onSaveBoxNote(shipmentBoxId, next);
      if (!makePickup && isLocalPickupText(next)) {
        showToast('Note text still mentions pickup — edit the note to fully clear the flag', 5000);
      } else {
        showToast(makePickup ? 'Marked as local pickup — this box will not ship' : 'Local pickup cleared');
      }
    } catch (e) {
      // A silent failure here means a do-not-ship flag the operator believes
      // is set — always say it out loud.
      showToast(e?.message || 'Could not update the pickup flag — try again', 5000);
    }
  };

  // Persist a per-box packaging change (box size / weight / service). The
  // server returns the full row, so we mirror it wholesale into the cache.
  const onSaveBoxPackaging = async (shipmentBoxId, patch) => {
    const saved = await api.setBoxPackaging({ shipmentBoxId, ...patch });
    setBoxNotesByBox(prev => ({
      ...prev,
      [shipmentBoxId]: {
        note: saved.note,
        boxSizeId: saved.boxSizeId ?? null,
        weightOz: saved.weightOz ?? null,
        serviceKey: saved.serviceKey ?? null,
        carrierOverride: saved.carrierOverride ?? null,
        holdUntil: saved.holdUntil ?? null,
        updatedAt: saved.updatedAt,
        updatedBy: saved.updatedBy,
      },
    }));
  };

  // Put a box on a one-week hold or clear it. Holds are WEEK-scoped: pressed
  // in week 30 → ships when week 32 begins (computed client-side so the
  // operator's local timezone owns the week boundary, not the server's UTC
  // clock). The server returns the full shipment_boxes row, so mirror it
  // into the cache (which re-tints the card and shows the countdown).
  const onSetHold = async (shipmentBoxId, hold, release = false) => {
    // release: the box's hold comes from a "1-week hold" line the buyer
    // bought — it can't be deleted, so the server stamps the HOLD_RELEASED
    // sentinel, the only thing that outranks the item (holdInfo.js), and
    // the box reads "hold done".
    const saved = await api.setBoxHold({
      shipmentBoxId,
      hold,
      release,
      ...(hold ? { holdUntil: weekHoldUntil(new Date()).toISOString() } : {}),
    });
    setBoxNotesByBox(prev => ({
      ...prev,
      [shipmentBoxId]: {
        ...(prev[shipmentBoxId] || {}),
        holdUntil: saved.holdUntil ?? null,
        updatedAt: saved.updatedAt,
        updatedBy: saved.updatedBy,
      },
    }));
    showToast(hold
      ? `Held — ships ${weekHoldUntil(new Date()).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`
      : release ? 'Hold released — OK to ship' : 'Hold cleared');
  };

  // Manual "extra insulation" mark — reaches the packer within one 8s
  // box-notes poll cycle.
  const onToggleInsulation = async (shipmentBoxId, on) => {
    try {
      const saved = await api.setBoxInsulation({ shipmentBoxId, extraInsulation: on });
      setBoxNotesByBox(prev => ({
        ...prev,
        [shipmentBoxId]: {
          ...(prev[shipmentBoxId] || {}),
          extraInsulation: saved.extraInsulation ?? null,
          updatedAt: saved.updatedAt,
          updatedBy: saved.updatedBy,
        },
      }));
      showToast(on ? '❄ Marked: extra insulation' : 'Insulation mark cleared');
    } catch (e) {
      showToast(e.message || 'Could not save the insulation mark', 'error');
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, notes] = await Promise.all([
          api.getShipments(),
          api.getBoxNotes(),
        ]);
        if (cancelled) return;
        setShipmentsByBox(Object.fromEntries((list || []).map(s => [s.id, s])));
        setBoxNotesByBox(notes || {});
      } catch { /* no-op */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Box-size presets live in the id='shipping' settings row, edited in
  // ShippingSettingsModal (a sibling view, not a child). settingsVersion is
  // bumped by the parent whenever that modal saves, so re-pull the presets
  // here to keep the per-box size picker in sync without a page reload. The
  // version starts at 0, so this also does the initial load on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const settings = await api.getSettings('shipping').catch(() => null);
        if (cancelled) return;
        setBoxSizes(Array.isArray(settings?.data?.boxSizes) ? settings.data.boxSizes : []);
      } catch { /* no-op */ }
    })();
    return () => { cancelled = true; };
  }, [settingsVersion]);

  // "Ready to ship" = boxes with at least one item still 'sold' (i.e. not
  // every item has been shipped yet). "Shipped" = boxes where every item
  // is in 'shipped' or 'delivered'. Both views use the same buyer
  // grouping for layout consistency.
  const { groups, totalBoxes, totalItems } = useMemo(
    () => groupBoxesByBuyer(inventoryItems, sales, READY_PREDICATE, boxNotesByBox),
    [inventoryItems, sales, boxNotesByBox]
  );
  const shipped = useMemo(
    () => groupBoxesByBuyer(inventoryItems, sales, SHIPPED_PREDICATE, boxNotesByBox),
    [inventoryItems, sales, boxNotesByBox]
  );
  // Heat-check scope: every Ready box that actually ships — local pickups
  // are collected in person, so transit heat doesn't apply. Grouped boxes
  // carry no `note` (it merges in at render time), so the pickup flag must
  // be read from boxNotesByBox; and `code` isn't attached either, so derive
  // it here for the panel's box chips.
  const heatCheckBoxes = useMemo(
    () => groups.flatMap(g => g.boxes)
      .filter(b => !boxIsLocalPickup(boxNotesByBox?.[b.id]?.note, b.items))
      .map(b => ({ ...b, code: shortBoxCode(b.id) })),
    [groups, boxNotesByBox],
  );

  // Lineup numbers carried by 2+ unpacked items across the open boxes (last
  // week's hold labels beside this week's, block spills, manual dupes). The
  // per-item Pack buttons and Pack all confirm before packing on a bare #;
  // the finder names the OTHER open box so the confirm can point at it.
  const dupeLots = useMemo(
    () => findDupeLots(groups.flatMap(g => g.boxes)),
    [groups],
  );
  const findDupeLotBox = (lot, excludeBoxId) => {
    for (const g of groups) {
      for (const b of g.boxes) {
        if (b.id === excludeBoxId) continue;
        if (b.items.some(i => i.status === 'sold' && !i.packedAt && parseInt(i.lotNumber, 10) === lot)) return b;
      }
    }
    return null;
  };

  // Sales in 'packing' status that haven't had their orders uploaded yet —
  // they don't have boxes to list (no shipmentBoxId assigned), so they need
  // a separate "awaiting upload" surface to route the operator back to the
  // Sale tab's validate-orders step.
  const awaitingUpload = useMemo(
    () => sales
      .filter(s => s.status === 'packing')
      .filter(s => !inventoryItems.some(i => i.saleId === s.id && i.shipmentBoxId))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)),
    [sales, inventoryItems]
  );

  // Pre-compute the open-box delete summary so the confirm dialog can
  // show what will actually happen ("Revert N items / soft-delete M
  // placeholders") instead of a generic "are you sure?" prompt.
  const deleteSummary = useMemo(() => {
    let matched = 0;
    let unmatched = 0;
    for (const item of inventoryItems) {
      if (item.deletedAt) continue;
      if (item.status !== 'sold') continue;
      if (!item.shipmentBoxId) continue;
      if (item.lotKind === 'unmatched') unmatched++; else matched++;
    }
    return { matched, unmatched, total: matched + unmatched };
  }, [inventoryItems]);

  // Open boxes that duplicate an already-shipped order (re-validate artifacts).
  const duplicateBoxIds = useMemo(
    () => findShippedDuplicateBoxIds(inventoryItems),
    [inventoryItems],
  );

  const activeSale = sales.find(s => s.id === activeSaleId);
  if (activeSale) {
    return (
      <SalePackingPane
        sale={activeSale}
        inventoryItems={inventoryItems}
        onBack={() => setActiveSaleId(null)}
        onShipBox={(itemIds) => onShipBox(activeSale.id, itemIds)}
        onPrintItemLabels={onPrintItemLabels}
        setConfirmDialog={setConfirmDialog}
      />
    );
  }

  // Inline action handlers. The fast-path is to keep the operator on the
  // list — drilling into a sale is reserved for label PDFs, voids, and
  // partial-tracking edits.
  const handleMarkShipped = async (box) => {
    // Flip every item in the box that isn't already terminally shipped.
    // The prior version only included status='sold' items, which left
    // items in any other non-terminal state (e.g., full refunds) stuck
    // in the box — so the box couldn't move to the Shipped archive
    // (SHIPPED_PREDICATE requires every item to be shipped/delivered)
    // and silently disappeared from both views.
    const itemIds = box.items
      .filter(i => !['shipped', 'delivered'].includes(i.status))
      .map(i => i.id);
    if (itemIds.length === 0) return;
    await onShipBox(box.saleId, itemIds);
    // onShipBox refreshes items at the App level → groups recompute and
    // this box disappears. No need to refresh shipments here.
    // Hand focus back to the always-on scan strip so the operator can scan
    // the next box without clicking (no-op on mobile, where it isn't rendered).
    setTimeout(() => scanInputRef.current?.focus(), 0);
  };

  const handleSaveTracking = async (box, trackingNumber) => {
    await api.recordPalmstreetTracking(box.id, trackingNumber);
    await refreshShipments();
    showToast('Tracking saved');
  };

  // Move a fully-shipped box back to Ready. Reverts its shipped/delivered
  // items to 'sold' and clears the ship date (keeps tracking + label). Sale
  // reopen is handled at the App level (onUnshipBox).
  const handleUnship = async (box) => {
    const itemIds = box.items
      .filter(i => ['shipped', 'delivered'].includes(i.status))
      .map(i => i.id);
    if (itemIds.length === 0 || !onUnshipBox) return;
    await onUnshipBox(box.saleId, itemIds);
    setTimeout(() => scanInputRef.current?.focus(), 0);
  };

  // Save an edited recipient name + address onto every item in the box. The
  // box's shipmentBoxId is left unchanged so its label/tracking/notes stay
  // linked; only buyer + buyerAddress change.
  const handleSaveAddress = async (box, { buyer, buyerAddress }) => {
    const updates = box.items.map(i => ({ id: i.id, buyer, buyerAddress }));
    await api.upsertItems(updates);
    await onRefreshItems?.();
    showToast('Address updated');
  };

  // Remote reset of the packers' bench-sweep checklist. Their found-marks
  // are per-device (localStorage); the server stamp reaches every device
  // via the box-notes poll within ~8s.
  const handleResetPackerSweep = async () => {
    if (!window.confirm('Reset the packers’ hold-sweep checklist? Every found checkmark clears on all packer devices and they’ll go through the held & pickup list again.')) return;
    try {
      await api.resetHoldSweep();
      showToast('Packer sweep reset — every device gets a fresh checklist within a few seconds');
    } catch (e) {
      showToast(`Couldn’t reset the sweep: ${e.message || 'unknown error'}`);
    }
  };

  // Combine orders: one atomic server-side move of every still-sold item
  // from the source boxes into the target box (identity re-stamped
  // server-side; the server re-checks for active labels since our shipments
  // cache can be stale). The merged-away boxes disappear once no sold item
  // references them; their box-level notes/holds/packaging are left behind
  // (the modal warns about that). The target keeps its notes and size.
  const handleCombineBoxes = async (targetBox, sourceBoxes) => {
    const { moved } = await api.combineBoxes({
      targetBoxId: targetBox.id,
      sourceBoxIds: sourceBoxes.map(b => b.id),
    });
    // Merged-away box ids no longer exist — a stale selection would point at
    // nothing (or worse, preselect wrong rows in the bulk-buy modal).
    setSelectedBoxIds(new Set());
    await onRefreshItems?.();
    showToast(`Combined ${sourceBoxes.length + 1} boxes into ${shortBoxCode(targetBox.id)} — ${moved} item${moved === 1 ? '' : 's'} moved`);
  };

  // Confirm before unshipping — it's reversible, but it changes box state and
  // may reopen a closed sale, so make the operator acknowledge.
  const confirmUnship = (box) => {
    const count = box.items.filter(i => ['shipped', 'delivered'].includes(i.status)).length;
    const sale = sales.find(s => s.id === box.saleId);
    const willReopen = sale && sale.status === 'closed';
    setConfirmDialog?.({
      title: 'Mark box as not shipped?',
      message: `Moves ${count} item${count === 1 ? '' : 's'} back to Ready and clears the ship date.${willReopen ? ' This sale was closed when it shipped — it will be reopened.' : ''} The tracking number and label stay attached.`,
      confirmLabel: 'Mark unshipped',
      onConfirm: () => handleUnship(box),
    });
  };

  // Handler for "Scan box" — decodes a B-XXXXXX code and filters the
  // list down to just that box. Walks the Ready groups first, then the
  // Shipped archive. On match we also switch sub-tabs so the operator
  // sees the box in the right context. On miss the toast tells them
  // the code didn't match anything.
  const handleScannedBoxCode = (rawText) => {
    const code = normalizeBoxCode(rawText);
    if (!code) return;
    const findIn = (groupArr) => {
      for (const g of groupArr) {
        for (const b of g.boxes) {
          if (shortBoxCode(b.id) === code) return b;
        }
      }
      return null;
    };
    const inReady = findIn(groups);
    if (inReady) {
      setSubTab('ready');
      setScannedBoxId(inReady.id);
      showToast(`Found ${code} in Ready`);
      return;
    }
    const inShipped = findIn(shipped.groups);
    if (inShipped) {
      setSubTab('shipped');
      setScannedBoxId(inShipped.id);
      showToast(`Found ${code} in Shipped`);
      return;
    }
    showToast(`No box matches ${code}`);
  };

  // Handler for "Scan item" — decodes an inventory SKU and surfaces the
  // box that contains it. Walks both Ready and Shipped to find the box.
  // On miss, the toast says the SKU isn't in any active box (likely the
  // item isn't sold yet, or its box has been deleted).
  const handleScannedItemSku = (rawText) => {
    const sku = normalizeSku(rawText);
    if (!sku) return;
    const findBoxWithSku = (groupArr) => {
      for (const g of groupArr) {
        for (const b of g.boxes) {
          if (b.items.some(i => normalizeSku(i.sku) === sku)) {
            return b;
          }
        }
      }
      return null;
    };
    const inReady = findBoxWithSku(groups);
    if (inReady) {
      setSubTab('ready');
      setScannedBoxId(inReady.id);
      showToast(`${sku} is in box ${shortBoxCode(inReady.id)}`);
      return;
    }
    const inShipped = findBoxWithSku(shipped.groups);
    if (inShipped) {
      setSubTab('shipped');
      setScannedBoxId(inShipped.id);
      showToast(`${sku} is in shipped box ${shortBoxCode(inShipped.id)}`);
      return;
    }
    showToast(`SKU ${sku} isn't in any active box`);
  };

  // Handler for a scanned shipping-label barcode. Finds the box this tracking
  // number was assigned to (during Import Labels) and confirms it's the right
  // one. The shipping desk uses this to spot a mis-stuck label before it
  // ships; the packer's mobile view does the same scan but also marks the box
  // packed (see PackerView).
  const handleScannedTracking = (rawText) => {
    const findBox = (groupArr) => {
      for (const g of groupArr) {
        for (const b of g.boxes) {
          const tn = shipmentsByBox[b.id]?.trackingNumber;
          if (tn && tracksMatch(rawText, tn)) return b;
        }
      }
      return null;
    };
    const inReady = findBox(groups);
    const box = inReady || findBox(shipped.groups);
    if (!box) {
      setScanFeedback(null);
      showToast('⚠ Unknown label — not assigned to any box');
      return;
    }
    setSubTab(inReady ? 'ready' : 'shipped');
    setScannedBoxId(box.id);
    setScanFeedback({ kind: 'box', text: shortBoxCode(box.id) });
    showToast(`✓ Label matches ${shortBoxCode(box.id)} — ${box.buyer || 'box'}`);
  };

  // Combined filter: scannedBoxId (from Scan box / Scan item lookup)
  // and the desktop search query. A box must pass both to survive. Each
  // group's box list is narrowed accordingly; groups with no surviving
  // boxes are dropped. Same logic applied to the Shipped archive so the
  // filter works regardless of which sub-tab the box lives in.
  const searchLower = searchQuery.trim().toLowerCase();
  const matchSearch = (box) => {
    if (!searchLower) return true;
    if (shortBoxCode(box.id).toLowerCase().includes(searchLower)) return true;
    if (box.buyer && box.buyer.toLowerCase().includes(searchLower)) return true;
    if (box.buyerUsername && box.buyerUsername.toLowerCase().includes(searchLower)) return true;
    for (const i of box.items) {
      if (i.sku && i.sku.toLowerCase().includes(searchLower)) return true;
      if (i.name && i.name.toLowerCase().includes(searchLower)) return true;
      if (i.variety && i.variety.toLowerCase().includes(searchLower)) return true;
      // Lineup number — exact match only (substring would flood short #s).
      // Lowercased to match the query normalization (manual lots can carry
      // letters).
      if (i.lotNumber && String(i.lotNumber).trim().toLowerCase() === searchLower) return true;
    }
    return false;
  };
  // A box passes the contents filter if it holds the selected kind.
  // Anthurium keys off item.variety (the same predicate the Print ANT
  // labels button and box labels use): any box with an anthurium item is
  // an Anthurium box. TC is the complement — a box with a tissue-culture
  // item and NO anthurium at all — so a mixed box that contains anthurium
  // never shows under TC (TC boxes hold no anthurium inside).
  const matchContents = (box) => {
    const hasAnthurium = box.items.some(isAnthuriumItem);
    if (contentFilter === 'tc') return box.items.some(i => i.type === 'tc') && !hasAnthurium;
    if (contentFilter === 'anthurium') return hasAnthurium;
    return true;
  };
  const filterBoxes = (boxes, applyCarrierFilter) =>
    boxes.filter(b =>
      (!scannedBoxId || b.id === scannedBoxId) &&
      matchSearch(b) &&
      matchContents(b) &&
      (!applyCarrierFilter ||
        readyCarrierFilter === 'all' ||
        (b.carrier || 'usps').toLowerCase() === readyCarrierFilter),
    );
  const anyFilter = !!(scannedBoxId || searchLower || contentFilter !== 'all');
  // Sort boxes within a group, then groups across the page, by the
  // operator's chosen mode. Tie-breakers fall back to buyer name and
  // box code so the order is deterministic.
  const boxSortKey = (b) => {
    switch (readySort) {
      case 'created-asc':
      case 'created-desc': return b.openedAt || '';
      case 'items-asc':
      case 'items-desc': return b.items.length;
      case 'carrier-usps': return (b.carrier || 'usps').toLowerCase() === 'usps' ? 0 : 1;
      case 'carrier-ups': return (b.carrier || 'usps').toLowerCase() === 'ups' ? 0 : 1;
      case 'customer':
      default: return (b.buyer || '').toLowerCase();
    }
  };
  const sortDir = readySort.endsWith('-desc') ? -1 : 1;
  const sortBoxes = (arr) => [...arr].sort((a, b) => {
    const ka = boxSortKey(a), kb = boxSortKey(b);
    if (ka < kb) return -1 * sortDir;
    if (ka > kb) return 1 * sortDir;
    return shortBoxCode(a.id).localeCompare(shortBoxCode(b.id));
  });
  const sortGroups = (arr) => [...arr].sort((a, b) => {
    if (readySort === 'customer') {
      return a.displayName.localeCompare(b.displayName);
    }
    if (readySort === 'items-asc' || readySort === 'items-desc') {
      const ai = a.boxes.reduce((s, b) => s + b.items.length, 0);
      const bi = b.boxes.reduce((s, b) => s + b.items.length, 0);
      return (ai - bi) * (readySort === 'items-desc' ? -1 : 1);
    }
    if (readySort === 'created-asc' || readySort === 'created-desc') {
      const ao = a.boxes.reduce((m, b) => (!m || (b.openedAt && b.openedAt < m)) ? b.openedAt : m, null) || '';
      const bo = b.boxes.reduce((m, b) => (!m || (b.openedAt && b.openedAt < m)) ? b.openedAt : m, null) || '';
      if (ao < bo) return -1 * (readySort === 'created-desc' ? -1 : 1);
      if (ao > bo) return 1 * (readySort === 'created-desc' ? -1 : 1);
      return 0;
    }
    // carrier-* sorts keep groups alphabetical (carrier is per-box, not group)
    return a.displayName.localeCompare(b.displayName);
  });
  const filteredReady = (() => {
    const filtered = groups
      .map(g => ({ ...g, boxes: filterBoxes(g.boxes, true) }))
      .filter(g => g.boxes.length > 0);
    return sortGroups(filtered.map(g => ({ ...g, boxes: sortBoxes(g.boxes) })));
  })();
  const filteredShipped = anyFilter
    ? {
        ...shipped,
        groups: shipped.groups
          .map(g => ({ ...g, boxes: filterBoxes(g.boxes) }))
          .filter(g => g.boxes.length > 0),
      }
    : shipped;

  // Shipping cost vs. what buyers paid, across the shipped boxes currently
  // shown. Only boxes with a real purchased label count (see shippingRollup),
  // so a negative net is a genuine "we shipped this at a loss" figure.
  //
  // The summary can scope to the current Mon–Sun local week (default). A box's
  // ship date is the latest shippedAt across its items (handleMarkShipped
  // stamps them together), falling back to the label's purchasedAt for older
  // boxes that predate shippedAt. The list itself stays all-time.
  const shippedCostBoxes = filteredShipped.groups.flatMap(g => g.boxes);
  const weekBounds = (() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // back to Monday 00:00 local
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    return { start: start.getTime(), end: end.getTime() };
  })();
  const boxShippedTime = (box) => {
    let t = 0;
    for (const i of box.items) {
      if (i.shippedAt) { const ts = new Date(i.shippedAt).getTime(); if (ts > t) t = ts; }
    }
    if (!t) {
      const p = shipmentsByBox?.[box.id]?.purchasedAt;
      if (p) t = new Date(p).getTime();
    }
    return t;
  };
  const boxesThisWeek = shippedCostBoxes.filter(b => {
    const t = boxShippedTime(b);
    return t >= weekBounds.start && t < weekBounds.end;
  });
  const shippedShippingAll = shippingRollup(shippedCostBoxes.flatMap(b => b.items), shipmentsByBox);
  const shippedShipping = shippedCostPeriod === 'week'
    ? shippingRollup(boxesThisWeek.flatMap(b => b.items), shipmentsByBox)
    : shippedShippingAll;

  // Ready boxes that are duplicates of an already-shipped order — surfaced
  // as a one-click cleanup banner so the operator can clear them in bulk.
  const duplicateBoxes = groups.flatMap(g => g.boxes).filter(b => duplicateBoxIds.has(b.id));

  // Which boxes start expanded. Rows are collapsed by default to keep the
  // list calm; we auto-expand only the box the operator is clearly focused
  // on — a scan/lookup target, or the sole survivor of a search/filter — so
  // the fast path (scan → see contents → act) needs no extra click.
  const readyVisibleIds = filteredReady.flatMap(g => g.boxes.map(b => b.id));
  const shippedVisibleIds = filteredShipped.groups.flatMap(g => g.boxes.map(b => b.id));
  const readyExpandSet = new Set();
  if (scannedBoxId) readyExpandSet.add(scannedBoxId);
  if (readyVisibleIds.length === 1) readyExpandSet.add(readyVisibleIds[0]);
  const shippedExpandSet = new Set();
  if (scannedBoxId) shippedExpandSet.add(scannedBoxId);
  if (shippedVisibleIds.length === 1) shippedExpandSet.add(shippedVisibleIds[0]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <Package className="w-5 h-5 text-emerald-600" /> Shipping
        </h2>
        <div className="shrink-0 flex items-center gap-2">
          {/* Upload Palmstreet/Shippo label PDFs → auto-match to boxes and
              store each tracking number. */}
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg border border-emerald-600 text-emerald-700 bg-white hover:bg-emerald-50 active:bg-emerald-100"
          >
            <Upload className="w-4 h-4" /> Import labels
          </button>
          {/* Print the boxes currently on screen (current sub-tab + filter) as
              a packing-list table, straight to the document printer. */}
          <PrintListButton
            getBoxes={() => (subTab === 'ready'
              ? filteredReady.flatMap(g => g.boxes)
              : filteredShipped.groups.flatMap(g => g.boxes))}
            kind={subTab}
            showToast={showToast}
          />
        {/* Camera-based scan buttons — mobile only. Desktop uses the
            always-on scan strip below. */}
        <div className="flex items-center gap-2 sm:hidden">
          <button
            type="button"
            onClick={() => setScannerMode('box')}
            className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800"
          >
            <ScanLine className="w-4 h-4" /> Scan box
          </button>
          <button
            type="button"
            onClick={() => setScannerMode('item')}
            className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg border border-emerald-600 text-emerald-700 bg-white hover:bg-emerald-50 active:bg-emerald-100"
          >
            <ScanLine className="w-4 h-4" /> Scan item
          </button>
        </div>
        </div>
      </div>

      {/* Desktop-only scan + search row.
          - Scan strip: always-on autofocused input. A USB scanner can
            emit codes back-to-back; each CR fires submitScan which
            auto-routes (B-... → box code, else → item SKU), clears,
            and refocuses. The strip takes ~2/3 width to telegraph
            that scanning is the primary path.
          - Search: filters the visible list (box code / buyer /
            @username / SKU / plant name).
          Both hidden on mobile — phones use the Scan buttons (camera)
          in the header above. */}
      <div className="hidden sm:flex items-stretch gap-3">
        <div className="relative flex-[2]">
          <ScanLine className={`w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none ${
            scanFeedback ? 'text-emerald-600' : 'text-emerald-500'
          }`} />
          <input
            ref={scanInputRef}
            type="text"
            value={scanInput}
            onChange={(e) => setScanInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitScan(scanInput);
              }
            }}
            placeholder="Scan a box (B-…) or an item SKU — Enter to submit"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className={`w-full pl-11 pr-32 py-3 text-base font-mono uppercase border-2 rounded-xl focus:outline-none focus:ring-2 transition ${
              scanFeedback
                ? 'border-emerald-500 bg-emerald-50 ring-emerald-500/30'
                : 'border-emerald-300 bg-emerald-50/40 focus:border-emerald-500 focus:ring-emerald-500/30'
            }`}
          />
          {scanFeedback ? (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-emerald-700 bg-white px-2 py-1 rounded-md border border-emerald-300 shadow-sm">
              ✓ {scanFeedback.kind === 'box' ? 'box' : 'item'} · <span className="font-mono">{scanFeedback.text}</span>
            </span>
          ) : (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-emerald-700/70 hidden md:inline">
              auto-routes by prefix
            </span>
          )}
        </div>
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search boxes..."
            className="w-full pl-9 pr-9 py-3 text-sm border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent bg-white"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Ready / Shipped split — the primary navigation. Underline tabs
          keep it light; counts live here so they aren't repeated in a
          section header below. */}
      <div className="flex items-center gap-1 border-b border-gray-200">
        {[
          { value: 'ready', label: 'Ready to ship', count: totalBoxes },
          { value: 'shipped', label: 'Shipped', count: shipped.totalBoxes },
        ].map(tab => {
          const active = subTab === tab.value;
          return (
            <button
              key={tab.value}
              onClick={() => setSubTab(tab.value)}
              className={`flex items-center gap-1.5 px-3 py-2 -mb-px border-b-2 text-sm whitespace-nowrap transition ${
                active
                  ? 'border-emerald-600 text-emerald-700 font-medium'
                  : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              {tab.label}
              <span className={`text-xs ${active ? 'text-emerald-600' : 'text-gray-400'}`}>
                {tab.count}
              </span>
            </button>
          );
        })}
        {/* Remote reset of the packers' Step-1 sweep checklist — lives here
            (not per box) because the sweep spans all held/pickup boxes. */}
        <button
          type="button"
          onClick={handleResetPackerSweep}
          title="Clear every packer device's hold-sweep checkmarks so they go through the held & pickup list again"
          className="ml-auto mb-1 text-xs font-medium px-2.5 py-1.5 rounded-md border border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100 active:bg-amber-200 flex items-center gap-1"
        >
          <Clock className="w-3.5 h-3.5" /> Reset packer sweep
        </button>
      </div>

      {/* Heat check — flag recipients whose 3-day forecast peaks ≥ 90°F so
          the desk can contact them before their plants cook in transit. */}
      {subTab === 'ready' && (
        <HeatCheckPanel boxes={heatCheckBoxes} showToast={showToast} />
      )}

      {/* Filters — sort + carrier + contents in one quiet row. Active
          chips share the single emerald accent (instead of per-option
          blue/amber/sky) so the toolbar reads as one calm band. */}
      <div className="flex items-center gap-x-4 gap-y-2 flex-wrap text-xs">
        <label className="flex items-center gap-1.5">
          <span className="text-gray-400">Sort</span>
          <select
            value={readySort}
            onChange={(e) => setReadySort(e.target.value)}
            className="text-xs border border-gray-200 rounded-md py-1 px-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            <option value="created-desc">Newest</option>
            <option value="created-asc">Oldest</option>
            <option value="customer">Customer A–Z</option>
            <option value="items-desc">Most items</option>
            <option value="items-asc">Fewest items</option>
            <option value="carrier-usps">USPS first</option>
            <option value="carrier-ups">UPS first</option>
          </select>
        </label>
        <div className="flex items-center gap-1">
          <span className="text-gray-400 mr-0.5">Carrier</span>
          {[
            { v: 'all', label: 'All' },
            { v: 'usps', label: 'USPS' },
            { v: 'ups', label: 'UPS' },
          ].map(c => (
            <button
              key={c.v}
              type="button"
              onClick={() => setReadyCarrierFilter(c.v)}
              className={`px-2 py-1 rounded-md font-medium transition ${
                readyCarrierFilter === c.v
                  ? 'bg-emerald-600 text-white'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-gray-400 mr-0.5">Contents</span>
          {[
            { v: 'all', label: 'All' },
            { v: 'tc', label: 'TC' },
            { v: 'anthurium', label: 'Anthurium' },
          ].map(c => (
            <button
              key={c.v}
              type="button"
              onClick={() => setContentFilter(c.v)}
              className={`px-2 py-1 rounded-md font-medium transition ${
                contentFilter === c.v
                  ? 'bg-emerald-600 text-white'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        {selectedBoxIds.size > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-emerald-700 font-medium">
              {selectedBoxIds.size} selected
            </span>
            <button
              type="button"
              onClick={clearSelection}
              className="px-2 py-1 rounded-md text-gray-500 hover:bg-gray-100"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {/* Active-filter banner shown when a box was scanned / looked up.
          Clearing it returns the list to every box. */}
      {scannedBoxId && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 flex items-center gap-2 text-sm text-emerald-900">
          <ScanLine className="w-4 h-4 text-emerald-600 shrink-0" />
          <span className="flex-1 truncate">
            Showing box{' '}
            <span className="font-mono">{shortBoxCode(scannedBoxId)}</span>
          </span>
          <button
            type="button"
            onClick={() => setScannedBoxId(null)}
            className="text-xs font-medium text-emerald-700 hover:text-emerald-900 px-2 py-1"
          >
            Clear
          </button>
        </div>
      )}

      {subTab === 'ready' && (
        <>
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs text-gray-400">
                {totalBoxes} {totalBoxes === 1 ? 'box' : 'boxes'} · {groups.length} {groups.length === 1 ? 'buyer' : 'buyers'} · {totalItems} {totalItems === 1 ? 'item' : 'items'}
              </span>
              <div className="flex items-center gap-2 flex-wrap">
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => setNewBoxOpen(true)}
                    className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800"
                  >
                    <Plus className="w-4 h-4" />
                    Add shipment
                  </button>
                )}
                {totalBoxes > 0 && onPrintBoxLabels && (
                  <button
                    type="button"
                    onClick={() => {
                      // If the operator picked specific boxes via the
                      // checkboxes, print only those. Otherwise print
                      // every open box across every buyer group.
                      const allBoxes = groups.flatMap(g => g.boxes);
                      const targets = selectedBoxIds.size > 0
                        ? allBoxes.filter(b => selectedBoxIds.has(b.id))
                        : allBoxes;
                      onPrintBoxLabels(targets);
                    }}
                    className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 active:bg-gray-100"
                  >
                    <Printer className="w-4 h-4" />
                    Print box labels
                    <span className="text-xs text-gray-400 ml-1">
                      · {selectedBoxIds.size > 0 ? selectedBoxIds.size : totalBoxes}
                    </span>
                  </button>
                )}
                {/* Print the carrier shipping-label PDFs for the selected
                    boxes (or all visible boxes if none selected) as one merged
                    document — a single print dialog for the whole batch.
                    Disabled until at least one box in scope has a label. */}
                {totalBoxes > 0 && (() => {
                  const allBoxes = groups.flatMap(g => g.boxes);
                  const pool = selectedBoxIds.size > 0
                    ? allBoxes.filter(b => selectedBoxIds.has(b.id))
                    : allBoxes;
                  const printable = pool.filter(b => boxHasPrintableLabel(b.id));
                  return (
                    <button
                      type="button"
                      disabled={printable.length === 0 || printingLabels}
                      title={printable.length === 0
                        ? 'No shipping labels on these boxes yet — import or buy labels first'
                        : `Print ${printable.length} shipping label${printable.length === 1 ? '' : 's'} as one document`}
                      onClick={async () => {
                        setPrintingLabels(true);
                        try {
                          await printShippingLabels(printable.map(b => b.id), showToast);
                        } finally {
                          setPrintingLabels(false);
                        }
                      }}
                      className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg border border-emerald-300 text-emerald-700 bg-white hover:bg-emerald-50 active:bg-emerald-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {printingLabels
                        ? <Loader2 className="w-4 h-4 animate-spin" />
                        : <Printer className="w-4 h-4" />}
                      Print shipping labels
                      <span className="text-xs text-emerald-600/70 ml-1">· {printable.length}</span>
                    </button>
                  );
                })()}
                {/* Bulk label purchase: every open box in scope (selected-else-
                    all, same idiom as the print buttons) that doesn't already
                    have an active label. The modal lets the operator tick
                    boxes, pick each one's size + service, then buys them
                    sequentially. */}
                {totalBoxes > 0 && (() => {
                  const allBoxes = groups.flatMap(g => g.boxes);
                  const pool = selectedBoxIds.size > 0
                    ? allBoxes.filter(b => selectedBoxIds.has(b.id))
                    : allBoxes;
                  const needsLabel = pool.filter(b => {
                    const s = shipmentsByBox[b.id];
                    return !(s && !s.voidedAt);
                  });
                  // Badge counts UPS boxes so it matches the button's label;
                  // the modal itself lists every carrier (UPS pre-checked).
                  const upsCount = needsLabel.filter(b => b.carrier === 'ups').length;
                  return (
                    <button
                      type="button"
                      disabled={needsLabel.length === 0}
                      title={needsLabel.length === 0
                        ? 'Every box in scope already has a label'
                        : `${needsLabel.length} open box${needsLabel.length === 1 ? '' : 'es'} without a label (${upsCount} UPS — pre-selected in the modal)`}
                      onClick={() => setBulkBuyOpen(true)}
                      className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg border border-amber-300 text-amber-800 bg-white hover:bg-amber-50 active:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <ShoppingCart className="w-4 h-4" />
                      Buy UPS labels
                      <span className="text-xs text-amber-600/70 ml-1">· {upsCount}</span>
                    </button>
                  );
                })()}
                {/* Combine orders — one buyer's multiple boxes into a single
                    shipment. Admin-only, like Edit items / Delete box: it
                    bulk-rewrites item box pointers + buyer identity. The
                    badge counts buyers with 2+ open unlabeled boxes. */}
                {isAdmin && totalBoxes > 1 && (() => {
                  const allBoxes = groups.flatMap(g => g.boxes);
                  const combinable = allBoxes.filter(b => {
                    const s = shipmentsByBox[b.id];
                    return !(s && !s.voidedAt);
                  });
                  const byBuyer = new Map();
                  for (const b of combinable) {
                    const k = (b.buyerUsername || b.buyer || 'unknown').toLowerCase();
                    byBuyer.set(k, (byBuyer.get(k) || 0) + 1);
                  }
                  const candidates = [...byBuyer.values()].filter(n => n > 1).length;
                  return (
                    <button
                      type="button"
                      disabled={combinable.length < 2}
                      title={combinable.length < 2
                        ? 'Need at least two open boxes without a label'
                        : `${candidates} buyer${candidates === 1 ? '' : 's'} with multiple open boxes`}
                      onClick={() => { refreshShipments(); setCombineOpen(true); }}
                      className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 active:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Combine className="w-4 h-4" />
                      Combine orders
                      {candidates > 0 && <span className="text-xs text-emerald-600 ml-1">· {candidates}</span>}
                    </button>
                  );
                })()}
                {onPrintItemLabels && (() => {
                  // Every plant to label across the currently-visible open boxes:
                  // Anthurium items PLUS unmatched placeholders (which have no
                  // variety but are still a physical plant the packer must find by
                  // its lineup number). Each label carries the big lineup # + name
                  // + SKU, like the live-sale labels.
                  const allBoxes = groups.flatMap(g => g.boxes);
                  const antItems = allBoxes.flatMap(b =>
                    (b.items || []).filter(i => isAnthuriumItem(i) || i.lotKind === 'unmatched')
                  );
                  const n = antItems.length;
                  return (
                    <button
                      type="button"
                      disabled={n === 0}
                      onClick={() => onPrintItemLabels(antItems)}
                      className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 active:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Printer className="w-4 h-4" />
                      Print ANT labels
                      <span className="text-xs text-gray-400 ml-1">· {n}</span>
                    </button>
                  );
                })()}
              </div>
            </div>
            {isAdmin && onDeleteBoxes && duplicateBoxes.length > 0 && (
              <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl p-3">
                <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-amber-900">
                    {duplicateBoxes.length} box{duplicateBoxes.length === 1 ? '' : 'es'} duplicate an already-shipped order
                  </div>
                  <div className="text-xs text-amber-800 mt-0.5">
                    These were re-created by a Validate Sales re-upload after the order had already shipped. Deleting reverts their re-sold items back to "listed" and purges any placeholders — the original shipped boxes are untouched.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const names = duplicateBoxes
                      .map(b => `${b.buyer || b.buyerUsername || 'Unknown'} (${shortBoxCode(b.id)})`)
                      .join(', ');
                    setConfirmDialog?.({
                      title: `Delete ${duplicateBoxes.length} duplicate box${duplicateBoxes.length === 1 ? '' : 'es'}?`,
                      message: `These open boxes duplicate orders that already shipped: ${names}. Their re-sold items revert to "listed" and placeholders are purged. Shipped boxes are not affected.`,
                      confirmLabel: 'Delete duplicates',
                      danger: true,
                      onConfirm: () => onDeleteBoxes(duplicateBoxes.map(b => b.id)),
                    });
                  }}
                  className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg border border-red-200 text-red-700 bg-white hover:bg-red-50 active:bg-red-100 flex-shrink-0"
                >
                  <Trash2 className="w-4 h-4" /> Delete duplicates
                </button>
              </div>
            )}
            {filteredReady.length === 0 ? (
              <div className="bg-white border border-gray-200 rounded-xl p-8 text-center">
                <PackageOpen className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                <p className="text-sm text-gray-500">
                  {searchLower
                    ? `No Ready boxes match "${searchQuery.trim()}".`
                    : scannedBoxId
                    ? `Scanned box isn't in Ready to ship — check the Shipped tab.`
                    : contentFilter !== 'all'
                    ? `No Ready boxes contain ${contentFilter === 'tc' ? 'TC' : 'Anthurium'} items.`
                    : `Nothing waiting to ship. When a sale's orders get applied, boxes show up here.`}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {filteredReady.map(g => (
                  <BuyerGroupCard
                    key={g.key}
                    group={g}
                    expandSet={readyExpandSet}
                    sales={sales}
                    shipmentsByBox={shipmentsByBox}
                    boxNotesByBox={boxNotesByBox}
                    boxSizes={boxSizes}
                    onSaveBoxNote={onSaveBoxNote}
                    onSaveBoxPackaging={onSaveBoxPackaging}
                    onSetHold={onSetHold}
                    onTogglePickup={onTogglePickup}
                    onToggleInsulation={onToggleInsulation}
                    onBought={refreshShipments}
                    onCancelLabel={onCancelLabel}
                    onOpenBox={(saleId) => setActiveSaleId(saleId)}
                    onBuyLabel={(box) => setBuyingFor(box)}
                    onSaveTracking={handleSaveTracking}
                    onMarkShipped={handleMarkShipped}
                    onUnship={confirmUnship}
                    onTogglePacked={onTogglePacked}
                    dupeLots={dupeLots}
                    findDupeLotBox={findDupeLotBox}
                    showToast={showToast}
                    isAdmin={isAdmin}
                    selectedBoxIds={selectedBoxIds}
                    onToggleBoxSelected={toggleBoxSelected}
                    onPrintSlip={(box) => setSlipBox(box)}
                    onEditAddress={(box, note) =>
                      // note: set when the click came from an address-change
                      // note's shortcut — the modal shows it for reference.
                      setEditingAddressBox(note ? { ...box, addressNote: note } : box)}
                    onEditItems={(box) => setEditingBox(box)}
                    onDeleteBox={(box) => {
                      // Confirm before nuking. Mirrors the existing
                      // "Delete all open boxes" confirm dialog style.
                      const sold = box.items.filter(i => i.status === 'sold');
                      const matched = sold.filter(i => i.lotKind !== 'unmatched').length;
                      const unmatched = sold.filter(i => i.lotKind === 'unmatched').length;
                      setConfirmDialog?.({
                        title: `Delete this box?`,
                        message: unmatched > 0
                          ? `Reverts ${matched} matched item${matched === 1 ? '' : 's'} back to "listed" and permanently deletes ${unmatched} unmatched placeholder${unmatched === 1 ? '' : 's'}. Already-shipped items in this box aren't touched.`
                          : `Reverts ${matched} matched item${matched === 1 ? '' : 's'} back to "listed". Already-shipped items in this box aren't touched.`,
                        confirmLabel: 'Delete box',
                        danger: true,
                        onConfirm: () => onDeleteBox?.(box.id),
                      });
                    }}
                  />
                ))}
              </div>
            )}
          </section>

          {/* Danger zone — wipe every open box in one click. Reverts
              matched items back to 'listed' and soft-deletes unmatched
              placeholders. Used to recover after an upload that went
              wrong (wrong file, bad SKUs, etc.) so the operator can
              clean up and re-apply. */}
          {deleteSummary.total > 0 && onDeleteAllOpenBoxes && (
            <section>
              <button
                type="button"
                onClick={() => {
                  setConfirmDialog?.({
                    title: `Delete all open boxes?`,
                    message: deleteSummary.unmatched > 0
                      ? `Reverts ${deleteSummary.matched} matched item${deleteSummary.matched === 1 ? '' : 's'} back to "listed" and permanently deletes ${deleteSummary.unmatched} unmatched placeholder${deleteSummary.unmatched === 1 ? '' : 's'} (so re-uploads don't trip the unique SKU). Already-shipped items aren't touched.`
                      : `Reverts ${deleteSummary.matched} matched item${deleteSummary.matched === 1 ? '' : 's'} back to "listed". Already-shipped items aren't touched.`,
                    confirmLabel: 'Delete all open boxes',
                    danger: true,
                    onConfirm: () => onDeleteAllOpenBoxes(),
                  });
                }}
                className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg border border-red-200 text-red-700 bg-white hover:bg-red-50 active:bg-red-100"
              >
                <Trash2 className="w-4 h-4" />
                Delete all open boxes
                <span className="text-xs text-red-500 font-normal ml-1">
                  · {deleteSummary.matched} revert{deleteSummary.unmatched > 0 ? ` + ${deleteSummary.unmatched} placeholder${deleteSummary.unmatched === 1 ? '' : 's'}` : ''}
                </span>
              </button>
            </section>
          )}

          {awaitingUpload.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-sm font-medium text-gray-700">
                Awaiting upload
                <span className="text-gray-400 font-normal ml-1">
                  · {awaitingUpload.length}
                </span>
              </h3>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {awaitingUpload.map(sale => (
                  <button
                    key={sale.id}
                    onClick={() => setActiveSaleId(sale.id)}
                    className="text-left bg-amber-50 border border-amber-200 rounded-xl p-4 hover:border-amber-400 hover:shadow-sm active:bg-amber-100 transition"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-gray-900 truncate">{sale.name}</div>
                        <div className="text-xs text-gray-500">{sale.date}</div>
                      </div>
                      <Upload className="w-4 h-4 text-amber-600 shrink-0" />
                    </div>
                    <div className="text-xs text-amber-800 mt-2">
                      Run "Validate Sales" in the Sale tab to assemble boxes.
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* Shipped archive — BoxRow detects the all-shipped state and hides
          the per-row action buttons (nothing left to act on), but the
          chevron drill-in still works for label-PDF retrieval. */}
      {subTab === 'shipped' && (
        <section className="space-y-2">
          <span className="text-xs text-gray-400">
            {shipped.totalBoxes} {shipped.totalBoxes === 1 ? 'box' : 'boxes'} · {shipped.groups.length} {shipped.groups.length === 1 ? 'buyer' : 'buyers'} · {shipped.totalItems} {shipped.totalItems === 1 ? 'item' : 'items'}
          </span>
          {/* Shipping-cost summary — scoped to this week by default; toggle to
              all time. Shown whenever any shipped box has a real label cost. */}
          {shippedShippingAll.boxes > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-gray-400 mr-0.5">Shipping cost</span>
                {[
                  { v: 'week', label: 'This week' },
                  { v: 'all', label: 'All time' },
                ].map(p => (
                  <button
                    key={p.v}
                    type="button"
                    onClick={() => setShippedCostPeriod(p.v)}
                    className={`px-2 py-1 rounded-md font-medium transition ${
                      shippedCostPeriod === p.v
                        ? 'bg-emerald-600 text-white'
                        : 'text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              {shippedShipping.boxes > 0 ? (
                <div className="grid grid-cols-3 gap-2">
                  <SummaryStat
                    label="Shipping cost"
                    value={fmt$2(shippedShipping.cost)}
                    sub={`${shippedShipping.boxes} label${shippedShipping.boxes === 1 ? '' : 's'}${shippedCostPeriod === 'week' ? ' this week' : ''}`}
                    tone="gray"
                  />
                  <SummaryStat
                    label="Buyers paid"
                    value={fmt$2(shippedShipping.collected)}
                    sub="shipping collected"
                    tone="gray"
                  />
                  <SummaryStat
                    label={shippedShipping.net < 0 ? 'Lost on shipping' : 'Shipping net'}
                    value={fmt$2(shippedShipping.net)}
                    sub={shippedShipping.net < 0 ? 'cost over collected' : 'collected over cost'}
                    tone={shippedShipping.net < 0 ? 'red' : 'emerald'}
                  />
                </div>
              ) : (
                <div className="bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-xs text-gray-500">
                  No labels bought this week. Switch to <span className="font-medium text-gray-700">All time</span> for the running total.
                </div>
              )}
            </div>
          )}
          {filteredShipped.groups.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl p-8 text-center">
              <PackageOpen className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-500">
                {searchLower
                  ? `No Shipped boxes match "${searchQuery.trim()}".`
                  : scannedBoxId
                  ? `Scanned box isn't in Shipped — check the Ready tab.`
                  : contentFilter !== 'all'
                  ? `No Shipped boxes contain ${contentFilter === 'tc' ? 'TC' : 'Anthurium'} items.`
                  : `No boxes have shipped yet. Once you Mark shipped on a row, it moves here.`}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredShipped.groups.map(g => (
                <BuyerGroupCard
                  key={g.key}
                  group={g}
                  expandSet={shippedExpandSet}
                  sales={sales}
                  shipmentsByBox={shipmentsByBox}
                  boxNotesByBox={boxNotesByBox}
                  boxSizes={boxSizes}
                  onSaveBoxNote={onSaveBoxNote}
                  onSaveBoxPackaging={onSaveBoxPackaging}
                  onBought={refreshShipments}
                  onCancelLabel={onCancelLabel}
                  onOpenBox={(saleId) => setActiveSaleId(saleId)}
                  onBuyLabel={(box) => setBuyingFor(box)}
                  onSaveTracking={handleSaveTracking}
                  onMarkShipped={handleMarkShipped}
                  onUnship={confirmUnship}
                  onTogglePacked={onTogglePacked}
                  showToast={showToast}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {buyingFor && (
        <BuyLabelModal
          box={buyingFor}
          onClose={() => setBuyingFor(null)}
          onPurchased={() => {
            refreshShipments();
            showToast('Label purchased');
          }}
          showToast={showToast}
        />
      )}

      {bulkBuyOpen && (() => {
        // Same scope as the button: selected-else-all open boxes without an
        // active label, with each box's saved packaging (size/weight/service)
        // merged in — the same merge BoxRow does per-row (boxNotesByBox).
        const allBoxes = groups.flatMap(g => g.boxes);
        const pool = selectedBoxIds.size > 0
          ? allBoxes.filter(b => selectedBoxIds.has(b.id))
          : allBoxes;
        const buyable = pool
          .filter(b => {
            const s = shipmentsByBox[b.id];
            return !(s && !s.voidedAt);
          })
          .map(b => ({ ...b, ...(boxNotesByBox?.[b.id] || {}) }));
        return (
          <BulkBuyLabelsModal
            boxes={buyable}
            boxSizes={boxSizes}
            preselectedIds={selectedBoxIds.size > 0 ? selectedBoxIds : null}
            onClose={() => setBulkBuyOpen(false)}
            onBought={refreshShipments}
            showToast={showToast}
          />
        );
      })()}

      {combineOpen && isAdmin && (
        <CombineBoxesModal
          boxes={groups.flatMap(g => g.boxes)}
          shipmentsByBox={shipmentsByBox}
          boxNotesByBox={boxNotesByBox}
          salesById={new Map((sales || []).map(s => [s.id, s]))}
          onClose={() => setCombineOpen(false)}
          onCombine={async (target, sources) => {
            await handleCombineBoxes(target, sources);
            setCombineOpen(false);
          }}
          showToast={showToast}
        />
      )}

      {importOpen && (
        <ImportLabelsModal
          openBoxes={groups.flatMap(g => g.boxes)}
          shipmentsByBox={shipmentsByBox}
          onClose={() => setImportOpen(false)}
          onDone={async () => {
            await refreshShipments();
            await onRefreshItems?.();
          }}
          showToast={showToast}
        />
      )}

      {scannerMode && isMobile && (
        <CameraScanner
          onScan={(text) => {
            if (scannerMode === 'box') handleScannedBoxCode(text);
            else if (scannerMode === 'item') handleScannedItemSku(text);
          }}
          onClose={() => setScannerMode(null)}
        />
      )}

      {scannerMode && !isMobile && (
        <ScanTextInputDialog
          mode={scannerMode}
          onSubmit={(text) => {
            if (scannerMode === 'box') handleScannedBoxCode(text);
            else if (scannerMode === 'item') handleScannedItemSku(text);
            setScannerMode(null);
          }}
          onClose={() => setScannerMode(null)}
        />
      )}

      {newBoxOpen && (
        <NewBoxModal
          inventoryItems={inventoryItems}
          showToast={showToast}
          onRefreshItems={onRefreshItems}
          onClose={() => setNewBoxOpen(false)}
        />
      )}

      {editingBox && (
        <EditBoxItemsModal
          box={(() => {
            // Always read the freshest version of this box from the
            // current groups so adds/removes reflect immediately when
            // onRefreshItems lands. Falls back to the captured prop if
            // the box just emptied out (handle close-on-disappear).
            const fresh = [...groups, ...shipped.groups]
              .flatMap(g => g.boxes)
              .find(b => b.id === editingBox.id);
            return fresh || editingBox;
          })()}
          inventoryItems={inventoryItems}
          showToast={showToast}
          onRefreshItems={onRefreshItems}
          onClose={() => setEditingBox(null)}
        />
      )}

      {editingAddressBox && (
        <EditBoxAddressModal
          box={(() => {
            // Read the freshest copy of the box so the form prefills with
            // current values; fall back to the captured one if it just left
            // the list.
            const fresh = [...groups, ...shipped.groups]
              .flatMap(g => g.boxes)
              .find(b => b.id === editingAddressBox.id);
            return fresh || editingAddressBox;
          })()}
          note={editingAddressBox.addressNote || null}
          onSave={(data) => handleSaveAddress(editingAddressBox, data)}
          onClose={() => setEditingAddressBox(null)}
          showToast={showToast}
        />
      )}

      {slipBox && (
        <ShippingSlipSheet
          box={slipBox}
          onClose={() => setSlipBox(null)}
          showToast={showToast}
        />
      )}

      {toast && (
        <div className="fixed bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-sm px-4 py-2 rounded-lg shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Buyer grouping helpers.
// ───────────────────────────────────────────────────────────────────────────

// "Ready to ship" — at least one item still 'sold' (not every item has
// been shipped yet). Partially-shipped boxes show up here too so the
// operator can finish them.
const READY_PREDICATE = (box) =>
  box.items.some(i => i.status === 'sold');

// "Shipped" — every item in the box is shipped/delivered. Used by the
// archive section so the operator can find historical boxes by buyer.
const SHIPPED_PREDICATE = (box) =>
  box.items.length > 0 &&
  box.items.every(i => ['shipped', 'delivered'].includes(i.status));

// Open boxes that are re-validate artifacts of an already-shipped order.
// Re-validating a Palmstreet file after a buyer's box shipped mints a fresh
// box for any line it can't fold into an existing OPEN box — producing a
// duplicate that sits in Ready next to the shipped original. A box is such a
// duplicate when: it has a 'sold' item (so it's in Ready), it has NO shipped
// item of its own (a genuinely partially-shipped box is left alone), and
// every one of its items belongs to an order that shipped in some other box.
// Palmstreet order numbers are unique per order, so a shared orderId can only
// mean the same order was re-imported — never a legitimately new order.
function findShippedDuplicateBoxIds(items) {
  const shippedOrderIds = new Set();
  for (const i of items) {
    if (i.deletedAt || !i.orderId) continue;
    if (i.status === 'shipped' || i.status === 'delivered') shippedOrderIds.add(i.orderId);
  }
  const byBox = new Map();
  for (const i of items) {
    if (i.deletedAt || !i.shipmentBoxId) continue;
    if (!['sold', 'shipped', 'delivered'].includes(i.status)) continue;
    if (!byBox.has(i.shipmentBoxId)) byBox.set(i.shipmentBoxId, []);
    byBox.get(i.shipmentBoxId).push(i);
  }
  const dupes = new Set();
  for (const [boxId, list] of byBox) {
    if (!list.some(i => i.status === 'sold')) continue;                       // must be open
    if (list.some(i => ['shipped', 'delivered'].includes(i.status))) continue; // not a real partial
    if (list.every(i => i.orderId && shippedOrderIds.has(i.orderId))) dupes.add(boxId);
  }
  return dupes;
}

function groupBoxesByBuyer(items, sales, predicate, boxNotesByBox = {}) {
  // First, assemble every (live) box from item rows. A box exists once an
  // item has a shipmentBoxId — that's what the post-upload apply step
  // stamps on. We always consider items in 'sold'/'shipped'/'delivered'
  // (anything that's been through Validate Sales). The caller-supplied
  // predicate decides which of the resulting boxes survive to be grouped.
  const boxMap = new Map();
  for (const item of items) {
    if (!item.shipmentBoxId) continue;
    if (item.deletedAt) continue;
    if (!['sold', 'shipped', 'delivered'].includes(item.status)) continue;
    let box = boxMap.get(item.shipmentBoxId);
    if (!box) {
      box = {
        id: item.shipmentBoxId,
        saleId: item.saleId,
        buyer: item.buyer || '',
        buyerUsername: item.buyerUsername || '',
        buyerAddress: item.buyerAddress || {},
        // stampedCarrier = the value written on items at apply time (encodes
        // the legacy UPS-upgrade-line rule). carrier (the effective one) is
        // resolved from contents + any override in the post-loop below.
        stampedCarrier: item.shipmentCarrier || 'usps',
        carrier: item.shipmentCarrier || 'usps',
        items: [],
      };
      boxMap.set(item.shipmentBoxId, box);
    }
    box.items.push(item);
  }

  // Box openedAt = earliest soldAt across its items. The system has no
  // explicit "box opened" event since a box exists once any item gets
  // a shipmentBoxId stamped; the first soldAt is when that happened.
  // shippingFeeCollected = what the buyer(s) paid to ship this box, summed
  // from each item's Palmstreet order shipping fee — compared against the
  // label cost in the rate/label UI to flag boxes we lose money on.
  for (const box of boxMap.values()) {
    let earliest = null;
    let feeCollected = 0;
    for (const i of box.items) {
      if (i.soldAt && (!earliest || i.soldAt < earliest)) earliest = i.soldAt;
      feeCollected += parseFloat(i.orderShippingFee) || 0;
    }
    box.openedAt = earliest;
    box.shippingFeeCollected = feeCollected;
    // Effective carrier: a per-box override wins, else anthurium → UPS, else
    // the stamped carrier. Computed here (once items are all attached) so the
    // badge, carrier filter/sort, and label flow all agree.
    box.carrierOverride = boxNotesByBox?.[box.id]?.carrierOverride ?? null;
    box.carrier = resolveBoxCarrier(box.items, box.carrierOverride, box.stampedCarrier);
  }

  const openBoxes = [...boxMap.values()].filter(predicate);

  // Group by buyer. Prefer username (canonical across Palmstreet sales),
  // fall back to display name. The username is what disambiguates two
  // buyers who happen to share a display name.
  const groupMap = new Map();
  for (const box of openBoxes) {
    const key = (box.buyerUsername || box.buyer || 'unknown').toLowerCase();
    let group = groupMap.get(key);
    if (!group) {
      group = {
        key,
        displayName: box.buyer || box.buyerUsername || 'Unknown buyer',
        username: box.buyerUsername || '',
        addressSnippet: addressOneLine(box.buyerAddress),
        boxes: [],
      };
      groupMap.set(key, group);
    }
    group.boxes.push(box);
  }

  // Within a group, sort boxes by sale recency (newest sale first). Across
  // groups, sort alphabetically by display name — operator can scan to find
  // a specific buyer fast.
  const saleById = new Map(sales.map(s => [s.id, s]));
  for (const group of groupMap.values()) {
    group.boxes.sort((a, b) => {
      const sa = saleById.get(a.saleId);
      const sb = saleById.get(b.saleId);
      return new Date(sb?.createdAt || 0) - new Date(sa?.createdAt || 0);
    });
  }
  const groups = [...groupMap.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName)
  );

  const totalItems = openBoxes.reduce((sum, b) => sum + b.items.length, 0);
  return { groups, totalBoxes: openBoxes.length, totalItems };
}

function addressOneLine(addr) {
  if (!addr || typeof addr !== 'object') return '';
  const parts = [addr.city, addr.state, addr.zip || addr.zipCode].filter(Boolean);
  return parts.join(', ');
}

function BuyerGroupCard({
  group, expandSet, sales, shipmentsByBox, boxNotesByBox, boxSizes, onSaveBoxNote, onSaveBoxPackaging, onSetHold, onTogglePickup, onToggleInsulation, onBought, onCancelLabel,
  onOpenBox, onBuyLabel, onSaveTracking, onMarkShipped, onUnship, onTogglePacked, dupeLots, findDupeLotBox, showToast,
  isAdmin, onEditItems, onEditAddress, onDeleteBox, onPrintSlip,
  selectedBoxIds, onToggleBoxSelected,
}) {
  const totalItems = group.boxes.reduce((sum, b) => sum + b.items.length, 0);
  const saleCount = new Set(group.boxes.map(b => b.saleId)).size;
  const salesById = useMemo(
    () => new Map(sales.map(s => [s.id, s])),
    [sales],
  );

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-gray-900 truncate">{group.displayName}</div>
          <div className="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
            {group.username && <span>@{group.username}</span>}
            {group.addressSnippet && <span className="truncate">· {group.addressSnippet}</span>}
          </div>
        </div>
        <div className="text-right text-xs text-gray-500 shrink-0 leading-tight">
          <div>
            {group.boxes.length} {group.boxes.length === 1 ? 'box' : 'boxes'}
          </div>
          <div>
            {totalItems} {totalItems === 1 ? 'item' : 'items'}
            {saleCount > 1 && <> · {saleCount} sales</>}
          </div>
        </div>
      </div>
      <div className="space-y-1.5">
        {group.boxes.map(box => {
          // Merge the shipment_boxes metadata once — the modal opened by
          // Buy label needs serviceKey/notes on the box too, not just BoxRow.
          const merged = { ...box, ...(boxNotesByBox?.[box.id] || {}) };
          return (
          <BoxRow
            key={box.id}
            box={merged}
            defaultExpanded={expandSet ? expandSet.has(box.id) : false}
            sale={salesById.get(box.saleId)}
            salesById={salesById}
            shipment={shipmentsByBox[box.id]}
            onOpen={() => onOpenBox(box.saleId)}
            onBuyLabel={() => onBuyLabel(merged)}
            onSaveTracking={(num) => onSaveTracking(box, num)}
            onMarkShipped={() => onMarkShipped(box)}
            onUnship={onUnship ? () => onUnship(box) : null}
            onTogglePacked={onTogglePacked}
            dupeLots={dupeLots}
            findDupeLotBox={findDupeLotBox}
            onSetHold={onSetHold ? (hold, release) => onSetHold(box.id, hold, release) : null}
            onTogglePickup={onTogglePickup ? (make) => onTogglePickup(box.id, make) : null}
            onToggleInsulation={onToggleInsulation ? (on) => onToggleInsulation(box.id, on) : null}
            onSaveNote={onSaveBoxNote ? (note) => onSaveBoxNote(box.id, note) : null}
            boxSizes={boxSizes}
            onSavePackaging={onSaveBoxPackaging ? (patch) => onSaveBoxPackaging(box.id, patch) : null}
            onBought={onBought}
            onCancelLabel={onCancelLabel ? () => onCancelLabel(box) : null}
            showToast={showToast}
            isAdmin={isAdmin}
            onEditItems={onEditItems ? () => onEditItems(box) : null}
            onEditAddress={onEditAddress ? (note) => onEditAddress(box, note) : null}
            onDeleteBox={onDeleteBox ? () => onDeleteBox(box) : null}
            onPrintSlip={onPrintSlip ? () => onPrintSlip(box) : null}
            isSelected={selectedBoxIds ? selectedBoxIds.has(box.id) : false}
            onToggleSelected={onToggleBoxSelected ? () => onToggleBoxSelected(box.id) : null}
          />
        );
        })}
      </div>
    </div>
  );
}

// Compute the per-box action state. The shipments row is the source of
// truth for "has label / tracking", but a voided row counts as "no label"
// so the operator can buy/enter again.
function boxActionState(box, shipment) {
  const liveShipment = shipment && !shipment.voidedAt ? shipment : null;
  const hasLabel = !!liveShipment?.labelStoragePath;
  const hasTracking = !!liveShipment?.trackingNumber;
  const carrier = (box.carrier || 'usps').toLowerCase();

  if (hasLabel || hasTracking) return { kind: 'ship', carrier, shipment: liveShipment };
  if (carrier === 'ups') return { kind: 'buy-label', carrier };
  return { kind: 'enter-tracking', carrier };
}

// Copy-to-clipboard chips for the buyer's shipping address. The
// operator buys USPS labels off-site (Pirate Ship, etc.) and pastes
// these fields one-by-one into the carrier's form. Each chip shows
// the field label + the actual value (truncated if long) and copies
// the full value on click. Hover to see the full untruncated value.
function AddressCopyStrip({ box, showToast }) {
  const a = box.buyerAddress || {};
  const fields = [
    { label: 'Name', value: (box.buyer || '').trim() },
    { label: 'Street 1', value: (a.street1 || '').trim() },
    { label: 'Street 2', value: (a.street2 || '').trim() },
    { label: 'City', value: (a.city || '').trim() },
    { label: 'State', value: (a.state || '').trim() },
    { label: 'Zip', value: (a.zip || '').trim() },
  ].filter(f => f.value);
  if (fields.length === 0) return null;

  const copy = async (value, label) => {
    try {
      await navigator.clipboard.writeText(value);
      showToast?.(`Copied ${label}`);
    } catch {
      // Older Safari / non-HTTPS fallback — most modern setups go
      // through navigator.clipboard fine, but keep a soft failure
      // message rather than crashing the row.
      showToast?.('Copy failed — try again');
    }
  };

  return (
    <div className="px-3 py-2 bg-gray-50/70 border-t border-gray-100 flex flex-wrap gap-1.5">
      {fields.map(f => (
        <button
          key={f.label}
          type="button"
          onClick={(e) => { e.stopPropagation(); copy(f.value, f.label); }}
          title={`Copy ${f.label}: ${f.value}`}
          className="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-emerald-50 hover:border-emerald-300 hover:text-emerald-700 active:bg-emerald-100"
        >
          <span className="font-medium text-gray-500 uppercase tracking-wide text-[9px]">{f.label}</span>
          <span className="font-mono truncate max-w-[160px]">{f.value}</span>
          <Copy className="w-3 h-3 text-gray-400" />
        </button>
      ))}
    </div>
  );
}

function BoxItemsList({ box, salesById, onTogglePacked, dupeLots, findDupeLotBox, onResolveReview, onEditAddress }) {
  // Hide already-shipped items in open boxes — the operator only cares
  // about what's left to pack. Shipped boxes (every item is shipped)
  // skip the filter so the archive view still shows the full contents.
  const isOpenBox = box.items.some(i => i.status === 'sold');
  const sortedItems = useMemo(() => {
    let copy = [...box.items];
    if (isOpenBox) {
      copy = copy.filter(i => !['shipped', 'delivered'].includes(i.status));
    }
    copy.sort((a, b) => {
      const sa = (a.sku || a.name || '').toString();
      const sb = (b.sku || b.name || '').toString();
      return sa.localeCompare(sb);
    });
    return copy;
  }, [box.items, isOpenBox]);

  return (
    <div className="border-t border-gray-100 bg-gray-50/40 px-3 py-2 space-y-1.5">
      {sortedItems.map(item => {
        const itemSale = salesById?.get(item.saleId);
        const name = (item.name || '').trim();
        const variety = (item.variety || '').trim();
        const qty = item.quantity || 1;
        // salePrice is set at order-apply time (SalesUploadModal). It's
        // stored as a numeric in dollars to match the existing
        // ShipBoxCard / SalesView display convention.
        const priceRaw = item.salePrice != null ? parseFloat(item.salePrice) : NaN;
        const priceStr = Number.isFinite(priceRaw) && priceRaw > 0
          ? `$${priceRaw.toFixed(2)}`
          : null;
        const isGiveaway = item.lotKind === 'giveaway';
        const isUnmatched = item.lotKind === 'unmatched';
        const shippedAlready = ['shipped', 'delivered'].includes(item.status);

        // Visual treatment: matched lots get an emerald accent, unmatched
        // placeholders get a purple accent so they stand out for the
        // operator (they're a flag — the order line couldn't be linked
        // to real inventory at apply time).
        const rowBg = isUnmatched
          ? 'bg-purple-50 border-l-2 border-purple-300'
          : 'bg-emerald-50 border-l-2 border-emerald-300';

        const isPacked = !!item.packedAt;
        // The packed checkbox only makes sense for items still in 'sold'
        // status — once an item is shipped, packed state is moot.
        const showPackedToggle = item.status === 'sold' && !!onTogglePacked;

        return (
          <div
            key={item.id}
            className={`text-sm flex items-start justify-between gap-3 rounded px-2 py-1.5 ${rowBg} ${shippedAlready ? 'opacity-60' : ''}`}
          >
            {showPackedToggle && (
              isPacked ? (
                <button
                  type="button"
                  onClick={() => onTogglePacked(item.id, false)}
                  title="Mark as unpacked"
                  className="shrink-0 text-[11px] font-medium px-2 py-1 rounded-md border border-gray-300 text-gray-600 bg-white hover:bg-gray-50 active:bg-gray-100 flex items-center gap-1"
                >
                  <X className="w-3 h-3" /> Unpack
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    // Collided lineup number — confirm with the # and the
                    // other open box carrying it before packing on a bare #.
                    const lot = parseInt(item.lotNumber, 10);
                    if (dupeLots?.has(lot)) {
                      const other = findDupeLotBox?.(lot, box.id);
                      const where = other
                        ? `box ${shortBoxCode(other.id)}${other.buyer ? ` (${other.buyer})` : ''}`
                        : 'this box';
                      if (!window.confirm(
                        `#${lot} is also on an unpacked plant in ${where}. Check the wk tag on the label — pack ${item.sku || 'this item'} anyway?`,
                      )) return;
                    }
                    onTogglePacked(item.id, true);
                  }}
                  title="Mark as packed"
                  className="shrink-0 text-[11px] font-medium px-2 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800 flex items-center gap-1"
                >
                  <Check className="w-3 h-3" /> Pack
                </button>
              )
            )}
            {item.lotNumber && (
              <span
                className={`shrink-0 self-center min-w-[1.9rem] px-1.5 py-0.5 rounded-md text-sm font-extrabold text-center tabular-nums ${
                  isPacked ? 'bg-gray-100 text-gray-400' : 'bg-blue-600 text-white'
                }`}
                title="Lineup number — find the plant labelled with this #"
              >
                {item.lotNumber}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className={`flex items-baseline gap-2 flex-wrap ${isPacked ? 'line-through text-gray-500' : ''}`}>
                {item.sku && (
                  <span className="font-mono text-[11px] text-gray-500 shrink-0">{item.sku}</span>
                )}
                {name && (
                  <span className="text-gray-900 font-medium truncate">{name}</span>
                )}
                {name && variety && (
                  <span className="text-gray-300 shrink-0">·</span>
                )}
                {variety && (
                  <span className="text-gray-700 truncate">{variety}</span>
                )}
                {!name && !variety && (
                  <span className="text-gray-400">—</span>
                )}
                <span className="text-xs text-gray-500 shrink-0">×{qty}</span>
                {shippedAlready && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 no-underline">
                    shipped
                  </span>
                )}
                {isUnmatched && !shippedAlready && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 no-underline">
                    unmatched
                  </span>
                )}
                {isPacked && !shippedAlready && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 no-underline">
                    packed
                  </span>
                )}
                {item.reviewFlag === 'double_sale' && (
                  onResolveReview ? (
                    <button
                      type="button"
                      onClick={() => onResolveReview(item)}
                      title="Possible double-sale — this SKU was already shipped in a different box. Click to clear the flag once you've handled it."
                      className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-100 text-red-800 hover:bg-red-200 active:bg-red-300 no-underline"
                    >
                      ⚠ double-sale?
                    </button>
                  ) : (
                    <span
                      title="Possible double-sale — this SKU was already shipped in a different box."
                      className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-100 text-red-800 no-underline"
                    >
                      ⚠ double-sale?
                    </span>
                  )
                )}
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-gray-500 flex-wrap mt-0.5">
                {isGiveaway ? (
                  <span className="text-amber-700 font-medium">giveaway</span>
                ) : isUnmatched ? (
                  <span className="text-purple-700 font-medium">no inventory link</span>
                ) : (
                  <span>regular</span>
                )}
                {item.orderId && (
                  <>
                    <span className="text-gray-300">·</span>
                    <span className="font-mono">{item.orderId}</span>
                  </>
                )}
                {itemSale?.name && (
                  <>
                    <span className="text-gray-300">·</span>
                    <span className="truncate">{itemSale.name}</span>
                  </>
                )}
                {item.soldAt && (
                  <>
                    <span className="text-gray-300">·</span>
                    <span
                      title={`Sold ${new Date(item.soldAt).toLocaleString()}`}
                    >
                      sold {fmtShortDate(item.soldAt)}
                    </span>
                  </>
                )}
              </div>
              <ItemNotes raw={item.notes} onChangeAddress={onEditAddress || null} />
            </div>
            {priceStr && (
              <span className="text-sm text-gray-700 font-medium shrink-0 tabular-nums">
                {priceStr}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Per-box carrier control. The default is content-derived (any anthurium item
// makes it a UPS box); this lets the operator override that by hand. "Auto"
// clears the override and reverts to the derived default (shown inline).
// Persists via onSave({ carrierOverride }) — the same shipment_boxes row as
// packaging + notes — so the choice survives reloads and wins over the rule.
function CarrierToggle({ box, onSave, showToast }) {
  const [busy, setBusy] = useState(false);
  const override = (box.carrierOverride || '').toLowerCase();
  const auto = derivedBoxCarrier(box.items, box.stampedCarrier);
  const set = async (value) => {
    if (busy || value === (override || null)) return;
    setBusy(true);
    try { await onSave({ carrierOverride: value }); }
    catch (e) { showToast?.(e?.message || 'Save failed'); }
    finally { setBusy(false); }
  };
  const chip = (active, label, value, sub) => (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); set(value); }}
      disabled={busy}
      className={`px-2 py-1 rounded-md font-medium transition disabled:opacity-60 ${
        active ? 'bg-emerald-600 text-white' : 'text-gray-600 hover:bg-gray-100'
      }`}
    >
      {label}
      {sub && <span className={active ? 'text-emerald-100' : 'text-gray-400'}> · {sub}</span>}
    </button>
  );
  return (
    <div className="px-3 py-2 border-t border-gray-100 bg-gray-50/40 flex items-center gap-1.5 text-xs">
      <span className="text-gray-400 mr-0.5">Carrier</span>
      {chip(override === 'usps', 'USPS', 'usps')}
      {chip(override === 'ups', 'UPS', 'ups')}
      {chip(!override, 'Auto', null, !override ? auto.toUpperCase() : null)}
      {!!override && (
        <span className="text-gray-400 ml-1">overrides auto ({auto.toUpperCase()})</span>
      )}
    </div>
  );
}

function BoxRow({
  box, sale, shipment, salesById,
  onOpen, onBuyLabel, onSaveTracking, onMarkShipped, onUnship, onTogglePacked, dupeLots, findDupeLotBox, showToast,
  onSaveNote, onSetHold, onTogglePickup, onToggleInsulation, boxSizes, onSavePackaging, onBought, onCancelLabel,
  isAdmin, onEditItems, onEditAddress, onDeleteBox, onPrintSlip,
  isSelected, onToggleSelected, defaultExpanded,
}) {
  // Box-level pack rollup. unpackedSoldCount = items still 'sold' and
  // not yet packed; pack-all flips them all to packed in one click.
  // Hidden when every sold item is already packed (nothing to do).
  const unpackedSoldCount = box.items.filter(
    i => i.status === 'sold' && !i.packedAt,
  ).length;
  const shipped = box.items.filter(i =>
    ['shipped', 'delivered'].includes(i.status)
  ).length;
  const total = box.items.length;
  const partial = shipped > 0 && shipped < total;
  const allShipped = total > 0 && shipped === total;
  // Fully packed = there are sold items to pack and none are still unpacked.
  // Drives the big "Packed" badge + green card so the operator can see at a
  // glance which boxes are packed and ready to ship.
  const soldCount = box.items.filter(i => i.status === 'sold').length;
  const allPacked = soldCount > 0 && unpackedSoldCount === 0;

  // Collapsed by default to keep each buyer card calm; the parent expands
  // the operator's focused box (a scan/lookup target or the sole survivor
  // of a filter) via defaultExpanded. Clicking the header toggles either way.
  const [expanded, setExpanded] = useState(!!defaultExpanded);
  const [editingTracking, setEditingTracking] = useState(false);
  const [trackingDraft, setTrackingDraft] = useState('');
  const [busy, setBusy] = useState(false);
  // Honor a later expand request (e.g. the operator scans/searches down to
  // this box) by adjusting state during render when defaultExpanded flips on
  // — React's documented alternative to an effect-driven setState cascade.
  // A manual collapse of some other row is never stomped.
  const [prevDefaultExpanded, setPrevDefaultExpanded] = useState(defaultExpanded);
  if (defaultExpanded !== prevDefaultExpanded) {
    setPrevDefaultExpanded(defaultExpanded);
    if (defaultExpanded) setExpanded(true);
  }
  // The rendered open-state. A focused box (defaultExpanded — a scan/lookup
  // target or sole filter survivor) is always shown open, independent of the
  // local toggle, so scanning a box reliably opens its card. Once the focus
  // clears, the box follows the operator's own expand/collapse again.
  const isExpanded = expanded || !!defaultExpanded;
  const carrierKey = (box.carrier || 'usps').toLowerCase();
  const carrierLabel = carrierKey.toUpperCase();

  // Which UPS label kind this box buys with (explicit choice wins; a paid
  // Next Day upgrade sets the default). Shown as an inline picker on the
  // header row so the operator can set it per box without expanding, then
  // "Buy UPS labels" purchases each box accordingly.
  const paidNextDay = hasPaidNextDay(box.items);
  const upsServiceKey = boxUpsServiceKey(box.items, box.serviceKey);
  // The buyer paid for Next Day but this box would buy something else —
  // flag it in red, same drift warning the bulk modal shows. Either next-day
  // service (Saver or full Next Day Air) satisfies the upgrade.
  const upsServiceDrift = paidNextDay && !isNextDayService(upsServiceKey);
  const [savingSvc, setSavingSvc] = useState(false);
  const saveUpsService = async (serviceKey) => {
    if (savingSvc || !onSavePackaging) return;
    setSavingSvc(true);
    try { await onSavePackaging({ serviceKey }); }
    catch (e) { showToast?.(e?.message || 'Save failed'); }
    finally { setSavingSvc(false); }
  };

  // For shipped boxes there's nothing left to act on — hide the
  // primary action button and the inline tracking editor. Chevron
  // drill-in to the per-sale pane is still useful (label PDF download).
  const action = allShipped ? null : boxActionState(box, shipment);
  // A live (non-voided) bought label is always printable: the PDF is in
  // Storage (labelStoragePath) or inline as a fallback — getLabelUrl serves
  // either. Palmstreet tracking-only rows have no PDF unless one was
  // attached, so require labelStoragePath there.
  const liveShipment = shipment && !shipment.voidedAt ? shipment : null;
  const canPrintLabel = !!liveShipment && (
    !!liveShipment.labelStoragePath || liveShipment.carrierCode !== 'palmstreet'
  );
  // Any live label can be removed: ShipStation/Shippo labels void/refund;
  // Palmstreet USPS rows just clear so the box can switch carriers and re-buy.
  const canCancelLabel = !!liveShipment && !!onCancelLabel;
  const isManualLabel = !!liveShipment && liveShipment.carrierCode === 'palmstreet';
  // A shipping label has been added (imported / typed tracking) or bought for
  // this box — drives the at-a-glance "Label" color mark on the row so the
  // operator can see which open boxes are label-ready.
  const hasLabel = !!liveShipment && (
    !!liveShipment.trackingNumber || !!liveShipment.labelStoragePath || liveShipment.carrierCode !== 'palmstreet'
  );
  // One-week hold: an item-based hold ("1-week hold" line) counts a week from
  // that item's purchase date then becomes 'ready'; a manual button hold uses
  // its holdUntil timestamp. Not shown once the box has shipped.
  const hold = boxHoldState(box.items, box.holdUntil);
  const onHold = !allShipped && hold.state === 'holding';
  const holdReady = !allShipped && hold.state === 'ready';
  const holdDays = hold.state === 'holding' ? hold.daysLeft : null;
  // Local pickup (seller note / item says "pickup") — a separate "do not ship"
  // flag with its own violet colour.
  const isPickup = !allShipped && boxIsLocalPickup(box.note, box.items);

  const handleSaveTracking = async (e) => {
    e?.stopPropagation();
    const num = trackingDraft.trim();
    if (!num) return;
    setBusy(true);
    try {
      await onSaveTracking(num);
      setEditingTracking(false);
      setTrackingDraft('');
    } catch (err) {
      showToast?.(err?.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const handleMarkShipped = async (e) => {
    e?.stopPropagation();
    setBusy(true);
    try {
      await onMarkShipped();
    } catch (err) {
      showToast?.(err?.message || 'Ship failed');
    } finally {
      setBusy(false);
    }
  };

  const handlePackAll = async (e) => {
    e?.stopPropagation();
    if (!onTogglePacked) return;
    const targets = box.items.filter(i => i.status === 'sold' && !i.packedAt);
    // ONE confirm for the whole batch when any target's lineup number is
    // also open elsewhere — those #s need a wk-tag check before bulk-packing.
    const collided = [...new Set(
      targets.map(i => parseInt(i.lotNumber, 10)).filter(lot => dupeLots?.has(lot)),
    )];
    if (collided.length > 0 && !window.confirm(
      `#${collided.join(', #')} ${collided.length === 1 ? 'is' : 'are'} also on other unpacked plants. Check the wk tag on those labels — pack all anyway?`,
    )) return;
    setBusy(true);
    try {
      for (const it of targets) {
        await onTogglePacked(it.id, true);
      }
    } catch (err) {
      showToast?.(err?.message || 'Pack all failed');
    } finally {
      setBusy(false);
    }
  };

  const stop = (e) => e.stopPropagation();

  const statusClass = partial
    ? 'text-amber-700 font-medium'
    : allShipped
    ? 'text-emerald-700'
    : 'text-gray-600';

  // The single most-relevant action, surfaced on the collapsed row so the
  // common path (scan → ship) doesn't require expanding first. The full set
  // (edit, pack-all, print, cancel, open-in-sale) lives in the expanded
  // toolbar below.
  const primaryAction = !action ? null
    : action.kind === 'ship' ? (
      <button
        onClick={handleMarkShipped}
        disabled={busy}
        className="text-xs font-medium px-2.5 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800 disabled:opacity-60 flex items-center gap-1 shrink-0"
      >
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
        Mark shipped
      </button>
    ) : action.kind === 'buy-label' ? (
      <button
        onClick={(e) => { stop(e); onBuyLabel(); }}
        className="text-xs font-medium px-2.5 py-1 rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 active:bg-gray-100 flex items-center gap-1 shrink-0"
      >
        <Truck className="w-3 h-3" /> Buy label
      </button>
    ) : action.kind === 'enter-tracking' ? (
      <button
        onClick={(e) => { stop(e); setExpanded(true); setEditingTracking(true); }}
        className="text-xs font-medium px-2.5 py-1 rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 active:bg-gray-100 flex items-center gap-1 shrink-0"
      >
        <Pencil className="w-3 h-3" /> Enter tracking
      </button>
    ) : null;

  return (
    <div className={`rounded-lg border transition ${
      isSelected
        ? 'border-emerald-500 ring-1 ring-emerald-200'
        : onHold
        ? 'border-amber-300 bg-amber-50/60'
        : isPickup
        ? 'border-violet-300 bg-violet-50/60'
        : holdReady
        ? 'border-emerald-400 bg-emerald-50/40'
        : allPacked
        ? 'border-emerald-400 bg-emerald-50/40'
        : 'border-gray-100 hover:border-emerald-400'
    }`}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        className="w-full text-left px-3 py-2.5 cursor-pointer hover:bg-emerald-50/30 active:bg-emerald-50"
      >
        {/* Row 1 — identity. Optional select checkbox + carrier badge +
            box code on the left, opened-time + item-count + chevron on
            the right. Single line, never wraps; sale info moves to row
            2 below. */}
        <div className="flex items-center gap-2">
          {onToggleSelected && (
            <input
              type="checkbox"
              checked={!!isSelected}
              onClick={(e) => e.stopPropagation()}
              onChange={onToggleSelected}
              aria-label={isSelected ? 'Deselect box' : 'Select box'}
              className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 shrink-0 cursor-pointer"
            />
          )}
          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-gray-500 shrink-0">
            <span className={`w-1.5 h-1.5 rounded-full ${carrierKey === 'ups' ? 'bg-amber-500' : 'bg-blue-500'}`} />
            {carrierLabel}
          </span>
          {/* UPS label kind — settable right on the row; Buy UPS labels uses
              it per box. Hidden once a label exists (service is locked). */}
          {carrierKey === 'ups' && !allShipped && !hasLabel && onSavePackaging && (
            <select
              value={upsServiceKey}
              onClick={(e) => e.stopPropagation()}
              // Keyboard too: Enter/Space would bubble to the row's
              // role="button" handler, toggling expansion instead of
              // opening the dropdown.
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => { e.stopPropagation(); saveUpsService(e.target.value); }}
              disabled={savingSvc}
              aria-label="UPS label kind"
              title={upsServiceDrift
                ? 'Buyer paid for Next Day — this box is set to buy a different service'
                : paidNextDay
                ? 'Buyer paid for Next Day (preselected) — Buy UPS labels uses this'
                : 'UPS label kind for this box — Buy UPS labels uses this'}
              className={`text-[10px] font-medium rounded-md px-1 py-0.5 shrink-0 cursor-pointer border disabled:opacity-60 ${
                upsServiceDrift
                  ? 'border-red-300 bg-red-50 text-red-800'
                  : 'border-amber-200 bg-amber-50 text-amber-900'
              }`}
            >
              <option value="ups_2nd_day_air">2nd Day Air</option>
              <option value="ups_next_day_air_saver">Next Day Saver</option>
              <option value="ups_next_day_air">Next Day Air</option>
            </select>
          )}
          <BoxContentBadges box={box} />
          <span className="font-mono text-[11px] text-gray-600 shrink-0">
            {shortBoxCode(box.id)}
          </span>
          {/* Label-ready mark — a shipping label has been added/bought for
              this open box. Hidden once shipped (the shipped status says it). */}
          {hasLabel && !allShipped && (
            <span
              title="Shipping label added or bought"
              className="inline-flex items-center gap-1 text-[10px] font-medium text-indigo-700 bg-indigo-100 ring-1 ring-indigo-200 px-1.5 py-0.5 rounded shrink-0"
            >
              <Tag className="w-3 h-3" /> Label
            </span>
          )}
          {box.openedAt && (
            <span
              className="text-[11px] text-gray-400 shrink-0"
              title={`Opened ${new Date(box.openedAt).toLocaleString()}`}
            >
              · {fmtShortDate(box.openedAt)}
            </span>
          )}
          <div className="flex-1" />
          {/* One-week hold: amber countdown while holding, then a filled
              "Time to ship" call-to-action once the week is up. */}
          {onHold && (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-800 bg-amber-100 ring-1 ring-amber-300 px-2 py-0.5 rounded-lg shrink-0" title="On hold — do not ship yet">
              <Clock className="w-3.5 h-3.5" /> Hold{holdDays ? ` · ${holdDays}d` : ''}
            </span>
          )}
          {isPickup && (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-violet-800 bg-violet-100 ring-1 ring-violet-300 px-2 py-0.5 rounded-lg shrink-0" title="Local pickup — do not ship">
              <Package className="w-3.5 h-3.5" /> Pickup
            </span>
          )}
          {holdReady && (
            <span className="inline-flex items-center gap-1 text-xs font-bold text-white bg-emerald-600 px-2 py-0.5 rounded-lg shrink-0" title="Hold elapsed — ready to ship">
              <Truck className="w-3.5 h-3.5" /> Time to ship
            </span>
          )}
          {allPacked && (
            <span className="inline-flex items-center gap-1 text-sm font-bold text-emerald-700 bg-emerald-100 px-2.5 py-1 rounded-lg shrink-0">
              <CheckCircle2 className="w-5 h-5" /> Packed
            </span>
          )}
          {/* Item count — big number so it's readable at a glance. */}
          <span className={`shrink-0 leading-none ${statusClass}`}>
            {allShipped ? (
              <span className="text-sm font-medium">{total} shipped</span>
            ) : partial ? (
              <span className="text-sm font-medium">{shipped}/{total} shipped</span>
            ) : (
              <span className="inline-flex items-baseline gap-1">
                <span className="text-xl font-bold tabular-nums">{total}</span>
                <span className="text-[11px]">{total === 1 ? 'item' : 'items'}</span>
              </span>
            )}
          </span>
          {!isExpanded && primaryAction}
          <ChevronRight className={`w-4 h-4 text-gray-300 shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
        </div>

        {/* Row 2 — sale info. Plenty of room to display the full sale
            name + date on its own line; truncates on overflow. */}
        {(sale?.name || sale?.date) && (
          <div className="mt-0.5 flex items-baseline gap-2 text-sm">
            <span className="text-gray-900 truncate">{sale?.name || '(unknown sale)'}</span>
            {sale?.date && <span className="text-xs text-gray-400 shrink-0">{sale.date}</span>}
          </div>
        )}

        {/* Shipping P/L for shipped boxes — what the buyer paid to ship vs.
            what the label cost, so a loss is visible right on the row. */}
        {allShipped &&
          (box.shippingFeeCollected > 0 ||
            (liveShipment && !liveShipment.isTestLabel && liveShipment.labelCost != null)) && (
          <div className="mt-1">
            <ShippingMarginNote
              feeCollected={box.shippingFeeCollected}
              cost={liveShipment && !liveShipment.isTestLabel && liveShipment.labelCost != null
                ? parseFloat(liveShipment.labelCost)
                : null}
              className="text-[11px]"
            />
          </div>
        )}

      </div>

      {isExpanded && (
        <>
          {/* Action toolbar — the full set for the focused box. The collapsed
              row carries only the primary action; everything else (edit,
              pack-all, print, cancel, open-in-sale) lives here so it's only
              on screen for the one box the operator opened. */}
          <div className="px-3 py-2 border-t border-gray-100 flex items-center gap-1.5 flex-wrap">
            {action && isAdmin && onEditItems && (
              <button
                onClick={(e) => { stop(e); onEditItems(); }}
                title="Add or remove items in this box"
                aria-label="Edit items"
                className="text-xs font-medium px-2 py-1 rounded-md border border-gray-300 text-gray-600 bg-white hover:bg-gray-50 active:bg-gray-100 flex items-center gap-1"
              >
                <Pencil className="w-3 h-3" /> Edit
              </button>
            )}
            {action && onEditAddress && (
              <button
                onClick={(e) => { stop(e); onEditAddress(); }}
                title="Edit the recipient name + shipping address for this box"
                aria-label="Edit address"
                className="text-xs font-medium px-2 py-1 rounded-md border border-gray-300 text-gray-600 bg-white hover:bg-gray-50 active:bg-gray-100 flex items-center gap-1"
              >
                <MapPin className="w-3 h-3" /> Address
              </button>
            )}
            {/* One-week hold toggle. Held boxes turn amber with a countdown;
                after a week they flip to "Time to ship". Keyed on the
                EFFECTIVE hold state, not just holdUntil — an item-based hold
                (the "1-week hold" line the buyer bought) is cleared via
                release (a past holdUntil that outranks the item), since the
                line itself is sale data and stays. */}
            {action && onSetHold && (
              onHold ? (
                <button
                  onClick={(e) => {
                    stop(e);
                    // release whenever a hold ITEM exists — clearing to null
                    // would just let it resurface, holdUntil or not.
                    onSetHold(false, boxHasHoldItem(box.items));
                  }}
                  title="Clear the one-week hold — the box becomes OK to ship now"
                  className="text-xs font-medium px-2 py-1 rounded-md border border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100 active:bg-amber-200 flex items-center gap-1"
                >
                  <Clock className="w-3 h-3" /> Clear hold
                </button>
              ) : (
                <button
                  onClick={(e) => { stop(e); onSetHold(true); }}
                  title="Hold this box — it skips all of next week and ships when the week after next begins"
                  className="text-xs font-medium px-2 py-1 rounded-md border border-gray-300 text-gray-600 bg-white hover:bg-amber-50 hover:text-amber-700 hover:border-amber-300 active:bg-amber-100 flex items-center gap-1"
                >
                  <Clock className="w-3 h-3" /> Hold 1 week
                </button>
              )
            )}
            {/* Local-pickup toggle. Pickup boxes turn violet, never ship, and
                are excluded from bulk buys; the flag lives in the box note
                ("Local pickup"), which the packer's banner reads too. An
                item-driven flag (a "local pickup" line the buyer bought)
                can't be cleared from here — the item itself says pickup. */}
            {action && onTogglePickup && (
              isPickup ? (
                (() => {
                  const fromItems = boxIsLocalPickup(null, box.items);
                  const fromNote = isLocalPickupText(box.note);
                  return (
                    <button
                      onClick={(e) => { stop(e); if (!fromItems) onTogglePickup(false); }}
                      disabled={fromItems}
                      title={fromItems
                        ? (fromNote
                          ? 'Pickup is flagged by an item AND the note — remove the item, then clear again'
                          : 'Pickup is flagged by an item in this box — edit or remove that item to clear it')
                        : 'Clear the local-pickup flag — the box ships normally again'}
                      className="text-xs font-medium px-2 py-1 rounded-md border border-violet-300 text-violet-700 bg-violet-50 hover:bg-violet-100 active:bg-violet-200 flex items-center gap-1 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      <Package className="w-3 h-3" /> Clear pickup
                    </button>
                  );
                })()
              ) : (
                <button
                  onClick={(e) => { stop(e); onTogglePickup(true); }}
                  title="Mark for local pickup — the buyer collects this box; it must not ship"
                  className="text-xs font-medium px-2 py-1 rounded-md border border-gray-300 text-gray-600 bg-white hover:bg-violet-50 hover:text-violet-700 hover:border-violet-300 active:bg-violet-100 flex items-center gap-1"
                >
                  <Package className="w-3 h-3" /> Local pickup
                </button>
              )
            )}
            {/* Extra-insulation mark — chip turns it on; the sky strip below
                (next to the note) carries the Clear once set. */}
            {action && onToggleInsulation && (
              <InsulationChip on={!!box.extraInsulation} onToggle={onToggleInsulation} stop={stop} />
            )}
            {action && isAdmin && onDeleteBox && (
              <button
                onClick={(e) => { stop(e); onDeleteBox(); }}
                title="Delete this box (reverts matched items, purges placeholders)"
                aria-label="Delete box"
                className="text-xs font-medium px-2 py-1 rounded-md border border-red-200 text-red-700 bg-white hover:bg-red-50 active:bg-red-100 flex items-center gap-1"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
            {action && onTogglePacked && unpackedSoldCount > 0 && (
              <button
                onClick={handlePackAll}
                disabled={busy}
                title={`Mark all ${unpackedSoldCount} unpacked item${unpackedSoldCount === 1 ? '' : 's'} as packed`}
                className="text-xs font-medium px-2.5 py-1 rounded-md border border-emerald-300 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 active:bg-emerald-200 disabled:opacity-60 flex items-center gap-1"
              >
                <Check className="w-3 h-3" /> Pack all
                <span className="text-emerald-600">· {unpackedSoldCount}</span>
              </button>
            )}
            {action?.kind === 'buy-label' && (
              <button
                onClick={(e) => { stop(e); onBuyLabel(); }}
                className="text-xs font-medium px-2.5 py-1 rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 active:bg-gray-100 flex items-center gap-1"
              >
                <Truck className="w-3 h-3" /> Buy label
              </button>
            )}
            {action?.kind === 'enter-tracking' && !editingTracking && (
              <button
                onClick={(e) => { stop(e); setEditingTracking(true); }}
                className="text-xs font-medium px-2.5 py-1 rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 active:bg-gray-100 flex items-center gap-1"
              >
                <Pencil className="w-3 h-3" /> Enter tracking
              </button>
            )}
            {/* Print the saved shipping label (ShipStation or Shippo). */}
            {canPrintLabel && (
              <button
                onClick={(e) => { stop(e); openLabelPdf(liveShipment, 'label', showToast); }}
                title="Open the saved shipping label PDF to print"
                className="text-xs font-medium px-2.5 py-1 rounded-md border border-emerald-300 text-emerald-700 bg-white hover:bg-emerald-50 active:bg-emerald-100 flex items-center gap-1"
              >
                <Printer className="w-3 h-3" /> Print label
              </button>
            )}
            {/* Remove the label so the quote panel + carrier switch return.
                ShipStation/Shippo labels void/refund; USPS (Palmstreet) rows
                just clear so the box can be re-bought under a new carrier. */}
            {canCancelLabel && (
              <button
                onClick={(e) => { stop(e); onCancelLabel(); }}
                title={isManualLabel
                  ? 'Disable this USPS label so you can switch carriers and buy a new one'
                  : 'Cancel this label (void / refund) and re-enable rate quoting'}
                className="text-xs font-medium px-2.5 py-1 rounded-md border border-gray-300 text-gray-600 bg-white hover:bg-red-50 hover:text-red-600 hover:border-red-200 active:bg-red-100 flex items-center gap-1"
              >
                <RotateCcw className="w-3 h-3" /> {isManualLabel ? 'Disable label' : 'Cancel label'}
              </button>
            )}
            {action && onPrintSlip && (
              <button
                onClick={(e) => { stop(e); onPrintSlip(); }}
                title="Print the customer-facing shipping slip"
                className="text-xs font-medium px-2.5 py-1 rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 active:bg-gray-100 flex items-center gap-1"
              >
                <Receipt className="w-3 h-3" /> Print slip
              </button>
            )}
            {onOpen && (
              <button
                onClick={(e) => { stop(e); onOpen(); }}
                title="Open this box in its full sale view"
                className="text-xs font-medium px-2 py-1 rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-700 flex items-center gap-1"
              >
                Open in sale <ChevronRight className="w-3 h-3" />
              </button>
            )}
            {action && (
              <button
                onClick={handleMarkShipped}
                disabled={busy}
                className="ml-auto text-xs font-medium px-2.5 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800 disabled:opacity-60 flex items-center gap-1"
              >
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                Mark shipped
              </button>
            )}
            {/* Shipped boxes: undo the ship — moves the box back to Ready
                (reverts items to 'sold', keeps tracking + label). */}
            {allShipped && onUnship && (
              <button
                onClick={(e) => { stop(e); onUnship(); }}
                title="Move this box back to Ready (reverts items to sold; tracking and label stay)"
                className="ml-auto text-xs font-medium px-2.5 py-1 rounded-md border border-amber-300 text-amber-700 bg-white hover:bg-amber-50 active:bg-amber-100 flex items-center gap-1"
              >
                <RotateCcw className="w-3 h-3" /> Mark unshipped
              </button>
            )}
          </div>
          <AddressCopyStrip box={box} showToast={showToast} />
          <BoxItemsList box={box} salesById={salesById} onTogglePacked={onTogglePacked} dupeLots={dupeLots} findDupeLotBox={findDupeLotBox} onEditAddress={onEditAddress} />
          <LabelInfoRow shipment={shipment} feeCollected={box.shippingFeeCollected} showToast={showToast} />
          {/* Carrier — defaults from contents (anthurium → UPS); operator can
              override here. Hidden once a label is bought (carrier is locked). */}
          {onSavePackaging && !allShipped && !liveShipment && (
            <CarrierToggle box={box} onSave={onSavePackaging} showToast={showToast} />
          )}
          {/* Quote panel — hidden while a label is active; reappears once the
              label is cancelled (liveShipment goes null). */}
          {onSavePackaging && !allShipped && !liveShipment && (
            <BoxPackagingPanel
              box={box}
              boxSizes={boxSizes}
              onSavePackaging={onSavePackaging}
              showToast={showToast}
              shipment={shipment}
              onBought={onBought}
            />
          )}
          <InsulationStrip
            on={!!box.extraInsulation}
            onToggle={onToggleInsulation}
            allShipped={allShipped}
            compact
          />
          {onSaveNote && (
            <BoxNotePanel
              note={box.note}
              onSave={onSaveNote}
              allShipped={allShipped}
              showToast={showToast}
              compact
            />
          )}
        </>
      )}

      {/* Inline tracking-number entry. Click "Enter tracking" → row expands
          with a small form; Save fires the API and refreshes shipments,
          which transitions this row to "Mark shipped". */}
      {editingTracking && (
        <div
          onClick={stop}
          className="px-3 pb-3 pt-1 flex items-center gap-2 border-t border-gray-100 bg-gray-50/60"
        >
          <input
            type="text"
            autoFocus
            value={trackingDraft}
            onChange={(e) => setTrackingDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveTracking(e);
              if (e.key === 'Escape') { setEditingTracking(false); setTrackingDraft(''); }
            }}
            placeholder="USPS tracking number"
            className="flex-1 text-sm px-2 py-1 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
          />
          <button
            onClick={handleSaveTracking}
            disabled={busy || !trackingDraft.trim()}
            className="text-xs font-medium px-2.5 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60 flex items-center gap-1"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
            Save
          </button>
          <button
            onClick={(e) => { stop(e); setEditingTracking(false); setTrackingDraft(''); }}
            className="text-xs font-medium px-2 py-1 rounded-md text-gray-600 hover:bg-gray-200 flex items-center gap-1"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}
    </div>
  );
}

// Purchased-label strip: shows once a box has a live (non-voided) label.
// The tracking number copies on click; "Print label" opens the saved PDF
// in a new tab. Renders in the box tab (BoxRow) so the operator never has
// to drill into the sale to grab tracking or reprint.
function LabelInfoRow({ shipment, feeCollected, showToast }) {
  const live = shipment && !shipment.voidedAt ? shipment : null;
  if (!live || (!live.trackingNumber && !live.labelStoragePath)) return null;
  return (
    <div className="px-3 py-2 bg-emerald-50/50 border-t border-emerald-100 flex items-center gap-2 flex-wrap text-xs">
      {live.trackingNumber ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); copyText(live.trackingNumber, showToast); }}
          title="Copy tracking number"
          className="flex items-center gap-1.5 text-gray-700 hover:text-emerald-700 group"
        >
          <Truck className="w-3.5 h-3.5 text-gray-500 group-hover:text-emerald-600" />
          <span className="font-mono">{live.trackingNumber}</span>
          <Copy className="w-3 h-3 text-gray-400 group-hover:text-emerald-600" />
        </button>
      ) : (
        <span className="flex items-center gap-1.5 text-gray-500">
          <Truck className="w-3.5 h-3.5 text-gray-400" /> <span className="font-mono">(no tracking)</span>
        </span>
      )}
      {live.serviceCode && <span className="text-gray-400">{live.serviceCode}</span>}
      {live.isTestLabel && (
        <span className="text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded text-[10px]">test</span>
      )}
      <ShippingMarginNote
        feeCollected={feeCollected}
        cost={live.isTestLabel || live.labelCost == null ? null : parseFloat(live.labelCost)}
      />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Per-sale packing pane: shows the upload prompt OR the assembled boxes
// (derived from items once the upload has been applied).
// ───────────────────────────────────────────────────────────────────────────

function SalePackingPane({ sale, inventoryItems, onBack, onShipBox, onPrintItemLabels, setConfirmDialog }) {
  const saleItems = useMemo(
    () => inventoryItems.filter(i => i.saleId === sale.id),
    [inventoryItems, sale.id]
  );

  // If any item has a shipmentBoxId, the upload was applied (in the Sales
  // tab, Step 3). Otherwise direct the user back to do it.
  const hasApplied = saleItems.some(i => i.shipmentBoxId);

  if (!hasApplied) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="p-2 -ml-2 text-gray-600 hover:bg-gray-100 active:bg-gray-200 rounded-lg" aria-label="Back">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{sale.name}</h2>
            <p className="text-xs text-gray-500">{saleItems.length} lineup items · {sale.date}</p>
          </div>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-center">
          <AlertCircle className="w-8 h-8 text-amber-500 mx-auto mb-2" />
          <div className="text-sm font-medium text-gray-900">No boxes to pack yet</div>
          <p className="text-xs text-gray-600 mt-1">
            Run "Validate Sales" from the Sale tab (step 3) to mark items
            sold and create the shipping boxes.
          </p>
        </div>
      </div>
    );
  }
  return (
    <PackingBoxesPane
      sale={sale}
      saleItems={saleItems}
      onBack={onBack}
      onShipBox={onShipBox}
      onPrintItemLabels={onPrintItemLabels}
      setConfirmDialog={setConfirmDialog}
    />
  );
}


// ───── Boxes phase (after apply) ───────────────────────────────────────────

function PackingBoxesPane({ sale, saleItems, onBack, onShipBox, onPrintItemLabels, setConfirmDialog }) {
  // Shipments (= purchased labels) for this sale, keyed by shipmentBoxId.
  // Loaded once on mount and refreshed after a Buy/Void completes.
  const [shipmentsByBox, setShipmentsByBox] = useState({});
  const [boxNotesByBox, setBoxNotesByBox] = useState({});
  const [boxSizes, setBoxSizes] = useState([]);
  const [buyingFor, setBuyingFor] = useState(null);
  const [actionToast, setActionToast] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const [list, notes, settings] = await Promise.all([
          api.getShipments(sale.id),
          api.getBoxNotes(sale.id),
          api.getSettings('shipping').catch(() => null),
        ]);
        setShipmentsByBox(Object.fromEntries((list || []).map(s => [s.id, s])));
        setBoxNotesByBox(notes || {});
        setBoxSizes(Array.isArray(settings?.data?.boxSizes) ? settings.data.boxSizes : []);
      } catch {
        // Silent — shipments / notes simply won't show until refresh.
      }
    })();
  }, [sale.id]);

  const refreshShipments = async () => {
    try {
      const [list, notes] = await Promise.all([
        api.getShipments(sale.id),
        api.getBoxNotes(sale.id),
      ]);
      setShipmentsByBox(Object.fromEntries((list || []).map(s => [s.id, s])));
      setBoxNotesByBox(notes || {});
    } catch {/* no-op */}
  };

  const showToast = (msg) => {
    setActionToast(msg);
    setTimeout(() => setActionToast(null), 2500);
  };

  // Group sold items by shipmentBoxId. Each group is a "box". The effective
  // carrier is resolved from contents (anthurium → UPS) + any per-box override,
  // falling back to the value stamped on items at apply time.
  const boxes = useMemo(() => {
    const map = new Map();
    for (const item of saleItems) {
      if (!item.shipmentBoxId) continue;
      if (!map.has(item.shipmentBoxId)) {
        map.set(item.shipmentBoxId, {
          id: item.shipmentBoxId,
          recipientName: item.buyer || '(unknown)',
          username: item.buyerUsername || '',
          address: item.buyerAddress || {},
          stampedCarrier: item.shipmentCarrier || 'usps',
          carrier: item.shipmentCarrier || 'usps',
          items: [],
          shippingFeeCollected: 0,
        });
      }
      const b = map.get(item.shipmentBoxId);
      b.items.push(item);
      b.shippingFeeCollected += parseFloat(item.orderShippingFee) || 0;
    }
    for (const b of map.values()) {
      b.carrierOverride = boxNotesByBox?.[b.id]?.carrierOverride ?? null;
      b.carrier = resolveBoxCarrier(b.items, b.carrierOverride, b.stampedCarrier);
    }
    return [...map.values()].sort((a, b) =>
      (a.recipientName || '').localeCompare(b.recipientName || '')
    );
  }, [saleItems, boxNotesByBox]);

  // Carrier filter: 'all' | 'usps' | 'ups'. Default to 'all' so opening
  // the pane still shows everything, but counts in the tab labels make
  // the split obvious.
  const [carrierFilter, setCarrierFilter] = useState('all');
  const uspsBoxes = useMemo(() => boxes.filter(b => b.carrier === 'usps'), [boxes]);
  const upsBoxes = useMemo(() => boxes.filter(b => b.carrier === 'ups'), [boxes]);
  const visibleBoxes = carrierFilter === 'usps' ? uspsBoxes
    : carrierFilter === 'ups' ? upsBoxes
    : boxes;

  const totalBoxes = boxes.length;
  const shippedBoxes = boxes.filter(b =>
    b.items.every(i => ['shipped', 'delivered'].includes(i.status))
  ).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="p-2 -ml-2 text-gray-600 hover:bg-gray-100 active:bg-gray-200 rounded-lg" aria-label="Back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-gray-900">{sale.name}</h2>
          <p className="text-xs text-gray-500">
            {shippedBoxes}/{totalBoxes} boxes shipped · {sale.date}
          </p>
        </div>
        <span className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded">
          Orders applied
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <SummaryStat label="Total boxes" value={totalBoxes} tone="blue" />
        <SummaryStat
          label="Shipped"
          value={shippedBoxes}
          tone={shippedBoxes === totalBoxes && totalBoxes > 0 ? 'emerald' : 'gray'}
        />
        <SummaryStat label="Outstanding" value={totalBoxes - shippedBoxes} tone="amber" />
      </div>

      {/* Carrier tabs — splits the box list into USPS vs UPS so the user
          can buy labels in batches per carrier. */}
      <div className="bg-white rounded-xl border border-gray-200 px-1 py-1 flex gap-0.5 overflow-x-auto">
        {[
          { value: 'all', label: 'All', count: totalBoxes },
          { value: 'usps', label: 'USPS', count: uspsBoxes.length },
          { value: 'ups', label: 'UPS', count: upsBoxes.length },
        ].map(tab => {
          const active = carrierFilter === tab.value;
          return (
            <button
              key={tab.value}
              onClick={() => setCarrierFilter(tab.value)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg whitespace-nowrap transition ${
                active ? 'bg-emerald-600 text-white font-medium' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              {tab.label}
              <span className={`text-xs ${active ? 'text-emerald-100' : 'text-gray-400'}`}>
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>

      <div className="space-y-3">
        {visibleBoxes.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-xl p-8 text-center text-sm text-gray-500">
            No {carrierFilter === 'all' ? '' : carrierFilter.toUpperCase() + ' '}boxes.
          </div>
        ) : visibleBoxes.map(box => (
          <ShipBoxCard
            key={box.id}
            box={{ ...box, ...(boxNotesByBox[box.id] || {}) }}
            shipment={shipmentsByBox[box.id]}
            showToast={showToast}
            onPrintItemLabels={onPrintItemLabels}
            boxSizes={boxSizes}
            onBought={refreshShipments}
            onSavePackaging={async (patch) => {
              const saved = await api.setBoxPackaging({ shipmentBoxId: box.id, ...patch });
              // Merge over the previous entry — a packaging save must not
              // wipe fields it doesn't return (holdUntil, extraInsulation).
              setBoxNotesByBox(prev => ({
                ...prev,
                [box.id]: {
                  ...(prev[box.id] || {}),
                  note: saved.note,
                  boxSizeId: saved.boxSizeId ?? null,
                  weightOz: saved.weightOz ?? null,
                  serviceKey: saved.serviceKey ?? null,
                  carrierOverride: saved.carrierOverride ?? null,
                  updatedAt: saved.updatedAt,
                  updatedBy: saved.updatedBy,
                },
              }));
            }}
            onToggleInsulation={async (on) => {
              const saved = await api.setBoxInsulation({ shipmentBoxId: box.id, extraInsulation: on });
              setBoxNotesByBox(prev => ({
                ...prev,
                [box.id]: { ...(prev[box.id] || {}), extraInsulation: saved.extraInsulation ?? null },
              }));
              showToast(on ? '❄ Marked: extra insulation' : 'Insulation mark cleared');
            }}
            onSaveNote={async (note) => {
              const saved = await api.setBoxNote({ shipmentBoxId: box.id, note });
              setBoxNotesByBox(prev => ({
                ...prev,
                [box.id]: {
                  ...(prev[box.id] || {}),
                  note: saved.note,
                  updatedAt: saved.updatedAt,
                  updatedBy: saved.updatedBy,
                },
              }));
            }}
            onShip={() => onShipBox(box.items.map(i => i.id))}
            onBuyLabel={() => setBuyingFor(box)}
            onVoidLabel={() => {
              setConfirmDialog?.({
                title: `Void label for ${box.recipientName}?`,
                message: `ShipStation may decline if it's already been used or scanned.`,
                confirmLabel: 'Void label',
                danger: true,
                onConfirm: async () => {
                  try {
                    await api.voidLabel(box.id);
                    showToast('Label voided');
                    refreshShipments();
                  } catch (e) {
                    showToast(e.message || 'Void failed');
                  }
                },
              });
            }}
            onSaveTracking={async (b, trackingNumber) => {
              await api.recordPalmstreetTracking(b.id, trackingNumber);
              showToast('Tracking saved');
              refreshShipments();
            }}
            onClearTracking={() => {
              setConfirmDialog?.({
                title: `Clear tracking for ${box.recipientName}?`,
                message: 'Removes the manual USPS tracking entry. The Palmstreet label itself is not affected.',
                confirmLabel: 'Clear',
                danger: true,
                onConfirm: async () => {
                  try {
                    await api.clearPalmstreetTracking(box.id);
                    showToast('Tracking cleared');
                    refreshShipments();
                  } catch (e) {
                    showToast(e.message || 'Clear failed');
                  }
                },
              });
            }}
          />
        ))}
      </div>

      {buyingFor && (
        <BuyLabelModal
          box={buyingFor}
          onClose={() => setBuyingFor(null)}
          onPurchased={() => refreshShipments()}
          showToast={showToast}
        />
      )}

      {actionToast && (
        <div className="fixed bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-sm px-4 py-2 rounded-lg shadow-lg z-50">
          {actionToast}
        </div>
      )}
    </div>
  );
}

// Desktop counterpart to CameraScanner. Autofocused text input that
// accepts a USB-barcode-scanner's keystroke burst or a human typing the
// SKU / box code. Enter submits, Esc cancels. The dialog stays mounted
// while the operator types so a hardware scanner's CR-suffix triggers
// onSubmit cleanly — same as a manual Enter press.
function ScanTextInputDialog({ mode, onSubmit, onClose }) {
  const [value, setValue] = useState('');
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const submit = (e) => {
    e?.preventDefault();
    const v = value.trim();
    if (!v) return;
    onSubmit(v);
  };
  const isBox = mode === 'box';
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-start sm:items-center justify-center p-4 pt-24 sm:pt-4" onClick={onClose}>
      <div className="bg-white w-full max-w-md rounded-2xl shadow-xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="font-semibold text-gray-900 text-base flex items-center gap-2">
              <ScanLine className="w-5 h-5 text-emerald-600" />
              {isBox ? 'Scan or type a box code' : 'Scan or type an item SKU'}
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {isBox
                ? 'B-XXXXXX format. Scanner input fires Enter automatically.'
                : 'e.g. JWL-1574. Scanner input fires Enter automatically.'}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 -mr-1 text-gray-500 hover:bg-gray-100 rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={submit}>
          <input
            ref={ref}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={isBox ? 'B-XXXXXX' : 'JWL-XXXX'}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
            className="w-full px-4 py-3 text-lg font-mono uppercase border-2 border-emerald-300 bg-emerald-50/40 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
          />
          <div className="flex items-center justify-end gap-2 mt-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!value.trim()}
              className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white rounded-lg disabled:bg-gray-300"
            >
              {isBox ? 'Find box' : 'Find item'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

