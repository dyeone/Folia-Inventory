import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus, Search, Download, RefreshCw, Printer, Store, CalendarDays, LayoutGrid, AlertTriangle, Loader2, X, HardDrive, Camera,
  CheckSquare, Globe, Undo2,
} from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';
import { EventChoices } from './EventChoices.jsx';
import { api } from '../api.js';
import { PlantCard } from './PlantCard.jsx';
import { PlantSheet } from './PlantSheet.jsx';
import { AddPlantsSheet } from './AddPlantsSheet.jsx';
import { SaleCalendar } from './SaleCalendar.jsx';
import { MediaWalkthrough } from './MediaWalkthrough.jsx';
import { useMediaUploads } from './useMediaUploads.js';
import { IN_POOL, ON_WEBSITE, poolItems, onWebsite, openSaleIdSet, pauseSaleIdSet, openEvents, readiness, photosOf, videosOf } from './pools.js';
import { exportPoolToPalmstreet, exportPalmstreetCsv, MEDIA_SEPARATORS } from '../sales/palmstreetExport.js';

const SYNC_EVERY_MS = 2 * 60 * 1000;

function useStored(key, fallback, allowed) {
  const [v, setV] = useState(() => {
    try { const s = localStorage.getItem(key); return s && (!allowed || allowed.includes(s)) ? s : fallback; } catch { return fallback; }
  });
  const set = useCallback((x) => { setV(x); try { localStorage.setItem(key, x); } catch { /* private mode */ } }, [key]);
  return [v, set];
}

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'web', label: 'On website' },
  { id: 'notweb', label: 'Not on website' },
  { id: 'photo', label: 'Needs photo' },
  { id: 'video', label: 'Needs video' },
  { id: 'price', label: 'Needs price' },
];

