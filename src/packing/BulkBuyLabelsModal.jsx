import { useEffect, useRef, useState } from 'react';
import {
  X, ShoppingCart, AlertCircle, Check, FlaskConical, Loader2,
} from 'lucide-react';
import { api } from '../api.js';
import { shortBoxCode } from '../labels/boxCode.js';
import { boxHoldState, boxIsLocalPickup } from './holdInfo.js';

// One-week-hold boxes don't ship yet and local pickups never ship — both are
// listed (so the operator sees why they're excluded) but never pre-checked,
// and select-all skips them. They stay manually tickable for the odd
// exception (e.g. buying a hold's label a day early).
function boxFlags(b) {
  const hold = boxHoldState(b.items, b.holdUntil);
  return {
    holding: hold.state === 'holding',
    daysLeft: hold.daysLeft,
    pickup: boxIsLocalPickup(b.note, b.items),
  };
}

// Bulk label purchase for open boxes. The operator ticks which boxes to buy,
// picks each box's size (dims come from the Shipping Settings catalog) and
// service, then one click buys them all — SEQUENTIALLY, because the
// ShipStation client has no 429 backoff (api/_lib/shipstation.js) and each
// purchase is a real charge. Failures don't abort the batch: every row gets
// its own success/error status. The server's already-purchased guard (409)
// makes re-running MOST failures safe — the exception is a server error
// AFTER the carrier charge (save failed → no shipments row), where re-buying
// double-charges; the failure copy tells the operator to verify in
// ShipStation first.
//
// Chosen size/weight/service are persisted to shipment_boxes (best-effort)
// right before each buy so the per-box packaging panel agrees with what was
// actually bought.

// Display mirror of api/_lib/services.js — the server owns the provider code
// mapping; this modal only needs key + label (same mirror as BoxPackagingPanel).
const SERVICES = [
  { key: 'usps_priority', label: 'USPS Priority', carrier: 'usps' },
  { key: 'ups_2nd_day_air', label: 'UPS 2nd Day Air', carrier: 'ups' },
  { key: 'ups_next_day_air_saver', label: 'UPS Next Day Air Saver', carrier: 'ups' },
];

const money = (n) => (n == null ? '' : `$${Number(n).toFixed(2)}`);

