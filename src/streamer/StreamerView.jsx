import { useContext, useEffect, useMemo, useState } from 'react';
import { LogOut, Radio, CalendarDays, CalendarCheck, Boxes, Search, ChevronLeft, ChevronRight, Loader2, AlertCircle, Package, ChevronDown } from 'lucide-react';
import { api } from '../api.js';
import { AuthContext } from '../AuthContext.js';
import { AvailabilityForm } from '../schedule/AvailabilityForm.jsx';
import { mondayOf, todayStr, addDays, weekDays, dayName, shortDate, weekLabel, fmtRange, fmtHours, hoursBetween } from '../schedule/weekUtils.js';

// The streamer's screen (mobile first, like the consultant's): three tabs.
//   Availability — this week and the next two, by the hour (AvailabilityForm)
//   Schedule     — the published week: everyone's shifts, theirs first
//   Inventory    — what is AVAILABLE to sell: name, SKU, variety, the list
//                  price and the consultant's sell note. Never a cost: the
//                  reads are the consultant-safe ones (items action=stock,
//                  species GET strips wholesale prices for this role).

const TABS = [['availability', 'Availability'], ['schedule', 'Schedule'], ['inventory', 'Inventory']];
const TAB_ICON = { availability: <CalendarDays className="w-6 h-6" />, schedule: <CalendarCheck className="w-6 h-6" />, inventory: <Boxes className="w-6 h-6" /> };

