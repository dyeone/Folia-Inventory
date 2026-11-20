import { useMemo, useState, lazy, Suspense } from 'react';
import { ChevronLeft, ChevronRight, Plus, Download, Copy, X, Loader2, Search, Video } from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';
import { platformStyle, saleDay, ymd, money, isForSale, facebookPost, eventHolds, isUnsoldInEvent, photosOf } from './pools.js';

const SaleFormModal = lazy(() => import('../sales/SaleFormModal.jsx').then((m) => ({ default: m.SaleFormModal })));

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const SOLD = ['sold', 'shipped', 'delivered'];

function monthGrid(year, month) {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, k) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + k));
}

function timeOf(sale) {
  if (!sale.startTime) return '';
  const d = new Date(sale.startTime);
  return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Calendar of sale events — Palmstreet lives, Facebook sales, TikTok lives.
// Events are the same `sales` rows the Sale tab uses; plants go into one
// from the For Sale pools.
export function SaleCalendar({ items, sales, isBae, showToast, onSaveSale, onEventAssign, onEventUnassign, onExportEvent, onOpenPlant }) {
  const today = ymd(new Date());
  const [cursor, setCursor] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [day, setDay] = useState(today);
  const [creating, setCreating] = useState(null);   // initial form values
  const [openId, setOpenId] = useState(null);

  const byDay = useMemo(() => {
    const m = new Map();
    for (const s of sales || []) {
      const d = saleDay(s);
      if (!d) continue;
      if (!m.has(d)) m.set(d, []);
      m.get(d).push(s);
    }
    for (const list of m.values()) list.sort((a, b) => String(a.startTime || '').localeCompare(String(b.startTime || '')));
    return m;
  }, [sales]);

  const counts = useMemo(() => {
    const m = new Map();
    for (const i of items || []) {
      if (!i.saleId || i.deletedAt) continue;
      const c = m.get(i.saleId) || { staged: 0, sold: 0 };
      if (SOLD.includes(i.status)) c.sold += 1; else if (isUnsoldInEvent(i)) c.staged += 1;
      m.set(i.saleId, c);
    }
    return m;
  }, [items]);

  const upcoming = useMemo(() => (sales || [])
    .filter((s) => s.status !== 'closed' && saleDay(s) >= today && saleDay(s) !== day)
    .sort((a, b) => saleDay(a).localeCompare(saleDay(b)) || String(a.startTime || '').localeCompare(String(b.startTime || '')))
    .slice(0, 8), [sales, today, day]);

  const cells = monthGrid(cursor.y, cursor.m);
  const monthLabel = new Date(cursor.y, cursor.m, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
  const shift = (n) => setCursor(({ y, m }) => { const d = new Date(y, m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const dayEvents = byDay.get(day) || [];
  const openSale = openId ? (sales || []).find((s) => s.id === openId) : null;

  const eventRow = (s) => {
    const st = platformStyle(s.platform);
    const c = counts.get(s.id) || { staged: 0, sold: 0 };
    return (
      <button key={s.id} type="button" onClick={() => setOpenId(s.id)} className="w-full text-left flex items-center gap-3 px-3 py-2.5 bg-white border border-gray-200 rounded-xl active:bg-gray-50">
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${st.dot}`} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-gray-900 truncate">{s.name}</div>
          <div className="text-xs text-gray-500 truncate">
            {st.label}{saleDay(s) ? ` · ${saleDay(s)}` : ''}{timeOf(s) ? ` · ${timeOf(s)}` : ''}{s.status === 'closed' ? ' · closed' : ''}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm font-semibold text-gray-900">{c.staged}</div>
          <div className="text-[10px] text-gray-500">{c.sold ? `${c.sold} sold` : 'plants'}</div>
        </div>
      </button>
    );
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-gray-200 p-3">
        <div className="flex items-center justify-between mb-2">
          <button type="button" onClick={() => shift(-1)} aria-label="Previous month" className="p-2 rounded-lg active:bg-gray-100"><ChevronLeft className="w-5 h-5" /></button>
          <div className="text-base font-semibold text-gray-900">{monthLabel}</div>
          <button type="button" onClick={() => shift(1)} aria-label="Next month" className="p-2 rounded-lg active:bg-gray-100"><ChevronRight className="w-5 h-5" /></button>
        </div>
        <div className="grid grid-cols-7 text-center text-[11px] font-semibold text-gray-400 mb-1">
          {WEEKDAYS.map((w, k) => <div key={k}>{w}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-0.5">
          {cells.map((d) => {
            const key = ymd(d);
            const evs = byDay.get(key) || [];
            const inMonth = d.getMonth() === cursor.m;
            const isSel = key === day;
            return (
              <button
                key={key} type="button" onClick={() => setDay(key)}
                className={`relative h-12 sm:h-20 rounded-lg flex flex-col items-center sm:items-stretch pt-1 px-0.5 text-sm ${
                  isSel ? 'bg-emerald-600 text-white' : inMonth ? 'text-gray-900 active:bg-gray-100' : 'text-gray-300'
                }`}
              >
                <span className={`text-xs sm:text-sm sm:px-1 ${key === today && !isSel ? 'font-bold text-emerald-700' : 'font-medium'}`}>{d.getDate()}</span>
                {/* Phone: dots. Wider screens: event names. */}
                <span className="flex gap-0.5 mt-1 sm:hidden">
                  {evs.slice(0, 3).map((s) => <span key={s.id} className={`w-1.5 h-1.5 rounded-full ${isSel ? 'bg-white' : platformStyle(s.platform).dot}`} />)}
                </span>
                <span className="hidden sm:flex flex-col gap-0.5 mt-0.5 overflow-hidden">
                  {evs.slice(0, 2).map((s) => (
                    <span key={s.id} className={`truncate text-[10px] leading-tight px-1 py-0.5 rounded border text-left ${isSel ? 'bg-white/20 border-white/30 text-white' : platformStyle(s.platform).chip}`}>{s.name}</span>
                  ))}
                  {evs.length > 2 && <span className={`text-[10px] ${isSel ? 'text-white/80' : 'text-gray-400'}`}>+{evs.length - 2}</span>}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-700">
            {new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}
          </h3>
          <button
            type="button" onClick={() => setCreating({ date: day, platform: 'Palmstreet' })}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold active:bg-emerald-700"
          >
            <Plus className="w-4 h-4" /> New event
          </button>
        </div>
        {dayEvents.length ? dayEvents.map(eventRow) : (
          <div className="text-sm text-gray-400 bg-white border border-dashed border-gray-200 rounded-xl px-3 py-4 text-center">No events this day</div>
        )}
      </div>

      {upcoming.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-700">Coming up</h3>
          {upcoming.map(eventRow)}
        </div>
      )}

      {creating && (
        <Suspense fallback={null}>
          <SaleFormModal
            initial={creating}
            isBae={isBae}
            onClose={() => setCreating(null)}
            onSave={async (data) => {
              const ok = await onSaveSale(data);
              if (ok) { setCreating(null); setDay(data.date || day); }
            }}
          />
        </Suspense>
      )}
      {openSale && (
        <EventSheet
          sale={openSale}
          items={items}
          sales={sales}
          showToast={showToast}
          onClose={() => setOpenId(null)}
          onEventAssign={onEventAssign}
          onEventUnassign={onEventUnassign}
          onExportEvent={onExportEvent}
          onOpenPlant={onOpenPlant}
        />
      )}
    </div>
  );
}

// One event: its plants, add more from the pools, take unsold ones out,
// and the per-platform hand-off (Palmstreet CSV / Facebook post text).
function EventSheet({ sale, items, sales, showToast, onClose, onEventAssign, onEventUnassign, onExportEvent, onOpenPlant }) {
  const [picking, setPicking] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const st = platformStyle(sale.platform);
  const isPalmstreet = String(sale.platform || '').toLowerCase() === 'palmstreet';
  const isFacebook = String(sale.platform || '').toLowerCase() === 'facebook';
  const closed = sale.status === 'closed';

  const plants = useMemo(() => (items || [])
    .filter((i) => i.saleId === sale.id && !i.deletedAt)
    .sort((a, b) => (parseInt(a.lotNumber, 10) || 1e9) - (parseInt(b.lotNumber, 10) || 1e9)
      || String(a.saleCode || a.sku).localeCompare(String(b.saleCode || b.sku))), [items, sale.id]);
  const unsold = plants.filter(isUnsoldInEvent);

  const copyPost = async () => {
    const text = facebookPost(sale, unsold);
    try {
      await navigator.clipboard.writeText(text);
      showToast('Post text copied');
    } catch {
      window.prompt('Copy the post text:', text);
    }
  };

  const remove = async (i) => {
    setBusyId(i.id);
    try { await onEventUnassign(sale.id, [i.id]); } finally { setBusyId(null); }
  };

  return (
    <Modal title={sale.name} onClose={onClose} size="lg">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`px-2 py-0.5 rounded-full border font-semibold ${st.chip}`}>{st.label}</span>
          <span className="text-gray-500">{saleDay(sale)}{timeOf(sale) ? ` · ${timeOf(sale)}` : ''}</span>
          <span className="text-gray-500">· {unsold.length} plant{unsold.length === 1 ? '' : 's'}{plants.length - unsold.length ? ` · ${plants.length - unsold.length} sold` : ''}</span>
          {closed && <span className="text-gray-500">· closed</span>}
        </div>

        <div className="flex flex-wrap gap-2">
          {!closed && (
            <button type="button" onClick={() => setPicking(true)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold active:bg-emerald-700">
              <Plus className="w-4 h-4" /> Add plants
            </button>
          )}
          {isPalmstreet && plants.length > 0 && (
            <button type="button" onClick={() => onExportEvent(sale)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-300 text-sm font-semibold text-gray-800">
              <Download className="w-4 h-4" /> Palmstreet CSV
            </button>
          )}
          {isFacebook && unsold.length > 0 && (
            <button type="button" onClick={copyPost} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-300 text-sm font-semibold text-gray-800">
              <Copy className="w-4 h-4" /> Copy post text
            </button>
          )}
        </div>
        {isPalmstreet && unsold.some((i) => !i.lotNumber) && (
          <p className="text-[11px] text-gray-500">Lineup numbers are given on the Sale tab's Pre Sale screen, as usual.</p>
        )}

        {plants.length === 0 ? (
          <div className="text-sm text-gray-400 border border-dashed border-gray-200 rounded-xl px-3 py-6 text-center">No plants yet — add some from the pools.</div>
        ) : (
          <div className="divide-y divide-gray-100 border border-gray-200 rounded-xl overflow-hidden">
            {plants.map((i) => {
              const sold = !isUnsoldInEvent(i);
              return (
                <div key={i.id} className="flex items-center gap-2.5 px-3 py-2 bg-white">
                  <button type="button" onClick={() => onOpenPlant(i)} className="shrink-0 relative">
                    {photosOf(i)[0] ? <img src={photosOf(i)[0]} alt="" className="w-12 h-12 rounded-lg object-cover" /> : <div className="w-12 h-12 rounded-lg bg-gray-100" />}
                    {i.videoUrl && <Video className="w-3.5 h-3.5 text-white absolute bottom-0.5 right-0.5 drop-shadow" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-gray-900 truncate">
                      {i.lotNumber ? <span className="font-bold mr-1">#{i.lotNumber}</span> : null}
                      {i.saleCode ? <span className="font-mono font-bold mr-1">{i.saleCode}</span> : null}
                      {i.listingDetails?.title || i.name}
                    </div>
                    <div className="text-[11px] text-gray-500 truncate">
                      <span className="font-mono">{i.sku}</span> · {sold
                        ? <span className="text-green-700 font-semibold">{SOLD.includes(i.status) ? `sold ${money(i.salePrice)}` : i.status}</span>
                        : money(i.listingPrice)}
                    </div>
                  </div>
                  {!sold && !closed && (
                    <button type="button" onClick={() => remove(i)} disabled={busyId === i.id} aria-label={`Take ${i.sku} out`} className="p-2 rounded-lg text-gray-400 active:bg-gray-100 disabled:opacity-40">
                      {busyId === i.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {picking && (
        <EventPicker
          sale={sale}
          items={items}
          sales={sales}
          onClose={() => setPicking(false)}
          onAdd={async (ids) => {
            const ok = await onEventAssign(sale.id, ids);
            if (ok) setPicking(false);
          }}
        />
      )}
    </Modal>
  );
}

// Choose plants for an event from the For Sale pool.
function EventPicker({ sale, items, sales, onClose, onAdd }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState([]);
  const [busy, setBusy] = useState(false);
  const openOther = useMemo(() => new Map((sales || [])
    .filter((s) => eventHolds(s) && s.id !== sale.id).map((s) => [s.id, s.name])), [sales, sale.id]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (items || [])
      .filter((i) => i.salePool && isForSale(i) && ['available', 'listed'].includes(i.status) && i.saleId !== sale.id)
      .filter((i) => !s || [i.sku, i.name, i.saleCode, i.variety, i.listingDetails?.title].some((f) => String(f || '').toLowerCase().includes(s)))
      .sort((a, b) => String(a.saleCode || '').localeCompare(String(b.saleCode || '')));
  }, [items, q, sale.id]);

  const why = (i) => {
    if (i.saleId && openOther.has(i.saleId)) return `in ${openOther.get(i.saleId)}`;
    if (sale.itemTypes === 'tc' && i.type !== 'tc') return 'not a TC';
    if (sale.itemTypes === 'plant' && i.type !== 'plant') return 'not a plant';
    return '';
  };
  const pickable = list.filter((i) => !why(i));
  const allOn = pickable.length > 0 && pickable.every((i) => sel.includes(i.id));
  const toggle = (id) => setSel((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <Modal title={`Add plants · ${sale.name}`} onClose={onClose} size="lg">
      <div className="space-y-3">
        <div className="relative">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search code, SKU or name" className="input pl-9 text-base" />
        </div>
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>{list.length} in the pool · {sel.length} picked</span>
          {pickable.length > 0 && (
            <button
              type="button" className="underline"
              onClick={() => setSel(allOn
                ? sel.filter((id) => !pickable.some((i) => i.id === id))
                : [...new Set([...sel, ...pickable.map((i) => i.id)])])}
            >
              {allOn ? 'Clear' : 'Pick all'}
            </button>
          )}
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-[45vh] overflow-y-auto">
          {list.map((i) => {
            const blocked = why(i);
            const on = sel.includes(i.id);
            return (
              <button
                key={i.id} type="button" disabled={!!blocked} onClick={() => toggle(i.id)}
                className={`relative rounded-lg overflow-hidden border-2 text-left ${on ? 'border-emerald-500' : 'border-transparent'} disabled:opacity-40`}
              >
                <div className="relative aspect-square bg-gray-100 overflow-hidden">
                  {photosOf(i)[0] && <img src={photosOf(i)[0]} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />}
                </div>
                {i.saleCode && <span className="absolute top-1 left-1 px-1.5 rounded bg-black/80 text-white font-mono font-bold text-xs">{i.saleCode}</span>}
                {on && <span className="absolute top-1 right-1 w-5 h-5 rounded-full bg-emerald-500 text-white text-xs flex items-center justify-center">✓</span>}
                <div className="px-1 py-0.5 text-[10px] text-gray-700 truncate">{blocked || `${money(i.listingPrice)} · ${i.name}`}</div>
              </button>
            );
          })}
        </div>
        {list.length === 0 && <p className="text-sm text-gray-400 text-center py-4">No pool plants to add. Add plants to a pool first.</p>}
        <button
          type="button" disabled={!sel.length || busy}
          onClick={async () => { setBusy(true); try { await onAdd(sel); } finally { setBusy(false); } }}
          className="w-full py-3 rounded-xl bg-emerald-600 text-white font-semibold disabled:opacity-40 flex items-center justify-center gap-2"
        >
          {busy && <Loader2 className="w-4 h-4 animate-spin" />} Add {sel.length || ''} to {sale.name}
        </button>
      </div>
    </Modal>
  );
}

