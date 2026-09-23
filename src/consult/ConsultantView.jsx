import { useContext, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, LogOut, ClipboardList, Check, Loader2, Search, ChevronRight, Tag, Radio, Boxes, ChevronDown } from 'lucide-react';
import { api } from '../api.js';
import { AuthContext } from '../AuthContext.js';

// Consultant screen — a phone-first pricing workspace over three tabs.
//
// The consultant role (migration 0045) prices the wholesale orders and needs
// the context to do it well:
//   · Orders  — each wholesale order with its sell-through (% of received
//               plants sold); inside, per plant: stock + sales history and
//               the two fields they own — the species LIST price and the
//               note for the seller (what the streamer sees on scan).
//   · Sales   — every live sale event; tap one for its analysis board:
//               totals, per-plant breakdown, and every plant sold with its
//               price next to the list price.
//   · Stock   — what's on hand, grouped by plant, with list price + history.
// Everything here comes from cost-free reads: the purchase-orders API strips
// costs for non-admins, the species API strips wholesalePrice for this
// role, and the sales/stock actions select only sale + list prices.
//
// Both editable fields live on the SPECIES, so a price set here shows on
// every order of that plant and on the live surfaces immediately.

const STATUS_ORDER = { ordered: 0, draft: 1, received: 2 };
const STATUS_LABEL = { draft: 'Draft', ordered: 'Ordered', received: 'Received' };
const STATUS_CLASS = {
  draft: 'bg-gray-100 text-gray-700',
  ordered: 'bg-amber-100 text-amber-800',
  received: 'bg-emerald-100 text-emerald-800',
};
const SALE_STATUS_CLASS = {
  ongoing: 'bg-red-100 text-red-700',
  packing: 'bg-amber-100 text-amber-800',
  closed: 'bg-gray-100 text-gray-600',
};
const fmtDate = (t) => (t ? String(t).slice(0, 10) : '');
const money = (v) => (v == null || v === '' ? null : parseFloat(v));
const fmtInt = (v) => (v == null ? '—' : Number(v).toLocaleString());
const fmtMoney = (v) => (v == null || Number.isNaN(Number(v)) ? '—' : `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 100) : null);
const TABS = [['orders', 'Orders'], ['sales', 'Sales'], ['stock', 'Stock']];
const TAB_ICONS = { orders: ClipboardList, sales: Radio, stock: Boxes };

export function ConsultantView({ onLogout }) {
  const { currentUser, activeBrand, brands, switchBrand } = useContext(AuthContext);
  const [tab, setTab] = useState('orders');
  const [species, setSpecies] = useState([]);
  const [stats, setStats] = useState(null);       // { totals, bySpecies } — stock + sales, no costs
  const [toast, setToast] = useState(null);
  // Per-tab "open" record: an order or a sale; null = list.
  const [openPo, setOpenPo] = useState(null);
  const [openSale, setOpenSale] = useState(null);

  const speciesById = useMemo(() => new Map((species || []).map(s => [s.id, s])), [species]);
  const showToast = (msg, type = 'ok') => { setToast({ msg, type }); setTimeout(() => setToast(null), 2600); };
  const onSpeciesSaved = (id, patch) => setSpecies(prev => prev.map(s => (s.id === id ? { ...s, ...patch } : s)));

  // Catalog + stats once per mount (App remounts this screen keyed on the
  // brand, so a brand switch starts clean — no state resets in effects).
  useEffect(() => {
    let alive = true;
    api.getSpecies().then(sp => { if (alive) setSpecies(sp || []); }).catch(() => {});
    api.getSpeciesStats().then(st => { if (alive) setStats(st || null); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const title = openPo ? (openPo.supplier || 'Wholesale order')
    : openSale ? (openSale.name || 'Sale')
    : tab === 'orders' ? 'Wholesale orders' : tab === 'sales' ? 'Live sales' : 'Stock';
  const subtitle = openPo ? `${STATUS_LABEL[openPo.status] || openPo.status} · ${fmtDate(openPo.createdAt)}`
    : openSale ? [openSale.platform, openSale.date ? fmtDate(openSale.date) : null].filter(Boolean).join(' · ')
    : currentUser.displayName;
  const onBack = openPo ? () => setOpenPo(null) : openSale ? () => setOpenSale(null) : null;

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      <TopBar title={title} subtitle={subtitle} onBack={onBack} onLogout={onLogout} />
      {!onBack && brands && brands.length > 1 && (
        <BrandStrip brands={brands} activeBrand={activeBrand} onSwitch={switchBrand} />
      )}

      <div className="flex-1 w-full max-w-md mx-auto px-3 py-3 pb-28">
        {tab === 'orders' && (
          <OrdersTab
            openPo={openPo} setOpenPo={setOpenPo}
            speciesById={speciesById} stats={stats}
            onSpeciesSaved={onSpeciesSaved} showToast={showToast}
          />
        )}
        {tab === 'sales' && (
          <SalesTab openSale={openSale} setOpenSale={setOpenSale} speciesById={speciesById} showToast={showToast} />
        )}
        {tab === 'stock' && (
          <StockTab speciesById={speciesById} stats={stats} showToast={showToast} />
        )}
      </div>

      {!onBack && (
        <nav className="fixed bottom-0 inset-x-0 z-20 bg-white border-t border-gray-200 pb-safe">
          <div className="max-w-md mx-auto grid grid-cols-3">
            {TABS.map(([id, label]) => {
              const Icon = TAB_ICONS[id];
              return (
              <button
                key={id}
                type="button"
                onClick={() => { setTab(id); setOpenPo(null); setOpenSale(null); }}
                aria-current={tab === id ? 'page' : undefined}
                className={`h-16 flex flex-col items-center justify-center gap-1 text-xs font-semibold ${tab === id ? 'text-emerald-700' : 'text-gray-500'}`}
              >
                <Icon className="w-6 h-6" />
                {label}
              </button>
              );
            })}
          </div>
        </nav>
      )}

      {toast && (
        <div className={`fixed left-1/2 -translate-x-1/2 bottom-24 z-50 px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg ${
          toast.type === 'error' ? 'bg-red-600 text-white' : 'bg-gray-900 text-white'
        }`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ─── Orders ──────────────────────────────────────────────────────────────

function OrdersTab({ openPo, setOpenPo, speciesById, stats, onSpeciesSaved, showToast }) {
  const [pos, setPos] = useState(null);
  const [progress, setProgress] = useState(null);   // { poId: { received, sold } }
  const [err, setErr] = useState(null);
  const [lines, setLines] = useState(null);

  useEffect(() => {
    let alive = true;
    api.listPurchaseOrders('ordered,draft,received')
      .then(ps => {
        if (!alive) return;
        setPos([...(ps || [])].sort((a, b) =>
          (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
          || new Date(b.createdAt) - new Date(a.createdAt)));
      })
      .catch(e => { if (alive) setErr(e.message || 'Could not load orders'); });
    api.purchaseOrderSoldProgress().then(p => { if (alive) setProgress(p || {}); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!openPo) return undefined;
    let alive = true;
    api.getPurchaseOrder(openPo.id)
      .then(r => { if (alive) setLines([...(r.lines || [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))); })
      .catch(e => { if (alive) { showToast(e.message || 'Could not load the order', 'error'); setOpenPo(null); } });
    return () => { alive = false; setLines(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPo?.id]);

  if (err) return <ErrorBox msg={err} />;
  if (!pos) return <Loading label="Loading orders…" />;
  if (openPo) {
    return (
      <OrderDetail
        po={openPo} lines={lines} speciesById={speciesById}
        statsBySpecies={stats?.bySpecies || null}
        progress={progress?.[openPo.id] || null}
        onSpeciesSaved={onSpeciesSaved} showToast={showToast}
      />
    );
  }
  return (
    <div className="space-y-2">
      <InventorySummary totals={stats?.totals || null} loaded={!!stats} />
      <div className="text-xs text-gray-500 px-1 pt-1">Tap an order to set list prices and seller notes.</div>
      {pos.length === 0 && <div className="py-12 text-center text-gray-500 text-sm">No wholesale orders for this brand yet.</div>}
      {pos.map(po => {
        const pr = progress?.[po.id];
        const soldPct = pr ? pct(pr.sold, pr.received) : null;
        return (
          <button
            key={po.id}
            type="button"
            onClick={() => setOpenPo(po)}
            className="w-full text-left bg-white rounded-2xl border border-gray-200 px-4 py-3.5 flex items-center gap-3 active:bg-gray-50"
          >
            <Ring value={soldPct} label={pr ? `${pr.sold}/${pr.received}` : null} />
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-gray-900 truncate">{po.supplier || 'Wholesale order'}</div>
              <div className="text-xs text-gray-500 mt-0.5">
                {fmtDate(po.createdAt)} · {po.lineCount} {po.lineCount === 1 ? 'plant' : 'plants'} · {po.unitCount} {po.unitCount === 1 ? 'unit' : 'units'}
              </div>
              <div className="text-xs mt-0.5">
                {progress == null ? <span className="text-gray-400">sell-through…</span>
                  : !pr || pr.received === 0 ? <span className="text-gray-400">nothing received yet</span>
                  : <span className="text-gray-700"><b className="text-gray-900">{soldPct}%</b> of received sold · {pr.sold} of {pr.received}</span>}
              </div>
            </div>
            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${STATUS_CLASS[po.status] || 'bg-gray-100 text-gray-700'}`}>
              {STATUS_LABEL[po.status] || po.status}
            </span>
            <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
          </button>
        );
      })}
    </div>
  );
}

