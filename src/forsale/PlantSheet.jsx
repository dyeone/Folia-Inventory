import { useEffect, useMemo, useRef, useState } from 'react';
import { Printer, Trash2, RefreshCw, Loader2, Globe, Undo2 } from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';
import { api } from '../api.js';
import { MediaEditor } from './MediaEditor.jsx';
import { IN_POOL, ON_WEBSITE, onWebsite, shopifyBadge, money, openEvents, isWebsiteSale } from './pools.js';
import { EventChoices } from './EventChoices.jsx';

const TONE_TEXT = { ok: 'text-green-700', wait: 'text-gray-600', warn: 'text-amber-700', error: 'text-red-700' };

// Statuses a sale event takes (api/_lib/pool.js EVENT_STATUSES).
const EVENT_STATUSES = ['available', 'listed'];

// One plant's For Sale details: its photos and videos (shoot or pick on the
// phone — they upload in the background), price, the team's note on it, the
// website (push it there / take it off — admins only — and what its listing
// is doing), its sale event, and tag.
// canWebsite: may push to / take off the website (the CEO can't, 2026-11-20).
// notesOn: migration 0055 is in (staffNote exists).
export function PlantSheet({
  item, sales, openSaleIds, pausedSaleIds, shopifyConnected, canWebsite, notesOn, showToast, uploads,
  onClose, onMerged, onSyncShopify, onPrintLabel, onSetPool, onEventAssign, onEventUnassign,
}) {
  const [price, setPrice] = useState(item.listingPrice != null && Number(item.listingPrice) > 0 ? String(item.listingPrice) : '');
  const [priceBusy, setPriceBusy] = useState(false);
  const [note, setNote] = useState(item.staffNote || '');
  const [noteBusy, setNoteBusy] = useState(false);
  const savedNote = useRef(item.staffNote || '');
  const [poolBusy, setPoolBusy] = useState(false);
  const [eventBusy, setEventBusy] = useState(null);

  const web = onWebsite(item);
  const followShopify = () => { if (web) onSyncShopify([item.id]); };
  const events = useMemo(() => openEvents(sales), [sales]);
  const openEvent = item.saleId && openSaleIds.has(item.saleId) ? events.find((s) => s.id === item.saleId) || null : null;
  const badge = web ? shopifyBadge(item, pausedSaleIds, shopifyConnected) : null;
  const eventable = EVENT_STATUSES.includes(item.status);

  // Into an event (moving it out of the one it's in, on purpose), or out.
  const pickEvent = async (saleId) => {
    if (saleId === (openEvent?.id ?? null)) return;
    const code = item.saleCode || item.sku;
    if (openEvent && item.lotNumber && !window.confirm(`${code} is #${item.lotNumber} in ${openEvent.name}'s lineup. ${saleId ? 'Move it' : 'Take it out'} anyway?`)) return;
    setEventBusy(saleId ?? 'none');
    try {
      if (saleId) await onEventAssign(saleId, [item.id], { move: true });
      else await onEventUnassign(openEvent.id, [item.id]);
    } finally {
      setEventBusy(null);
    }
  };

  const savePrice = async () => {
    const v = parseFloat(price);
    if (!Number.isFinite(v) || v <= 0) { showToast('Enter a price above $0', 'error'); return; }
    const rounded = Math.round(v * 100) / 100;
    setPriceBusy(true);
    try {
      await api.upsertItems([{ id: item.id, listingPrice: rounded }]);
      onMerged([{ id: item.id, listingPrice: rounded }]);
      showToast(`Price ${money(rounded)}`);
      followShopify();
    } catch (err) {
      showToast(err.message || 'Could not save the price', 'error');
    } finally {
      setPriceBusy(false);
    }
  };

  // The note saves on Save, when the box loses focus, and when the sheet
  // closes with it unsaved. Never exported — not in the Palmstreet CSV, not
  // on the website.
  const saveNote = async () => {
    const v = note.trim();
    if (v === savedNote.current.trim() || !notesOn) return;
    const before = savedNote.current;
    savedNote.current = v;
    setNoteBusy(true);
    try {
      await api.upsertItems([{ id: item.id, staffNote: v || null }]);
      onMerged([{ id: item.id, staffNote: v || null }]);
      showToast(v ? 'Note saved' : 'Note cleared');
    } catch (err) {
      savedNote.current = before;
      showToast(/staffNote/.test(err.message || '') ? 'Notes need migration 0055 — run it in the Supabase SQL editor first' : (err.message || 'Could not save the note'), 'error');
    } finally {
      setNoteBusy(false);
    }
  };
  const noteDirty = note.trim() !== (item.staffNote || '').trim();
  const saveNoteRef = useRef(saveNote);
  useEffect(() => { saveNoteRef.current = saveNote; });
  useEffect(() => () => { saveNoteRef.current(); }, []);

  const setPool = async (pool) => {
    if (pool === item.salePool) return;
    if (pool === null && !window.confirm(`Take ${item.saleCode || item.sku} out of For Sale?${web ? ' It comes off the website too.' : ''}`)) return;
    setPoolBusy(true);
    try {
      await onSetPool([item.id], pool);
      if (pool === null) onClose();
    } finally {
      setPoolBusy(false);
    }
  };

  const title = item.listingDetails?.title || item.name || item.sku;
  const priceDirty = price !== '' && Number(price) !== Number(item.listingPrice);

  return (
    <Modal title={`${item.saleCode ? `${item.saleCode} · ` : ''}${title}`} onClose={onClose} size="lg">
      <div className="space-y-4">
        <MediaEditor item={item} uploads={uploads} showToast={showToast} onMerged={onMerged} onChanged={followShopify} />

        {/* Price */}
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Price</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
              <input
                type="number" inputMode="decimal" min="0" step="1" value={price}
                onChange={(e) => setPrice(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') savePrice(); }}
                className="input pl-7 text-base" placeholder="0"
              />
            </div>
            <button
              type="button" onClick={savePrice} disabled={priceBusy || !priceDirty}
              className="px-4 rounded-lg bg-emerald-600 text-white text-sm font-semibold disabled:opacity-40"
            >
              {priceBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
            </button>
          </div>
        </div>

        {/* Note */}
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">
            Note <span className="font-normal text-gray-400">· for the team, never shown to buyers</span>
          </label>
          {notesOn ? (
            <>
              <textarea
                value={note} onChange={(e) => setNote(e.target.value)} onBlur={saveNote}
                rows={2} maxLength={1000} placeholder="Anything the team should know about this plant"
                className="input text-base resize-y"
              />
              {(noteDirty || noteBusy) && (
                <div className="mt-1.5 flex justify-end">
                  <button
                    type="button" onClick={saveNote} disabled={noteBusy}
                    className="px-4 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold disabled:opacity-50"
                  >
                    {noteBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save note'}
                  </button>
                </div>
              )}
            </>
          ) : (
            <p className="text-xs text-gray-500">Notes need migration <b>0055_plant_videos_notes</b> — run it in the Supabase SQL editor.</p>
          )}
        </div>

        {/* Website */}
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Website</label>
          {!canWebsite ? (
            <p className="text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
              {web ? 'On the website.' : 'Not on the website.'} <span className="text-gray-500">Only an admin can {web ? 'take it off' : 'push it there'}.</span>
            </p>
          ) : web ? (
            <button
              type="button" disabled={poolBusy} onClick={() => setPool(IN_POOL)}
              className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-lg border-2 border-gray-200 text-sm font-semibold text-gray-700 active:bg-gray-50 disabled:opacity-50"
            >
              {poolBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Undo2 className="w-4 h-4" />} Take off website — keep in the pool
            </button>
          ) : (
            <button
              type="button" disabled={poolBusy} onClick={() => setPool(ON_WEBSITE)}
              className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-lg bg-emerald-600 active:bg-emerald-700 text-sm font-semibold text-white disabled:opacity-50"
            >
              {poolBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Globe className="w-4 h-4" />} Push to website
            </button>
          )}
          {badge && (
            <div className={`mt-2 text-xs ${TONE_TEXT[badge.tone]} flex items-start gap-2`}>
              <span className="font-semibold shrink-0">On the website: {badge.label}.</span>
              <span className="flex-1">{badge.detail}</span>
              {shopifyConnected && (
                <button type="button" onClick={() => onSyncShopify([item.id])} className="shrink-0 inline-flex items-center gap-1 text-gray-600 underline">
                  <RefreshCw className="w-3 h-3" /> Sync
                </button>
              )}
            </div>
          )}
        </div>

        {/* Sale event */}
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Sale event</label>
          {eventable ? (
            <EventChoices events={events} value={openEvent?.id ?? null} busy={eventBusy} onPick={pickEvent} />
          ) : (
            <p className="text-xs text-gray-500">A plant that's {item.status} can't go in a sale event — make it available first.</p>
          )}
          {openEvent && isWebsiteSale(openEvent) && !web && (
            <p className="mt-1.5 text-xs text-indigo-700">In a website sale — {canWebsite ? 'push it to the website above' : 'an admin needs to push it to the website'} so it's listed there.</p>
          )}
          {openEvent && !isWebsiteSale(openEvent) && web && (
            <p className="mt-1.5 text-xs text-amber-700">Hidden on the website while it's in {openEvent.name}.</p>
          )}
        </div>

        <div className="text-xs text-gray-500 space-y-0.5">
          <div>SKU <span className="font-mono text-gray-700">{item.sku}</span> · {item.status}{item.variety ? ` · ${item.variety}` : ''}</div>
          {item.saleCode && <div>Code <span className="font-mono font-bold text-gray-800">{item.saleCode}</span> — on the tag and in every listing title, so the packer can find this pot.</div>}
        </div>

        <div className="flex gap-2 pt-1">
          <button
            type="button" onClick={() => onPrintLabel(item)}
            className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg border border-gray-300 text-sm font-semibold text-gray-800 active:bg-gray-100"
          >
            <Printer className="w-4 h-4" /> Print tag
          </button>
          {(canWebsite || !web) && (
            <button
              type="button" disabled={poolBusy} onClick={() => setPool(null)}
              className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg border border-red-200 text-sm font-semibold text-red-700 active:bg-red-50 disabled:opacity-50"
            >
              <Trash2 className="w-4 h-4" /> Remove
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