// The schedule and availability are shared across brands (one team); only
// the Inventory tab is per brand, so the brand strip shows there alone.
// Switching brand remounts the app, so the open tab is remembered.
const TAB_KEY = 'streamer-tab';
export function StreamerView({ onLogout, onSwitchToPacker }) {
  const { currentUser, activeBrand, brands, switchBrand } = useContext(AuthContext);
  const [tab, setTabState] = useState(() => { try { const t = localStorage.getItem(TAB_KEY); return TABS.some(([id]) => id === t) ? t : 'availability'; } catch { return 'availability'; } });
  const setTab = (t) => { setTabState(t); try { localStorage.setItem(TAB_KEY, t); } catch { /* fine */ } };
  const [toast, setToast] = useState(null);
  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 2500); };

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      <div className="bg-emerald-700 text-white pt-safe flex-shrink-0">
        <div className="h-16 px-3 flex items-center gap-2 max-w-md mx-auto">
          <div className="w-12 h-12 -ml-2 rounded-full flex items-center justify-center"><Radio className="w-6 h-6" /></div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-lg leading-tight truncate">{currentUser.displayName}</div>
            <div className="text-sm text-emerald-100 leading-tight truncate mt-0.5">Streamer · {TABS.find(([id]) => id === tab)?.[1]}{tab === 'inventory' && brands?.length > 1 ? ` · ${brands.find((b) => b.id === activeBrand)?.name || activeBrand}` : ''}</div>
          </div>
          {onSwitchToPacker && (
            <button onClick={onSwitchToPacker} aria-label="Switch to the packing bench" title="Packing bench — shipping, labels, acclimation" className="h-12 px-3 rounded-full flex items-center gap-1.5 text-sm font-semibold hover:bg-emerald-800 active:bg-emerald-900">
              <Package className="w-5 h-5" /><span className="hidden sm:inline">Packing</span>
            </button>
          )}
          <button onClick={onLogout} aria-label="Log out" className="w-12 h-12 -mr-2 rounded-full flex items-center justify-center hover:bg-emerald-800 active:bg-emerald-900"><LogOut className="w-6 h-6" /></button>
        </div>
      </div>
      {brands && brands.length > 1 && tab === 'inventory' && (
        <div className="flex-shrink-0 bg-white border-b border-gray-200 px-3 py-2.5">
          <div className="max-w-md mx-auto flex items-center gap-2">
            {brands.map((b) => {
              const active = b.id === activeBrand;
              return (
                <button key={b.id} type="button" onClick={() => { if (!active) switchBrand(b.id); }} aria-pressed={active}
                  className={`flex-1 h-11 rounded-xl border-2 text-sm font-semibold inline-flex items-center justify-center gap-2 ${active ? 'text-white' : 'bg-white text-gray-600 border-gray-200'}`}
                  style={active ? { background: b.accent, borderColor: b.accent } : undefined}>
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: active ? '#fff' : b.accent }} />{b.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex-1 w-full max-w-md mx-auto px-3 py-3 pb-28">
        {tab === 'availability' && <AvailabilityTab />}
        {tab === 'schedule' && <ScheduleTab me={currentUser.id} />}
        {tab === 'inventory' && <InventoryTab key={activeBrand} showToast={showToast} />}
      </div>

      <nav className="fixed bottom-0 inset-x-0 z-20 bg-white border-t border-gray-200 pb-safe">
        <div className="max-w-md mx-auto grid grid-cols-3">
          {TABS.map((t) => (
            <button key={t[0]} type="button" onClick={() => setTab(t[0])} aria-current={tab === t[0] ? 'page' : undefined}
              className={`h-16 flex flex-col items-center justify-center gap-1 text-xs font-semibold ${tab === t[0] ? 'text-emerald-700' : 'text-gray-500'}`}>
              {TAB_ICON[t[0]]}{t[1]}
            </button>
          ))}
        </div>
      </nav>

      {toast && (
        <div className={`fixed left-1/2 -translate-x-1/2 bottom-24 z-50 px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg ${toast.type === 'error' ? 'bg-red-600 text-white' : 'bg-gray-900 text-white'}`}>{toast.msg}</div>
      )}
    </div>
  );
}

// ─── Availability ────────────────────────────────────────────────────────
function AvailabilityTab() {
  const thisWeek = mondayOf(todayStr());
  const weeks = [thisWeek, addDays(thisWeek, 7), addDays(thisWeek, 14)];
  const [week, setWeek] = useState(weeks[1]);
  return (
    <div className="space-y-3">
      <div className="flex gap-1.5 flex-wrap">
        {weeks.map((w, i) => (
          <button key={w} type="button" onClick={() => setWeek(w)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${week === w ? 'bg-gray-900 text-white border-gray-900' : 'bg-white border-gray-300 text-gray-700'}`}>
            {i === 0 ? 'This week' : i === 1 ? 'Next week' : 'In two weeks'}
          </button>
        ))}
      </div>
      <AvailabilityForm key={week} week={week} stickySubmit />
    </div>
  );
}

// ─── Schedule ────────────────────────────────────────────────────────────
function ScheduleTab({ me }) {
  const [week, setWeek] = useState(() => mondayOf(todayStr()));
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let cancelled = false;
    api.getShiftWeek(week).then((r) => { if (!cancelled) { setData(r); setErr(''); } }).catch((e) => { if (!cancelled) setErr(e.message || 'Could not load the schedule.'); });
    return () => { cancelled = true; };
  }, [week]);
  const loading = !data || data.week !== week;
  const dates = useMemo(() => weekDays(week), [week]);
  const today = todayStr();
  const nameOf = (id) => data?.users?.find((u) => u.id === id)?.displayName || '—';
  const shifts = data?.schedule?.shifts || [];
  const mine = shifts.filter((s) => s.userId === me);
  const myHours = mine.reduce((n, s) => n + hoursBetween(s.from, s.to), 0);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => setWeek(addDays(week, -7))} className="p-2 rounded-lg border border-gray-300 bg-white" aria-label="Previous week"><ChevronLeft className="w-4 h-4" /></button>
        <button type="button" onClick={() => setWeek(mondayOf(todayStr()))} className="px-3 py-2 rounded-lg border border-gray-300 bg-white text-sm">This week</button>
        <button type="button" onClick={() => setWeek(addDays(week, 7))} className="p-2 rounded-lg border border-gray-300 bg-white" aria-label="Next week"><ChevronRight className="w-4 h-4" /></button>
        <div className="ml-auto text-sm font-semibold text-gray-900">{weekLabel(week)}</div>
      </div>
      {err && <div className="flex items-center gap-2 bg-red-50 text-red-700 text-sm px-3 py-2 rounded-lg"><AlertCircle className="w-4 h-4 shrink-0" /> {err}</div>}
      {loading && !err && <div className="flex items-center gap-2 text-sm text-gray-500 py-4"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>}
      {!loading && !data.schedule?.published && (
        <div className="rounded-xl border border-gray-200 bg-white px-3 py-4 text-sm text-gray-600 text-center">{data.schedule?.hidden ? 'This week is still being planned.' : 'No schedule published for this week yet.'}</div>
      )}
      {!loading && data.schedule?.published && (
        <>
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            <b>Your week:</b> {mine.length ? `${mine.length} shift${mine.length === 1 ? '' : 's'} · ${fmtHours(myHours)}` : 'no shifts'}
          </div>
          {dates.map((d) => {
            const day = shifts.filter((s) => s.date === d).sort((a, b) => a.from.localeCompare(b.from));
            return (
              <div key={d} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                <div className={`px-3 py-1.5 text-sm font-semibold flex items-center justify-between ${d === today ? 'bg-emerald-50 text-emerald-800' : 'bg-gray-50 text-gray-800'}`}>
                  <span>{dayName(d)} {shortDate(d)}{d === today ? ' · today' : ''}</span>
                  <span className="text-xs font-normal text-gray-500">{day.length ? `${new Set(day.map((s) => s.userId)).size} on` : 'nobody on'}</span>
                </div>
                {day.length > 0 && (
                  <ul className="divide-y divide-gray-100">
                    {day.map((s) => (
                      <li key={s.id} className={`px-3 py-2 text-sm flex items-center gap-2 ${s.userId === me ? 'bg-emerald-50/60' : ''}`}>
                        <span className={`font-medium ${s.userId === me ? 'text-emerald-900' : 'text-gray-900'}`}>{s.userId === me ? 'You' : nameOf(s.userId)}</span>
                        <span className="text-gray-600 tabular-nums">{fmtRange(s.from, s.to)}</span>
                        {s.label && <span className="text-xs text-gray-500 truncate">· {s.label}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

// ─── Inventory ───────────────────────────────────────────────────────────
const money = (v) => (v == null || Number.isNaN(Number(v)) ? null : `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`);

function InventoryTab({ showToast }) {
  const [items, setItems] = useState(null);
  const [species, setSpecies] = useState([]);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(() => new Set());   // groups showing every SKU
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [stock, sp] = await Promise.all([api.getStockItems(), api.getSpecies()]);
        if (cancelled) return;
        setItems((stock || []).filter((i) => i.status === 'available' || i.status === 'listed'));
        setSpecies(sp || []);
      } catch (e) {
        if (!cancelled) { setErr(e.message || 'Could not load the inventory.'); showToast?.(e.message || 'Could not load', 'error'); }
      }
    })();
    return () => { cancelled = true; };
  }, [showToast]);
  const speciesById = useMemo(() => new Map(species.map((s) => [s.id, s])), [species]);

  // One card per species (the same plant listed many times reads as a
  // count, not a wall of rows); plants without a catalog link group by
  // name + variety. Search matches the name, variety or any SKU in the group.
  const groups = useMemo(() => {
    const m = new Map();
    for (const i of items || []) {
      const sp = speciesById.get(i.speciesId);
      const key = i.speciesId || `${i.name || ''}|${i.variety || ''}`;
      if (!m.has(key)) m.set(key, { key, name: i.name || sp?.epithet || '', variety: i.variety || '', listPrice: sp?.idealSellingPrice ?? null, sellNote: sp?.sellNote || '', items: [] });
      const g = m.get(key);
      g.items.push(i);
      if (g.listPrice == null && i.listingPrice != null) g.listPrice = i.listingPrice;
    }
    const needle = q.trim().toLowerCase();
    const list = [...m.values()].filter((g) => !needle || [g.name, g.variety].some((v) => String(v || '').toLowerCase().includes(needle)) || g.items.some((i) => String(i.sku || '').toLowerCase().includes(needle)));
    for (const g of list) g.items.sort((a, b) => String(a.sku || '').localeCompare(String(b.sku || ''), undefined, { numeric: true }));
    return list.sort((a, b) => a.name.localeCompare(b.name) || a.variety.localeCompare(b.variety));
  }, [items, speciesById, q]);
  const shownCount = groups.reduce((n, g) => n + g.items.length, 0);
  const toggleOpen = (key) => setOpen((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const SKU_PREVIEW = 4;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, SKU or variety…" className="w-full pl-9 pr-3 py-2.5 text-sm border border-gray-300 rounded-xl bg-white" />
      </div>
      {err && <div className="flex items-center gap-2 bg-red-50 text-red-700 text-sm px-3 py-2 rounded-lg"><AlertCircle className="w-4 h-4 shrink-0" /> {err}</div>}
      {!items && !err && <div className="flex items-center gap-2 text-sm text-gray-500 py-4"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>}
      {items && <div className="text-xs text-gray-500">{groups.length} plant{groups.length === 1 ? '' : 's'} · {shownCount} of {items.length} available</div>}
      {items && groups.length === 0 && <div className="rounded-xl border border-gray-200 bg-white px-3 py-6 text-center text-sm text-gray-500">{items.length ? `Nothing matches "${q}".` : 'Nothing available right now.'}</div>}
      <div className="space-y-2">
        {groups.map((g) => {
          const expanded = open.has(g.key);
          const skus = expanded ? g.items : g.items.slice(0, SKU_PREVIEW);
          return (
            <div key={g.key} className="rounded-xl border border-gray-200 bg-white px-3 py-2.5">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-gray-900 leading-tight">{g.name}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{g.variety}{g.items.some((i) => i.type === 'tc') ? ' · TC' : ''}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-lg font-bold text-gray-900 leading-tight">{money(g.listPrice) || '—'}</div>
                  <div className="text-[11px] text-gray-500">list · <b className="text-gray-800">{g.items.length}</b> available</div>
                </div>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {skus.map((i) => <span key={i.id} className="font-mono text-[11px] text-gray-700 bg-gray-100 rounded px-1.5 py-0.5">{i.sku}</span>)}
                {g.items.length > SKU_PREVIEW && (
                  <button type="button" onClick={() => toggleOpen(g.key)} className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-emerald-700 px-1">
                    {expanded ? 'fewer' : `+${g.items.length - SKU_PREVIEW} more`}<ChevronDown className={`w-3 h-3 transition ${expanded ? 'rotate-180' : ''}`} />
                  </button>
                )}
              </div>
              {g.sellNote && (
                <div className="mt-2 rounded-lg bg-amber-50 border-l-4 border-amber-400 px-2.5 py-1.5 text-sm text-amber-900">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-amber-700">Say this</div>
                  <div className="whitespace-pre-wrap">{g.sellNote}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
