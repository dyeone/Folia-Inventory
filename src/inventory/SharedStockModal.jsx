import { useEffect, useMemo, useState } from 'react';
import { Search, ArrowRightLeft, Undo2, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { api } from '../api.js';
import { Modal } from '../ui/Modal.jsx';
import { brandName } from '../brands.js';

// The OTHER brand's stock, and the plants that moved between brands.
//
// Reads are read-only; the one write is "Move to <this brand>", which calls
// the transfer action: the plant then belongs to this brand like any other
// (lineups, scanning, packing, shipping, reports all see an ordinary
// plant). "Return" is the same move the other way, offered for plants that
// came in and are still unsold here. The server decides what may move; this
// screen just asks and shows the answer.

const MOVABLE = new Set(['available', 'listed', 'acclimated']);
const money = (v) => (v == null || Number.isNaN(Number(v)) ? '—' : `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const when = (t) => { try { return new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

export function SharedStockModal({ activeBrand, items, canTransfer, showCosts, onItemsChanged, showToast, onClose }) {
  const [stock, setStock] = useState(null);      // { items, brands }
  const [transfers, setTransfers] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(() => new Set());
  const [tab, setTab] = useState('stock');

  // Both reads land together after the awaits (the lint rule wants no
  // synchronous setState inside the effect body).
  const load = async () => {
    try {
      const [s, t] = await Promise.all([api.getSharedStock(), api.getItemTransfers()]);
      setStock(s);
      setTransfers(t);
      setErr('');
    } catch (e) {
      setErr(e.message || 'Could not load the other brand\'s stock.');
    }
  };
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, t] = await Promise.all([api.getSharedStock(), api.getItemTransfers()]);
        if (cancelled) return;
        setStock(s);
        setTransfers(t);
      } catch (e) {
        if (!cancelled) setErr(e.message || 'Could not load the other brand\'s stock.');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const brandLabel = (id) => stock?.brands?.[id] || transfers?.brands?.[id] || brandName(id);

  const shown = useMemo(() => {
    const list = stock?.items || [];
    const needle = q.trim().toLowerCase();
    const hit = needle
      ? list.filter((i) => [i.sku, i.name, i.variety].some((v) => String(v || '').toLowerCase().includes(needle)))
      : list;
    const groups = new Map();
    for (const i of hit) { if (!groups.has(i.brandId)) groups.set(i.brandId, []); groups.get(i.brandId).push(i); }
    return [...groups.entries()];
  }, [stock, q]);

  const mine = useMemo(() => new Map((items || []).map((i) => [i.id, i])), [items]);

  const mark = (id, on) => setBusy((prev) => { const n = new Set(prev); if (on) n.add(id); else n.delete(id); return n; });

  const move = async (item) => {
    if (!canTransfer || busy.has(item.id)) return;
    mark(item.id, true);
    try {
      const r = await api.transferItem({ itemId: item.id, fromBrandId: item.brandId, reason: 'manual' });
      setStock((s) => (s ? { ...s, items: s.items.filter((i) => i.id !== item.id) } : s));
      showToast?.(r.relabel
        ? `${item.name} moved to ${brandName(activeBrand)} as ${r.item.sku} — that SKU was taken here, print a new label`
        : `${item.name} (${item.sku}) moved to ${brandName(activeBrand)}`);
      await Promise.all([onItemsChanged?.(), api.getItemTransfers().then(setTransfers).catch(() => {})]);
    } catch (e) {
      showToast?.(e.message || 'Could not move that plant', 'error');
    } finally {
      mark(item.id, false);
    }
  };

  const giveBack = async (t) => {
    if (!canTransfer || busy.has(t.itemId)) return;
    mark(t.itemId, true);
    try {
      await api.transferItem({ itemId: t.itemId, fromBrandId: activeBrand, toBrandId: t.fromBrandId, reason: 'return' });
      showToast?.(`${t.toSku} returned to ${brandLabel(t.fromBrandId)}`, 'success');
      await Promise.all([onItemsChanged?.(), load()]);
    } catch (e) {
      showToast?.(e.message || 'Could not return that plant', 'error');
    } finally {
      mark(t.itemId, false);
    }
  };

  // A plant that came INTO this brand and is still here, unsold and not in
  // a lineup, can go back. (Its latest move must be the one into us.)
  const latestByItem = useMemo(() => {
    const m = new Map();
    for (const t of transfers?.transfers || []) if (!m.has(t.itemId)) m.set(t.itemId, t);
    return m;
  }, [transfers]);
  const returnable = (t) => {
    if (latestByItem.get(t.itemId) !== t || t.toBrandId !== activeBrand) return false;
    const it = mine.get(t.itemId);
    return !!it && MOVABLE.has(it.status) && !it.saleId && !it.shipmentBoxId;
  };

  const total = stock?.items?.length || 0;

  return (
    <Modal title="Other brand stock" onClose={onClose} size="xl">
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs">
          {[['stock', `In stock elsewhere${stock ? ` · ${total}` : ''}`], ['moves', `Moves${transfers?.transfers ? ` · ${transfers.transfers.length}` : ''}`]].map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`px-3 py-1.5 rounded-full border ${tab === id ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}
            >{label}</button>
          ))}
          <button type="button" onClick={load} title="Reload" className="ml-auto p-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50"><RefreshCw className="w-3.5 h-3.5" /></button>
        </div>

        {err && (
          <div className="flex items-center gap-2 bg-red-50 text-red-700 text-xs px-3 py-2 rounded-lg"><AlertCircle className="w-4 h-4 shrink-0" /> {err}</div>
        )}

        {tab === 'stock' && (
          <>
            <div className="text-xs text-gray-600">
              Plants the other brand has on hand. <b>Move to {brandName(activeBrand)}</b> makes one yours to list, sell and ship here; its cost comes with it and the move is recorded.
              {!canTransfer && <span className="text-amber-700"> Moving needs a staff or admin login.</span>}
            </div>
            <div className="relative">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search SKU, plant or variety…"
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg"
              />
            </div>
            {!stock && !err && <div className="flex items-center gap-2 text-sm text-gray-500 py-6 justify-center"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>}
            {stock && total === 0 && <div className="text-sm text-gray-500 py-6 text-center">The other brand has nothing in stock right now.</div>}
            {stock && total > 0 && shown.length === 0 && <div className="text-sm text-gray-500 py-6 text-center">Nothing matches "{q}".</div>}
            {shown.map(([brandId, list]) => (
              <div key={brandId} className="border border-gray-200 rounded-xl overflow-hidden">
                <div className="px-3 py-2 bg-gray-50 text-xs font-semibold text-gray-700 flex items-center justify-between">
                  <span>{brandLabel(brandId)}</span><span className="font-normal text-gray-500">{list.length} plant{list.length === 1 ? '' : 's'}</span>
                </div>
                <div className="max-h-[48vh] overflow-y-auto divide-y divide-gray-100">
                  {list.map((i) => {
                    const blocked = i.saleId ? 'in a lineup there' : i.shipmentBoxId ? 'in a box there' : !MOVABLE.has(i.status) ? i.status : null;
                    return (
                      <div key={i.id} className="px-3 py-2 flex items-center gap-3 text-sm">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-mono text-xs text-gray-500 shrink-0">{i.sku}</span>
                            <span className="font-medium text-gray-900 truncate">{i.name}</span>
                          </div>
                          <div className="text-xs text-gray-500 flex flex-wrap gap-x-2">
                            <span>{i.variety}</span>
                            <span>· {i.status}</span>
                            {i.listingPrice != null && <span>· list {money(i.listingPrice)}</span>}
                            {showCosts && i.grossCost != null && <span>· cost {money(i.grossCost)}</span>}
                            {blocked && <span className="text-amber-700">· {blocked}</span>}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={!canTransfer || !!blocked || busy.has(i.id)}
                          onClick={() => move(i)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white disabled:opacity-40 hover:bg-emerald-700 shrink-0"
                          title={blocked ? `Can't move: ${blocked}` : `Move to ${brandName(activeBrand)}`}
                        >
                          {busy.has(i.id) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRightLeft className="w-3.5 h-3.5" />}
                          Move to {brandName(activeBrand)}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </>
        )}

        {tab === 'moves' && (
          <>
            <div className="text-xs text-gray-600">Every plant that moved into or out of {brandName(activeBrand)}, newest first. A plant that came in and is still unsold here can be returned.</div>
            {transfers?.unsupported && (
              <div className="flex items-center gap-2 bg-amber-50 text-amber-800 text-xs px-3 py-2 rounded-lg"><AlertCircle className="w-4 h-4 shrink-0" /> Moving stock between brands needs migration 0046 — run it in the Supabase SQL editor first.</div>
            )}
            {transfers && !transfers.unsupported && transfers.transfers.length === 0 && <div className="text-sm text-gray-500 py-6 text-center">No moves yet.</div>}
            {transfers?.transfers?.length > 0 && (
              <div className="border border-gray-200 rounded-xl overflow-hidden max-h-[56vh] overflow-y-auto divide-y divide-gray-100">
                {transfers.transfers.map((t) => {
                  const inbound = t.toBrandId === activeBrand;
                  return (
                    <div key={t.id} className="px-3 py-2 flex items-center gap-3 text-sm">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${inbound ? 'bg-emerald-100 text-emerald-800' : 'bg-sky-100 text-sky-800'}`}>{inbound ? 'in' : 'out'}</span>
                          <span className="font-mono text-xs text-gray-500">{t.toSku}{t.toSku !== t.fromSku ? ` (was ${t.fromSku})` : ''}</span>
                          <span className="text-xs text-gray-600 truncate">{brandLabel(t.fromBrandId)} → {brandLabel(t.toBrandId)}</span>
                        </div>
                        <div className="text-xs text-gray-500 flex flex-wrap gap-x-2">
                          <span>{when(t.createdAt)}</span>
                          <span>· {t.reason === 'sale' ? 'for a sale' : t.reason === 'return' ? 'returned' : 'moved'}</span>
                          {t.createdBy && <span>· by {t.createdBy}</span>}
                          {showCosts && t.grossCost != null && <span>· at cost {money(t.grossCost)}</span>}
                        </div>
                      </div>
                      {returnable(t) && (
                        <button
                          type="button"
                          disabled={!canTransfer || busy.has(t.itemId)}
                          onClick={() => giveBack(t)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40 shrink-0"
                        >
                          {busy.has(t.itemId) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />}
                          Return to {brandLabel(t.fromBrandId)}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