// The For Sale tab: plants ready to sell, in ONE pool (2026-11-19, operator:
// "only have one pool… select some and click push to website, then sync the
// selected ones to Shopify, others keep in the pool"), each with its short
// code, several photos and videos, and a note for the team. Select plants →
// Push to website lists them on the Shopify store (admins only — the CEO
// runs the rest of the tab but not the website, 2026-11-20); the rest stay
// in the pool (the Palmstreet CSV, sale events). Plus a calendar of sale
// events to put plants into. Phone first. Adding plants goes straight on to
// their photos (MediaWalkthrough); every upload runs in the tab's
// background uploader (useMediaUploads).
export function ForSaleView({ items, sales, isBae, isAdmin, showToast, onItemsMerged, onPrintLabels, onSaveSale }) {
  const [view, setView] = useStored('forsale.view', 'pools', ['pools', 'calendar']);
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState(() => new Set());
  const [moving, setMoving] = useState(null);   // 'push' | 'pull' | 'event' while a bulk change runs
  const [eventFor, setEventFor] = useState(false);   // bulk "Sale event" picker open
  const [bulkKey, setBulkKey] = useState(null);       // the event being saved there ('none' = No event)
  const [eventFilter, setEventFilter] = useState('');  // '' any · 'none' · a sale id
  const [separator, setSeparator] = useStored('forsale.mediaSep', 'comma', Object.keys(MEDIA_SEPARATORS));
  const [status, setStatus] = useState(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [justAdded, setJustAdded] = useState([]);
  const [walk, setWalk] = useState(null);   // plant ids going through photos & video
  const syncingRef = useRef(false);
  const pendingRef = useRef(new Set());   // plants to sync once the running sync ends

  const shopifyOn = !!status?.shopify?.configured;
  const canWebsite = !!isAdmin;   // the server checks too (api/_lib/pool.js)
  // Migration 0055: several videos per plant + the team note (assumed in
  // until the status read says otherwise — the server copes either way).
  const notesOn = status?.notesMigrated !== false;
  const openSaleIds = useMemo(() => openSaleIdSet(sales), [sales]);
  const pausedSaleIds = useMemo(() => pauseSaleIdSet(sales), [sales]);
  const events = useMemo(() => openEvents(sales), [sales]);
  const saleById = useMemo(() => new Map((sales || []).map((s) => [s.id, s])), [sales]);
  const byId = useMemo(() => new Map((items || []).map((i) => [i.id, i])), [items]);
  const byIdRef = useRef(byId);
  useEffect(() => { byIdRef.current = byId; });

  // A failed status read keeps the last good one (a blip must not switch
  // the Shopify sync off until the tab is reopened).
  const loadStatus = useCallback(async () => {
    try { setStatus(await api.poolStatus()); } catch (e) { setStatus((prev) => (prev ? { ...prev, error: e.message } : { migrated: true, shopify: null, error: e.message })); }
  }, []);
  useEffect(() => {
    let alive = true;
    api.poolStatus()
      .then((r) => { if (alive) setStatus(r); })
      .catch((e) => { if (alive) setStatus((prev) => (prev ? { ...prev, error: e.message } : { migrated: true, shopify: null, error: e.message })); });
    return () => { alive = false; };
  }, []);

  // Shopify, both ways. A full pass loops while the server says listings
  // are still behind (it works in time-boxed batches).
  const runSync = useCallback(async ({ itemIds, force = false, quiet = false } = {}) => {
    if (!shopifyOn) return;
    if (syncingRef.current) {
      // A plant changed while a sync runs: queue it, don't drop it.
      for (const id of itemIds || []) pendingRef.current.add(id);
      return;
    }
    syncingRef.current = true;
    setSyncing(true);
    try {
      let prevRemaining = Infinity;
      for (let round = 0; round < 8; round++) {
        const r = await api.poolSync({ itemIds, force: force && round === 0 });
        if (r.items?.length) onItemsMerged(r.items);
        if (!quiet && r.orders?.error) showToast(`Shopify orders: ${r.orders.error}`, 'error');
        if (!quiet && r.listing?.error) showToast(`Shopify listings: ${r.listing.error}`, 'error');
        const sold = r.orders?.soldIds?.length || 0;
        if (sold) showToast(`Shopify: ${sold} plant${sold === 1 ? '' : 's'} sold — boxes are on the Shipping tab`);
        // Another full round only while it's still making headway.
        const L = r.listing || {};
        const stuck = !L.processed || L.busy || (L.errors?.length || 0) >= L.processed || !(L.remaining < prevRemaining);
        if (itemIds || !(L.remaining > 0) || stuck) break;
        prevRemaining = L.remaining;
      }
      await loadStatus();
    } catch (e) {
      if (!quiet) showToast(e.message || 'Shopify sync failed', 'error');
    } finally {
      syncingRef.current = false;
      setSyncing(false);
      if (pendingRef.current.size) {
        const ids = [...pendingRef.current];
        pendingRef.current.clear();
        setTimeout(() => runSyncRef.current?.({ itemIds: ids, quiet: true }), 0);
      }
    }
  }, [shopifyOn, onItemsMerged, showToast, loadStatus]);
  const runSyncRef = useRef(null);
  useEffect(() => { runSyncRef.current = runSync; }, [runSync]);

  // A Shopify-pool plant's listing follows its photo / video / price edits.
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; });
  const followShopify = useCallback((id) => {
    const it = (itemsRef.current || []).find((i) => i.id === id);
    if (onWebsite(it)) runSyncRef.current?.({ itemIds: [id], quiet: true });
  }, []);
  // Before migration 0053 the server can't keep a plant's photo list, so
  // don't show one this session only to lose it on reload.
  const photosMigratedRef = useRef(true);
  useEffect(() => { photosMigratedRef.current = status?.photosMigrated !== false; });
  const mergeMedia = useCallback((rows) => onItemsMerged(photosMigratedRef.current
    ? rows : rows.map(({ photoUrls: _drop, ...r }) => r)), [onItemsMerged]);
  const uploads = useMediaUploads({ onMerged: mergeMedia, onSettled: followShopify, showToast, multiVideo: notesOn });
  const uploadingIds = useMemo(() => new Set(uploads.jobs.map((j) => j.itemId)), [uploads.jobs]);

  useEffect(() => {
    if (!shopifyOn) return undefined;
    const first = setTimeout(() => runSync({ quiet: true }), 0);
    const id = setInterval(() => { if (document.visibilityState === 'visible') runSync({ quiet: true }); }, SYNC_EVERY_MS);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [shopifyOn, runSync]);

  // pool: IN_POOL (join the pool, or come off the website), ON_WEBSITE
  // (push to the website) or null (out of For Sale).
  const setPoolFor = useCallback(async (ids, toPool) => {
    try {
      const r = await api.poolSet({ itemIds: ids, pool: toPool });
      if (r.items?.length) onItemsMerged(r.items);
      const n = r.items?.length || 0;
      if (r.skipped?.length) {
        const first = r.skipped[0];
        showToast(`${n ? `${n} done · ` : ''}${r.skipped.length} skipped — ${first.sku || 'a plant'} ${first.reason}`, 'error');
      } else if (toPool === ON_WEBSITE) {
        const notReady = (r.items || []).filter((i) => readiness(i).some((m) => m === 'photo' || m === 'price')).length;
        showToast(`Pushed ${n} to the website${!shopifyOn ? ' — it goes up once Shopify is connected for this brand'
          : notReady ? ` · ${notReady} need${notReady === 1 ? 's' : ''} a price or photo before showing` : ''}`);
      } else if (toPool) {
        showToast(ids.some((id) => onWebsite(byIdRef.current.get(id))) ? `Took ${n} off the website — still in the pool` : `${n} added to For Sale`);
      } else {
        showToast('Taken out of For Sale');
      }
      if (r.shopify?.error) showToast(`Shopify: ${r.shopify.error}`, 'error');
      return r;
    } catch (e) {
      showToast(e.message || 'Could not update the pool', 'error');
      return null;
    }
  }, [onItemsMerged, showToast, shopifyOn]);

  const addToPool = async (ids, { media = false } = {}) => {
    const r = await setPoolFor(ids, IN_POOL);
    if (!r) return false;
    setView('pools');
    const added = (r.items || []).map((i) => i.id);
    setJustAdded(added);
    // In the order they were scanned (the picker lists newest first).
    if (media && added.length) setWalk([...ids].reverse().filter((id) => added.includes(id)));
    return true;
  };

  // move: the person picked this event for these plants, so ones in another
  // upcoming event move here (the calendar's Add plants leaves them be).
  const onEventAssign = async (saleId, ids, { move = false } = {}) => {
    try {
      const r = await api.eventAssign({ saleId, itemIds: ids, move });
      if (r.items?.length) onItemsMerged(r.items);
      const n = r.assignedIds?.length || 0;
      const name = saleById.get(saleId)?.name || 'the event';
      if (r.skipped?.length) showToast(`${n} added to ${name} · ${r.skipped.length} skipped (${r.skipped[0].sku} ${r.skipped[0].reason})`, n ? 'success' : 'error');
      else showToast(`${n} plant${n === 1 ? '' : 's'} added to ${name}`);
      return n > 0;
    } catch (e) {
      showToast(e.message || 'Could not add to the event', 'error');
      return false;
    }
  };

  const onEventUnassign = async (saleId, ids) => {
    try {
      const r = await api.eventUnassign({ saleId, itemIds: ids });
      if (r.items?.length) onItemsMerged(r.items);
      if (r.removedIds?.length) showToast('Taken out of the event');
      else showToast('Couldn\'t take it out — it\'s sold or in a box now', 'error');
    } catch (e) {
      showToast(e.message || 'Could not take it out', 'error');
    }
  };

  const onExportEvent = (sale) => {
    const r = exportPalmstreetCsv(sale, items, { separator });
    showToast(r.ok ? `Exported ${r.count} lots` : r.reason, r.ok ? 'success' : 'error');
  };

  const inPool = useMemo(() => poolItems(items)
    .sort((a, b) => String(b.poolAddedAt || '').localeCompare(String(a.poolAddedAt || ''))), [items]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const evOf = (i) => (i.saleId && openSaleIds.has(i.saleId) ? i.saleId : 'none');
    return inPool
      .filter((i) => !eventFilter || evOf(i) === eventFilter)
      .filter((i) => filter === 'all' || (filter === 'web' ? onWebsite(i) : filter === 'notweb' ? !onWebsite(i) : readiness(i).includes(filter)))
      .filter((i) => !s || [i.saleCode, i.sku, i.name, i.variety, i.listingDetails?.title, i.staffNote].some((f) => String(f || '').toLowerCase().includes(s)));
  }, [inPool, q, filter, eventFilter, openSaleIds]);
  const needs = useMemo(() => ({
    web: inPool.filter(onWebsite).length,
    notweb: inPool.filter((i) => !onWebsite(i)).length,
    photo: inPool.filter((i) => !photosOf(i).length).length,
    video: inPool.filter((i) => !videosOf(i).length).length,
    price: inPool.filter((i) => !(Number(i.listingPrice) > 0)).length,
  }), [inPool]);

  // Selection (Select → tap plants → Push to website / Take off website).
  // Only plants still in the pool count — one sold meanwhile drops out.
  const picked = useMemo(() => inPool.filter((i) => sel.has(i.id)), [inPool, sel]);
  const toPush = picked.filter((i) => !onWebsite(i));
  const toPull = picked.filter(onWebsite);
  const toggleSel = (id) => setSel((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const stopSelecting = () => { setSelecting(false); setSel(new Set()); };
  const allShownPicked = shown.length > 0 && shown.every((i) => sel.has(i.id));
  const moveWebsite = async (dir) => {
    const list = dir === 'push' ? toPush : toPull;
    if (!list.length || moving) return;
    setMoving(dir);
    try {
      const r = await setPoolFor(list.map((i) => i.id), dir === 'push' ? ON_WEBSITE : IN_POOL);
      if (r) stopSelecting();
    } finally {
      setMoving(null);
    }
  };

  // Bulk: put the selected plants in one event (moving them out of any
  // other upcoming one), or take them out of their events.
  const bulkEvent = async (saleId) => {
    if (moving) return;
    const inOther = picked.filter((i) => i.saleId && openSaleIds.has(i.saleId) && i.saleId !== saleId);
    const numbered = inOther.filter((i) => i.lotNumber).length;
    if (numbered && !window.confirm(`${numbered} of them ${numbered === 1 ? 'has' : 'have'} a number in another event's lineup. ${saleId ? 'Move' : 'Take out'} anyway?`)) return;
    setMoving('event');
    setBulkKey(saleId ?? 'none');
    try {
      if (saleId) {
        const ok = await onEventAssign(saleId, picked.map((i) => i.id), { move: true });
        if (!ok) return;
      } else {
        const groups = new Map();
        for (const i of inOther) { if (!groups.has(i.saleId)) groups.set(i.saleId, []); groups.get(i.saleId).push(i.id); }
        if (!groups.size) { showToast('None of them are in an event'); return; }
        for (const [sid, ids] of groups) await onEventUnassign(sid, ids);
      }
      setEventFor(false);
      stopSelecting();
    } finally {
      setMoving(null);
      setBulkKey(null);
    }
  };

  // The Palmstreet CSV: the pool's plants that aren't on the website (one
  // plant listed in two stores could sell twice) and aren't lined up in an
  // upcoming event (they sell in that event).
  const exportPool = () => {
    const offSite = inPool.filter((i) => !onWebsite(i));
    const listable = offSite.filter((i) => !(i.saleId && openSaleIds.has(i.saleId)));
    const held = offSite.length - listable.length;
    const web = inPool.length - offSite.length;
    const r = exportPoolToPalmstreet(listable, { separator });
    if (!r.ok) {
      showToast(!listable.length && (held || web)
        ? `Nothing to export — ${[held && `${held} in an upcoming sale event`, web && `${web} on the website`].filter(Boolean).join(', ')}`
        : r.reason, 'error');
      return;
    }
    showToast(`Exported ${r.count} plants${r.unpriced ? ` · ${r.unpriced} left out (no price)` : ''}${held ? ` · ${held} in an upcoming event` : ''}${web ? ` · ${web} on the website left out` : ''}`);
  };

  const cleanup = async () => {
    try {
      const plan = await api.mediaCleanup({ dryRun: true, days: 14 });
      if (!plan.photos && !plan.videos) { showToast('Nothing to clean — no media on plants shipped 14+ days ago'); return; }
      if (!window.confirm(`Delete ${plan.photos} photo${plan.photos === 1 ? '' : 's'} and ${plan.videos} video${plan.videos === 1 ? '' : 's'} of plants shipped 14+ days ago (or trashed)? This can't be undone.`)) return;
      const r = await api.mediaCleanup({ dryRun: false, days: 14 });
      showToast(`Deleted ${r.photos} photos and ${r.videos} videos`);
    } catch (e) {
      showToast(e.message || 'Cleanup failed', 'error');
    }
  };

  const openItem = openId ? byId.get(openId) : null;
  const unmigrated = status && status.migrated === false;
  const photosUnmigrated = status && status.migrated !== false && status.photosMigrated === false;
  const notesUnmigrated = status && status.migrated !== false && status.notesMigrated === false;
  // Shown plants still missing a photo or the video — "Photos & video" walks them.
  const needMedia = useMemo(() => shown.filter((i) => readiness(i).some((m) => m === 'photo' || m === 'video')), [shown]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">For Sale</h2>
          <p className="text-xs text-gray-500 hidden sm:block">Plants ready to sell{canWebsite ? ' — select some and push them to the website' : ''}.</p>
        </div>
        <div className="inline-flex rounded-xl bg-gray-100 p-1">
          {[{ id: 'pools', label: 'Pool', icon: LayoutGrid }, { id: 'calendar', label: 'Calendar', icon: CalendarDays }].map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id} type="button" onClick={() => setView(t.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold ${view === t.id ? 'bg-white shadow text-gray-900' : 'text-gray-500'}`}
              >
                <Icon className="w-4 h-4" /> {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {unmigrated && (
        <div className="flex gap-2 items-start bg-amber-50 border border-amber-200 text-amber-900 rounded-xl px-3 py-2.5 text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>The For Sale tab needs migration <b>0052_for_sale_pools</b>. Run it in the Supabase SQL editor, then reload.</span>
        </div>
      )}
      {photosUnmigrated && (
        <div className="flex gap-2 items-start bg-amber-50 border border-amber-200 text-amber-900 rounded-xl px-3 py-2.5 text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>Run migration <b>0053_plant_photo_urls</b> in the Supabase SQL editor — until then extra photos are saved, but the CSV and Shopify only get each plant's cover photo.</span>
        </div>
      )}
      {notesUnmigrated && (
        <div className="flex gap-2 items-start bg-amber-50 border border-amber-200 text-amber-900 rounded-xl px-3 py-2.5 text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>Run migration <b>0055_plant_videos_notes</b> in the Supabase SQL editor — until then each plant keeps one video and notes can't be saved.</span>
        </div>
      )}
      {uploads.jobs.length > 0 && (
        <div className="flex items-center gap-2 bg-gray-900 text-white rounded-xl px-3 py-2 text-xs">
          <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
          <span className="flex-1">Uploading {uploads.jobs.length} file{uploads.jobs.length === 1 ? '' : 's'} — keep the app open until it's done.</span>
        </div>
      )}

      {view === 'calendar' ? (
        <SaleCalendar
          items={items}
          sales={sales}
          isBae={isBae}
          showToast={showToast}
          onSaveSale={onSaveSale}
          onEventAssign={onEventAssign}
          onEventUnassign={onEventUnassign}
          onExportEvent={onExportEvent}
          onOpenPlant={(i) => setOpenId(i.id)}
        />
      ) : (
        <>
          {(shopifyOn || needs.web > 0) && (
            <ShopifyPanel status={status?.shopify} syncing={syncing} isAdmin={isAdmin}
              onSync={() => runSync({ force: true })}
              onDismiss={async (keys) => {
                try { await api.poolSync({ dismissProblems: keys }); } catch (e) { showToast(e.message || 'Could not dismiss', 'error'); }
                loadStatus();
              }} />
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button" onClick={() => setAdding(true)} disabled={unmigrated}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 active:bg-emerald-700 text-white text-sm font-semibold disabled:opacity-40"
            >
              <Plus className="w-4 h-4" /> Add plants
            </button>
            {inPool.length > 0 && (
              <button
                type="button" onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
                className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm font-semibold ${selecting ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 text-gray-800 active:bg-gray-100'}`}
              >
                <CheckSquare className="w-4 h-4" /> {selecting ? 'Done' : 'Select'}
              </button>
            )}
            {needMedia.length > 0 && (
              <button
                type="button" onClick={() => setWalk(needMedia.map((i) => i.id))}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-300 text-sm font-semibold text-gray-800 active:bg-gray-100"
              >
                <Camera className="w-4 h-4" /> Photos &amp; video ({needMedia.length})
              </button>
            )}
            {needs.notweb > 0 && (
              <span className="inline-flex items-stretch rounded-lg border border-gray-300 overflow-hidden">
                <button type="button" onClick={exportPool} title="The Palmstreet CSV of the plants not on the website" className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-gray-800 active:bg-gray-100">
                  <Download className="w-4 h-4" /> Export CSV
                </button>
                <select
                  value={separator} onChange={(e) => setSeparator(e.target.value)}
                  title="How the photo and video URLs share the Image URL cell"
                  className="border-l border-gray-300 bg-gray-50 text-xs text-gray-700 px-1.5"
                >
                  {Object.entries(MEDIA_SEPARATORS).map(([k, v]) => <option key={k} value={k}>Photos{v.label === 'New line' ? '↵' : v.sep === ' ' ? '␣' : v.sep}video</option>)}
                </select>
              </span>
            )}
            {shown.length > 0 && (
              <button type="button" onClick={() => onPrintLabels(shown)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-300 text-sm font-semibold text-gray-800 active:bg-gray-100">
                <Printer className="w-4 h-4" /> Tags ({shown.length})
              </button>
            )}
          </div>

          {justAdded.length > 0 && (
            <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2 text-sm text-emerald-900">
              <span className="flex-1">Added {justAdded.length}. Print their tags so the codes are on the pots.</span>
              <button type="button" onClick={() => { onPrintLabels(justAdded.map((id) => byId.get(id)).filter(Boolean)); setJustAdded([]); }} className="px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-xs font-semibold">
                Print {justAdded.length}
              </button>
              <button type="button" aria-label="Dismiss" onClick={() => setJustAdded([])} className="p-1 text-emerald-700"><X className="w-4 h-4" /></button>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex gap-2">
              <div className="relative flex-1 min-w-0">
                <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search code, SKU or name" className="input pl-9 text-base" />
              </div>
              {events.length > 0 && (
                <select
                  value={eventFilter} onChange={(e) => setEventFilter(e.target.value)} aria-label="Sale event"
                  className={`input w-auto max-w-[45%] text-sm ${eventFilter ? 'border-emerald-500 bg-emerald-50' : ''}`}
                >
                  <option value="">Any event</option>
                  {events.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  <option value="none">No event</option>
                </select>
              )}
            </div>
            <div className="flex gap-1.5 overflow-x-auto -mx-1 px-1 pb-0.5">
              {FILTERS.map((f) => (
                <button
                  key={f.id} type="button" onClick={() => setFilter(f.id)}
                  className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border ${filter === f.id ? 'bg-gray-900 text-white border-gray-900' : 'bg-white border-gray-200 text-gray-600'}`}
                >
                  {f.label}{f.id === 'all' ? ` · ${inPool.length}` : needs[f.id] ? ` · ${needs[f.id]}` : ''}
                </button>
              ))}
            </div>
          </div>

          {selecting && (
            <div className="sticky top-16 sm:top-28 z-20 bg-gray-900 text-white rounded-xl px-3 py-2 shadow-md space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-semibold">{picked.length ? `${picked.length} selected` : 'Tap plants to select them'}</span>
                <span className="flex-1" />
                {shown.length > 0 && (
                  <button
                    type="button" className="text-xs underline text-gray-300"
                    onClick={() => setSel(allShownPicked ? new Set() : new Set(shown.map((i) => i.id)))}
                  >
                    {allShownPicked ? 'Clear' : `Select all ${shown.length}`}
                  </button>
                )}
                <button type="button" aria-label="Stop selecting" onClick={stopSelecting} className="p-1 text-gray-300"><X className="w-4 h-4" /></button>
              </div>
              {picked.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {canWebsite && (
                    <button
                      type="button" onClick={() => moveWebsite('push')} disabled={!toPush.length || !!moving}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-500 active:bg-emerald-600 text-white text-sm font-semibold disabled:opacity-40"
                    >
                      {moving === 'push' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Globe className="w-4 h-4" />}
                      Push to website{toPush.length ? ` (${toPush.length})` : ''}
                    </button>
                  )}
                  {canWebsite && toPull.length > 0 && (
                    <button
                      type="button" onClick={() => moveWebsite('pull')} disabled={!!moving}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/15 active:bg-white/25 text-sm font-semibold disabled:opacity-40"
                    >
                      {moving === 'pull' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Undo2 className="w-4 h-4" />}
                      Take off website ({toPull.length})
                    </button>
                  )}
                  <button
                    type="button" onClick={() => setEventFor(true)} disabled={!!moving}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/15 active:bg-white/25 text-sm font-semibold disabled:opacity-40"
                  >
                    <CalendarDays className="w-4 h-4" /> Sale event ({picked.length})
                  </button>
                  <button
                    type="button" onClick={() => onPrintLabels(picked)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/15 active:bg-white/25 text-sm font-semibold"
                  >
                    <Printer className="w-4 h-4" /> Tags ({picked.length})
                  </button>
                </div>
              )}
              {canWebsite && picked.length > 0 && !toPush.length && (
                <div className="text-[11px] text-gray-300">All selected plants are already on the website.</div>
              )}
            </div>
          )}

          {shown.length === 0 ? (
            <div className="text-center text-sm text-gray-400 bg-white border border-dashed border-gray-200 rounded-2xl py-10 px-4">
              {inPool.length ? 'Nothing matches.' : 'The pool is empty — tap Add plants and scan their tags.'}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2.5">
              {shown.map((i) => (
                <PlantCard
                  key={i.id}
                  item={i}
                  event={i.saleId && openSaleIds.has(i.saleId) ? saleById.get(i.saleId) || null : null}
                  pausedSaleIds={pausedSaleIds}
                  shopifyConnected={shopifyOn}
                  uploading={uploadingIds.has(i.id)}
                  selecting={selecting}
                  selected={selecting && sel.has(i.id)}
                  onClick={() => (selecting ? toggleSel(i.id) : setOpenId(i.id))}
                />
              ))}
            </div>
          )}

          {isAdmin && (
            <div className="pt-2 flex justify-end">
              <button type="button" onClick={cleanup} className="inline-flex items-center gap-1.5 text-xs text-gray-500 underline">
                <HardDrive className="w-3.5 h-3.5" /> Free up storage (media of shipped plants)
              </button>
            </div>
          )}
        </>
      )}

      {adding && (
        <AddPlantsSheet items={items} onAdd={addToPool} onClose={() => setAdding(false)} showToast={showToast} />
      )}
      {walk && (
        <MediaWalkthrough
          ids={walk}
          items={items}
          uploads={uploads}
          showToast={showToast}
          onMerged={onItemsMerged}
          onChanged={followShopify}
          onClose={() => setWalk(null)}
        />
      )}
      {openItem && (
        <PlantSheet
          key={openItem.id}
          item={openItem}
          sales={sales}
          openSaleIds={openSaleIds}
          pausedSaleIds={pausedSaleIds}
          shopifyConnected={shopifyOn}
          canWebsite={canWebsite}
          notesOn={notesOn}
          showToast={showToast}
          uploads={uploads}
          onClose={() => setOpenId(null)}
          onMerged={onItemsMerged}
          onSyncShopify={(ids) => runSync({ itemIds: ids })}
          onPrintLabel={(i) => onPrintLabels([i])}
          onSetPool={setPoolFor}
          onEventAssign={onEventAssign}
          onEventUnassign={onEventUnassign}
        />
      )}
      {eventFor && (
        <Modal title={`Sale event for ${picked.length} plant${picked.length === 1 ? '' : 's'}`} onClose={() => setEventFor(false)}>
          <EventChoices events={events} value={undefined} busy={bulkKey} onPick={bulkEvent} />
        </Modal>
      )}
    </div>
  );
}

const nowMs = () => Date.now();

function ago(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((nowMs() - Date.parse(iso)) / 1000));
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

// Shopify connection: how to connect (env names, never values), or the
// sync's state and anything that needs a person (double sales, cancelled
// orders, unknown SKUs).
function ShopifyPanel({ status, syncing, isAdmin, onSync, onDismiss }) {
  if (!status) return null;
  if (!status.configured && !isAdmin) {
    return (
      <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-700">
        <Store className="w-4 h-4 shrink-0" /> The website (Shopify) isn't connected for this brand yet — plants pushed to it wait here until it is.
      </div>
    );
  }
  if (!status.configured) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl px-3 py-3 text-sm text-gray-700 space-y-1.5">
        <div className="flex items-center gap-2 font-semibold text-gray-900"><Store className="w-4 h-4" /> Shopify isn't connected</div>
        <p className="text-xs text-gray-600">
          Plants pushed to the website wait here until the store is connected. To connect: in Shopify's Dev Dashboard create an app for this store
          (scopes: products, inventory, files, publications, locations, orders, customers, fulfillment orders), install it, then add these
          Vercel environment variables and redeploy:
        </p>
        <ul className="text-xs font-mono text-gray-800 bg-gray-50 rounded-lg px-2 py-1.5 space-y-0.5">
          <li>{status.env?.shop} = your-store (the part before .myshopify.com)</li>
          <li>{status.env?.clientId}</li>
          <li>{status.env?.clientSecret}</li>
        </ul>
      </div>
    );
  }
  const problems = status.problems || [];
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm space-y-2">
      <div className="flex items-center gap-2">
        <Store className="w-4 h-4 text-lime-700 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-gray-900 truncate">{status.shop}</div>
          <div className="text-[11px] text-gray-500">Orders checked {ago(status.lastOrderPullAt)} · listings synced {ago(status.lastListingSyncAt)}</div>
        </div>
        <button type="button" onClick={onSync} disabled={syncing} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 text-xs font-semibold text-gray-800 disabled:opacity-50">
          {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Sync now
        </button>
      </div>
      {status.lastError && <div className="text-xs text-red-700">{status.lastError}</div>}
      {problems.length > 0 && (
        <div className="space-y-1">
          {problems.slice(0, 8).map((p) => (
            <div key={p.key} className="flex items-start gap-2 text-xs bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 text-amber-900">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span className="flex-1">{p.message}</span>
              <button type="button" onClick={() => onDismiss([p.key])} aria-label="Dismiss" className="shrink-0 p-0.5"><X className="w-3.5 h-3.5" /></button>
            </div>
          ))}
          {problems.length > 8 && <div className="text-[11px] text-gray-500">+{problems.length - 8} more</div>}
        </div>
      )}
    </div>
  );
}
