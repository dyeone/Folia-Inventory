import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus, Search, Download, RefreshCw, Printer, Store, CalendarDays, LayoutGrid, AlertTriangle, Loader2, X, HardDrive,
} from 'lucide-react';
import { api } from '../api.js';
import { PlantCard } from './PlantCard.jsx';
import { PlantSheet } from './PlantSheet.jsx';
import { AddPlantsSheet } from './AddPlantsSheet.jsx';
import { SaleCalendar } from './SaleCalendar.jsx';
import { POOLS, poolItems, openSaleIdSet, readiness } from './pools.js';
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
  { id: 'photo', label: 'Needs photo' },
  { id: 'video', label: 'Needs video' },
  { id: 'price', label: 'Needs price' },
];

// The For Sale tab: plants ready to sell, in two product pools — Palmstreet
// (exported as the CSV, photo + video in the Image URL cell) and Shopify
// (synced automatically) — each with its short code, one photo and one
// video; plus a calendar of sale events to put plants into. Phone first.
export function ForSaleView({ items, sales, isBae, isAdmin, showToast, onItemsMerged, onPrintLabels, onSaveSale }) {
  const [view, setView] = useStored('forsale.view', 'pools', ['pools', 'calendar']);
  const [pool, setPool] = useStored('forsale.pool', 'palmstreet', ['palmstreet', 'shopify']);
  const [separator, setSeparator] = useStored('forsale.mediaSep', 'comma', Object.keys(MEDIA_SEPARATORS));
  const [status, setStatus] = useState(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [justAdded, setJustAdded] = useState([]);
  const syncingRef = useRef(false);
  const pendingRef = useRef(new Set());   // plants to sync once the running sync ends

  const shopifyOn = !!status?.shopify?.configured;
  const openSaleIds = useMemo(() => openSaleIdSet(sales), [sales]);
  const saleName = useMemo(() => new Map((sales || []).map((s) => [s.id, s.name])), [sales]);
  const byId = useMemo(() => new Map((items || []).map((i) => [i.id, i])), [items]);

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

  useEffect(() => {
    if (!shopifyOn) return undefined;
    const first = setTimeout(() => runSync({ quiet: true }), 0);
    const id = setInterval(() => { if (document.visibilityState === 'visible') runSync({ quiet: true }); }, SYNC_EVERY_MS);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [shopifyOn, runSync]);

  const setPoolFor = useCallback(async (ids, toPool) => {
    try {
      const r = await api.poolSet({ itemIds: ids, pool: toPool });
      if (r.items?.length) onItemsMerged(r.items);
      if (r.skipped?.length) {
        const first = r.skipped[0];
        showToast(`${r.skipped.length} skipped — ${first.sku || 'a plant'} ${first.reason}`, 'error');
      } else if (toPool) {
        showToast(`${r.items.length} in the ${POOLS.find((p) => p.id === toPool)?.label} pool`);
      } else {
        showToast('Taken out of For Sale');
      }
      if (r.shopify?.error) showToast(`Shopify: ${r.shopify.error}`, 'error');
      return r;
    } catch (e) {
      showToast(e.message || 'Could not update the pool', 'error');
      return null;
    }
  }, [onItemsMerged, showToast]);

  const addToPool = async (ids, toPool) => {
    const r = await setPoolFor(ids, toPool);
    if (!r) return false;
    setPool(toPool);
    setView('pools');
    setJustAdded((r.items || []).map((i) => i.id));
    return true;
  };

  const onEventAssign = async (saleId, ids) => {
    try {
      const r = await api.eventAssign({ saleId, itemIds: ids });
      if (r.items?.length) onItemsMerged(r.items);
      const n = r.assignedIds?.length || 0;
      if (r.skipped?.length) showToast(`${n} added · ${r.skipped.length} skipped (${r.skipped[0].sku} ${r.skipped[0].reason})`, n ? 'success' : 'error');
      else showToast(`${n} plant${n === 1 ? '' : 's'} added`);
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

  const inPool = useMemo(() => poolItems(items, pool)
    .sort((a, b) => String(b.poolAddedAt || '').localeCompare(String(a.poolAddedAt || ''))), [items, pool]);
  const counts = useMemo(() => Object.fromEntries(POOLS.map((p) => [p.id, poolItems(items, p.id).length])), [items]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return inPool
      .filter((i) => filter === 'all' || readiness(i).includes(filter))
      .filter((i) => !s || [i.saleCode, i.sku, i.name, i.variety, i.listingDetails?.title].some((f) => String(f || '').toLowerCase().includes(s)));
  }, [inPool, q, filter]);
  const needs = useMemo(() => ({
    photo: inPool.filter((i) => !i.imageUrl).length,
    video: inPool.filter((i) => !i.videoUrl).length,
    price: inPool.filter((i) => !(Number(i.listingPrice) > 0)).length,
  }), [inPool]);

  // Plants lined up in an upcoming event are left out of the store CSV —
  // they sell in that event.
  const exportPool = () => {
    const listable = inPool.filter((i) => !(i.saleId && openSaleIds.has(i.saleId)));
    const held = inPool.length - listable.length;
    const r = exportPoolToPalmstreet(listable, { separator });
    if (!r.ok) { showToast(held && !listable.length ? `All ${held} are in an upcoming sale event` : r.reason, 'error'); return; }
    showToast(`Exported ${r.count} plants${r.unpriced ? ` · ${r.unpriced} left out (no price)` : ''}${held ? ` · ${held} in an upcoming event` : ''}`);
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">For Sale</h2>
          <p className="text-xs text-gray-500 hidden sm:block">Plants ready to sell — one photo, one video and a short code each.</p>
        </div>
        <div className="inline-flex rounded-xl bg-gray-100 p-1">
          {[{ id: 'pools', label: 'Pools', icon: LayoutGrid }, { id: 'calendar', label: 'Calendar', icon: CalendarDays }].map((t) => {
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
          <div className="grid grid-cols-2 gap-2">
            {POOLS.map((p) => (
              <button
                key={p.id} type="button" onClick={() => setPool(p.id)}
                className={`flex items-center justify-between px-3 py-2.5 rounded-xl border-2 text-left ${
                  pool === p.id ? 'border-emerald-500 bg-emerald-50' : 'border-gray-200 bg-white'
                }`}
              >
                <span>
                  <span className={`block text-sm font-semibold ${pool === p.id ? 'text-emerald-900' : 'text-gray-800'}`}>{p.label}</span>
                  <span className="block text-[11px] text-gray-500">{p.hint}</span>
                </span>
                <span className={`text-lg font-bold ${pool === p.id ? 'text-emerald-700' : 'text-gray-400'}`}>{counts[p.id]}</span>
              </button>
            ))}
          </div>

          {pool === 'shopify' && (
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
            {pool === 'palmstreet' && (
              <span className="inline-flex items-stretch rounded-lg border border-gray-300 overflow-hidden">
                <button type="button" onClick={exportPool} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-gray-800 active:bg-gray-100">
                  <Download className="w-4 h-4" /> Export CSV
                </button>
                <select
                  value={separator} onChange={(e) => setSeparator(e.target.value)}
                  title="How the photo and video URLs share the Image URL cell"
                  className="border-l border-gray-300 bg-gray-50 text-xs text-gray-700 px-1.5"
                >
                  {Object.entries(MEDIA_SEPARATORS).map(([k, v]) => <option key={k} value={k}>Photo{v.label === 'New line' ? '↵' : v.sep === ' ' ? '␣' : v.sep}video</option>)}
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
            <div className="relative">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search code, SKU or name" className="input pl-9 text-base" />
            </div>
            <div className="flex gap-1.5 overflow-x-auto -mx-1 px-1 pb-0.5">
              {FILTERS.map((f) => (
                <button
                  key={f.id} type="button" onClick={() => setFilter(f.id)}
                  className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border ${filter === f.id ? 'bg-gray-900 text-white border-gray-900' : 'bg-white border-gray-200 text-gray-600'}`}
                >
                  {f.label}{f.id !== 'all' && needs[f.id] ? ` · ${needs[f.id]}` : ''}
                </button>
              ))}
            </div>
          </div>

          {shown.length === 0 ? (
            <div className="text-center text-sm text-gray-400 bg-white border border-dashed border-gray-200 rounded-2xl py-10 px-4">
              {inPool.length ? 'Nothing matches.' : `The ${POOLS.find((p) => p.id === pool)?.label} pool is empty — tap Add plants and scan their tags.`}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2.5">
              {shown.map((i) => (
                <PlantCard
                  key={i.id}
                  item={i}
                  pool={pool}
                  eventName={i.saleId && openSaleIds.has(i.saleId) ? saleName.get(i.saleId) : null}
                  openSaleIds={openSaleIds}
                  shopifyConnected={shopifyOn}
                  onClick={() => setOpenId(i.id)}
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
        <AddPlantsSheet items={items} pool={pool} onAdd={addToPool} onClose={() => setAdding(false)} showToast={showToast} />
      )}
      {openItem && (
        <PlantSheet
          key={openItem.id}
          item={openItem}
          sales={sales}
          openSaleIds={openSaleIds}
          shopifyConnected={shopifyOn}
          showToast={showToast}
          onClose={() => setOpenId(null)}
          onMerged={onItemsMerged}
          onSyncShopify={(ids) => runSync({ itemIds: ids })}
          onPrintLabel={(i) => onPrintLabels([i])}
          onSetPool={setPoolFor}
        />
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
  if (!status.configured) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl px-3 py-3 text-sm text-gray-700 space-y-1.5">
        <div className="flex items-center gap-2 font-semibold text-gray-900"><Store className="w-4 h-4" /> Shopify isn't connected</div>
        <p className="text-xs text-gray-600">
          Plants in this pool are kept here until the store is connected. To connect: in Shopify's Dev Dashboard create an app for this store
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
              {isAdmin && <button type="button" onClick={() => onDismiss([p.key])} aria-label="Dismiss" className="shrink-0 p-0.5"><X className="w-3.5 h-3.5" /></button>}
            </div>
          ))}
          {problems.length > 8 && <div className="text-[11px] text-gray-500">+{problems.length - 8} more</div>}
        </div>
      )}
    </div>
  );
}