// Small sell-through ring: percentage in the middle, "sold/received" under it.
function Ring({ value, label }) {
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  const r = 17, c = 2 * Math.PI * r;
  return (
    <div className="flex-shrink-0 w-12 text-center">
      <svg width="44" height="44" viewBox="0 0 44 44" className="block mx-auto">
        <circle cx="22" cy="22" r={r} fill="none" stroke="#e5e7eb" strokeWidth="4" />
        {value != null && (
          <circle cx="22" cy="22" r={r} fill="none" stroke="#059669" strokeWidth="4" strokeLinecap="round"
            strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 22 22)" />
        )}
        <text x="22" y="26" textAnchor="middle" fontSize="11" fontWeight="700" fill={value != null ? '#065f46' : '#9ca3af'}>
          {value != null ? `${v}%` : '—'}
        </text>
      </svg>
      {label && <div className="text-[10px] text-gray-500 -mt-0.5 tabular-nums">{label}</div>}
    </div>
  );
}

// Brand-wide stock + sales, on the order list. Sale prices are the
// consultant's pricing context; costs never reach this screen.
function InventorySummary({ totals, loaded }) {
  const t = totals || {};
  return (
    <div className="bg-white rounded-2xl border border-gray-200 px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold text-gray-900">Inventory &amp; sales</div>
        <div className="text-[11px] text-gray-500">{loaded ? 'last 30 days' : 'loading…'}</div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Tile label="In stock" value={loaded ? fmtInt(t.inStock) : '—'} sub="units on hand" />
        <Tile label="Sold" value={loaded ? fmtInt(t.sold30d) : '—'} sub={loaded ? `${fmtInt(t.sold)} all time` : null} />
        <Tile label="Avg sale" value={loaded ? fmtMoney(t.avgSalePrice30d) : '—'} sub={loaded && t.avgSalePrice != null ? `${fmtMoney(t.avgSalePrice)} all time` : null} />
      </div>
    </div>
  );
}