export function BulkBuyLabelsModal({ boxes, boxSizes = [], preselectedIds, onClose, onBought, showToast }) {
  const [settings, setSettings] = useState(null);
  const [settingsError, setSettingsError] = useState('');
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [provider, setProvider] = useState('shipstation');
  const [phase, setPhase] = useState('edit'); // edit → buying → done
  const [progress, setProgress] = useState(0);
  const [totalToBuy, setTotalToBuy] = useState(0);
  const [statuses, setStatuses] = useState({});
  // If the component unmounts mid-loop (operator switches app tabs, which
  // unmounts the whole Shipping view), stop buying the REMAINING boxes —
  // otherwise the loop keeps charging money with no UI to show the results.
  // The in-flight purchase completes server-side either way.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);
  // Per-box drafts, seeded from each box's saved packaging (boxNotesByBox is
  // merged in by the parent). UPS boxes are pre-checked — that's what the
  // button promises — unless the operator already picked boxes via the tab's
  // checkboxes, in which case that selection wins.
  const [rows, setRows] = useState(() => {
    const init = {};
    for (const b of boxes) {
      const size = boxSizes.find(s => s.id === b.boxSizeId) || null;
      const { holding, pickup } = boxFlags(b);
      init[b.id] = {
        checked: (preselectedIds ? preselectedIds.has(b.id) : b.carrier === 'ups')
          && !holding && !pickup,
        sizeId: b.boxSizeId || '',
        weight: b.weightOz != null ? String(b.weightOz)
          : (size?.weightOz != null ? String(size.weightOz) : ''),
        serviceKey: b.serviceKey
          || (b.carrier === 'ups' ? 'ups_2nd_day_air' : 'usps_priority'),
      };
    }
    return init;
  });

  // Settings gate the whole flow: ship-from must exist, and test mode changes
  // the button color + copy (and dooms UPS buys — ShipStation refuses UPS
  // test labels, see api/shipstation.js). Same load as BuyLabelModal.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const row = await api.getSettings('shipping');
        if (alive) setSettings(row?.data || {});
      } catch (e) {
        if (alive) setSettingsError(e?.message || 'Failed to load shipping settings');
      } finally {
        if (alive) setLoadingSettings(false);
      }
    })();
    return () => { alive = false; };
  }, []);  

  const testMode = settings ? settings.testMode !== false : true;
  const shipFromOk = !!settings?.shipFrom &&
    ['name', 'street1', 'city', 'state', 'zip', 'country'].every(k => (settings.shipFrom[k] || '').trim());

  const patchRow = (id, p) => setRows(r => ({ ...r, [id]: { ...r[id], ...p } }));

  const onPickSize = (id, sizeId) => {
    const preset = boxSizes.find(s => s.id === sizeId) || null;
    setRows(r => {
      const row = r[id];
      const next = { ...row, sizeId };
      // Seed the weight from the preset's default when the field is blank,
      // mirroring BoxPackagingPanel.onPickSize.
      if (preset?.weightOz != null && !String(row.weight).trim()) next.weight = String(preset.weightOz);
      return { ...r, [id]: next };
    });
  };

  const rowProblem = (row) => {
    if (!row.sizeId || !boxSizes.some(s => s.id === row.sizeId)) return 'pick a box size';
    const w = parseFloat(row.weight);
    if (!Number.isFinite(w) || w <= 0) return 'set a weight';
    if (!SERVICES.some(s => s.key === row.serviceKey)) return 'pick a service';
    return null;
  };

  // Boxes that appeared after mount have no draft row (render skips them) —
  // exclude them from counts too, or select-all can never read as "all".
  const knownBoxes = boxes.filter(b => rows[b.id]);
  const selected = knownBoxes.filter(b => rows[b.id].checked);
  const invalidSelected = selected.filter(b => rowProblem(rows[b.id]));
  // "All" means all SHIPPABLE boxes — held / local-pickup rows don't count
  // toward select-all and are never swept up by it.
  const eligible = knownBoxes.filter(b => {
    const { holding, pickup } = boxFlags(b);
    return !holding && !pickup;
  });
  const allChecked = eligible.length > 0 && eligible.every(b => rows[b.id].checked);
  const canBuy = phase === 'edit' && !loadingSettings && shipFromOk
    && selected.length > 0 && invalidSelected.length === 0;

  const toggleAll = () => {
    if (phase !== 'edit') return;
    const eligibleIds = new Set(eligible.map(b => b.id));
    setRows(r => Object.fromEntries(Object.entries(r).map(([id, row]) => [
      id,
      // Check-all touches only shippable boxes; uncheck-all clears everything
      // (including a manually-ticked held box).
      allChecked ? { ...row, checked: false }
        : (eligibleIds.has(id) ? { ...row, checked: true } : row),
    ])));
  };

  // Bulk size: apply one catalog size to every selected row (seeding each
  // blank weight from the size's default, same as picking it per-row).
  const applySizeToSelected = (sizeId) => {
    if (!sizeId || phase !== 'edit') return;
    const preset = boxSizes.find(s => s.id === sizeId) || null;
    setRows(r => Object.fromEntries(Object.entries(r).map(([id, row]) => {
      if (!row.checked) return [id, row];
      const next = { ...row, sizeId };
      if (preset?.weightOz != null && !String(row.weight).trim()) next.weight = String(preset.weightOz);
      return [id, next];
    })));
  };

  // The modal must not vanish mid-purchase — money is moving.
  const close = () => { if (phase !== 'buying') onClose(); };

  // Browser close/refresh mid-loop would drop the remaining buys AND the
  // per-row results — warn first (the in-flight purchase completes anyway).
  useEffect(() => {
    if (phase !== 'buying') return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  const buyAll = async () => {
    if (!canBuy) return;
    setPhase('buying');
    let ok = 0, failed = 0;
    const targets = knownBoxes.filter(b => rows[b.id].checked);
    setTotalToBuy(targets.length);
    for (let i = 0; i < targets.length; i++) {
      if (!aliveRef.current) return; // unmounted — stop spending money
      const b = targets[i];
      const row = rows[b.id];
      setProgress(i + 1);
      setStatuses(s => ({ ...s, [b.id]: { state: 'buying' } }));
      const size = boxSizes.find(x => x.id === row.sizeId);
      const weightOz = parseFloat(row.weight);
      // Keep the box's saved packaging in sync with what's being bought so
      // the per-box panel agrees afterwards. A failed save must not block
      // the purchase.
      if (row.sizeId !== (b.boxSizeId || '') || weightOz !== b.weightOz || row.serviceKey !== (b.serviceKey || '')) {
        try {
          await api.setBoxPackaging({ shipmentBoxId: b.id, boxSizeId: row.sizeId, weightOz, serviceKey: row.serviceKey });
        } catch { /* best-effort */ }
      }
      try {
        const shipment = await api.buyLabel({
          shipmentBoxId: b.id,
          provider,
          serviceKey: row.serviceKey,
          dims: { length: size.length, width: size.width, height: size.height },
          weightOz,
        });
        ok++;
        setStatuses(s => ({ ...s, [b.id]: { state: 'ok', cost: shipment?.labelCost, test: !!shipment?.isTestLabel } }));
      } catch (e) {
        failed++;
        setStatuses(s => ({ ...s, [b.id]: { state: 'error', message: e?.message || 'Purchase failed' } }));
      }
    }
    setPhase('done');
    onBought?.();
    showToast?.(failed === 0
      ? `Bought ${ok} label${ok === 1 ? '' : 's'}`
      : `Bought ${ok} label${ok === 1 ? '' : 's'} · ${failed} failed`);
  };

  const boughtCount = Object.values(statuses).filter(s => s.state === 'ok').length;
  const failedCount = Object.values(statuses).filter(s => s.state === 'error').length;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-stretch sm:items-center justify-center p-0 sm:p-4" onClick={close}>
      <div className="bg-white w-full max-w-3xl h-full sm:h-auto sm:max-h-[92vh] sm:rounded-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-gray-200 px-4 sm:px-5 py-3 sm:py-4 flex items-center justify-between flex-shrink-0">
          <h3 className="font-semibold text-gray-900 text-base sm:text-lg flex items-center gap-2">
            <ShoppingCart className="w-5 h-5 text-emerald-600" /> Buy shipping labels
          </h3>
          <button onClick={close} disabled={phase === 'buying'} className="p-2 -mr-1 text-gray-500 hover:bg-gray-100 rounded-lg disabled:opacity-40" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-4 space-y-3">
          {loadingSettings ? (
            <div className="text-sm text-gray-500 text-center py-12">Loading…</div>
          ) : settingsError ? (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-gray-700">
                <div className="font-medium text-gray-900">Couldn&apos;t load shipping settings</div>
                <p className="text-xs mt-1">{settingsError} — close and try again.</p>
              </div>
            </div>
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
              {testMode && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2 text-xs">
                  <FlaskConical className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div className="text-amber-900">
                    <strong>Test mode is on</strong> — and ShipStation refuses <em>test</em> UPS labels, so
                    UPS rows below will fail. Turn Test mode off in Shipping Settings to buy real labels.
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between gap-3 flex-wrap">
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={toggleAll}
                    disabled={phase !== 'edit'}
                    className="rounded border-gray-300"
                  />
                  {selected.length} of {knownBoxes.length} box{knownBoxes.length === 1 ? '' : 'es'} selected
                </label>
                <div className="flex items-center gap-3 flex-wrap">
                  {/* Command-style select: applies to all selected rows, then
                      snaps back to the placeholder (value stays ''). */}
                  <select
                    value=""
                    onChange={e => applySizeToSelected(e.target.value)}
                    disabled={phase !== 'edit' || selected.length === 0}
                    className="px-2 py-1.5 border border-gray-300 rounded-lg text-sm text-gray-700"
                  >
                    <option value="">Set size for selected…</option>
                    {boxSizes.map(s => (
                      <option key={s.id} value={s.id}>{s.name} · {s.length}×{s.width}×{s.height}</option>
                    ))}
                  </select>
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    Buy via
                    <select
                      value={provider}
                      onChange={e => setProvider(e.target.value)}
                      disabled={phase !== 'edit'}
                      className="px-2 py-1.5 border border-gray-300 rounded-lg text-sm"
                    >
                      <option value="shipstation">ShipStation</option>
                      <option value="shippo">Shippo</option>
                    </select>
                  </label>
                </div>
              </div>

              <div className="border border-gray-200 rounded-xl overflow-x-auto">
                <div className="min-w-[44rem]">
                  <div className="grid grid-cols-[2rem_minmax(0,1fr)_9rem_5.5rem_12rem_minmax(6rem,0.6fr)] gap-2 items-center px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-200 bg-gray-50">
                    <span />
                    <span>Box</span>
                    <span>Box size</span>
                    <span>Weight oz</span>
                    <span>Label</span>
                    <span>Status</span>
                  </div>
                  {boxes.map(b => {
                    const row = rows[b.id];
                    // A box can APPEAR mid-session (background item polling
                    // re-derives the pool while the modal is open); it has no
                    // draft row, so skip it — it'll be there on next open.
                    if (!row) return null;
                    const st = statuses[b.id];
                    const flags = boxFlags(b);
                    const problem = row.checked ? rowProblem(row) : null;
                    return (
                      <div key={b.id} className={`grid grid-cols-[2rem_minmax(0,1fr)_9rem_5.5rem_12rem_minmax(6rem,0.6fr)] gap-2 items-center px-3 py-2 border-b border-gray-100 last:border-b-0 ${row.checked ? '' : 'opacity-50'}`}>
                        <input
                          type="checkbox"
                          checked={row.checked}
                          onChange={() => patchRow(b.id, { checked: !row.checked })}
                          disabled={phase !== 'edit'}
                          className="rounded border-gray-300"
                        />
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-gray-900 truncate">
                            <span className="font-mono text-xs text-gray-500 mr-1.5">{shortBoxCode(b.id)}</span>
                            {b.buyer || '(no name)'}
                          </div>
                          <div className="text-[11px] text-gray-500">
                            {(b.items || []).length} item{(b.items || []).length === 1 ? '' : 's'}
                            <span className={`ml-1.5 uppercase font-semibold ${b.carrier === 'ups' ? 'text-amber-700' : 'text-blue-700'}`}>{b.carrier}</span>
                            {flags.holding && (
                              <span className="ml-1.5 inline-block px-1.5 py-px rounded bg-amber-100 text-amber-800 font-semibold">
                                On hold{flags.daysLeft ? ` · ${flags.daysLeft}d left` : ''}
                              </span>
                            )}
                            {flags.pickup && (
                              <span className="ml-1.5 inline-block px-1.5 py-px rounded bg-gray-100 text-gray-600 font-semibold">
                                Local pickup
                              </span>
                            )}
                          </div>
                        </div>
                        <select
                          value={row.sizeId}
                          onChange={e => onPickSize(b.id, e.target.value)}
                          disabled={phase !== 'edit'}
                          className="px-2 py-1.5 border border-gray-300 rounded-lg text-xs w-full"
                        >
                          <option value="">Pick size…</option>
                          {boxSizes.map(s => (
                            <option key={s.id} value={s.id}>{s.name} · {s.length}×{s.width}×{s.height}</option>
                          ))}
                        </select>
                        <input
                          type="number"
                          min="1"
                          value={row.weight}
                          onChange={e => patchRow(b.id, { weight: e.target.value })}
                          disabled={phase !== 'edit'}
                          className="px-2 py-1.5 border border-gray-300 rounded-lg text-xs w-full"
                        />
                        <select
                          value={row.serviceKey}
                          onChange={e => patchRow(b.id, { serviceKey: e.target.value })}
                          disabled={phase !== 'edit'}
                          className="px-2 py-1.5 border border-gray-300 rounded-lg text-xs w-full"
                        >
                          {SERVICES.map(s => (
                            <option key={s.key} value={s.key}>{s.label}</option>
                          ))}
                        </select>
                        <div className="text-xs min-w-0">
                          {st?.state === 'buying' && <span className="inline-flex items-center gap-1 text-gray-500"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Buying…</span>}
                          {st?.state === 'ok' && (
                            <span className="inline-flex items-center gap-1 text-emerald-700">
                              <Check className="w-3.5 h-3.5" /> Bought{st.test ? ' (test)' : ''} {money(st.cost)}
                            </span>
                          )}
                          {st?.state === 'error' && (
                            <span className="text-red-600 truncate block" title={st.message}>{st.message}</span>
                          )}
                          {!st && problem && <span className="text-amber-600">{problem}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {invalidSelected.length > 0 && phase === 'edit' && (
                <div className="text-xs text-amber-700">
                  {invalidSelected.length} selected box{invalidSelected.length === 1 ? ' is' : 'es are'} missing a size or weight — fix or untick to continue.
                </div>
              )}
            </>
          )}
        </div>

        <div className="border-t border-gray-200 px-4 sm:px-5 py-3 flex items-center justify-between gap-2 flex-shrink-0 bg-white">
          <div className="text-xs text-gray-500">
            {phase === 'buying' && <>Buying {progress} of {totalToBuy}… don&apos;t close this window.</>}
            {phase === 'done' && <>{boughtCount} bought{failedCount > 0 ? ` · ${failedCount} failed — check each error; if it happened AFTER the purchase (a save/upload error), verify in ShipStation before re-buying` : ''}</>}
          </div>
          <div className="flex gap-2">
            {phase !== 'done' && (
              <button onClick={close} disabled={phase === 'buying'} className="px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-40">
                Cancel
              </button>
            )}
            {phase === 'done' ? (
              <button onClick={onClose} className="px-5 py-2.5 text-sm font-medium text-white bg-gray-800 hover:bg-gray-900 rounded-lg">
                Close
              </button>
            ) : (
              <button
                onClick={buyAll}
                disabled={!canBuy}
                className={`px-5 py-2.5 text-sm font-medium text-white rounded-lg flex items-center gap-1.5 disabled:bg-gray-300 ${
                  testMode ? 'bg-amber-600 hover:bg-amber-700' : 'bg-emerald-600 hover:bg-emerald-700'
                }`}
              >
                {phase === 'buying'
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <Check className="w-4 h-4" />}
                {phase === 'buying'
                  ? 'Buying…'
                  : `Buy ${selected.length} ${testMode ? 'test ' : ''}label${selected.length === 1 ? '' : 's'}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
