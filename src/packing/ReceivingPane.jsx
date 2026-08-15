import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PackageOpen, Printer, Check, Loader2, ChevronLeft, RotateCcw,
  AlertTriangle, Plus, Minus,
} from 'lucide-react';
import { api } from '../api.js';
import { printItemLabels } from './packerPrint.js';

// New-order receiving at the packing table. The ADMIN uploads/manages the
// wholesale list on the website's Wholesale tab; this pane just shows the
// packer what's coming — each order's species lines — so they can label +
// count the physical shipment:
//
//   For each species: count the plants on the bench, set the number (it
//   defaults to what's still expected), hit "Receive & print" — the server
//   mints one inventory item per plant (wholesale cost + shipping share,
//   via the existing receive-line action) and their QR labels print. One
//   label per plant is the count check: leftover unlabeled plants are
//   extras (count again with the stepper — extras go straight into
//   inventory and print like the rest), missing labels mean the line stays
//   visibly short. When every line reaches its ordered quantity the PO
//   flips to received server-side.
//
// The receive happens BEFORE the print so a failed print never loses the
// receive — the last-printed batch is kept per line for reprints.

const dollars = (n) => (Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2)}` : '');

// One receive/print action caps here — mirrored server-side by RECEIVE_MAX
// in api/purchase-orders.js, so the limit holds even off this UI.
const MAX_PER_RECEIVE = 500;

export function ReceivingPane({ printDest, showToast, onClose, onChanged }) {
  const [pos, setPos] = useState(null);          // ordered POs (null = loading)
  const [activePoId, setActivePoId] = useState(null);
  const [detail, setDetail] = useState(null);    // { po, lines } for activePoId
  // Catalog for the line renderer's species/variety names.
  const [catalog, setCatalog] = useState({ species: [], varieties: [] });
  const speciesById = useMemo(() => new Map(catalog.species.map(s => [s.id, s])), [catalog]);
  const varietyById = useMemo(() => new Map(catalog.varieties.map(v => [v.id, v])), [catalog]);
  const [err, setErr] = useState('');
  const [countByLine, setCountByLine] = useState({});
  const [busyLine, setBusyLine] = useState(null);
  const [lastBatch, setLastBatch] = useState({}); // lineId → just-created items (reprint)
  // Mirrors busyLine for the poll tick — a background refresh mid-receive
  // would clobber optimistic UI and confuse the count steppers.
  const busyRef = useRef(null);
  useEffect(() => { busyRef.current = busyLine; }, [busyLine]);

  const refreshDetail = useCallback(async (poId) => {
    if (!poId) return;
    const { purchaseOrder, lines } = await api.getPurchaseOrder(poId);
    setDetail({ po: purchaseOrder, lines });
  }, []);

  // List + open-PO poll. 15s keeps a second device (or the admin marking a
  // new PO ordered) in sync without hammering the two-table endpoint. The
  // list tick pauses while a PO is open (openPoRef) — the detail poll is
  // the active one there, and the list is refetched on back-navigation.
  const openPoRef = useRef(null);
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      // Hidden-tab guard matches the packer's 8s items poll convention.
      if (busyRef.current || openPoRef.current || document.visibilityState === 'hidden') return;
      try {
        const fresh = await api.listPurchaseOrders('ordered');
        if (cancelled) return;
        setPos(fresh);
        setErr('');
      } catch (e) {
        if (!cancelled) setErr(e.message || 'Load failed');
      }
    };
    tick();
    const id = setInterval(tick, 15000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // One ordered PO is the common case — open it directly instead of showing
  // a one-item list. Derived (not synced state) so no effect is needed;
  // "back" from a single-PO view closes the whole pane instead.
  const effectivePoId = activePoId ?? (pos && pos.length === 1 ? pos[0].id : null);
  // Stale-detail guard: after switching POs, the previous order's lines must
  // not render under the new header while the fresh fetch is in flight.
  const activeDetail = detail && detail.po?.id === effectivePoId ? detail : null;
  useEffect(() => { openPoRef.current = effectivePoId; }, [effectivePoId]);

  // Species / variety names for the lines (the packer view doesn't carry
  // the catalog otherwise). Refetched per opened PO, not just per mount —
  // the admin's spreadsheet import CREATES species, and an order can arrive
  // on the pane's poll while it's already open; a stale map would render
  // every new-species line as "Unknown species" at the bench.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [species, varieties] = await Promise.all([api.getSpecies(), api.getVarieties()]);
        if (cancelled) return;
        setCatalog({ species: species || [], varieties: varieties || [] });
      } catch { /* names degrade to "Unknown species"; lines still work */ }
    })();
    return () => { cancelled = true; };
  }, [effectivePoId]);

  useEffect(() => {
    if (!effectivePoId) return undefined;
    let cancelled = false;
    const tick = async () => {
      if (busyRef.current || document.visibilityState === 'hidden') return;
      try {
        const { purchaseOrder, lines } = await api.getPurchaseOrder(effectivePoId);
        if (!cancelled) setDetail({ po: purchaseOrder, lines });
      } catch (e) {
        if (!cancelled) showToast?.(e.message || 'Could not load the order', 3000);
      }
    };
    tick();
    const id = setInterval(tick, 15000);
    return () => { cancelled = true; clearInterval(id); };
    // showToast is a stable-enough callback from PackerView; re-subscribing
    // per render would tear down the poll timer for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectivePoId]);

  const lineName = (line) => {
    const sp = speciesById.get(line.speciesId);
    const v = sp ? varietyById.get(sp.varietyId) : null;
    return { epithet: sp?.epithet || 'Unknown species', variety: v?.name || '' };
  };

  const totals = useMemo(() => {
    const lines = activeDetail?.lines || [];
    return {
      ordered: lines.reduce((s, l) => s + l.quantityOrdered, 0),
      received: lines.reduce((s, l) => s + l.quantityReceived, 0),
    };
  }, [activeDetail]);

  const receiveAndPrint = async (line, n) => {
    if (busyLine || !activeDetail) return;
    if (!Number.isFinite(n) || n < 1) {
      showToast?.('Set how many plants you counted first', 2500);
      return;
    }
    if (n > MAX_PER_RECEIVE) {
      showToast?.(`That count looks too high — max ${MAX_PER_RECEIVE} per print`, 3000);
      return;
    }
    // Ref set synchronously too: state flushes after paint, and a fast
    // double-tap on iPad can beat it.
    busyRef.current = line.id;
    setBusyLine(line.id);
    // Pin the PO. The single-PO id is otherwise DERIVED from the 'ordered'
    // list, which the final receive empties — the pane would snap to "no
    // incoming orders" mid-workflow and take the Reprint button with it.
    if (!activePoId) setActivePoId(activeDetail.po.id);
    const poId = activeDetail.po.id;
    let created;
    let flipped = false;
    try {
      const res = await api.receivePurchaseOrderLine({
        id: poId, lineId: line.id, quantityReceived: n,
      });
      created = res.createdItems || [];
      flipped = !!res.poFlippedToReceived;
    } catch (e) {
      // Only the receive call sits in this try — a failed REFRESH after a
      // successful receive must never read as "receive failed". And a
      // network error can lose a success response, so never claim nothing
      // was added; the refreshed counts are the truth.
      showToast?.(e.message || 'Receive failed — the counts above show what actually went through', 4500);
      try { await refreshDetail(poId); } catch { /* next poll catches up */ }
      busyRef.current = null;
      setBusyLine(null);
      return;
    }
    setLastBatch(prev => ({ ...prev, [line.id]: created }));
    setCountByLine(prev => ({ ...prev, [line.id]: undefined }));
    // Labels are the packer's physical critical path — start printing
    // immediately; the refreshes ride along in parallel.
    const printPromise = printItemLabels(created, printDest, showToast);
    try {
      await refreshDetail(poId);
      onChanged?.();
    } catch { /* items are received; the 15s poll will catch the UI up */ }
    if (flipped) showToast?.('Whole order received — nice work 🎉', 3500);
    const ok = await printPromise;
    if (ok) {
      showToast?.(`${created.length} label${created.length === 1 ? '' : 's'} printing — ${lineName(line).epithet}`, 2500);
    }
    // Print failed: the items ARE received; the line's Reprint button is
    // the retry path, so no rollback and no extra prompt here.
    busyRef.current = null;
    setBusyLine(null);
  };

  const reprint = async (line) => {
    const batch = lastBatch[line.id];
    if (!batch?.length || busyLine) return;
    busyRef.current = line.id;
    setBusyLine(line.id);
    try {
      const ok = await printItemLabels(batch, printDest, showToast);
      if (ok) showToast?.(`Reprinting ${batch.length} label${batch.length === 1 ? '' : 's'}`, 2000);
    } finally {
      busyRef.current = null;
      setBusyLine(null);
    }
  };

  const startOver = async (line) => {
    if (busyLine || !activeDetail) return;
    const { epithet } = lineName(line);
    const sure = window.confirm(
      `Start "${epithet}" over? All ${line.quantityReceived} received plants for this line are removed from inventory (recoverable from Recently Deleted for 30 days). Already-printed labels become invalid.`,
    );
    if (!sure) return;
    busyRef.current = line.id;
    setBusyLine(line.id);
    if (!activePoId) setActivePoId(activeDetail.po.id);
    try {
      const res = await api.cancelReceivePurchaseOrderLine({ id: activeDetail.po.id, lineId: line.id });
      setLastBatch(prev => ({ ...prev, [line.id]: null }));
      await refreshDetail(activeDetail.po.id);
      onChanged?.();
      showToast?.(`Removed ${res.deletedCount} plant${res.deletedCount === 1 ? '' : 's'} — count and print again`, 3000);
    } catch (e) {
      showToast?.(e.message || 'Could not start the line over', 4000);
    } finally {
      busyRef.current = null;
      setBusyLine(null);
    }
  };

  // ── PO list (several incoming orders) ────────────────────────────────────
  if (!effectivePoId) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <PaneHeader
          title="New order receiving"
          subtitle="Pick the shipment you're unpacking"
          onClose={onClose}
        />
        <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-3">
          <div className="max-w-3xl mx-auto space-y-2">
            {err && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{err}</div>}
            {pos === null ? (
              <div className="text-center text-gray-500 py-12"><Loader2 className="w-5 h-5 animate-spin inline mr-2" />Loading incoming orders…</div>
            ) : pos.length === 0 ? (
              <div className="text-center py-10 space-y-2">
                <div className="text-gray-500">No incoming orders right now.</div>
                <div className="text-sm text-gray-500">When the admin uploads a wholesale list, it shows up here for counting and labels.</div>
              </div>
            ) : (
              pos.map(po => (
                <button
                  key={po.id}
                  type="button"
                  onClick={() => setActivePoId(po.id)}
                  className="w-full bg-white border-2 border-gray-200 hover:border-sky-400 rounded-xl px-4 py-3 flex items-center gap-3 text-left active:scale-[0.99] transition"
                >
                  <PackageOpen className="w-7 h-7 text-sky-600 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-gray-900 truncate">{po.supplier || `Order #${po.id.slice(-6)}`}</div>
                    <div className="text-xs text-gray-500">
                      {po.orderedAt ? new Date(po.orderedAt).toLocaleDateString() : ''} · {po.lineCount} species · {po.unitCount} plants
                    </div>
                  </div>
                  <ChevronLeft className="w-5 h-5 text-gray-400 rotate-180" />
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── One PO: the species checklist ────────────────────────────────────────
  const lines = activeDetail?.lines || [];
  const complete = activeDetail?.po?.status === 'received';

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-shrink-0 px-4 sm:px-5 py-3 border-b border-sky-200 bg-sky-50">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setActivePoId(null);
                if ((pos?.length || 0) <= 1) { onClose(); return; }
                // The list poll paused while this PO was open — catch it up.
                api.listPurchaseOrders('ordered').then(setPos).catch(() => {});
              }}
              className="p-3 -ml-2 rounded-lg text-sky-800 hover:bg-sky-100 active:bg-sky-200"
              aria-label="Back"
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
            <PackageOpen className="w-6 h-6 text-sky-700 shrink-0" />
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-bold text-sky-900 truncate">
                {activeDetail?.po?.supplier || 'Incoming order'}
              </h2>
              <p className="text-xs text-sky-800">
                Count each species, then print — one label per plant. Extras get added to inventory automatically.
              </p>
            </div>
            <div className="text-right shrink-0">
              <div className="text-lg font-black tabular-nums text-sky-900">{totals.received}/{totals.ordered}</div>
              <div className="text-[11px] text-sky-700 -mt-0.5">received</div>
            </div>
          </div>
          <div
            className="mt-2 w-full bg-sky-200 rounded-full h-2.5 overflow-hidden"
            role="progressbar" aria-valuenow={totals.received} aria-valuemin={0} aria-valuemax={totals.ordered}
          >
            <div
              className={`h-full transition-all ${complete ? 'bg-emerald-500' : 'bg-sky-500'}`}
              style={{ width: totals.ordered ? `${Math.min(100, (totals.received / totals.ordered) * 100)}%` : 0 }}
            />
          </div>
          {complete && (
            <div className="mt-2 flex items-center gap-2 text-sm font-bold text-emerald-800 bg-emerald-100 rounded-lg px-3 py-1.5">
              <Check className="w-4 h-4" /> Every line received — the order is complete.
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-3">
        <div className="max-w-3xl mx-auto space-y-2 pb-24">
          {!activeDetail ? (
            <div className="text-center text-gray-500 py-12"><Loader2 className="w-5 h-5 animate-spin inline mr-2" />Loading order…</div>
          ) : (
            lines.map(line => (
              <ReceivingLine
                key={line.id}
                line={line}
                name={lineName(line)}
                count={countByLine[line.id]}
                onCount={(v) => setCountByLine(prev => ({ ...prev, [line.id]: v }))}
                busy={busyLine === line.id}
                anyBusy={!!busyLine}
                hasBatch={!!lastBatch[line.id]?.length}
                onReceive={(n) => receiveAndPrint(line, n)}
                onReprint={() => reprint(line)}
                onStartOver={() => startOver(line)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function PaneHeader({ title, subtitle, onClose }) {
  return (
    <div className="flex-shrink-0 px-4 sm:px-5 py-3 border-b border-sky-200 bg-sky-50">
      <div className="max-w-3xl mx-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onClose}
          className="p-2 -ml-2 rounded-lg text-sky-800 hover:bg-sky-100 active:bg-sky-200"
          aria-label="Close receiving"
        >
          <ChevronLeft className="w-6 h-6" />
        </button>
        <PackageOpen className="w-6 h-6 text-sky-700" />
        <div>
          <h2 className="text-base font-bold text-sky-900">{title}</h2>
          <p className="text-xs text-sky-800">{subtitle}</p>
        </div>
      </div>
    </div>
  );
}

// One species line. The stepper holds the packer's PHYSICAL count — it
// defaults to what's still expected, so the happy path is one tap. Setting
// it higher than expected is the extras path; the delta is called out
// before printing so over-receiving is always deliberate.
function ReceivingLine({ line, name, count, onCount, busy, anyBusy, hasBatch, onReceive, onReprint, onStartOver }) {
  const expected = line.quantityOrdered;
  const received = line.quantityReceived;
  const remaining = Math.max(0, expected - received);
  const extra = Math.max(0, received - expected);
  const done = remaining === 0;

  const defaultCount = done ? 1 : remaining;
  // '' is a REAL state (the packer backspaced to retype) — only undefined
  // falls back to the default. Snapping '' back to the default made the
  // next digit concatenate ('12' + '7' → 127 labels). Blur restores.
  const raw = count ?? String(defaultCount);
  const n = parseInt(raw, 10) || 0;
  // Called out whenever printing would push the line past its order —
  // including one-tap extras on an already-complete line.
  const overBy = Math.max(0, received + n - expected);

  const setN = (next) => onCount(String(Math.max(1, Math.min(MAX_PER_RECEIVE, next))));

  return (
    <div className={`bg-white rounded-xl border-2 px-3 sm:px-4 py-3 ${
      done ? (extra ? 'border-amber-300' : 'border-emerald-300')
        : received > 0 ? 'border-amber-300' : 'border-gray-200'
    }`}>
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-bold text-gray-900 text-base sm:text-lg truncate">{name.epithet}</div>
          <div className="text-xs text-gray-500 truncate">
            {name.variety}
            {line.unitWholesalePrice != null && ` · ${dollars(line.unitWholesalePrice)} each`}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className={`text-2xl font-black tabular-nums leading-none ${
            done ? 'text-emerald-600' : 'text-gray-900'
          }`}>
            {received}<span className="text-gray-400 text-lg">/{expected}</span>
          </div>
          <div className="text-sm mt-0.5">
            {done && !extra && <span className="text-emerald-700 font-bold inline-flex items-center gap-1"><Check className="w-4 h-4" /> complete</span>}
            {extra > 0 && <span className="text-amber-700 font-bold">+{extra} extra</span>}
            {!done && received > 0 && <span className="text-red-600 font-bold">short {remaining}</span>}
            {!done && received === 0 && <span className="text-gray-500">expected {expected}</span>}
          </div>
        </div>
      </div>

      <div className="mt-2.5 flex items-center gap-2 flex-wrap">
        {/* ≥44px touch targets throughout — this pane gets used with wet
            gloves at arm's length. focus-within marks which line's count
            field is armed (the input itself hides the native outline). */}
        <div className="flex items-center rounded-xl border-2 border-gray-300 focus-within:border-sky-500 overflow-hidden">
          <button
            type="button"
            onClick={() => setN(n - 1)}
            disabled={anyBusy || n <= 1}
            className="px-4 py-3 text-gray-700 active:bg-gray-200 disabled:opacity-30"
            aria-label="One fewer"
          >
            <Minus className="w-5 h-5" />
          </button>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={raw}
            // slice(0,3): a wedge-scanner blast into a focused count field
            // ("PLT-142" → digits) must not become a 142-plant receive;
            // three digits covers the 500 cap. Enter (the scanner's
            // terminator) just blurs.
            onChange={(e) => onCount(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
            onBlur={() => { if (raw === '') onCount(undefined); }}
            disabled={anyBusy}
            className="w-16 text-center text-xl font-bold tabular-nums py-2 focus:outline-none"
            aria-label={`Counted ${name.epithet}`}
          />
          <button
            type="button"
            onClick={() => setN(n + 1)}
            disabled={anyBusy || n >= MAX_PER_RECEIVE}
            className="px-4 py-3 text-gray-700 active:bg-gray-200 disabled:opacity-30"
            aria-label="One more"
          >
            <Plus className="w-5 h-5" />
          </button>
        </div>

        <button
          type="button"
          onClick={() => onReceive(n)}
          disabled={anyBusy || n < 1}
          className={`flex-1 min-w-[12rem] inline-flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl text-base font-bold text-white active:scale-[0.99] disabled:opacity-40 ${
            done ? 'bg-amber-500 hover:bg-amber-600' : 'bg-emerald-600 hover:bg-emerald-700'
          }`}
        >
          {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Printer className="w-5 h-5" />}
          {busy
            ? 'Receiving…'
            : done
              ? `Add ${n} extra & print label${n === 1 ? '' : 's'}`
              : `Receive ${n} & print label${n === 1 ? '' : 's'}`}
        </button>

        {hasBatch && (
          <button
            type="button"
            onClick={onReprint}
            disabled={anyBusy}
            title="Print the last batch again (didn't come out?)"
            className="inline-flex items-center gap-1.5 px-3.5 py-3.5 rounded-xl border-2 border-gray-300 text-sm font-semibold text-gray-700 hover:bg-gray-50 active:bg-gray-100 disabled:opacity-40"
          >
            <Printer className="w-4 h-4" /> Reprint
          </button>
        )}
        {received > 0 && (
          <button
            type="button"
            onClick={onStartOver}
            disabled={anyBusy}
            title="Miscounted? Remove everything received for this line and redo it"
            className="inline-flex items-center gap-1.5 px-3 py-3.5 rounded-xl text-sm font-semibold text-red-700 hover:bg-red-50 active:bg-red-100 disabled:opacity-40"
          >
            <RotateCcw className="w-4 h-4" /> Start over
          </button>
        )}
      </div>

      {overBy > 0 && (
        <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            That's <strong>{overBy} more than ordered</strong> — the extra plant{overBy === 1 ? '' : 's'} will be added to inventory and labeled too.
          </span>
        </div>
      )}
    </div>
  );
}