function Tile({ label, value, sub }) {
  return (
    <div className="bg-gray-50 rounded-xl px-3 py-2 min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 truncate">{label}</div>
      <div className="text-lg font-bold text-gray-900 tabular-nums leading-tight">{value}</div>
      {sub && <div className="text-[11px] text-gray-500 truncate">{sub}</div>}
    </div>
  );
}

// Per-plant stock + sales line under the quantities on a line card.
function SpeciesStats({ st }) {
  if (!st) return null;
  if (!st.sold && !st.inStock) return <div className="text-xs text-gray-400 mt-1">No stock or sales history yet</div>;
  return (
    <div className="text-xs text-gray-600 mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
      <span>In stock <b className="text-gray-900">{fmtInt(st.inStock)}</b></span>
      <span>·</span>
      {st.sold ? (
        <>
          <span>Sold <b className="text-gray-900">{fmtInt(st.sold)}</b>{st.sold30d ? ` (${fmtInt(st.sold30d)} in 30d)` : ''}</span>
          {st.avgSalePrice != null && <><span>·</span><span>Avg <b className="text-gray-900">{fmtMoney(st.avgSalePrice)}</b></span></>}
          {st.lastSalePrice != null && <><span>·</span><span>Last <b className="text-gray-900">{fmtMoney(st.lastSalePrice)}</b>{st.lastSoldAt ? ` on ${fmtDate(st.lastSoldAt)}` : ''}</span></>}
        </>
      ) : <span>No sales yet</span>}
    </div>
  );
}

function OrderDetail({ po, lines, speciesById, statsBySpecies, progress, onSpeciesSaved, showToast }) {
  const [q, setQ] = useState('');
  if (!lines) return <Loading label="Loading plants…" />;
  const rows = lines.map(l => ({ line: l, sp: speciesById.get(l.speciesId) || null }));
  const priced = rows.filter(r => money(r.sp?.idealSellingPrice) > 0).length;
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? rows.filter(r => `${r.sp?.epithet || ''} ${r.sp?.commonName || ''} ${r.sp?.varietyName || ''}`.toLowerCase().includes(needle))
    : rows;
  const soldPct = progress ? pct(progress.sold, progress.received) : null;
  return (
    <div>
      <div className="sticky top-0 z-10 -mx-3 px-3 pt-1 pb-2 bg-gray-100">
        <div className="bg-white rounded-2xl border border-gray-200 px-4 py-3 flex items-center gap-3">
          <Ring value={soldPct} label={progress ? `${progress.sold}/${progress.received}` : null} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-gray-900">{priced} of {rows.length} priced</div>
            <div className="text-xs text-gray-600">
              {progress && progress.received > 0
                ? `${soldPct}% of received sold · ${progress.sold} of ${progress.received}`
                : 'nothing received yet'}
            </div>
            {po.notes && <div className="text-xs text-gray-500 truncate">{po.notes}</div>}
          </div>
        </div>
        {rows.length > 6 && <SearchBox value={q} onChange={setQ} placeholder="Find a plant…" />}
      </div>
      <div className="space-y-3 mt-2">
        {shown.length === 0 && <div className="py-10 text-center text-gray-500 text-sm">No plants match.</div>}
        {shown.map(({ line, sp }) => (
          <LineCard key={line.id} line={line} species={sp} stats={statsBySpecies ? (statsBySpecies[line.speciesId] || null) : undefined} onSaved={onSpeciesSaved} showToast={showToast} />
        ))}
      </div>
    </div>
  );
}

