import { useMemo, useState } from 'react';
import { X, Combine, AlertCircle, Check, Loader2, ScanLine } from 'lucide-react';
import { shortBoxCode } from '../labels/boxCode.js';
import { boxHoldState, boxIsLocalPickup } from './holdInfo.js';

// Combine several open boxes into one: every item from the other boxes moves
// into the kept box (shipmentBoxId + denormalized recipient re-stamped, same
// write as the address editor). Meant for one buyer with multiple orders, so
// buyers with 2+ boxes list first. Boxes with an active label can't be
// combined (the label's postage is tied to that box's contents/weight — void
// it first). The kept box keeps its own notes / hold / packaging; the merged
// boxes' box-level metadata is left behind, so the modal warns when a merged
// box carries any.

const buyerKey = (b) => (b.buyerUsername || b.buyer || 'unknown').toLowerCase();

function addressOneLine(a = {}) {
  return [
    a.street1,
    [a.city, a.state].filter(Boolean).join(', '),
    a.zip,
  ].filter(Boolean).join(' · ');
}

export function CombineBoxesModal({ boxes, shipmentsByBox, boxNotesByBox, salesById, onClose, onCombine, showToast }) {
  const [selected, setSelected] = useState(() => new Set());
  const [keepId, setKeepId] = useState(null);
  // '' = not armed; otherwise the `${targetId}:${moveCount}` key it was
  // armed for (see confirmArmed below).
  const [confirming, setConfirming] = useState('');
  const [busy, setBusy] = useState(false);

  const hasLabel = (id) => {
    const s = shipmentsByBox?.[id];
    return !!(s && !s.voidedAt);
  };

  // Group by buyer (username-first key, same rule as the tab's grouping).
  // Multi-box buyers sort first — those are the combine candidates.
  const buyerGroups = useMemo(() => {
    const map = new Map();
    for (const b of boxes) {
      const key = buyerKey(b);
      if (!map.has(key)) {
        map.set(key, {
          key,
          name: b.buyer || b.buyerUsername || 'Unknown buyer',
          username: b.buyerUsername || '',
          boxes: [],
        });
      }
      map.get(key).boxes.push(b);
    }
    return [...map.values()].sort(
      (a, b) => (b.boxes.length - a.boxes.length) || a.name.localeCompare(b.name),
    );
  }, [boxes]);

  const selectedBoxes = boxes.filter(b => selected.has(b.id));
  const target = selectedBoxes.find(b => b.id === keepId) || selectedBoxes[0] || null;
  const sources = target ? selectedBoxes.filter(b => b.id !== target.id) : [];
  // Only still-sold items move (the server enforces the same rule) —
  // already-shipped items in a partially-shipped box stay behind as history.
  const soldCount = (b) => (b.items || []).filter(i => i.status === 'sold').length;
  const moveCount = sources.reduce((n, b) => n + soldCount(b), 0);
  const sourcesWithShipped = sources.filter(b => (b.items || []).length > soldCount(b));

  // A target with no usable address would stamp emptiness over every moved
  // item's real address — block until the operator keeps an addressed box
  // (or fixes the address first).
  const targetAddressMissing = !!target && !(target.buyerAddress?.street1)
    && sources.some(s => s.buyerAddress?.street1);

  const canCombine = !busy && selectedBoxes.length >= 2 && !!target
    && moveCount > 0 && !targetAddressMissing;

  // Cross-buyer combine is allowed (the operator may know it's the same
  // person) but loudly flagged — everything ships to the KEPT recipient.
  const mixedRecipients = target && sources.some(s => buyerKey(s) !== buyerKey(target));
  // Box-level metadata + item-driven flags on merged-away boxes don't carry
  // over: notes, holds (button OR hold-item), local pickup, size/weight.
  const sourcesWithMeta = sources.filter(s => {
    const n = boxNotesByBox?.[s.id];
    return !!(
      (n && ((n.note || '').trim() || n.holdUntil || n.boxSizeId || n.weightOz != null))
      || boxHoldState(s.items, n?.holdUntil).state !== 'none'
      || boxIsLocalPickup(n?.note, s.items)
    );
  });

  // The confirm step stays armed only for the exact target + move count it
  // was armed for — if either shifts under the 8s background poll (kept box
  // left the list, items moved), it disarms by derivation, no effect needed.
  const armedKey = target ? `${target.id}:${moveCount}` : '';
  const confirmArmed = confirming === armedKey;

  const toggle = (box) => {
    // A selected box can ALWAYS be unchecked — even if a label appeared on
    // it since selection (otherwise it's stuck checked and disabled).
    if (busy || (hasLabel(box.id) && !selected.has(box.id))) return;
    setConfirming('');
    const next = new Set(selected);
    if (next.has(box.id)) {
      next.delete(box.id);
      if (keepId === box.id) setKeepId(next.size ? [...next][0] : null);
    } else {
      next.add(box.id);
      if (next.size === 1) setKeepId(box.id);
    }
    setSelected(next);
  };

  const doCombine = async () => {
    if (!canCombine) return;
    setBusy(true);
    try {
      await onCombine(target, sources); // parent refreshes + closes on success
    } catch (e) {
      showToast?.(e?.message || 'Combine failed — nothing was moved');
      setBusy(false);
    }
  };

  const close = () => { if (!busy) onClose(); };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-stretch sm:items-center justify-center p-0 sm:p-4" onClick={close}>
      <div className="bg-white w-full max-w-2xl h-full sm:h-auto sm:max-h-[92vh] sm:rounded-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-gray-200 px-4 sm:px-5 py-3 sm:py-4 flex items-center justify-between flex-shrink-0">
          <div className="min-w-0">
            <h3 className="font-semibold text-gray-900 text-base sm:text-lg flex items-center gap-2">
              <Combine className="w-5 h-5 text-emerald-600" /> Combine orders
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Pick 2+ boxes, choose which one to keep — every item moves into it.
            </p>
          </div>
          <button onClick={close} disabled={busy} className="p-2 -mr-1 text-gray-500 hover:bg-gray-100 rounded-lg disabled:opacity-40" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-3">
          {boxes.length < 2 ? (
            <div className="text-sm text-gray-500 text-center py-12">Fewer than two open boxes — nothing to combine.</div>
          ) : (
            <div className="space-y-3">
              {buyerGroups.map(g => (
                <div key={g.key} className="border border-gray-200 rounded-xl overflow-hidden">
                  <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-100 flex items-center gap-2 text-xs">
                    <span className="font-semibold text-gray-800 truncate">{g.name}</span>
                    {g.username && <span className="text-gray-500 truncate">@{g.username}</span>}
                    {g.boxes.length > 1 && (
                      <span className="ml-auto px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-semibold flex-shrink-0">
                        {g.boxes.length} boxes
                      </span>
                    )}
                  </div>
                  {g.boxes.map(box => {
                    const labeled = hasLabel(box.id);
                    const isSelected = selected.has(box.id);
                    const isKeep = isSelected && target?.id === box.id;
                    const sale = salesById?.get?.(box.saleId);
                    return (
                      <label
                        key={box.id}
                        className={`flex items-center gap-2.5 px-3 py-2 border-b border-gray-100 last:border-b-0 ${
                          labeled ? 'opacity-50' : 'cursor-pointer hover:bg-gray-50'
                        } ${isSelected ? 'bg-emerald-50/60' : ''}`}
                        title={labeled ? 'This box has an active label — void it first to combine' : undefined}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggle(box)}
                          disabled={busy || labeled}
                          className="rounded border-gray-300"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-gray-900 flex items-center gap-1.5 flex-wrap">
                            <span className="font-mono text-xs text-gray-500">{shortBoxCode(box.id)}</span>
                            <span className="font-medium truncate">{box.buyer || (box.buyerUsername ? `@${box.buyerUsername}` : '(no name)')}</span>
                            <span className={`text-[10px] font-bold uppercase ${box.carrier === 'ups' ? 'text-amber-700' : 'text-blue-700'}`}>{box.carrier}</span>
                            {labeled && (
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                                <ScanLine className="w-3 h-3" /> has label
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-gray-500 truncate">
                            {soldCount(box)} item{soldCount(box) === 1 ? '' : 's'}
                            {sale?.name ? ` · ${sale.name}` : ''}
                            {addressOneLine(box.buyerAddress) ? ` · ${addressOneLine(box.buyerAddress)}` : ''}
                          </div>
                        </div>
                        {isSelected && (
                          <button
                            type="button"
                            onClick={(e) => { e.preventDefault(); setKeepId(box.id); setConfirming(''); }}
                            disabled={busy}
                            className={`flex-shrink-0 text-[11px] font-semibold px-2 py-1 rounded-md border ${
                              isKeep
                                ? 'bg-emerald-600 border-emerald-600 text-white'
                                : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
                            }`}
                            title="Keep this box — items from the others move into it"
                          >
                            {isKeep ? 'Keeping' : 'Keep'}
                          </button>
                        )}
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-gray-200 px-4 sm:px-5 py-3 flex-shrink-0 bg-white space-y-2">
          {mixedRecipients && (
            <div className="flex items-start gap-2 text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-600" />
              <span>
                Selected boxes have <strong>different recipients</strong>. Everything will ship to{' '}
                <strong>{target?.buyer || `@${target?.buyerUsername}`}</strong> — {addressOneLine(target?.buyerAddress) || 'no address'}.
              </span>
            </div>
          )}
          {targetAddressMissing && (
            <div className="flex items-start gap-2 text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-600" />
              <span>
                The kept box <strong>has no shipping address</strong> — combining would erase the other boxes&apos; addresses.
                Keep a box that has one, or edit the address first.
              </span>
            </div>
          )}
          {sourcesWithMeta.length > 0 && (
            <div className="flex items-start gap-2 text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-600" />
              <span>
                {sourcesWithMeta.map(s => shortBoxCode(s.id)).join(', ')} {sourcesWithMeta.length === 1 ? 'carries' : 'carry'} a note, hold,
                pickup flag or packaging — none of it <strong>carries over</strong>; re-apply on the kept box if still needed.
              </span>
            </div>
          )}
          {sourcesWithShipped.length > 0 && (
            <div className="text-[11px] text-gray-500 px-1">
              Already-shipped items in {sourcesWithShipped.map(s => shortBoxCode(s.id)).join(', ')} stay in their original box.
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-gray-500">
              {selectedBoxes.length < 2
                ? 'Select at least two boxes.'
                : `${moveCount} item${moveCount === 1 ? '' : 's'} will move into ${shortBoxCode(target.id)} (kept box).`}
            </div>
            <div className="flex gap-2">
              <button onClick={close} disabled={busy} className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg disabled:opacity-40">
                Cancel
              </button>
              {confirmArmed ? (
                <button
                  onClick={doCombine}
                  disabled={!canCombine}
                  className="px-4 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg flex items-center gap-1.5 disabled:bg-gray-300"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  {busy ? 'Combining…' : `Confirm — move ${moveCount} item${moveCount === 1 ? '' : 's'}`}
                </button>
              ) : (
                <button
                  onClick={() => setConfirming(armedKey)}
                  disabled={!canCombine}
                  className="px-4 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg flex items-center gap-1.5 disabled:bg-gray-300"
                >
                  <Combine className="w-4 h-4" /> Combine {selectedBoxes.length >= 2 ? `${selectedBoxes.length} boxes` : 'boxes'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