// One plant on an order: photo, name, quantities, stock + sales, then the
// two fields the consultant owns. Each saves on blur (or Enter for the
// price) so a phone keyboard's "Done" is the whole gesture.
function LineCard({ line, species, stats, onSaved, showToast }) {
  const [price, setPrice] = useState(species?.idealSellingPrice != null ? String(species.idealSellingPrice) : '');
  const [note, setNote] = useState(species?.sellNote || '');
  const [saving, setSaving] = useState(null);
  const [savedTick, setSavedTick] = useState(null);
  const imgUrl = useSpeciesPhoto(species);
  const flash = (field) => { setSavedTick(field); setTimeout(() => setSavedTick(null), 1800); };

  const savePrice = async () => {
    if (!species) return;
    const raw = price.trim();
    const v = raw === '' ? null : parseFloat(raw);
    if (v !== null && (!Number.isFinite(v) || v < 0)) {
      setPrice(species.idealSellingPrice != null ? String(species.idealSellingPrice) : '');
      return;
    }
    const cur = money(species.idealSellingPrice);
    if ((v === null && cur === null) || (v !== null && cur !== null && v === cur)) return;
    setSaving('price');
    try {
      const r = await api.updateSpecies({ id: species.id, patch: { idealSellingPrice: v } });
      onSaved(species.id, { idealSellingPrice: v });
      const n = r?.restamped?.listing || 0;
      showToast(v === null ? 'List price cleared' : `List price $${v.toFixed(2)} saved${n ? ` · ${n} plant${n === 1 ? '' : 's'} repriced` : ''}`);
      flash('price');
    } catch (e) {
      showToast(e.message || 'Could not save the price', 'error');
      setPrice(cur != null ? String(cur) : '');
    } finally { setSaving(null); }
  };

  const saveNote = async () => {
    if (!species) return;
    const v = note.trim();
    if (v === (species.sellNote || '')) return;
    setSaving('note');
    try {
      const r = await api.updateSpecies({ id: species.id, patch: { sellNote: v || null } });
      if (r?.sellNoteUnsupported) {
        showToast('Notes need a database update — tell the admin (migration 0044)', 'error');
        setNote(species.sellNote || '');
        return;
      }
      onSaved(species.id, { sellNote: v || null });
      showToast(v ? 'Note saved' : 'Note cleared');
      flash('note');
    } catch (e) {
      showToast(e.message || 'Could not save the note', 'error');
      setNote(species.sellNote || '');
    } finally { setSaving(null); }
  };

  const name = species ? [species.varietyName, species.epithet].filter(Boolean).join(' · ') : '(unknown plant)';
  const hasPrice = money(species?.idealSellingPrice) > 0;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-3.5">
      <div className="flex items-start gap-3">
        <Thumb url={imgUrl} />
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-gray-900 leading-snug">{species?.epithet || '(unknown plant)'}</div>
          {species?.varietyName && <div className="text-sm text-gray-500">{species.varietyName}</div>}
          {species?.commonName && <div className="text-xs text-gray-400">{species.commonName}</div>}
          <div className="text-xs text-gray-500 mt-1">
            {line.quantityOrdered} ordered
            {line.quantityReceived > 0 ? ` · ${line.quantityReceived} received` : ''}
            {(line.itemType === 'tc') ? ' · TC' : ''}
          </div>
          {stats !== undefined && <SpeciesStats st={stats || { inStock: 0, sold: 0 }} />}
        </div>
        {hasPrice && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 flex-shrink-0">priced</span>}
      </div>

      <div className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-3 items-center">
        <label htmlFor={`price-${line.id}`} className="text-sm font-medium text-gray-700">List price</label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-lg">$</span>
          <input
            id={`price-${line.id}`}
            type="number" inputMode="decimal" enterKeyHint="done" step="0.01" min={0}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            onBlur={savePrice}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            disabled={!species || saving === 'price'}
            placeholder="0.00"
            aria-label={`List price for ${name}`}
            className="w-full h-12 pl-8 pr-10 text-lg font-semibold tabular-nums border-2 border-emerald-300 bg-emerald-50/40 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 disabled:opacity-60"
          />
          <FieldState saving={saving === 'price'} saved={savedTick === 'price'} />
        </div>

        <label htmlFor={`note-${line.id}`} className="text-sm font-medium text-gray-700 self-start pt-2">Note for<br />the seller</label>
        <div className="relative">
          <textarea
            id={`note-${line.id}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={saveNote}
            disabled={!species || saving === 'note'}
            rows={2} maxLength={1000}
            placeholder="What to say about this plant on the live…"
            aria-label={`Note for the seller about ${name}`}
            className="w-full px-3 py-2 pr-10 text-base border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 resize-y disabled:opacity-60"
          />
          <FieldState saving={saving === 'note'} saved={savedTick === 'note'} />
        </div>
      </div>
    </div>
  );
}

// ─── Sales ───────────────────────────────────────────────────────────────

function SalesTab({ openSale, setOpenSale, speciesById, showToast }) {
  const [sales, setSales] = useState(null);
  const [summary, setSummary] = useState(null);   // { saleId: { sold, revenue, avgSalePrice } }
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    api.getSales()
      .then(ss => {
        if (!alive) return;
        // Newest first: the sale date when set, else when it was created.
        const when = (s) => new Date(s.date || s.createdAt || 0).getTime();
        setSales([...(ss || [])].sort((a, b) => when(b) - when(a)));
      })
      .catch(e => { if (alive) setErr(e.message || 'Could not load sales'); });
    api.getSalesSoldSummary().then(sm => { if (alive) setSummary(sm || {}); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  if (err) return <ErrorBox msg={err} />;
  if (!sales) return <Loading label="Loading sales…" />;
  if (openSale) return <SaleBoard sale={openSale} summary={summary?.[openSale.id] || null} speciesById={speciesById} showToast={showToast} />;

  const totalSold = summary ? Object.values(summary).reduce((s, x) => s + (x.sold || 0), 0) : null;
  const totalRev = summary ? Object.values(summary).reduce((s, x) => s + (x.revenue || 0), 0) : null;
  return (
    <div className="space-y-2">
      <div className="bg-white rounded-2xl border border-gray-200 px-4 py-3">
        <div className="text-sm font-semibold text-gray-900 mb-2">All live sales</div>
        <div className="grid grid-cols-3 gap-2">
          <Tile label="Events" value={fmtInt(sales.length)} />
          <Tile label="Plants sold" value={summary ? fmtInt(totalSold) : '—'} />
          <Tile label="Revenue" value={summary ? fmtMoney(totalRev) : '—'} />
        </div>
      </div>
      <div className="text-xs text-gray-500 px-1 pt-1">Tap a sale for its analysis board.</div>
      {sales.length === 0 && <div className="py-12 text-center text-gray-500 text-sm">No live sales for this brand yet.</div>}
      {sales.map(sale => {
        const sm = summary?.[sale.id];
        return (
          <button
            key={sale.id}
            type="button"
            onClick={() => setOpenSale(sale)}
            className="w-full text-left bg-white rounded-2xl border border-gray-200 px-4 py-3.5 flex items-center gap-3 active:bg-gray-50"
          >
            <div className="w-10 h-10 rounded-full bg-red-50 text-red-600 flex items-center justify-center flex-shrink-0">
              <Radio className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-gray-900 truncate">{sale.name || 'Sale'}</div>
              <div className="text-xs text-gray-500 mt-0.5">
                {[sale.date ? fmtDate(sale.date) : fmtDate(sale.createdAt), sale.platform].filter(Boolean).join(' · ')}
              </div>
              <div className="text-xs mt-0.5">
                {summary == null ? <span className="text-gray-400">totals…</span>
                  : !sm ? <span className="text-gray-400">nothing sold yet</span>
                  : <span className="text-gray-700"><b className="text-gray-900">{fmtInt(sm.sold)}</b> sold · <b className="text-gray-900">{fmtMoney(sm.revenue)}</b>{sm.avgSalePrice != null ? ` · avg ${fmtMoney(sm.avgSalePrice)}` : ''}</span>}
              </div>
            </div>
            {sale.status && (
              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full capitalize ${SALE_STATUS_CLASS[sale.status] || 'bg-gray-100 text-gray-700'}`}>
                {sale.status}
              </span>
            )}
            <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
          </button>
        );
      })}
    </div>
  );
}

// One sale's analysis board: totals, per-plant breakdown, every plant sold.
function SaleBoard({ sale, summary, speciesById, showToast }) {
  const [items, setItems] = useState(null);
  const [view, setView] = useState('plants');   // 'plants' | 'items'
  const [q, setQ] = useState('');

  useEffect(() => {
    let alive = true;
    api.getSaleSoldItems(sale.id)
      .then(list => { if (alive) setItems(list || []); })
      .catch(e => { if (alive) { showToast(e.message || 'Could not load this sale', 'error'); setItems([]); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sale.id]);

  if (!items) return <Loading label="Loading what sold…" />;

  const priced = items.filter(i => i.salePrice != null);
  const revenue = priced.reduce((s, i) => s + i.salePrice * (i.quantity || 1), 0);
  const count = items.reduce((s, i) => s + (i.quantity || 1), 0);
  const avg = priced.length ? revenue / priced.reduce((s, i) => s + (i.quantity || 1), 0) : null;
  const top = priced.length ? Math.max(...priced.map(i => i.salePrice)) : null;
  const low = priced.length ? Math.min(...priced.map(i => i.salePrice)) : null;
  const vsList = priced.filter(i => i.listPrice != null);
  const vsListPct = vsList.length
    ? Math.round((vsList.reduce((s, i) => s + i.salePrice, 0) / vsList.reduce((s, i) => s + i.listPrice, 0)) * 100)
    : null;

  // Per-plant breakdown (by species when known, else by name).
  const groups = new Map();
  for (const it of items) {
    const key = it.speciesId || `name:${it.name}`;
    const g = groups.get(key) || { key, name: it.name, variety: it.variety, sold: 0, revenue: 0, priced: 0, top: null, listPrice: money(speciesById.get(it.speciesId)?.idealSellingPrice) };
    g.sold += it.quantity || 1;
    if (it.salePrice != null) { g.revenue += it.salePrice * (it.quantity || 1); g.priced += it.quantity || 1; g.top = g.top == null ? it.salePrice : Math.max(g.top, it.salePrice); }
    groups.set(key, g);
  }
  const plants = [...groups.values()].sort((a, b) => b.revenue - a.revenue || b.sold - a.sold);
  const needle = q.trim().toLowerCase();
  const shownItems = needle ? items.filter(i => `${i.name || ''} ${i.variety || ''} ${i.sku || ''} ${i.lotNumber || ''}`.toLowerCase().includes(needle)) : items;
  const shownPlants = needle ? plants.filter(g => `${g.name || ''} ${g.variety || ''}`.toLowerCase().includes(needle)) : plants;

  return (
    <div>
      <div className="bg-white rounded-2xl border border-gray-200 px-4 py-3">
        <div className="grid grid-cols-2 gap-2">
          <Tile label="Plants sold" value={fmtInt(count)} sub={summary && summary.sold !== count ? `${fmtInt(summary.sold)} in totals` : null} />
          <Tile label="Revenue" value={fmtMoney(revenue)} sub={priced.length < items.length ? `${items.length - priced.length} without a price` : null} />
          <Tile label="Avg price" value={fmtMoney(avg)} sub={top != null ? `${fmtMoney(low)} – ${fmtMoney(top)}` : null} />
          <Tile label="Vs list price" value={vsListPct != null ? `${vsListPct}%` : '—'} sub={vsListPct != null ? (vsListPct >= 100 ? 'sold at or above list' : 'sold below list') : 'no list prices to compare'} />
        </div>
      </div>

      <div className="mt-3 flex rounded-xl border border-gray-200 bg-gray-200/60 p-1" role="group" aria-label="View">
        {[['plants', `By plant (${plants.length})`], ['items', `Every plant (${count})`]].map(([id, label]) => (
          <button key={id} type="button" onClick={() => setView(id)} aria-pressed={view === id}
            className={`flex-1 h-10 text-sm font-semibold rounded-lg ${view === id ? 'bg-white text-emerald-700 shadow-sm' : 'text-gray-600'}`}>
            {label}
          </button>
        ))}
      </div>
      {items.length > 8 && <div className="mt-2"><SearchBox value={q} onChange={setQ} placeholder="Find a plant, SKU, or lot…" /></div>}

      {items.length === 0 ? (
        <div className="py-12 text-center text-gray-500 text-sm">Nothing sold in this sale yet.</div>
      ) : view === 'plants' ? (
        <div className="mt-2 bg-white rounded-2xl border border-gray-200 divide-y divide-gray-100">
          {shownPlants.map(g => (
            <div key={g.key} className="px-4 py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-gray-900 truncate">{g.name || '(unnamed)'}</div>
                <div className="text-xs text-gray-500 truncate">{g.variety || ''}{g.listPrice != null ? ` · list ${fmtMoney(g.listPrice)}` : ''}</div>
              </div>
              <div className="text-right">
                <div className="font-bold text-gray-900 tabular-nums">{fmtMoney(g.revenue)}</div>
                <div className="text-xs text-gray-500 tabular-nums">{g.sold} sold{g.priced ? ` · avg ${fmtMoney(g.revenue / g.priced)}` : ''}{g.top != null ? ` · top ${fmtMoney(g.top)}` : ''}</div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-2 bg-white rounded-2xl border border-gray-200 divide-y divide-gray-100">
          {shownItems.map(it => {
            const delta = it.salePrice != null && it.listPrice != null ? Math.round(((it.salePrice - it.listPrice) / it.listPrice) * 100) : null;
            return (
              <div key={it.id} className="px-4 py-2.5 flex items-center gap-3">
                <div className="w-11 text-center flex-shrink-0">
                  <div className="text-[10px] uppercase text-gray-400">lot</div>
                  <div className="font-mono font-semibold text-gray-800 text-sm">{it.lotNumber || '—'}</div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-900 truncate">{it.name || it.sku}</div>
                  <div className="text-xs text-gray-500 truncate">{[it.variety, it.sku].filter(Boolean).join(' · ')}{it.listPrice != null ? ` · list ${fmtMoney(it.listPrice)}` : ''}</div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="font-bold text-gray-900 tabular-nums">{it.salePrice != null ? fmtMoney(it.salePrice) : <span className="text-gray-400 font-normal">no price</span>}</div>
                  {delta != null && (
                    <div className={`text-[11px] font-semibold tabular-nums ${delta >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>{delta >= 0 ? '+' : ''}{delta}% vs list</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Stock ───────────────────────────────────────────────────────────────

function StockTab({ speciesById, stats, showToast }) {
  const [items, setItems] = useState(null);
  const [q, setQ] = useState('');
  const [openKey, setOpenKey] = useState(null);

  useEffect(() => {
    let alive = true;
    api.getStockItems()
      .then(list => { if (alive) setItems(list || []); })
      .catch(e => { if (alive) { showToast(e.message || 'Could not load stock', 'error'); setItems([]); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!items) return <Loading label="Loading stock…" />;

  const groups = new Map();
  for (const it of items) {
    const key = it.speciesId || `name:${it.name}`;
    const sp = it.speciesId ? speciesById.get(it.speciesId) : null;
    const g = groups.get(key) || {
      key, speciesId: it.speciesId, name: sp?.epithet || it.name, variety: sp?.varietyName || it.variety,
      listPrice: money(sp?.idealSellingPrice), units: 0, listed: 0, items: [],
    };
    g.units += Math.max(1, parseInt(it.quantity, 10) || 1);
    if (it.status === 'listed') g.listed += 1;
    g.items.push(it);
    groups.set(key, g);
  }
  const rows = [...groups.values()].sort((a, b) => b.units - a.units || String(a.name).localeCompare(String(b.name)));
  const needle = q.trim().toLowerCase();
  const shown = needle ? rows.filter(g => `${g.name || ''} ${g.variety || ''}`.toLowerCase().includes(needle)) : rows;
  const units = rows.reduce((s, g) => s + g.units, 0);
  const unpriced = rows.filter(g => g.listPrice == null).length;

  return (
    <div>
      <div className="bg-white rounded-2xl border border-gray-200 px-4 py-3">
        <div className="grid grid-cols-3 gap-2">
          <Tile label="Units" value={fmtInt(units)} sub="on hand" />
          <Tile label="Plants" value={fmtInt(rows.length)} sub="kinds in stock" />
          <Tile label="No list price" value={fmtInt(unpriced)} sub={unpriced ? 'need pricing' : 'all priced'} />
        </div>
      </div>
      {rows.length > 6 && <div className="mt-2"><SearchBox value={q} onChange={setQ} placeholder="Find a plant…" /></div>}
      {rows.length === 0 ? (
        <div className="py-12 text-center text-gray-500 text-sm">Nothing in stock for this brand.</div>
      ) : (
        <div className="mt-2 bg-white rounded-2xl border border-gray-200 divide-y divide-gray-100">
          {shown.map(g => {
            const st = stats?.bySpecies?.[g.speciesId] || null;
            const open = openKey === g.key;
            return (
              <div key={g.key}>
                <button type="button" onClick={() => setOpenKey(open ? null : g.key)} className="w-full text-left px-4 py-3 flex items-center gap-3 active:bg-gray-50">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-gray-900 truncate">{g.name || '(unnamed)'}</div>
                    <div className="text-xs text-gray-500 truncate">
                      {g.variety || ''}
                      {st?.sold ? ` · sold ${fmtInt(st.sold)}${st.avgSalePrice != null ? ` avg ${fmtMoney(st.avgSalePrice)}` : ''}` : ''}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="font-bold text-gray-900 tabular-nums">{fmtInt(g.units)} <span className="text-xs font-normal text-gray-500">in stock</span></div>
                    <div className={`text-xs tabular-nums ${g.listPrice == null ? 'text-amber-700 font-semibold' : 'text-gray-600'}`}>
                      {g.listPrice == null ? 'no list price' : `list ${fmtMoney(g.listPrice)}`}{g.listed ? ` · ${g.listed} listed` : ''}
                    </div>
                  </div>
                  <ChevronDown className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
                </button>
                {open && (
                  <div className="px-4 pb-3 flex flex-wrap gap-1.5">
                    {g.items.map(it => (
                      <span key={it.id} className={`font-mono text-[11px] px-2 py-1 rounded-lg ${it.status === 'listed' ? 'bg-sky-50 text-sky-800' : it.status === 'acclimated' ? 'bg-violet-50 text-violet-800' : 'bg-gray-100 text-gray-700'}`} title={it.status}>
                        {it.sku}{it.lotNumber ? ` #${it.lotNumber}` : ''}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── shared bits ─────────────────────────────────────────────────────────

function useSpeciesPhoto(species) {
  const [photoUrl, setPhotoUrl] = useState(null);
  const primaryPhotoId = (() => {
    const photos = species?.photos || [];
    if (!photos.length) return null;
    if (species?.primaryPhotoId && photos.find(p => p.id === species.primaryPhotoId)) return species.primaryPhotoId;
    return photos[0]?.id || null;
  })();
  useEffect(() => {
    if (!primaryPhotoId) return undefined;
    let alive = true;
    api.speciesPhotoSignedUrl(primaryPhotoId).then(u => { if (alive) setPhotoUrl(u); }).catch(() => {});
    return () => { alive = false; };
  }, [primaryPhotoId]);
  return primaryPhotoId ? photoUrl : (species?.imageUrl || null);
}

function Thumb({ url }) {
  return (
    <div className="w-16 h-16 rounded-xl bg-gray-100 overflow-hidden flex-shrink-0 flex items-center justify-center text-gray-300">
      {url ? <img src={url} alt="" className="w-full h-full object-cover" /> : <Tag className="w-5 h-5" />}
    </div>
  );
}

function SearchBox({ value, onChange, placeholder }) {
  return (
    <label className="flex items-center gap-2 bg-white rounded-xl border border-gray-200 px-3">
      <Search className="w-4 h-4 text-gray-400" />
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="flex-1 h-11 text-base outline-none bg-transparent" />
    </label>
  );
}

function Loading({ label }) {
  return <div className="py-16 text-center text-gray-500"><Loader2 className="w-5 h-5 animate-spin inline mr-2" />{label}</div>;
}

function ErrorBox({ msg }) {
  return <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">{msg}</div>;
}

function FieldState({ saving, saved }) {
  if (!saving && !saved) return null;
  return (
    <span className="absolute right-3 top-3 text-emerald-600" aria-live="polite">
      {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
    </span>
  );
}

function TopBar({ title, subtitle, onBack, onLogout }) {
  return (
    <div className="bg-emerald-700 text-white pt-safe flex-shrink-0">
      <div className="h-16 px-3 flex items-center gap-2 max-w-md mx-auto">
        {onBack ? (
          <button onClick={onBack} aria-label="Back" className="w-12 h-12 -ml-2 rounded-full flex items-center justify-center hover:bg-emerald-800 active:bg-emerald-900">
            <ArrowLeft className="w-6 h-6" />
          </button>
        ) : (
          <div className="w-12 h-12 -ml-2 rounded-full flex items-center justify-center"><Tag className="w-6 h-6" /></div>
        )}
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-lg leading-tight truncate">{title}</div>
          {subtitle && <div className="text-sm text-emerald-100 leading-tight truncate mt-0.5">{subtitle}</div>}
        </div>
        <button onClick={onLogout} aria-label="Log out" className="w-12 h-12 -mr-2 rounded-full flex items-center justify-center hover:bg-emerald-800 active:bg-emerald-900">
          <LogOut className="w-6 h-6" />
        </button>
      </div>
    </div>
  );
}

function BrandStrip({ brands, activeBrand, onSwitch }) {
  return (
    <div className="flex-shrink-0 bg-white border-b border-gray-200 px-3 py-2.5">
      <div className="max-w-md mx-auto flex items-center gap-2">
        {brands.map((b) => {
          const active = b.id === activeBrand;
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => { if (!active) onSwitch(b.id); }}
              aria-pressed={active}
              className={`flex-1 h-11 rounded-xl border-2 text-sm font-semibold inline-flex items-center justify-center gap-2 ${active ? 'text-white' : 'bg-white text-gray-600 border-gray-200'}`}
              style={active ? { background: b.accent, borderColor: b.accent } : undefined}
            >
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: active ? '#fff' : b.accent }} />
              {b.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
